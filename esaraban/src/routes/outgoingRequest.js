// หน้าขอเลขหนังสือส่งของครู และหน้าออกเลขของธุรการ
//
// ตามระเบียบงานสารบรรณ ทะเบียนหนังสือส่งเป็นสมุดของเจ้าหน้าที่ธุรการ ครูที่จะส่งหนังสือออกต้องขอเลข
// จากธุรการก่อน ไม่ใช่ดึงเลขถัดไปมาใช้เอง (ดูเหตุผลเต็มใน services/outgoingRequest.js)
//
// การแบ่งงานบนหน้าจอ: ครูกรอกสี่ช่องที่มีแต่เจ้าของเรื่องรู้ — จาก / ถึง / เรื่อง / การปฏิบัติ — ซึ่งเป็น
// สี่ช่องของเล่มทะเบียนหนังสือส่ง (แบบที่ 14) ที่ระบบเดาแทนไม่ได้ ส่วน "เลขที่" กับ "ออกวันที่" ระบบ
// ออกให้เองตอนธุรการอนุมัติ และธุรการแก้ได้ทุกช่องก่อนกด ที่เหลือ (ฝ่าย ชั้นความเร็ว ชั้นความลับ
// หนังสือเวียน ร่างหนังสือ) ซ่อนไว้ใต้ "ตัวเลือกเพิ่มเติม" เพราะค่าเริ่มต้นถูกเกือบทุกครั้ง
import { router, html, json, redirect, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateShort, emptyState, priorityBadge, rowLink, envNumberWarningBox, LABELS } from '../render.js';
import { requireApi, requirePage } from '../middleware.js';
import {
  previewNextNumber, outgoingCounterPosition, highestLiveOutgoing, setOutgoingCounter,
} from '../numbering.js';
import { db, todayInBangkok, beYear, audit } from '../db.js';
import {
  getSetting, setSetting, MAX_SETTING_LENGTH, missingOutgoingNumberEnv,
} from '../services/settings.js';
import { httpError, asText } from '../services/validate.js';
// ร่างหนังสือแนบใหม่ไม่ได้แล้ว (ดู submitOutgoingRequest) แต่เส้นทางเปิด/ดาวน์โหลดยังอยู่ เพราะคำขอ
// ที่ยื่นไว้ก่อนหน้านี้อาจมีร่างค้างอยู่ — ถ้าตัดทิ้งพร้อมกัน ไฟล์พวกนั้นจะเข้าถึงไม่ได้โดยไม่มีใครรู้
import { VIEWABLE_MIME, fallbackFilename } from '../services/attachments.js';
import {
  submitOutgoingRequest, listPendingOutgoingRequests, listMyOutgoingRequests,
  recentReviewedOutgoingRequests, issueOutgoingNumber, rejectOutgoingRequest,
  cancelOutgoingRequest, canIssueOutgoingNumber, editIssuedOutgoing, deleteOutgoingRequest,
  listRequestDrafts, getRequestDraft,
} from '../services/outgoingRequest.js';

function departments() {
  return db.prepare('SELECT id, name FROM departments ORDER BY name').all();
}

/** คนที่ธุรการเลือกเป็น "ผู้ขอ" ได้ตอนบันทึกแทน — ทุกคนที่ยังใช้งานระบบอยู่ */
function activePeople() {
  return db.prepare(`
    SELECT u.id, u.prefix, u.first_name, u.last_name, u.position, d.name AS dept_name
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.deleted_at IS NULL AND u.status = 'active'
    ORDER BY u.first_name, u.last_name
  `).all();
}

const fullName = (r) => `${r.requester_prefix || ''}${r.requester_first} ${r.requester_last}`.trim();
const personName = (u) => `${u.prefix || ''}${u.first_name} ${u.last_name}`.trim();
// ไฟล์เล็กกว่า 1 KB ต้องไม่ขึ้นว่า "0 KB" ซึ่งอ่านเหมือนไฟล์ว่างเปล่า
const fmtKb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} ไบต์`);

/** ช่อง ฝ่าย/ความเร็ว/ความลับ/เวียน ที่ซ่อนใต้ "ตัวเลือกเพิ่มเติม" — ใช้ร่วมกันทั้งฟอร์มครูและฟอร์มธุรการ */
function extraFields(prefix, { departmentId, isCircular = false } = {}) {
  const depts = departments();
  return `
    <div class="form-grid cols-3">
      <div class="field"><label for="${prefix}Dept">ฝ่ายที่รับผิดชอบ</label>
        <select id="${prefix}Dept">
          ${depts.map((d) => `<option value="${esc(d.id)}"${d.id === departmentId ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="${prefix}Priority">ชั้นความเร็ว</label>
        <select id="${prefix}Priority">
          ${Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="${prefix}Secret">ชั้นความลับ</label>
        <select id="${prefix}Secret">
          ${Object.entries(LABELS.SECRET_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select></div>
    </div>
    <div class="field">
      <label class="check-inline" style="display:block">
        <input type="checkbox" id="${prefix}Circular"${isCircular ? ' checked' : ''} />
        <span>เป็น<strong>หนังสือเวียน</strong> — มีถึงผู้รับหลายคนโดยมีใจความอย่างเดียวกัน</span>
      </label>
      <div class="help-text">หนังสือเวียนใช้เลข “ว” และมีทะเบียนแยกเล่มตามระเบียบงานสารบรรณ</div>
    </div>`;
}

// ---------------- ฟอร์มของครู ----------------

function requestFormCard(user) {
  const myName = `${user.prefix || ''}${user.first_name} ${user.last_name}`.trim();
  return `
    <div class="card">
      <h3 class="mt-0">🔢 ขอเลขหนังสือส่ง</h3>
      <p class="text-muted" style="margin-top:-.4rem;font-size:.85rem">
        กรอกสี่ช่องนี้แล้วกดขอ — <strong>เลขที่กับวันที่ระบบออกให้เอง</strong> เจ้าหน้าที่ธุรการเป็นผู้อนุมัติ
        แล้วระบบจะแจ้งเลขกลับมาให้ทั้งในระบบและทางไลน์
        (<strong>ยังไม่กินเลขทะเบียนจนกว่าธุรการจะอนุมัติ</strong>)
      </p>
      <form id="outReqForm" class="stack">
        <div class="form-grid cols-2">
          <div class="field">
            <label for="orFrom">จาก *</label>
            <input type="text" id="orFrom" maxlength="300" required value="${esc(myName)}" autocomplete="off" />
            <div class="help-text">เจ้าของเรื่อง — ชื่อตัวเอง หรือชื่อฝ่าย/กลุ่มงานก็ได้</div>
          </div>
          <div class="field">
            <label for="orTo">ถึง *</label>
            <input type="text" id="orTo" maxlength="300" required placeholder="เช่น ผู้อำนวยการสำนักงานเขตพื้นที่การศึกษา" autocomplete="off" />
            <div class="help-text">หน่วยงาน/บุคคลปลายทาง (ช่อง “เรียน” บนหนังสือ)</div>
          </div>
        </div>
        <div class="field">
          <label for="orTitle">เรื่อง *</label>
          <input type="text" id="orTitle" maxlength="300" required placeholder="เช่น ขออนุญาตพานักเรียนไปทัศนศึกษา" autocomplete="off" />
        </div>
        <div class="field">
          <label for="orAction">การปฏิบัติ</label>
          <input type="text" id="orAction" maxlength="300" placeholder="เช่น ส่งเพื่อพิจารณาอนุญาต" autocomplete="off" />
          <div class="help-text">ให้ปลายทางทำอะไรต่อ — เป็นช่องหนึ่งของเล่มทะเบียนหนังสือส่ง (เว้นว่างได้)</div>
        </div>
        <details class="field-more">
          <summary>ตัวเลือกเพิ่มเติม (ฝ่าย ชั้นความเร็ว ชั้นความลับ หนังสือเวียน)</summary>
          <div style="margin-top:.7rem">
            ${extraFields('or', { departmentId: user.department_id })}
            <div class="field">
              <label for="orNote">ข้อความถึงธุรการ <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
              <input type="text" id="orNote" maxlength="300" placeholder="เช่น ขอใช้ส่งวันศุกร์นี้" autocomplete="off" />
            </div>
          </div>
        </details>
        <button class="btn btn-primary" type="submit">ขอเลขหนังสือส่ง</button>
      </form>
    </div>
    <script>
      document.getElementById('outReqForm').addEventListener('submit', async function(e){
        e.preventDefault();
        var btn = e.target.querySelector('[type=submit]');
        var title = document.getElementById('orTitle').value.trim();
        var to = document.getElementById('orTo').value.trim();
        if (!title || !to) { toast('กรุณากรอกช่อง "ถึง" และ "เรื่อง" ให้ครบ', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังส่งคำขอ...');
        fetch('/outgoing-requests', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            title: title, correspondentName: to,
            fromName: document.getElementById('orFrom').value.trim(),
            actionNote: document.getElementById('orAction').value.trim(),
            departmentId: document.getElementById('orDept').value,
            priority: document.getElementById('orPriority').value,
            secretLevel: document.getElementById('orSecret').value,
            note: document.getElementById('orNote').value.trim(),
            isCircular: document.getElementById('orCircular').checked,
          }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'ส่งคำขอไม่สำเร็จ');
            toast(res.d.duplicate ? 'เรื่องนี้ขอไปแล้วและยังรอธุรการอยู่' : 'ส่งคำขอแล้ว รอธุรการอนุมัติ', 'success');
            setTimeout(function(){ location.reload(); }, 900);
          })
          .catch(function(err){ window.restoreBtn(btn); toast(err.message, 'danger'); });
      });
      window.cancelOutReq = function(id, btn){
        if (!confirm('ถอนคำขอนี้?')) return;
        window.setBtnLoading(btn, 'กำลังถอน...');
        fetch('/outgoing-requests/' + id + '/cancel', { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if (!res.ok) throw new Error(res.d.error); location.reload(); })
          .catch(function(err){ window.restoreBtn(btn); toast(err.message, 'danger'); });
      };
    </script>`;
}

function myRequestsCard(rows) {
  if (!rows.length) return '';
  const statusChip = (r) => {
    if (r.status === 'issued') return `<span class="badge badge-success">ได้เลขแล้ว</span>`;
    if (r.status === 'rejected') return `<span class="badge badge-danger">ยังออกให้ไม่ได้</span>`;
    return '<span class="badge badge-warning">รอธุรการอนุมัติ</span>';
  };
  return `
    <div class="card">
      <h3 class="mt-0">คำขอของฉัน</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>เรื่อง</th><th>สถานะ</th><th>เลขที่ / ออกวันที่</th><th>ขอเมื่อ</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.doc_title || r.title)}${r.is_circular ? ' <span class="badge badge-info">ว เวียน</span>' : ''}
            <div class="text-muted" style="font-size:.78rem">ถึง ${esc(r.doc_to || r.correspondent_name)}</div>
            ${listRequestDrafts(r.id).map((f) => `<div style="font-size:.78rem">
              <a href="/outgoing-requests/files/${esc(f.id)}" target="_blank" rel="noopener">📎 ${esc(f.filename)}</a></div>`).join('')}
            ${r.status === 'rejected' && r.reject_reason ? `<div class="text-muted" style="font-size:.78rem">เหตุผล: ${esc(r.reject_reason)}</div>` : ''}</td>
          <td>${statusChip(r)}</td>
          <td>${!r.doc_number_display ? '<span class="text-muted">—</span>'
            : r.doc_deleted_at
              // หนังสือถูกลบไปแล้ว ลิงก์จะพาไปหน้า "ไม่พบเอกสาร" เฉยๆ — บอกตรงๆ ดีกว่าให้ครูกดแล้วงง
              ? `<strong>${esc(r.doc_number_display)}</strong>
                 <div class="text-muted" style="font-size:.78rem">หนังสือถูกลบออกจากระบบแล้ว</div>`
              : `<a href="/documents/${esc(r.doc_id)}"><strong>${esc(r.doc_number_display)}</strong></a>
                 ${r.doc_date ? `<div class="text-muted" style="font-size:.78rem">ลงวันที่ ${esc(fmtThaiDateShort(r.doc_date))}</div>` : ''}`}</td>
          <td class="text-muted" style="font-size:.82rem;white-space:nowrap">${esc(fmtDate(r.created_at))}</td>
          <td>${r.status === 'pending'
            ? `<button class="btn btn-outline btn-sm" type="button" onclick="cancelOutReq('${esc(r.id)}', this)">ถอน</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

router.get('/outgoing-requests/mine', requirePage((ctx) => {
  const content = `
    <h2>🔢 ขอเลขหนังสือส่ง</h2>
    ${requestFormCard(ctx.user)}
    ${myRequestsCard(listMyOutgoingRequests(ctx.user.id))}`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ขอเลขหนังสือส่ง', path: '/outgoing-requests/mine', content }));
}));

// ---------------- หน้าธุรการ ----------------

/**
 * ตั้งรูปแบบเลขทะเบียนหนังสือส่ง จากหน้าของธุรการเอง
 *
 * เดิมค่าสองตัวนี้อยู่แต่ในหน้า "ตั้งค่าโรงเรียน" ซึ่งเปิดได้เฉพาะผู้ดูแลระบบ ผลคือธุรการ — คนที่ถือเล่ม
 * ทะเบียนจริง เป็นคนเดียวที่รู้ว่าเล่มกระดาษออกเลขไปถึงเท่าไร และเป็นคนที่เห็นเลขผิดเป็นคนแรก —
 * แก้เองไม่ได้เลย ต้องไปตามผู้ดูแลระบบมากรอกให้ ระหว่างนั้นหนังสือทุกฉบับที่ออกไปก็ได้เลขผิดไปเรื่อยๆ
 * และเลขที่ออกไปแล้วตามกลับมาแก้ไม่ได้ จึงย้ายมาไว้ตรงจุดที่ธุรการทำงานอยู่แล้วด้วย
 *
 * กางออกมาเองเมื่อยังไม่ได้ตั้งค่า เพราะเลขที่ออกตอนนั้นเป็นรูปแบบทะเบียนภายใน (0001/2569) ซึ่ง
 * "ดูเหมือนใช้ได้" จนกว่าจะมีคนทักว่าหนังสือที่ส่งออกไปข้างนอกต้องมีรหัสส่วนราชการนำหน้า
 */
function numberingCard() {
  const prefix = getSetting('outgoing_number_prefix');
  const start = getSetting('outgoing_number_start');
  const startYear = getSetting('outgoing_number_start_year');
  const unset = !prefix || !start;
  return `
    <details class="card alert-fold" data-fold="outNumbering"${unset ? ' open' : ''}>
      <summary>🔧 รูปแบบเลขทะเบียนหนังสือส่ง
        ${unset
    ? '<span class="badge badge-warning">ยังไม่ได้ตั้ง</span>'
    : `<span class="badge badge-success">${esc(previewNextNumber('outgoing'))}</span>`}</summary>
      <div class="alert-fold-body">
        ${unset ? `
          <div class="alert alert-warning">
            ตอนนี้ระบบออกเลขเป็น <strong>${esc(previewNextNumber('outgoing'))}</strong>
            ซึ่งเป็นรูปแบบของ<strong>ทะเบียนภายใน</strong> ไม่ใช่เลขที่ใช้บนหนังสือที่ส่งออกไปข้างนอก
            — ตามระเบียบงานสารบรรณ ช่อง “ที่” ต้องเป็น <strong>รหัสส่วนราชการ ทับ เลขทะเบียนหนังสือส่ง</strong>
            เช่น <code>ศธ 04047.109/206</code> กรอกสองช่องข้างล่างนี้ครั้งเดียว แล้วทุกฉบับถัดไปจะได้รูปแบบนี้เอง
          </div>` : ''}
        <div class="field">
          <label for="numPrefix">รหัสหนังสือของโรงเรียน</label>
          <input type="text" id="numPrefix" maxlength="${MAX_SETTING_LENGTH.outgoing_number_prefix}"
            value="${esc(prefix)}" placeholder="เช่น ศธ 04047.109" style="max-width:16rem"
            oninput="previewNum()" autocomplete="off" />
          <div class="help-text">ได้มาจากสำนักงานเขตพื้นที่การศึกษาต้นสังกัด — พิมพ์ให้ตรงกับที่ใช้บนหนังสือจริง เว้นวรรคตรงไหนก็พิมพ์ตรงนั้น</div>
        </div>
        <div class="field">
          <label for="numStart">เลขหนังสือส่งล่าสุดที่ออกไปแล้ว</label>
          <div class="flex gap-2 flex-wrap items-center">
            <input type="text" inputmode="numeric" id="numStart" maxlength="${MAX_SETTING_LENGTH.outgoing_number_start}"
              value="${esc(start)}" placeholder="เช่น 205" style="max-width:8rem" oninput="previewNum()" autocomplete="off" />
            <span class="text-muted">ของทะเบียนปี พ.ศ.</span>
            <input type="text" inputmode="numeric" id="numStartYear" maxlength="${MAX_SETTING_LENGTH.outgoing_number_start_year}"
              value="${esc(startYear || String(beYear()))}" style="max-width:6rem" oninput="previewNum()" autocomplete="off" />
          </div>
          <div class="help-text">
            เลขสุดท้ายในเล่มกระดาษก่อนมาใช้ระบบนี้ — กรอก <code>205</code> แล้วฉบับถัดไปได้ <code>206</code>
            <div style="margin-top:.3rem">
              ผูกกับปีเพราะทะเบียนหนังสือส่ง<strong>เริ่มนับ 1 ใหม่ทุกวันที่ 1 มกราคม</strong>
              พอขึ้นปีใหม่ค่านี้หมดอายุเอง ไม่ต้องกลับมาล้าง · ถ้าระบบออกเลขไปไกลกว่านี้แล้ว
              ค่านี้จะไม่ดึงเลขถอยหลัง (เลขที่ออกไปแล้วใช้ซ้ำไม่ได้)
            </div>
          </div>
        </div>
        <div class="callout-tip">เลขฉบับถัดไปจะเป็น: <strong id="numPreviewOut">${esc(previewNextNumber('outgoing'))}</strong></div>
        ${envNumberWarningBox(missingOutgoingNumberEnv())}
        <button class="btn btn-primary" type="button" onclick="saveNumbering(this)" style="margin-top:.6rem">บันทึกรูปแบบเลข</button>
      </div>
    </details>`;
}

router.get('/outgoing-requests', requirePage((ctx) => {
  // ครูที่กดลิงก์นี้ (หรือกดจากการแจ้งเตือนเก่า) ต้องไปหน้าของตัวเอง ไม่ใช่เจอ 403 เปล่าๆ
  if (!canIssueOutgoingNumber(ctx.user)) return redirect(ctx, '/outgoing-requests/mine');

  const pending = listPendingOutgoingRequests();
  const reviewed = recentReviewedOutgoingRequests();
  const today = todayInBangkok();

  // ช่อง "เลขที่" ตั้งใจเว้นว่างไว้ ไม่ prefill ด้วยเลขตัวอย่าง: ถ้า prefill ธุรการสองคนที่เปิดหน้านี้
  // พร้อมกันจะได้เลขเดียวกันติดมาในฟอร์มทั้งคู่ แล้วกดอนุมัติทั้งสองใบ → หนังสือสองฉบับมีเลขแสดงซ้ำกัน
  // ทั้งที่ตัวนับเดินไปสองเลข (เพราะเลขที่พิมพ์เองข้ามด่านกันเลขซ้ำ) เว้นว่าง = ระบบออกเลขตอนกดจริง
  const card = (r) => `
    <div class="card" id="outreq-${esc(r.id)}">
      <div class="card-header">
        <h3 class="mt-0">${esc(r.title)}</h3>
        <span class="text-muted" style="font-size:.82rem">ขอเมื่อ ${esc(fmtDate(r.created_at))}</span>
      </div>
      <p class="text-muted" style="margin:-.3rem 0 .6rem;font-size:.82rem">
        ผู้ขอ <strong>${esc(fullName(r))}</strong>${r.requester_position ? ` · ${esc(r.requester_position)}` : ''}
        · ฝ่าย ${esc(r.department_name || '-')} · ${priorityBadge(r.priority)} ${esc(LABELS.SECRET_LABEL[r.secret_level] || '')}
        ${r.note ? `<br/>ข้อความถึงธุรการ: <strong>${esc(r.note)}</strong>` : ''}
      </p>
      <div class="alert alert-info" style="padding:.5rem .7rem">
        เลขถัดไปที่ระบบจะออกให้คือ
        <strong id="hint-${esc(r.id)}" style="font-size:1.05rem">${esc(previewNextNumber('outgoing', undefined, Boolean(r.is_circular)))}</strong>
        <span class="text-muted">— แก้ได้ทุกช่องข้างล่างก่อนกดอนุมัติ</span>
      </div>
      <div class="form-grid cols-2">
        <div class="field">
          <label for="num-${esc(r.id)}">เลขที่ <span class="text-muted" style="font-weight:400">(เว้นว่าง = ให้ระบบออกเลขให้)</span></label>
          <input type="text" id="num-${esc(r.id)}" maxlength="60" placeholder="เว้นว่างให้ระบบออกเลขอัตโนมัติ" autocomplete="off" />
        </div>
        <div class="field">
          <label for="date-${esc(r.id)}">ออกวันที่</label>
          <input type="date" id="date-${esc(r.id)}" value="${esc(today)}" />
        </div>
      </div>
      <div class="form-grid cols-2">
        <div class="field"><label for="from-${esc(r.id)}">จาก</label>
          <input type="text" id="from-${esc(r.id)}" maxlength="300" value="${esc(r.from_name || '')}" autocomplete="off" /></div>
        <div class="field"><label for="to-${esc(r.id)}">ถึง *</label>
          <input type="text" id="to-${esc(r.id)}" maxlength="300" value="${esc(r.correspondent_name)}" autocomplete="off" /></div>
      </div>
      <div class="field"><label for="title-${esc(r.id)}">เรื่อง *</label>
        <input type="text" id="title-${esc(r.id)}" maxlength="300" value="${esc(r.title)}" autocomplete="off" /></div>
      <div class="field"><label for="act-${esc(r.id)}">การปฏิบัติ</label>
        <input type="text" id="act-${esc(r.id)}" maxlength="300" value="${esc(r.action_note || '')}" autocomplete="off" /></div>
      <details class="field-more">
        <summary>ตัวเลือกเพิ่มเติม (ฝ่าย ชั้นความเร็ว ชั้นความลับ หนังสือเวียน)</summary>
        <div style="margin-top:.7rem">
          <div class="form-grid cols-3">
            <div class="field"><label for="dept-${esc(r.id)}">ฝ่ายที่รับผิดชอบ</label>
              <select id="dept-${esc(r.id)}">
                ${departments().map((d) => `<option value="${esc(d.id)}"${d.id === r.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
              </select></div>
            <div class="field"><label for="pri-${esc(r.id)}">ชั้นความเร็ว</label>
              <select id="pri-${esc(r.id)}">
                ${Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => `<option value="${k}"${k === r.priority ? ' selected' : ''}>${esc(v)}</option>`).join('')}
              </select></div>
            <div class="field"><label for="sec-${esc(r.id)}">ชั้นความลับ</label>
              <select id="sec-${esc(r.id)}">
                ${Object.entries(LABELS.SECRET_LABEL).map(([k, v]) => `<option value="${k}"${k === r.secret_level ? ' selected' : ''}>${esc(v)}</option>`).join('')}
              </select></div>
          </div>
          <label class="check-inline" style="display:block">
            <input type="checkbox" id="circ-${esc(r.id)}"${r.is_circular ? ' checked' : ''} onchange="syncNumHint('${esc(r.id)}')" />
            <span>ออกเป็น<strong>หนังสือเวียน</strong> (เลข “ว” ทะเบียนแยกเล่ม)</span>
          </label>
          ${r.is_circular ? '<div class="help-text">ผู้ขอระบุมาว่าเป็นหนังสือเวียน</div>' : ''}
        </div>
      </details>
      ${
  // แนบร่างใหม่ไม่ได้แล้ว แถวนี้จึงโผล่เฉพาะคำขอเก่าที่ยังมีไฟล์ค้างอยู่ ไม่ใช่ขึ้นว่า
  // "ผู้ขอไม่ได้แนบร่างมา" ให้ทุกใบ ซึ่งเป็นบรรทัดที่ไม่ได้บอกอะไรเลยและกินที่
  listRequestDrafts(r.id).length ? `<div class="field"><span class="text-muted" style="font-size:.82rem">ร่างหนังสือ: ${
    listRequestDrafts(r.id).map((f) => `<a href="/outgoing-requests/files/${esc(f.id)}" target="_blank" rel="noopener">
        📎 ${esc(f.filename)}</a> (${fmtKb(f.filesize)})`).join(' · ')
  }</span></div>` : ''
}
      <div class="chip-row">
        <button class="btn btn-success" type="button" onclick="issueNum('${esc(r.id)}', this)">✅ อนุมัติและออกเลข</button>
        <button class="btn btn-outline" type="button" onclick="rejectNum('${esc(r.id)}', this)">✖️ ยังออกให้ไม่ได้</button>
      </div>
    </div>`;

  // ครูบางท่านฝากให้ธุรการลงให้ (บอกปากเปล่า/ทางไลน์/เอากระดาษมาให้) ฟอร์มนี้จึงลงแล้วออกเลขให้ในคราว
  // เดียว ไม่ต้องยื่นคำขอไปแล้วกลับมากดอนุมัติใบของตัวเองอีกรอบ — แต่หนังสือที่ออกมาขึ้นชื่อครูเจ้าของ
  // เรื่องเป็นผู้บันทึกเอกสารเหมือนกับที่ครูกดขอเอง ครูจึงเปิด/แนบไฟล์/เสนอต่อได้เอง และได้แจ้งเตือนเลข
  const onBehalfCard = `
    <details class="card alert-fold" data-fold="outOnBehalf">
      <summary>✍️ บันทึกแทนครู (ลงให้แล้วออกเลขทันที)</summary>
      <div class="alert-fold-body">
        <p class="text-muted" style="font-size:.85rem">
          สำหรับครูที่ฝากให้ธุรการลงให้ — กรอกสี่ช่องแล้วกดบันทึก ระบบจะออกเลขให้ทันทีและแจ้งเลขไปให้ครู
          เจ้าของเรื่องทั้งในระบบและทางไลน์ โดยหนังสือจะขึ้นชื่อครูคนนั้นเป็นผู้บันทึกเอกสาร
        </p>
        <div class="field">
          <label for="obWho">ผู้ขอ (เจ้าของเรื่อง) *</label>
          <select id="obWho">
            ${activePeople().map((u) => `<option value="${esc(u.id)}">${esc(personName(u))}${u.position ? ` · ${esc(u.position)}` : ''}${u.dept_name ? ` · ${esc(u.dept_name)}` : ''}</option>`).join('')}
          </select>
          <div class="help-text">หนังสือจะเป็นของคนนี้ และคนนี้คือคนที่ได้รับแจ้งเลขทางไลน์</div>
        </div>
        <div class="form-grid cols-2">
          <div class="field"><label for="obFrom">จาก</label>
            <input type="text" id="obFrom" maxlength="300" placeholder="เว้นว่าง = ใช้ชื่อผู้ขอ" autocomplete="off" /></div>
          <div class="field"><label for="obTo">ถึง *</label>
            <input type="text" id="obTo" maxlength="300" placeholder="เช่น ผู้อำนวยการสำนักงานเขตพื้นที่การศึกษา" autocomplete="off" /></div>
        </div>
        <div class="field"><label for="obTitle">เรื่อง *</label>
          <input type="text" id="obTitle" maxlength="300" autocomplete="off" /></div>
        <div class="field"><label for="obAction">การปฏิบัติ</label>
          <input type="text" id="obAction" maxlength="300" autocomplete="off" /></div>
        <div class="form-grid cols-2">
          <div class="field">
            <label for="obNum">เลขที่ <span class="text-muted" style="font-weight:400">(เว้นว่าง = ให้ระบบออกเลขให้)</span></label>
            <input type="text" id="obNum" maxlength="60" placeholder="เว้นว่างให้ระบบออกเลขอัตโนมัติ" autocomplete="off" /></div>
          <div class="field"><label for="obDate">ออกวันที่</label>
            <input type="date" id="obDate" value="${esc(today)}" /></div>
        </div>
        <details class="field-more">
          <summary>ตัวเลือกเพิ่มเติม (ฝ่าย ชั้นความเร็ว ชั้นความลับ หนังสือเวียน)</summary>
          <div style="margin-top:.7rem">${extraFields('ob')}</div>
        </details>
        <button class="btn btn-primary" type="button" onclick="recordOnBehalf(this)">✅ บันทึกและออกเลขให้</button>
      </div>
    </details>`;

  const content = `
    <h2>🔢 ขอเลขหนังสือส่ง</h2>
    ${numberingCard()}
    <p class="text-muted" style="margin-top:-.5rem">
      ครูกรอก จาก / ถึง / เรื่อง / การปฏิบัติ มาให้ — คุณเป็นผู้อนุมัติ <strong>เลขที่กับวันที่ระบบออกให้เอง</strong>
      และคุณแก้ได้ทุกช่องก่อนกด เมื่ออนุมัติ ระบบจะสร้างหนังสือส่งโดยมีครูผู้ขอเป็นผู้บันทึกเอกสาร
      และแจ้งเลขกลับไปให้เจ้าตัวทันทีทั้งในระบบและทางไลน์
    </p>
    <!-- เล่มทะเบียนอยู่คนละหน้ากับที่ธุรการออกเลข และทางเข้าเดิมคือปุ่มเล็กๆ ที่ซ่อนอยู่ในตัวกรองของ
         หน้ารายการหนังสือ ซึ่งแทบไม่มีใครเจอ — คนที่เพิ่งออกเลขเสร็จคือคนที่อยากเปิดเล่มมากที่สุด -->
    <div class="chip-row" style="margin-bottom:1rem">
      <a class="btn btn-outline btn-sm" href="/documents?direction=outgoing">📚 เปิดทะเบียนหนังสือส่ง</a>
      <a class="btn btn-outline btn-sm" href="/documents/register?direction=outgoing" target="_blank" rel="noopener">🖨️ พิมพ์เล่มทะเบียน / PDF</a>
      <a class="btn btn-outline btn-sm" href="/documents/export.xlsx?direction=outgoing">⬇️ ดาวน์โหลด Excel</a>
    </div>
    ${onBehalfCard}
    <h3>รออนุมัติ ${pending.length ? `<span class="badge badge-warning">${pending.length}</span>` : ''}</h3>
    ${pending.length ? pending.map(card).join('') : '<div class="card"><p class="text-muted" style="margin:0">ไม่มีคำขอรออนุมัติ</p></div>'}

    ${reviewed.length ? `
      <h3 style="margin-top:1.5rem">ออกเลข/ตรวจไปแล้วล่าสุด</h3>
      <div class="card"><table class="table-plain">
        ${reviewed.map((r) => `<tr id="outreq-row-${esc(r.id)}">
          <td>${r.doc_id && !r.doc_deleted_at ? rowLink(`/documents/${r.doc_id}`, esc(r.doc_title || r.title)) : esc(r.doc_title || r.title)}
            ${r.doc_deleted_at ? '<span class="badge badge-muted">หนังสือถูกลบแล้ว</span>' : ''}
            <div class="text-muted" style="font-size:.78rem">${esc(fullName(r))}${r.doc_to ? ` → ${esc(r.doc_to)}` : ''}</div></td>
          <td>${r.status === 'issued'
    ? `<span class="badge badge-success" id="outnum-${esc(r.id)}">ออกเลข ${esc(r.doc_number_display || '')}</span>
                 ${r.doc_date ? `<div class="text-muted" style="font-size:.78rem">ลงวันที่ ${esc(fmtThaiDateShort(r.doc_date))}</div>` : ''}`
    : `<span class="badge badge-muted">ไม่ออกให้</span>${r.reject_reason ? ` <span class="text-muted" style="font-size:.82rem">${esc(r.reject_reason)}</span>` : ''}`}</td>
          <td class="text-muted" style="font-size:.82rem;white-space:nowrap">${esc(fmtDate(r.reviewed_at))}${r.reviewer_first ? ` โดย ${esc(r.reviewer_first)} ${esc(r.reviewer_last)}` : ''}</td>
          <td style="white-space:nowrap">
            <!-- ค่าเดิมส่งผ่าน data- ไม่ใช่แปะเป็นสตริงกลาง onclick — เลขทะเบียนและชื่อเรื่องมีทั้ง
                 เครื่องหมายคำพูดและอักขระอื่นได้ ซึ่งทำให้ทั้ง attribute แตกแล้วสคริปต์ของหน้าตายทั้งก้อน -->
            ${r.status === 'issued' && r.doc_id && !r.doc_deleted_at
    ? `<button class="btn btn-outline btn-sm" type="button"
                  data-num="${esc(r.doc_number_display || '')}" data-date="${esc(r.doc_date || '')}"
                  data-from="${esc(r.doc_from || '')}" data-to="${esc(r.doc_to || '')}"
                  data-title="${esc(r.doc_title || '')}" data-action="${esc(r.doc_action || '')}"
                  onclick="editOutDoc('${esc(r.id)}', this)">✏️ แก้</button>` : ''}
            <button class="btn btn-outline btn-sm" type="button"
              onclick="deleteOutReq('${esc(r.id)}', ${r.status === 'issued' ? 'true' : 'false'}, this)">🗑️ ลบ</button>
          </td>
        </tr>`).join('')}
      </table></div>
      <p class="text-muted" style="font-size:.8rem;margin-top:.4rem">
        ✏️ "แก้" แก้ที่ตัวหนังสือจริง ทะเบียน/ตราประทับ/หน้าพิมพ์จะเปลี่ยนตามทั้งหมด แจ้งผู้ขอให้อัตโนมัติ
        และต้องยืนยันด้วย PIN ทุกครั้ง (ทุกการแก้ถูกบันทึกไว้ว่าใครแก้ช่องไหนจากอะไรเป็นอะไร)
        · 🗑️ "ลบ" ลบเฉพาะแถวคำขอนี้ออกจากรายการ <strong>หนังสือที่ออกเลขไปแล้วยังอยู่ในทะเบียนตามเดิม</strong>
        (ถ้าไม่ได้ใช้จริงให้กด "ยกเลิกเอกสาร" ที่ตัวหนังสือ เลขจะได้คงอยู่ในลำดับตามระเบียบ ไม่ขาดเป็นรูโหว่)
        — ใช้ PIN เหมือนกัน และเนื้อใบที่ลบถูกเก็บไว้ในประวัติการใช้งาน
      </p>` : ''}

    <script>
      // ตัวอย่างเลขต้องขยับตามที่พิมพ์ทันที — ธุรการกรอก "เลขล่าสุดในเล่มกระดาษ" แล้วต้องเห็นเดี๋ยวนั้นว่า
      // ฉบับถัดไปจะได้เลขอะไร ไม่ใช่กดบันทึกก่อนแล้วค่อยมาพบว่าผิด (เลขที่ออกไปแล้วแก้ย้อนหลังไม่ได้)
      // คิดด้วยสูตรเดียวกับฝั่งเซิร์ฟเวอร์เป๊ะ: max(ตำแหน่งตัวนับตอนนี้, เลขพื้นถ้าปีตรง) + 1
      var COUNTER_POS = ${JSON.stringify(outgoingCounterPosition())};
      var CUR_YEAR_BE = ${JSON.stringify(beYear())};
      function previewNum() {
        var prefix = document.getElementById('numPrefix').value.trim();
        var start = parseInt(document.getElementById('numStart').value.trim(), 10);
        var year = document.getElementById('numStartYear').value.trim();
        var base = COUNTER_POS;
        if (start > 0 && year === String(CUR_YEAR_BE)) base = Math.max(base, start);
        var n = base + 1;
        document.getElementById('numPreviewOut').textContent =
          prefix ? prefix + '/' + n : ('0000' + n).slice(-4) + '/' + CUR_YEAR_BE;
      }
      window.previewNum = previewNum;

      function saveNumbering(btn) {
        var start = document.getElementById('numStart').value.trim();
        var year = document.getElementById('numStartYear').value.trim();
        if (start && !year) { toast('กรอกเลขล่าสุดแล้ว ต้องระบุปี พ.ศ. ของทะเบียนเล่มนั้นด้วย', 'warning'); return; }
        send(false);
        function send(rewindCounter) {
          window.setBtnLoading(btn, 'กำลังบันทึก...');
          fetch('/outgoing-requests/numbering', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              outgoing_number_prefix: document.getElementById('numPrefix').value.trim(),
              outgoing_number_start: start,
              outgoing_number_start_year: year,
              rewindCounter: rewindCounter,
            }),
          }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){
              // ขอเลขที่ต่ำกว่าที่ออกไปแล้ว = ต้องยืนยันก่อน ไม่ใช่เงียบๆ แล้วเลขไม่ขยับตามที่กรอก
              if (!res.ok && res.d.confirmRetry) {
                window.restoreBtn(btn);
                if (confirm(res.d.confirmRetry.message)) send(true);
                return;
              }
              if (!res.ok) throw new Error(res.d.error || 'บันทึกไม่สำเร็จ');
              toast('บันทึกแล้ว — ฉบับถัดไปจะได้เลข ' + res.d.nextOutgoingNumber, 'success');
              setTimeout(function(){ location.reload(); }, 1400);
            })
            .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
        }
      }

      // ค่าของทุกช่องในใบหนึ่ง — รวมไว้ที่เดียวเพราะทั้งปุ่มอนุมัติและปุ่มบันทึกแทนครูส่งชุดเดียวกัน
      function fieldsOf(id) {
        return {
          customDocNumber: document.getElementById('num-' + id).value.trim(),
          docDate: document.getElementById('date-' + id).value,
          fromName: document.getElementById('from-' + id).value.trim(),
          correspondentName: document.getElementById('to-' + id).value.trim(),
          title: document.getElementById('title-' + id).value.trim(),
          actionNote: document.getElementById('act-' + id).value.trim(),
          departmentId: document.getElementById('dept-' + id).value,
          priority: document.getElementById('pri-' + id).value,
          secretLevel: document.getElementById('sec-' + id).value,
          isCircular: document.getElementById('circ-' + id).checked,
        };
      }

      async function issueNum(id, btn) {
        var body = fieldsOf(id);
        if (!body.title || !body.correspondentName) { toast('ช่อง "ถึง" และ "เรื่อง" เว้นว่างไม่ได้', 'warning'); return; }
        var pin = await window.askPin('ยืนยันออกเลขทะเบียนส่ง — เลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้');
        if (!pin) return;
        body.pin = pin;
        send(false);
        function send(allowDuplicate) {
          body.allowDuplicate = allowDuplicate;
          window.setBtnLoading(btn, 'กำลังออกเลข...');
          fetch('/outgoing-requests/' + id + '/issue', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
          }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){
              // เลขซ้ำไม่ใช่ข้อห้าม แต่ต้องยืนยันก่อน ไม่ใช่ปล่อยผ่านเงียบๆ จนหนังสือสองฉบับได้เลขเดียวกัน
              if (!res.ok && res.d.confirmRetry) {
                window.restoreBtn(btn);
                if (confirm(res.d.confirmRetry.message)) send(true);
                return;
              }
              if (!res.ok) throw new Error(res.d.error || 'ออกเลขไม่สำเร็จ');
              toast('ออกเลข ' + res.d.docNumberDisplay + ' แล้ว — แจ้งผู้ขอทางไลน์ให้อัตโนมัติ', 'success');
              setTimeout(function(){ location.reload(); }, 1200);
            })
            .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
        }
      }

      async function recordOnBehalf(btn) {
        var body = {
          onBehalfOfId: document.getElementById('obWho').value,
          fromName: document.getElementById('obFrom').value.trim(),
          correspondentName: document.getElementById('obTo').value.trim(),
          title: document.getElementById('obTitle').value.trim(),
          actionNote: document.getElementById('obAction').value.trim(),
          customDocNumber: document.getElementById('obNum').value.trim(),
          docDate: document.getElementById('obDate').value,
          departmentId: document.getElementById('obDept').value,
          priority: document.getElementById('obPriority').value,
          secretLevel: document.getElementById('obSecret').value,
          isCircular: document.getElementById('obCircular').checked,
        };
        if (!body.onBehalfOfId) { toast('กรุณาเลือกครูเจ้าของเรื่อง', 'warning'); return; }
        if (!body.title || !body.correspondentName) { toast('ช่อง "ถึง" และ "เรื่อง" เว้นว่างไม่ได้', 'warning'); return; }
        var pin = await window.askPin('ยืนยันบันทึกและออกเลขแทนครู');
        if (!pin) return;
        body.pin = pin;
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/outgoing-requests/on-behalf', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'บันทึกไม่สำเร็จ');
            toast('ออกเลข ' + res.d.docNumberDisplay + ' แล้ว — แจ้งครูเจ้าของเรื่องให้อัตโนมัติ', 'success');
            setTimeout(function(){ location.reload(); }, 1200);
          })
          .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
      }

      // เลขถัดไปของสองเล่มทะเบียนต่างกัน — ต้องเห็นก่อนกด เพราะเลขที่ออกไปแล้วย้ายเล่มทีหลังไม่ได้
      var NEXT_PLAIN = ${JSON.stringify(previewNextNumber('outgoing', undefined, false))};
      var NEXT_CIRCULAR = ${JSON.stringify(previewNextNumber('outgoing', undefined, true))};
      function syncNumHint(id) {
        document.getElementById('hint-' + id).textContent =
          document.getElementById('circ-' + id).checked ? NEXT_CIRCULAR : NEXT_PLAIN;
      }
      window.syncNumHint = syncNumHint;

      // แก้หลังออกเลขไปแล้ว — ถามทีละช่องด้วย prompt เพราะเป็นงานที่นานๆ ทำครั้ง (แก้คำผิด/ให้ตรงกับ
      // เล่มกระดาษ) ไม่คุ้มที่จะกางฟอร์มเต็มใบไว้ในตารางประวัติทุกแถว กด "ยกเลิก" ที่ช่องไหนก็ข้ามช่องนั้น
      async function editOutDoc(id, btn) {
        var body = {};
        var asked = false;
        for (var spec of [
          ['num', 'เลขที่', 'docNumber'],
          ['date', 'ออกวันที่ (ปี-เดือน-วัน เช่น ' + ${JSON.stringify(today)} + ')', 'docDate'],
          ['from', 'จาก', 'fromName'],
          ['to', 'ถึง', 'correspondentName'],
          ['title', 'เรื่อง', 'title'],
          ['action', 'การปฏิบัติ', 'actionNote'],
        ]) {
          var current = btn.getAttribute('data-' + spec[0]) || '';
          var next = prompt('แก้ "' + spec[1] + '" (กดยกเลิกเพื่อข้ามช่องนี้)', current);
          if (next === null) continue;
          asked = true;
          body[spec[2]] = next.trim();
        }
        if (!asked) return;
        var pin = await window.askPin('ยืนยันแก้หนังสือส่งที่ออกเลขไปแล้ว');
        if (!pin) return;
        body.pin = pin;
        send(false);
        function send(allowDuplicate) {
          body.allowDuplicate = allowDuplicate;
          window.setBtnLoading(btn, 'กำลังบันทึก...');
          fetch('/outgoing-requests/' + id + '/number', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
          }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){
              window.restoreBtn(btn);
              // เลขซ้ำไม่ใช่ข้อห้าม แต่ต้องยืนยันก่อน (เช่นแก้ให้ตรงกับเล่มกระดาษที่เคยลงซ้ำไว้)
              if (!res.ok && res.d.confirmRetry) {
                if (confirm(res.d.confirmRetry.message)) send(true);
                return;
              }
              if (!res.ok) throw new Error(res.d.error || 'แก้ไม่สำเร็จ');
              toast(res.d.changed ? 'แก้เรียบร้อย — แจ้งผู้ขอให้อัตโนมัติ' : 'ไม่มีช่องไหนเปลี่ยน', 'success');
              setTimeout(function(){ location.reload(); }, 1000);
            })
            .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
        }
      }

      async function deleteOutReq(id, issued, btn) {
        var msg = issued
          ? 'ลบแถวคำขอนี้ออกจากรายการ?\\n\\nหนังสือที่ออกเลขไปแล้วยังอยู่ในทะเบียนตามเดิม ถ้าไม่ได้ใช้จริง ให้กด "ยกเลิกเอกสาร" ที่ตัวหนังสือแทน เลขจะได้คงอยู่ในลำดับตามระเบียบ'
          : 'ลบแถวคำขอนี้ออกจากรายการ?';
        if (!confirm(msg)) return;
        // ใบที่ลบไปแล้วเรียกคืนจากรายการไม่ได้ — ด่าน PIN เดียวกับการออกเลข/แก้เลข ยืนยันว่าคนที่กดคือ
        // เจ้าของบัญชีจริง ไม่ใช่คนที่มานั่งที่เครื่องที่เปิดระบบค้างไว้
        var pin = await window.askPin('ยืนยันลบคำขอนี้ออกจากรายการ');
        if (!pin) return;
        window.setBtnLoading(btn, 'กำลังลบ...');
        fetch('/outgoing-requests/' + id + '/delete', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pin: pin }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'ลบไม่สำเร็จ');
            var row = document.getElementById('outreq-row-' + id);
            if (row) row.remove();
            toast(res.d.documentKept ? 'ลบคำขอแล้ว — หนังสือที่ออกเลขไปแล้วยังอยู่ในทะเบียน' : 'ลบคำขอแล้ว', 'success');
          })
          .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
      }

      function rejectNum(id, btn) {
        var reason = prompt('บอกเหตุผลที่ยังออกเลขให้ไม่ได้ (ผู้ขอจะได้รู้ว่าต้องแก้อะไรก่อนยื่นใหม่)');
        if (reason === null) return;
        if (!reason.trim()) { toast('ต้องระบุเหตุผล', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/outgoing-requests/' + id + '/reject', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ reason: reason.trim() }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'บันทึกไม่สำเร็จ');
            toast('แจ้งผู้ขอแล้ว', 'success');
            setTimeout(function(){ location.reload(); }, 900);
          })
          .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'คำขอเลขหนังสือส่ง', path: '/outgoing-requests', content }));
}));

/**
 * เปิด/ดาวน์โหลดร่างที่แนบมากับคำขอ
 *
 * สิทธิ์: เจ้าของคำขอ กับเจ้าหน้าที่ที่ออกเลขได้ (ธุรการ/ผู้ดูแล) เท่านั้น — ร่างหนังสือเป็นเนื้อหาของ
 * หนังสือราชการที่ยังไม่ได้ออกเลขด้วยซ้ำ ไม่ใช่ของที่ทุกคนที่ล็อกอินได้ควรเปิดดูได้
 */
router.get('/outgoing-requests/files/:fileId', requirePage((ctx) => {
  // ตอบเป็นหน้าเว็บเวลาเปิดไม่ได้ ไม่ใช่โยน error ดิบ — ผู้ใช้กดลิงก์นี้จากหน้าเว็บโดยตรง
  const deny = (status, message) => html(ctx, status, layout({
    user: ctx.user, title: 'เปิดไฟล์ไม่ได้', path: '/outgoing-requests', content: emptyState('📄', message),
  }));
  const file = getRequestDraft(ctx.params.fileId);
  if (!file) return deny(404, 'ไม่พบไฟล์ร่างนี้ — อาจถูกย้ายเข้าหนังสือหลังออกเลขไปแล้ว');
  const req = db.prepare('SELECT requester_id FROM outgoing_number_requests WHERE id = ?').get(file.request_id);
  if (!req) return deny(404, 'ไม่พบคำขอของไฟล์นี้');
  if (req.requester_id !== ctx.user.id && !canIssueOutgoingNumber(ctx.user)) {
    return deny(403, 'เปิดดูร่างหนังสือได้เฉพาะผู้ขอและเจ้าหน้าที่ธุรการเท่านั้น');
  }
  const buf = Buffer.from(file.content);
  ctx.res.writeHead(200, {
    'Content-Type': file.mime_type,
    'Content-Length': buf.length,
    // PDF/รูป เปิดดูในแท็บได้เลย ส่วน Word/Excel เบราว์เซอร์เปิดเองไม่ได้ ต้องให้ดาวน์โหลด
    'Content-Disposition': contentDispositionHeader(
      file.filename, fallbackFilename(file.mime_type), VIEWABLE_MIME.has(file.mime_type) ? 'inline' : 'attachment',
    ),
  });
  ctx.res.end(buf);
}));

// ---------------- API ----------------

/**
 * ยืนยันตัวตนก่อนแตะทะเบียนหนังสือส่ง
 *
 * ทำไมต้องมี PIN: การออกเลขและการแก้ย้อนหลังเขียนลงทะเบียนหนังสือราชการที่ส่งออกไปข้างนอกจริง
 * เลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ และเลขบนกระดาษที่ส่งออกไปแล้วตามกลับมาแก้ไม่ได้ — PIN คือสิ่งที่
 * ยืนยันว่าคนที่กดคือเจ้าของบัญชีจริง ไม่ใช่คนที่มานั่งที่เครื่องที่เปิดระบบค้างไว้ (เกณฑ์เดียวกับการ
 * ประทับตรา/ลงนามลงไฟล์ PDF) ด่านนี้เป็นเหตุผลที่เปิดให้ธุรการแก้ได้เองโดยไม่ต้องรอผู้ดูแลระบบ
 */
async function requirePin(ctx) {
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, ctx.body?.pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
}

/**
 * ตรวจบทบาทก่อน PIN เสมอ
 *
 * คนที่ไม่มีสิทธิ์ทำงานนี้ต้องได้คำตอบว่า "ไม่มีสิทธิ์" ไม่ใช่ "PIN ไม่ถูกต้อง" — ครูที่เผลอกดเส้นทางนี้
 * จะได้รู้ว่าต้องไปขอให้ธุรการทำให้ ไม่ใช่นั่งลองกรอก PIN ตัวเองซ้ำๆ แล้วคิดว่าตัวเองจำ PIN ผิด
 */
function requireRegistrar(ctx) {
  if (!canIssueOutgoingNumber(ctx.user)) {
    throw httpError(403, 'ออกเลขหนังสือส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
}

/**
 * ธุรการตั้งรูปแบบเลขทะเบียนหนังสือส่งเอง
 *
 * แยกจาก POST /admin/settings โดยตั้งใจ แทนที่จะคลายสิทธิ์ของเส้นทางนั้น — เส้นทางนั้นเขียนชื่อโรงเรียน
 * ที่ไปขึ้นบนหัวหนังสือราชการทุกใบและเวลาเตือนงานค้างของทั้งโรงเรียนด้วย ซึ่งไม่ใช่งานของธุรการ
 * ตรงนี้รับเฉพาะสามค่าของเล่มทะเบียนหนังสือส่ง ซึ่งเป็นสมุดของธุรการตามระเบียบงานสารบรรณอยู่แล้ว
 *
 * ไม่ต้องใส่ PIN ต่างจากการออกเลข/แก้เลข เพราะค่านี้ไม่ได้เขียนอะไรลงทะเบียนและไม่ได้แตะหนังสือสักฉบับ
 * — มันแค่ตั้งว่า "ฉบับต่อไปจะได้เลขอะไร" ซึ่งเห็นผลทันทีบนหน้าจอและแก้กลับได้ทันทีถ้าพิมพ์ผิด
 */
router.post('/outgoing-requests/numbering', requireApi(async (ctx) => {
  requireRegistrar(ctx);
  const start = asText(ctx.body?.outgoing_number_start);
  const startYear = asText(ctx.body?.outgoing_number_start_year);
  // เลขที่ไม่มีปีกำกับ = เลขพื้นที่ไม่ตรงกับเล่มไหนเลยแล้วเงียบหายไป (outgoingNumberFloor คืน 0
  // เมื่อปีไม่ตรง) ซึ่งอ่านจากหน้าเว็บไม่ออกว่าทำไมเลขไม่ขยับตามที่กรอก
  if (start && !startYear) {
    throw httpError(400, 'กรอกเลขหนังสือส่งล่าสุดแล้ว ต้องระบุปี พ.ศ. ของทะเบียนเล่มนั้นด้วย');
  }

  /*
   * ขอให้เลขถัดไป "ย้อนกลับ" ไปต่ำกว่าที่ตัวนับเดินไปแล้ว
   *
   * เลขพื้นตามปกติดันเลขขึ้นอย่างเดียว ไม่ดึงถอยหลัง เพราะเลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ตามระเบียบ
   * แต่ตอนเพิ่งติดตั้งระบบ เลขที่ "ออกไปแล้ว" หลายตัวคือฉบับทดลองที่ไม่เคยถูกพิมพ์ลงกระดาษจริง พอลบ
   * ฉบับพวกนั้นออกจากทะเบียนแล้ว เลขเหล่านั้นก็ไม่เคยถูกใช้จริง — ถ้าไม่เปิดทางให้ดึงกลับเลย โรงเรียน
   * จะติดอยู่กับเลขที่กระโดดข้ามไปหลายเลขตั้งแต่ฉบับแรกของจริง โดยอธิบายไม่ได้ว่าเลขที่หายไปคืออะไร
   *
   * ด่านที่กันไว้: ถ้ายังมีหนังสือ "ที่ยังอยู่ในทะเบียน" ถือเลขสูงกว่าที่ขอ จะปฏิเสธและบอกเลขที่ขวางอยู่
   * ให้ไปจัดการก่อน — ไม่งั้นฉบับถัดไปจะได้เลขซ้ำกับหนังสือที่ส่งออกไปข้างนอกแล้วจริงๆ
   */
  let rewindTo = null;
  if (start && Number(startYear) === beYear()) {
    const wanted = Number(start);
    if (wanted < outgoingCounterPosition()) {
      const blocking = highestLiveOutgoing();
      if (blocking > wanted) {
        throw httpError(409, `ดึงเลขถอยกลับไม่ได้ เพราะยังมีหนังสือในทะเบียนที่ใช้เลขถึง ${blocking} อยู่`
          + ` — ถ้าฉบับนั้นเป็นฉบับทดลอง ให้ลบออกจากทะเบียนก่อน แล้วค่อยกลับมาตั้งค่านี้อีกครั้ง`);
      }
      if (ctx.body?.rewindCounter !== true) {
        throw httpError(409, `ตอนนี้ระบบออกเลขไปถึง ${outgoingCounterPosition()} แล้ว`, {
          confirmRetry: {
            field: 'rewindCounter',
            message: `ระบบออกเลขไปถึง ${outgoingCounterPosition()} แล้ว แต่ไม่มีหนังสือฉบับไหนเหลืออยู่เกินเลข ${wanted}\n\n`
              + `ยืนยันดึงตัวนับกลับ ให้ฉบับถัดไปได้เลข ${wanted + 1} หรือไม่?\n\n`
              + 'ใช้ตอนเพิ่งติดตั้งระบบและลบฉบับทดลองออกไปแล้วเท่านั้น',
          },
        });
      }
      rewindTo = wanted;
    }
  }

  for (const key of ['outgoing_number_prefix', 'outgoing_number_start', 'outgoing_number_start_year']) {
    if (ctx.body?.[key] === undefined) continue;
    setSetting({ key, value: ctx.body[key], actorUser: ctx.user });
  }
  // เขียนตัวนับหลังบันทึกค่าตั้งค่า เพื่อให้ previewNextNumber ที่ตอบกลับไปเป็นเลขจริงหลังดึงกลับแล้ว
  if (rewindTo !== null) {
    setOutgoingCounter(rewindTo);
    audit({
      userId: ctx.user.id, action: 'outgoing_counter_rewound', tableName: 'document_number_counters',
      recordId: `${beYear()}:outgoing`, detail: { to: rewindTo, next: rewindTo + 1 },
    });
  }
  json(ctx, 200, { ok: true, nextOutgoingNumber: previewNextNumber('outgoing'), rewound: rewindTo !== null });
}));

router.post('/outgoing-requests', requireApi(async (ctx) => {
  json(ctx, 200, submitOutgoingRequest({
    title: ctx.body?.title, correspondentName: ctx.body?.correspondentName,
    fromName: ctx.body?.fromName, actionNote: ctx.body?.actionNote,
    departmentId: ctx.body?.departmentId, priority: ctx.body?.priority,
    secretLevel: ctx.body?.secretLevel, note: ctx.body?.note,
    isCircular: ctx.body?.isCircular === true, requester: ctx.user,
  }));
}));

// ค่าที่ธุรการแก้ได้ก่อนกดอนุมัติ — ไม่ส่งมา = ใช้ที่ครูกรอกไว้ (ดู issueOutgoingNumber)
const issueOverrides = (body) => ({
  customDocNumber: body?.customDocNumber, docDate: body?.docDate, isCircular: body?.isCircular,
  allowDuplicate: body?.allowDuplicate === true,
  title: body?.title, correspondentName: body?.correspondentName,
  fromName: body?.fromName, actionNote: body?.actionNote,
  departmentId: body?.departmentId, priority: body?.priority, secretLevel: body?.secretLevel,
});

router.post('/outgoing-requests/:id/issue', requireApi(async (ctx) => {
  // ตรวจสิทธิ์และ PIN ก่อนแตะอะไรทั้งนั้น — ถ้าตรวจทีหลัง เลขทะเบียนจะถูกกินไปแล้วตอนที่ตอบว่า PIN ผิด
  requireRegistrar(ctx);
  await requirePin(ctx);
  json(ctx, 200, await issueOutgoingNumber({
    requestId: ctx.params.id, ...issueOverrides(ctx.body), actorUser: ctx.user,
  }));
}));

/**
 * ธุรการลงคำขอแทนครูแล้วออกเลขให้ในคราวเดียว
 *
 * สองขั้นตอนไม่ได้อยู่ในธุรกรรมเดียวกันโดยตั้งใจ: ถ้าออกเลขล้มเหลว (เช่นฝ่ายที่เลือกถูกลบไปแล้ว)
 * ใบคำขอที่สร้างไว้จะค้างอยู่ในรายการ "รออนุมัติ" ให้ธุรการเห็นและกดอนุมัติซ้ำได้ ซึ่งดีกว่าการย้อนทิ้ง
 * ทั้งก้อนแล้วให้พิมพ์ใหม่ทั้งใบ — และดีกว่าการเอาการออกเลขไปอยู่ในธุรกรรมเดียวกัน เพราะขั้นออกเลข
 * ต้องย้ายไฟล์ร่างขึ้น Google Drive ซึ่งช้าและล้มได้จากเน็ตโรงเรียน
 */
router.post('/outgoing-requests/on-behalf', requireApi(async (ctx) => {
  requireRegistrar(ctx);
  await requirePin(ctx);
  const asked = submitOutgoingRequest({
    title: ctx.body?.title, correspondentName: ctx.body?.correspondentName,
    fromName: ctx.body?.fromName, actionNote: ctx.body?.actionNote,
    departmentId: ctx.body?.departmentId, priority: ctx.body?.priority,
    secretLevel: ctx.body?.secretLevel, note: ctx.body?.note,
    isCircular: ctx.body?.isCircular === true,
    requester: ctx.user, onBehalfOfId: ctx.body?.onBehalfOfId,
  });
  const issued = await issueOutgoingNumber({
    requestId: asked.id, ...issueOverrides(ctx.body), actorUser: ctx.user,
  });
  json(ctx, 200, { ...issued, requestId: asked.id, requesterId: asked.requesterId });
}));

router.post('/outgoing-requests/:id/reject', requireApi(async (ctx) => {
  json(ctx, 200, rejectOutgoingRequest({ requestId: ctx.params.id, reason: ctx.body?.reason, actorUser: ctx.user }));
}));

// ธุรการ/ผู้ดูแลแก้หนังสือที่ออกเลขไปแล้ว (กรอกผิด/ต้องให้ตรงกับเล่มกระดาษ) — แก้ที่ตัวหนังสือจริง
router.post('/outgoing-requests/:id/number', requireApi(async (ctx) => {
  requireRegistrar(ctx);
  await requirePin(ctx);
  json(ctx, 200, editIssuedOutgoing({
    requestId: ctx.params.id,
    docNumber: ctx.body?.docNumber, docDate: ctx.body?.docDate,
    fromName: ctx.body?.fromName, correspondentName: ctx.body?.correspondentName,
    title: ctx.body?.title, actionNote: ctx.body?.actionNote,
    allowDuplicate: ctx.body?.allowDuplicate === true, actorUser: ctx.user,
  }));
}));

// ธุรการ/ผู้ดูแลลบแถวคำขอออกจากรายการ (หนังสือที่ออกเลขไปแล้วยังอยู่ ดูเหตุผลใน service)
router.post('/outgoing-requests/:id/delete', requireApi(async (ctx) => {
  requireRegistrar(ctx);
  await requirePin(ctx);
  json(ctx, 200, deleteOutgoingRequest({ requestId: ctx.params.id, actorUser: ctx.user }));
}));

router.post('/outgoing-requests/:id/cancel', requireApi(async (ctx) => {
  json(ctx, 200, cancelOutgoingRequest({ requestId: ctx.params.id, actorUser: ctx.user }));
}));
