// หน้าขอเลขหนังสือส่งของครู และหน้าออกเลขของธุรการ
//
// ตามระเบียบงานสารบรรณ ทะเบียนหนังสือส่งเป็นสมุดของเจ้าหน้าที่ธุรการ ครูที่จะส่งหนังสือออกต้องขอเลข
// จากธุรการก่อน ไม่ใช่ดึงเลขถัดไปมาใช้เอง (ดูเหตุผลเต็มใน services/outgoingRequest.js)
import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate, emptyState, statusBadge, priorityBadge, rowLink, LABELS } from '../render.js';
import { requireApi, requirePage } from '../middleware.js';
import { previewNextNumber } from '../numbering.js';
import { db } from '../db.js';
import {
  submitOutgoingRequest, listPendingOutgoingRequests, listMyOutgoingRequests,
  recentReviewedOutgoingRequests, issueOutgoingNumber, rejectOutgoingRequest,
  cancelOutgoingRequest, canIssueOutgoingNumber, editIssuedOutgoingNumber, deleteOutgoingRequest,
} from '../services/outgoingRequest.js';

function departments() {
  return db.prepare('SELECT id, name FROM departments ORDER BY name').all();
}

const fullName = (r) => `${r.requester_prefix || ''}${r.requester_first} ${r.requester_last}`.trim();

// ---------------- ฟอร์มของครู ----------------

function requestFormCard(user) {
  const depts = departments();
  return `
    <div class="card">
      <h3 class="mt-0">🔢 ขอเลขหนังสือส่ง</h3>
      <p class="text-muted" style="margin-top:-.4rem;font-size:.85rem">
        กรอกเรื่องที่จะส่งแล้วกดขอ เจ้าหน้าที่ธุรการจะออกเลขทะเบียนส่งให้ และระบบจะแจ้งเตือนกลับมาพร้อมเลข
        — <strong>ยังไม่กินเลขทะเบียนจนกว่าธุรการจะกดออกเลขให้</strong>
      </p>
      <form id="outReqForm" class="stack">
        <div class="field">
          <label for="orTitle">เรื่อง *</label>
          <input type="text" id="orTitle" maxlength="300" required placeholder="เช่น ขออนุญาตพานักเรียนไปทัศนศึกษา" />
        </div>
        <div class="field">
          <label for="orTo">เรียน / หน่วยงานปลายทาง *</label>
          <input type="text" id="orTo" maxlength="300" required placeholder="เช่น ผู้อำนวยการสำนักงานเขตพื้นที่การศึกษา" />
        </div>
        <div class="form-grid cols-3">
          <div class="field"><label for="orDept">ฝ่ายที่รับผิดชอบ</label>
            <select id="orDept">
              ${depts.map((d) => `<option value="${esc(d.id)}"${d.id === user.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label for="orPriority">ชั้นความเร็ว</label>
            <select id="orPriority">
              ${Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select></div>
          <div class="field"><label for="orSecret">ชั้นความลับ</label>
            <select id="orSecret">
              ${Object.entries(LABELS.SECRET_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select></div>
        </div>
        <div class="field">
          <label class="check-inline" style="display:block">
            <input type="checkbox" id="orCircular" />
            <span>เป็น<strong>หนังสือเวียน</strong> — มีถึงผู้รับหลายคนโดยมีใจความอย่างเดียวกัน</span>
          </label>
          <div class="help-text">หนังสือเวียนใช้เลข “ว” และมีทะเบียนแยกเล่มตามระเบียบงานสารบรรณ (ธุรการตรวจอีกครั้งตอนออกเลข)</div>
        </div>
        <div class="field">
          <label for="orNote">ข้อความถึงธุรการ <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
          <input type="text" id="orNote" maxlength="300" placeholder="เช่น ขอใช้ส่งวันศุกร์นี้" />
        </div>
        <button class="btn btn-primary" type="submit">ขอเลขหนังสือส่ง</button>
      </form>
    </div>
    <script>
      document.getElementById('outReqForm').addEventListener('submit', function(e){
        e.preventDefault();
        var btn = e.target.querySelector('[type=submit]');
        var title = document.getElementById('orTitle').value.trim();
        var to = document.getElementById('orTo').value.trim();
        if (!title || !to) { toast('กรุณากรอกเรื่องและปลายทางให้ครบ', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังส่งคำขอ...');
        fetch('/outgoing-requests', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            title: title, correspondentName: to,
            departmentId: document.getElementById('orDept').value,
            priority: document.getElementById('orPriority').value,
            secretLevel: document.getElementById('orSecret').value,
            note: document.getElementById('orNote').value.trim(),
            isCircular: document.getElementById('orCircular').checked,
          }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'ส่งคำขอไม่สำเร็จ');
            toast(res.d.duplicate ? 'เรื่องนี้ขอไปแล้วและยังรอธุรการอยู่' : 'ส่งคำขอแล้ว รอธุรการออกเลขให้', 'success');
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
    return '<span class="badge badge-warning">รอธุรการออกเลข</span>';
  };
  return `
    <div class="card">
      <h3 class="mt-0">คำขอของฉัน</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>เรื่อง</th><th>สถานะ</th><th>เลขที่ได้</th><th>เมื่อ</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.title)}${r.is_circular ? ' <span class="badge badge-info">ว เวียน</span>' : ''}
            <div class="text-muted" style="font-size:.78rem">เรียน ${esc(r.correspondent_name)}</div>
            ${r.status === 'rejected' && r.reject_reason ? `<div class="text-muted" style="font-size:.78rem">เหตุผล: ${esc(r.reject_reason)}</div>` : ''}</td>
          <td>${statusChip(r)}</td>
          <td>${r.doc_number_display
            ? `<a href="/documents/${esc(r.doc_id)}"><strong>${esc(r.doc_number_display)}</strong></a>`
            : '<span class="text-muted">—</span>'}</td>
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

router.get('/outgoing-requests', requirePage((ctx) => {
  // ครูที่กดลิงก์นี้ (หรือกดจากการแจ้งเตือนเก่า) ต้องไปหน้าของตัวเอง ไม่ใช่เจอ 403 เปล่าๆ
  if (!canIssueOutgoingNumber(ctx.user)) return redirect(ctx, '/outgoing-requests/mine');

  const pending = listPendingOutgoingRequests();
  const reviewed = recentReviewedOutgoingRequests();
  // แก้/ลบเลขที่ออกไปแล้วเป็นการแก้ทะเบียนราชการย้อนหลัง หลังจากที่เลขถูกแจ้งออกไปให้เจ้าตัวแล้ว
  // (และอาจถูกพิมพ์ลงบนหนังสือจริงไปแล้ว) จึงจำกัดไว้ที่ผู้ดูแลระบบ ไม่ใช่ธุรการทุกคน
  const isAdmin = ctx.user.roleCodes.includes('admin');
  const card = (r) => `
    <div class="card" id="outreq-${esc(r.id)}">
      <div class="card-header">
        <h3 class="mt-0">${esc(r.title)}</h3>
        <span class="text-muted" style="font-size:.82rem">ขอเมื่อ ${esc(fmtDate(r.created_at))}</span>
      </div>
      <table class="table-plain">
        <tr><td class="text-muted" style="white-space:nowrap">ผู้ขอ</td><td>${esc(fullName(r))}
          ${r.requester_position ? `<span class="text-muted" style="font-size:.82rem"> · ${esc(r.requester_position)}</span>` : ''}</td></tr>
        <tr><td class="text-muted">เรียน</td><td>${esc(r.correspondent_name)}</td></tr>
        <tr><td class="text-muted">ฝ่าย</td><td>${esc(r.department_name || '-')}</td></tr>
        <tr><td class="text-muted">ชั้นความเร็ว/ความลับ</td><td>${priorityBadge(r.priority)} ${esc(LABELS.SECRET_LABEL[r.secret_level] || '')}</td></tr>
        ${r.note ? `<tr><td class="text-muted">ข้อความถึงธุรการ</td><td>${esc(r.note)}</td></tr>` : ''}
      </table>
      <div class="field" style="margin-top:.6rem">
        <label class="check-inline" style="display:block">
          <input type="checkbox" id="circ-${esc(r.id)}"${r.is_circular ? ' checked' : ''} onchange="syncNumHint('${esc(r.id)}')" />
          <span>ออกเป็น<strong>หนังสือเวียน</strong> (เลข “ว” ทะเบียนแยกเล่ม)</span>
        </label>
        <div class="help-text">${r.is_circular ? 'ผู้ขอระบุมาว่าเป็นหนังสือเวียน — ' : ''}เลขถัดไปจะเป็น
          <strong id="hint-${esc(r.id)}">${esc(previewNextNumber('outgoing', undefined, Boolean(r.is_circular)))}</strong></div>
      </div>
      <div class="field" style="margin-top:.6rem">
        <label for="num-${esc(r.id)}">เลขทะเบียนส่งที่ <span class="text-muted" style="font-weight:400">(เว้นว่าง = ให้ระบบออกเลขถัดไปให้)</span></label>
        <input type="text" id="num-${esc(r.id)}" maxlength="60" placeholder="เว้นว่างให้ระบบออกเลขอัตโนมัติ" style="max-width:280px" />
        <div class="help-text">พิมพ์เองได้ถ้าโรงเรียนใช้รูปแบบตามระเบียบ เช่น <code>ศธ 04xxx.yy/45</code> — ระบบจะใช้เลขนี้ทุกที่ (ทะเบียน/ตราประทับ/หน้าพิมพ์)</div>
      </div>
      <div class="chip-row">
        <button class="btn btn-success" type="button" onclick="issueNum('${esc(r.id)}', this)">✅ ออกเลขให้</button>
        <button class="btn btn-outline" type="button" onclick="rejectNum('${esc(r.id)}', this)">✖️ ยังออกให้ไม่ได้</button>
      </div>
    </div>`;

  const content = `
    <h2>🔢 คำขอเลขหนังสือส่ง</h2>
    <p class="text-muted" style="margin-top:-.5rem">
      ครูขอเลขมา คุณเป็นผู้ออกเลขทะเบียนส่งให้ — เมื่อกดออกเลข ระบบจะสร้างหนังสือส่งให้อัตโนมัติ
      โดยมีครูผู้ขอเป็นผู้บันทึกเอกสาร และแจ้งเลขกลับไปให้เจ้าตัวทันที
    </p>
    <h3>รอออกเลข ${pending.length ? `<span class="badge badge-warning">${pending.length}</span>` : ''}</h3>
    ${pending.length ? pending.map(card).join('') : '<div class="card"><p class="text-muted" style="margin:0">ไม่มีคำขอรอออกเลข</p></div>'}

    ${reviewed.length ? `
      <h3 style="margin-top:1.5rem">ออกเลข/ตรวจไปแล้วล่าสุด</h3>
      <div class="card"><table class="table-plain">
        ${reviewed.map((r) => `<tr id="outreq-row-${esc(r.id)}">
          <td>${r.doc_id ? rowLink(`/documents/${r.doc_id}`, esc(r.title)) : esc(r.title)}
            <div class="text-muted" style="font-size:.78rem">${esc(fullName(r))}</div></td>
          <td>${r.status === 'issued'
            ? `<span class="badge badge-success" id="outnum-${esc(r.id)}">ออกเลข ${esc(r.doc_number_display || '')}</span>`
            : `<span class="badge badge-muted">ไม่ออกให้</span>${r.reject_reason ? ` <span class="text-muted" style="font-size:.82rem">${esc(r.reject_reason)}</span>` : ''}`}</td>
          <td class="text-muted" style="font-size:.82rem;white-space:nowrap">${esc(fmtDate(r.reviewed_at))}${r.reviewer_first ? ` โดย ${esc(r.reviewer_first)} ${esc(r.reviewer_last)}` : ''}</td>
          ${isAdmin ? `<td style="white-space:nowrap">
            <!-- เลขเดิมส่งผ่าน data- ไม่ใช่แปะเป็นสตริงกลาง onclick — เลขทะเบียนมีทั้งเครื่องหมาย
                 คำพูดและอักขระอื่นได้ ซึ่งทำให้ทั้ง attribute แตกแล้วสคริปต์ของหน้าตายทั้งก้อน -->
            ${r.status === 'issued' && r.doc_id
              ? `<button class="btn btn-outline btn-sm" type="button" data-num="${esc(r.doc_number_display || '')}"
                  onclick="editOutNum('${esc(r.id)}', this)">✏️ แก้เลข</button>` : ''}
            <button class="btn btn-outline btn-sm" type="button"
              onclick="deleteOutReq('${esc(r.id)}', ${r.status === 'issued' ? 'true' : 'false'}, this)">🗑️ ลบ</button>
          </td>` : ''}
        </tr>`).join('')}
      </table></div>
      ${isAdmin ? `<p class="text-muted" style="font-size:.8rem;margin-top:.4rem">
        🛠️ ผู้ดูแลระบบ: "แก้เลข" แก้ที่ตัวหนังสือจริง ทะเบียน/ตราประทับ/หน้าพิมพ์จะเปลี่ยนตามทั้งหมด
        และแจ้งผู้ขอให้อัตโนมัติ · "ลบ" ลบเฉพาะแถวคำขอนี้ หนังสือที่ออกเลขไปแล้วยังอยู่ในทะเบียนตามเดิม
        (ถ้าไม่ได้ใช้จริงให้กด "ยกเลิกเอกสาร" ที่ตัวหนังสือ เลขจะได้คงอยู่ในลำดับตามระเบียบ)
      </p>` : ''}` : ''}

    <script>
      function issueNum(id, btn) {
        if (!confirm('ยืนยันออกเลขทะเบียนส่งให้คำขอนี้?\\n\\nเลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ตามระเบียบงานสารบรรณ')) return;
        window.setBtnLoading(btn, 'กำลังออกเลข...');
        fetch('/outgoing-requests/' + id + '/issue', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            customDocNumber: document.getElementById('num-' + id).value.trim(),
            isCircular: document.getElementById('circ-' + id).checked,
          }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'ออกเลขไม่สำเร็จ');
            toast('ออกเลข ' + res.d.docNumberDisplay + ' แล้ว — แจ้งผู้ขอให้อัตโนมัติ', 'success');
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

      function editOutNum(id, btn) {
        var num = prompt('แก้เลขหนังสือส่งของคำขอนี้ (จะเปลี่ยนที่ตัวหนังสือจริง และแจ้งผู้ขอให้อัตโนมัติ)',
          btn.getAttribute('data-num') || '');
        if (num === null) return;
        num = num.trim();
        if (!num) { toast('เลขหนังสือส่งเว้นว่างไม่ได้', 'warning'); return; }
        send(num, false);
        function send(value, allowDuplicate) {
          window.setBtnLoading(btn, 'กำลังบันทึก...');
          fetch('/outgoing-requests/' + id + '/number', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ docNumber: value, allowDuplicate: allowDuplicate }),
          }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){
              window.restoreBtn(btn);
              // เลขซ้ำไม่ใช่ข้อห้าม แต่ต้องยืนยันก่อน (เช่นแก้ให้ตรงกับเล่มกระดาษที่เคยลงซ้ำไว้)
              if (!res.ok && res.d.confirmRetry) {
                if (confirm(res.d.confirmRetry.message)) send(value, true);
                return;
              }
              if (!res.ok) throw new Error(res.d.error || 'แก้เลขไม่สำเร็จ');
              toast('แก้เลขเป็น ' + res.d.docNumberDisplay + ' แล้ว — แจ้งผู้ขอให้อัตโนมัติ', 'success');
              setTimeout(function(){ location.reload(); }, 1000);
            })
            .catch(function(e){ window.restoreBtn(btn); toast(e.message, 'danger'); });
        }
      }

      function deleteOutReq(id, issued, btn) {
        var msg = issued
          ? 'ลบแถวคำขอนี้ออกจากรายการ?\\n\\nหนังสือที่ออกเลขไปแล้วยังอยู่ในทะเบียนตามเดิม ถ้าไม่ได้ใช้จริง ให้กด "ยกเลิกเอกสาร" ที่ตัวหนังสือแทน เลขจะได้คงอยู่ในลำดับตามระเบียบ'
          : 'ลบแถวคำขอนี้ออกจากรายการ?';
        if (!confirm(msg)) return;
        window.setBtnLoading(btn, 'กำลังลบ...');
        fetch('/outgoing-requests/' + id + '/delete', { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
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

// ---------------- API ----------------

router.post('/outgoing-requests', requireApi(async (ctx) => {
  json(ctx, 200, submitOutgoingRequest({
    title: ctx.body?.title, correspondentName: ctx.body?.correspondentName,
    departmentId: ctx.body?.departmentId, priority: ctx.body?.priority,
    secretLevel: ctx.body?.secretLevel, note: ctx.body?.note,
    isCircular: ctx.body?.isCircular === true, requester: ctx.user,
  }));
}));

router.post('/outgoing-requests/:id/issue', requireApi(async (ctx) => {
  json(ctx, 200, issueOutgoingNumber({
    requestId: ctx.params.id, customDocNumber: ctx.body?.customDocNumber,
    isCircular: ctx.body?.isCircular, actorUser: ctx.user,
  }));
}));

router.post('/outgoing-requests/:id/reject', requireApi(async (ctx) => {
  json(ctx, 200, rejectOutgoingRequest({ requestId: ctx.params.id, reason: ctx.body?.reason, actorUser: ctx.user }));
}));

// ผู้ดูแลระบบแก้เลขที่ออกไปแล้ว (พิมพ์ผิด/ต้องให้ตรงกับเล่มกระดาษ) — แก้ที่ตัวหนังสือจริง
router.post('/outgoing-requests/:id/number', requireApi(async (ctx) => {
  json(ctx, 200, editIssuedOutgoingNumber({
    requestId: ctx.params.id, docNumber: ctx.body?.docNumber,
    allowDuplicate: ctx.body?.allowDuplicate === true, actorUser: ctx.user,
  }));
}));

// ผู้ดูแลระบบลบแถวคำขอออกจากรายการ (หนังสือที่ออกเลขไปแล้วยังอยู่ ดูเหตุผลใน service)
router.post('/outgoing-requests/:id/delete', requireApi(async (ctx) => {
  json(ctx, 200, deleteOutgoingRequest({ requestId: ctx.params.id, actorUser: ctx.user }));
}));

router.post('/outgoing-requests/:id/cancel', requireApi(async (ctx) => {
  json(ctx, 200, cancelOutgoingRequest({ requestId: ctx.params.id, actorUser: ctx.user }));
}));
