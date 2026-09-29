// ทะเบียนคำสั่งและประกาศของโรงเรียน (ดูเหตุผลทั้งหมดใน services/schoolOrder.js)
import { router, html, json, contentDispositionHeader } from '../router.js';
import { layout, esc, emptyState, fmtThaiDateShort, fmtThaiDateLong, fmtAgo, fmtCount, rowAttrs, rowLink, schoolName } from '../render.js';
import { requireApi, requirePage } from '../middleware.js';
import { db, beYear, todayInBangkok, audit } from '../db.js';
import { ACCEPT_ATTR, ALLOWED_LABEL, VIEWABLE_MIME, attachMimeScript, fallbackFilename } from '../services/attachments.js';
import { orderShareText, lineShareBlock } from '../services/line.js';
import {
  ORDER_KINDS, kindOf, kindNoun, canManageOrders, MAX_ORDER_RECIPIENTS,
  createSchoolOrder, updateSchoolOrder, deleteSchoolOrder, addOrderFile, addOrderRecipients,
  getSchoolOrder, orderFiles, getOrderFile, orderRecipients, markOrderOpened,
  listSchoolOrders, countSchoolOrders, listOrderYears, previewOrderNumber, auditOrderRegister,
} from '../services/schoolOrder.js';

const PAGE_SIZE = 50;
// เพดานแถวของหน้าพิมพ์ — เหตุผลเดียวกับทะเบียนหนังสือ: กระดาษที่หยิบไปเก็บเข้าแฟ้มต้องไม่ถูกตัด
// เงียบๆ โรงเรียนหนึ่งออกคำสั่งไม่ถึงพันฉบับต่อปี ค่านี้จึงครอบคลุมทั้งเล่มของปีหนึ่งเสมอ
const MAX_PRINT_ROWS = 1000;

const fmtKb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} ไบต์`);
const personName = (prefix, first, last) => `${prefix || ''}${first || ''} ${last || ''}`.trim();

function activeUsers() {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) AS role_names FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id ORDER BY u.first_name
  `).all();
}

/** ตัวเลือกผู้ลงนาม — ผู้บริหารขึ้นก่อนเพราะคนลงนามคำสั่งคือ ผอ. เกือบทุกฉบับ */
function signerOptions(selectedId) {
  const rows = activeUsers();
  const rank = (u) => (/ผู้อำนวยการ/.test(u.position || '') ? 0 : /รองผู้อำนวยการ/.test(u.position || '') ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || String(a.first_name).localeCompare(String(b.first_name), 'th'))
    .map((u) => `<option value="${esc(u.id)}"${u.id === selectedId ? ' selected' : ''}>${esc(personName(u.prefix, u.first_name, u.last_name))} — ${esc(u.position || u.role_names || '')}</option>`)
    .join('');
}

/** รายชื่อผู้ที่ต้องทราบแบบติ๊กได้หลายคน — คลาส `orderRecip` ถูกใช้ทั้งฟอร์มสร้างและฟอร์มเพิ่มภายหลัง */
function recipientCheckboxes(exclude = new Set()) {
  return activeUsers()
    .filter((u) => !exclude.has(u.id))
    .map((u) => `<label class="check-inline assignee-row">
      <input type="checkbox" class="orderRecip" value="${esc(u.id)}" />
      <span>${esc(personName(u.prefix, u.first_name, u.last_name))}
        <span class="text-muted" style="font-size:.82rem">— ${esc(u.position || u.role_names || '')}</span></span>
    </label>`).join('');
}

// ---------------- ทะเบียน ----------------

function kindTabs(activeKind, params) {
  return ORDER_KINDS.map((k) => {
    const qs = new URLSearchParams({ ...params, kind: k.code });
    return `<a class="btn btn-sm ${k.code === activeKind ? 'btn-primary' : 'btn-outline'}" href="/orders?${qs}">${k.icon} ${esc(k.label)}</a>`;
  }).join('');
}

router.get('/orders', requirePage((ctx) => {
  const kind = kindOf(ctx.query.kind)?.code || 'order';
  const k = kindOf(kind);
  const year = ctx.query.year ? Number(ctx.query.year) : null;
  const q = String(ctx.query.q || '').trim();
  const mine = ctx.query.mine === '1';
  const filters = { kind, year, q, mine, userId: ctx.user.id };

  const total = countSchoolOrders(filters);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(ctx.query.page) || 1)));
  const rows = listSchoolOrders(filters, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const years = listOrderYears(kind);
  const manage = canManageOrders(ctx.user);

  // เลขขาด/เลขซ้ำของปีที่กำลังดู — ฟ้องที่หน้าทะเบียนเลย ไม่ใช่รอให้ไปกดดูอีกหน้า เพราะคนที่ต้องรู้
  // คือคนที่กำลังจะออกเลขฉบับถัดไปอยู่ตรงนี้
  const auditYear = year || beYear();
  const reg = auditOrderRegister({ kind, year: auditYear });

  const rowsHtml = rows.map((o) => `
    <tr ${rowAttrs(`/orders/${o.id}`)}>
      <td class="cell-head" style="white-space:nowrap">${rowLink(`/orders/${o.id}`, `<strong style="color:var(--primary)">${esc(o.number_display)}</strong>`)}</td>
      <td class="cell-sub">${rowLink(`/orders/${o.id}`, esc(o.subject))}</td>
      <td data-label="ลงวันที่" style="white-space:nowrap">${o.signed_date ? esc(fmtThaiDateShort(o.signed_date)) : '<span class="text-muted">—</span>'}</td>
      <td data-label="ผู้ลงนาม" style="white-space:nowrap">${o.signer_first ? esc(personName(o.signer_prefix, o.signer_first, o.signer_last)) : '<span class="text-muted">—</span>'}</td>
      <td class="clip-col">${o.file_count ? `📎 ${o.file_count}` : ''}</td>
      <td data-label="ผู้ที่ต้องทราบ" style="white-space:nowrap">${o.recipient_count
        ? `${o.opened_count}/${o.recipient_count} อ่านแล้ว`
        : '<span class="text-muted">—</span>'}</td>
    </tr>`).join('');

  const pager = totalPages > 1 ? `<div class="chip-row" style="margin-top:.6rem">
    ${Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
    const qs = new URLSearchParams({ kind, ...(year ? { year: String(year) } : {}), ...(q ? { q } : {}), ...(mine ? { mine: '1' } : {}), page: String(p) });
    return `<a class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}" href="/orders?${qs}">${p}</a>`;
  }).join('')}
  </div>` : '';

  // ฟอร์มออกเลขยาวมาก (เรื่อง/วันที่/ผู้ลงนาม/หมายเหตุ/ไฟล์/ผู้ที่ต้องทราบ) บนมือถือมันดันทะเบียน
  // ลงไปพ้นจอเกือบสองจอ ทั้งที่คนส่วนใหญ่เปิดหน้านี้มา "ค้นหาคำสั่งเก่า" ไม่ใช่มาออกเลขใหม่
  const createCard = !manage ? '' : `
    <details class="phone-tools card" open>
      <summary>${k.icon} ออกเลข${esc(k.label)}ฉบับใหม่</summary>
      <div class="phone-tools-body">
      <h3 class="mt-0 hide-on-phone">${k.icon} ออกเลข${esc(k.label)}ฉบับใหม่</h3>
      <p class="text-muted" style="margin-top:-.4rem;font-size:.85rem">
        เลขถัดไปที่จะได้คือ <strong id="nextOrderNo">${esc(previewOrderNumber(kind))}</strong>
        — เล่มทะเบียน${esc(k.noun)}นับแยกจากทะเบียนหนังสือส่ง และเริ่มเลข 1 ใหม่ทุกปีปฏิทิน
      </p>
      <form id="orderForm" class="stack">
        <div class="field">
          <label for="ordSubject">เรื่อง *</label>
          <input type="text" id="ordSubject" maxlength="500" required
            placeholder="เช่น แต่งตั้งคณะกรรมการดำเนินงานกิจกรรมวันเด็กแห่งชาติ ประจำปี 2569" />
        </div>
        <div class="form-grid cols-2">
          <div class="field"><label for="ordSignedDate">วันที่ลงนาม</label>
            <input type="date" id="ordSignedDate" value="${esc(todayInBangkok())}" /></div>
          <div class="field"><label for="ordSigner">ผู้ลงนาม</label>
            <select id="ordSigner"><option value="">— ยังไม่ระบุ —</option>${signerOptions()}</select></div>
        </div>
        <div class="field">
          <label for="ordNote">หมายเหตุ <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
          <input type="text" id="ordNote" maxlength="1000" placeholder="เช่น ยกเลิกคำสั่งที่ 12/2569" />
        </div>
        <div class="field">
          <label for="ordFile">แนบไฟล์${esc(k.noun)}ที่ลงนามแล้ว <span class="text-muted" style="font-weight:400">(เว้นว่างได้ แนบภายหลังได้)</span></label>
          <input type="file" id="ordFile" accept="${ACCEPT_ATTR}" onchange="attachFilePreview(this, 'ordFileName')" />
          <div class="help-text" id="ordFileName"></div>
          <div class="help-text">รับ ${esc(ALLOWED_LABEL)} ขนาดไม่เกิน 5MB</div>
        </div>
        <!-- จุดสำคัญของหน้านี้: คำสั่งที่ไม่มีใครรู้ว่าตัวเองถูกแต่งตั้ง เท่ากับไม่มีคำสั่ง -->
        <details class="field">
          <summary style="cursor:pointer;font-weight:600">👥 ผู้ที่ต้องทราบ / ผู้ได้รับแต่งตั้ง (เลือกได้หลายคน)</summary>
          <div class="help-text" style="margin:.4rem 0">
            คนที่เลือกไว้จะได้รับ<strong>แจ้งเตือนถึงตัว</strong> (และเข้าไลน์ถ้าเชื่อมบัญชีไว้)
            และระบบจะบอกได้ว่าใครเปิดอ่านแล้วหรือยัง — ไม่ใช่แค่ติดบอร์ดไว้
          </div>
          <div class="chip-row" style="margin-bottom:.4rem">
            <button class="btn btn-outline btn-sm" type="button" onclick="pickAllRecips(true)">เลือกทุกคน</button>
            <button class="btn btn-outline btn-sm" type="button" onclick="pickAllRecips(false)">ล้างที่เลือก</button>
            <span class="text-muted" id="recipCount" style="font-size:.85rem">เลือกไว้ 0 คน</span>
          </div>
          <div class="assignee-pick">${recipientCheckboxes()}</div>
        </details>
        <button class="btn btn-primary" type="submit">ออกเลข${esc(k.noun)}</button>
      </form>
      </div>
    </details>
    ${attachMimeScript()}
    <script>
      window.pickAllRecips = function (on) {
        document.querySelectorAll('.orderRecip').forEach(function (x) { x.checked = on; });
        refreshRecipCount();
      };
      function refreshRecipCount() {
        var n = document.querySelectorAll('.orderRecip:checked').length;
        var el = document.getElementById('recipCount');
        if (el) el.textContent = 'เลือกไว้ ' + n + ' คน';
      }
      document.querySelectorAll('.orderRecip').forEach(function (x) { x.addEventListener('change', refreshRecipCount); });
      document.getElementById('orderForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = e.target.querySelector('[type=submit]');
        var subject = document.getElementById('ordSubject').value.trim();
        if (!subject) { window.toast('กรุณากรอกเรื่อง', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังออกเลข...');
        var body = {
          kind: ${JSON.stringify(kind)},
          subject: subject,
          signedDate: document.getElementById('ordSignedDate').value || null,
          signerId: document.getElementById('ordSigner').value || null,
          note: document.getElementById('ordNote').value.trim(),
          recipientIds: [].map.call(document.querySelectorAll('.orderRecip:checked'), function (x) { return x.value; })
        };
        var file = document.getElementById('ordFile').files[0];
        if (file) {
          if (file.size > 5 * 1024 * 1024) {
            window.restoreBtn(btn);
            window.toast('ไฟล์ต้องไม่เกิน 5MB', 'warning');
            return;
          }
          try {
            body.file = {
              fileName: file.name,
              fileType: window.attachMime(file.name, file.type),
              fileDataBase64: await window.fileToBase64(file)
            };
          } catch (err) {
            window.restoreBtn(btn);
            window.toast('อ่านไฟล์ที่แนบไม่สำเร็จ กรุณาลองใหม่', 'danger');
            return;
          }
        }
        window.postJson('/orders', body).then(function (d) {
          if (d === null) { window.restoreBtn(btn); return; }
          window.toast('ออกเลขเรียบร้อย — ' + d.noun + 'ที่ ' + d.numberDisplay, 'success');
          setTimeout(function () { location.href = '/orders/' + d.id; }, 900);
        }).catch(function (err) { window.toast(err.message, 'danger'); window.restoreBtn(btn); });
      });
    </script>`;

  const regWarn = reg.complete ? '' : `
    <div class="alert alert-warning" id="orderRegisterAudit">
      <strong>⚠️ เล่มทะเบียน${esc(k.noun)} ปี ${auditYear} ยังไม่เรียบร้อย</strong>
      ${reg.missing.length ? `<div style="margin-top:.3rem">เลขที่ไม่มีอยู่ในทะเบียน ${reg.missing.length} เลข:
        ${reg.missing.slice(0, 20).map((m) => `<span class="badge ${m.reason === 'deleted' ? 'badge-info' : 'badge-danger'}"
          title="${esc(m.reason === 'deleted' ? `ลบโดย ${m.deletedByName || 'ไม่ทราบ'} — ${m.deleteReason}` : 'ไม่พบร่องรอยว่าเคยมีฉบับนี้ในระบบ')}">${m.number}</span>`).join(' ')}
        ${reg.missing.length > 20 ? ` และอีก ${reg.missing.length - 20} เลข` : ''}</div>` : ''}
      ${reg.duplicates.length ? `<div style="margin-top:.3rem">เลขซ้ำ: ${reg.duplicates.map((d) => `${d.number} (${d.count} ฉบับ)`).join(', ')}</div>` : ''}
      <div class="help-text" style="margin-top:.3rem">
        เลขที่มีป้ายสีฟ้าคือเลขที่ถูกลบและอธิบายได้ (ชี้ที่ป้ายเพื่อดูเหตุผล) ส่วนป้ายสีแดงคือเลขที่หายไป
        โดยไม่มีร่องรอยในระบบ — มักเกิดจากการเขียนเลขในสมุดเล่มเก่าแล้วยังไม่บันทึกเข้าระบบ
      </div>
    </div>`;

  const yearChips = years.length > 1 ? `<div class="chip-row" style="margin-top:.5rem">
    <a class="btn btn-sm ${!year ? 'btn-primary' : 'btn-outline'}" href="/orders?kind=${kind}">ทุกปี</a>
    ${years.map((y) => `<a class="btn btn-sm ${year === y ? 'btn-primary' : 'btn-outline'}" href="/orders?kind=${kind}&year=${y}">ปี ${y}</a>`).join('')}
  </div>` : '';

  const printQs = new URLSearchParams({ kind, ...(year ? { year: String(year) } : {}), ...(q ? { q } : {}) });
  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">${k.icon} ทะเบียน${esc(k.label)}</h2>
        <p class="text-muted" style="margin-top:-.6rem">
          ${fmtCount(total)} ฉบับ${year ? ` ในปี ${year}` : ''}${q ? ` ที่ตรงกับ "${esc(q)}"` : ''}${mine ? ' · เฉพาะที่มีชื่อท่าน' : ''}
        </p>
      </div>
      <div class="chip-row">
        <a class="btn btn-outline btn-sm" href="/orders/register?${printQs}" target="_blank" rel="noopener">🖨️ พิมพ์ทะเบียน</a>
      </div>
    </div>
    <div class="card">
      <div class="chip-row">${kindTabs(kind, { ...(year ? { year: String(year) } : {}) })}</div>
      ${yearChips}
      <form method="get" action="/orders" class="flex gap-2 flex-wrap" style="margin-top:.6rem">
        <input type="hidden" name="kind" value="${esc(kind)}" />
        ${year ? `<input type="hidden" name="year" value="${year}" />` : ''}
        <input type="search" name="q" value="${esc(q)}" placeholder="ค้นจากเรื่อง หรือเลขที่" style="max-width:320px" />
        <label class="check-inline"><input type="checkbox" name="mine" value="1" ${mine ? 'checked' : ''} />
          <span>เฉพาะที่มีชื่อท่าน</span></label>
        <button class="btn btn-outline btn-sm" type="submit">ค้นหา</button>
        ${q || mine ? `<a class="btn btn-outline btn-sm" href="/orders?kind=${kind}">ล้างตัวกรอง</a>` : ''}
      </form>
    </div>
    ${regWarn}
    ${createCard}
    <div class="card">
      ${rows.length ? `<div class="table-wrap table-cards"><table>
        <thead><tr><th>ที่</th><th>เรื่อง</th><th>ลงวันที่</th><th>ผู้ลงนาม</th><th class="clip-col" title="ไฟล์แนบ">📎</th><th>ผู้ที่ต้องทราบ</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>${pager}`
    : emptyState(k.icon, q || mine || year
      ? 'ไม่พบรายการที่ตรงกับเงื่อนไขที่เลือก'
      : `ยังไม่มี${k.label}ในระบบ${manage ? ' — ออกเลขฉบับแรกได้จากแบบฟอร์มด้านบน' : ''}`)}
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: `ทะเบียน${k.label}`, path: '/orders', content }));
}));

// ต้องลงทะเบียนก่อน /orders/:id ไม่งั้น "register" จะถูกจับเป็น id
router.get('/orders/register', requirePage((ctx) => {
  const kind = kindOf(ctx.query.kind)?.code || 'order';
  const k = kindOf(kind);
  const year = ctx.query.year ? Number(ctx.query.year) : null;
  const q = String(ctx.query.q || '').trim();
  const filters = { kind, year, q, userId: ctx.user.id };
  const total = countSchoolOrders(filters);
  const truncated = total > MAX_PRINT_ROWS;
  const rows = listSchoolOrders(filters, { limit: MAX_PRINT_ROWS, offset: 0 })
    // ทะเบียนบนกระดาษเรียงจากเลขน้อยไปมาก ตรงกับสมุดทะเบียนของจริง (หน้าเว็บเรียงล่าสุดก่อนเพื่อใช้งาน)
    .slice().reverse();

  audit({
    userId: ctx.user.id, action: 'school_order_register_printed',
    detail: { kind, year: year || null, rows: rows.length }, ip: ctx.ip,
  });

  const body = `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ทะเบียน${esc(k.label)}</title>
<style>
  /* แนวตั้งพอ เพราะทะเบียนคำสั่งมีแค่ 6 คอลัมน์ (ต่างจากทะเบียนหนังสือที่มี 12 คอลัมน์จนต้องแนวนอน) */
  @page { size: A4 portrait; margin: 15mm 12mm; }
  body { font-family: "Sarabun", "TH SarabunPSK", "Noto Sans Thai", sans-serif; font-size: 12px; line-height: 1.5; color: #000; margin: 0; padding: 1rem 0; background: #d9d9d9; }
  /* กระดาษบนจอเท่ากระดาษจริง: A4 แนวตั้ง 210 × 297 มม. และ padding เท่า @page margin เป๊ะ
     ที่เห็นบนจอจึงเท่ากับที่พิมพ์ออกมา (เหตุผลเดียวกับหน้าพิมพ์ทะเบียนหนังสือ) */
  .sheet {
    width: 210mm; min-height: 297mm; box-sizing: border-box; padding: 15mm 12mm;
    margin: 0 auto; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.3);
    transform-origin: top left;
  }
  .sheet-head { text-align: center; margin-bottom: .8rem; }
  .sheet-head h1 { font-size: 17px; margin: 0 0 .15rem; }
  .sheet-head .sub { font-size: 13px; }
  .sheet-head .meta { font-size: 11px; color: #333; margin-top: .3rem; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 3px 5px; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #eee; font-weight: 700; text-align: center; font-size: 11px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  td.num { text-align: center; }
  .sign { margin-top: 1.6rem; display: flex; justify-content: flex-end; }
  .sign .box { text-align: center; font-size: 12px; min-width: 240px; }
  .sign .line { margin-top: 2.2rem; }
  .toolbar { margin: 0 auto 1rem; padding: 0 1rem; display: flex; gap: .5rem; flex-wrap: wrap; max-width: 210mm; }
  .toolbar button, .toolbar a {
    font: inherit; padding: .45rem .9rem; border-radius: 8px; border: 1px solid #888;
    background: #f3f3f3; color: #000; cursor: pointer; text-decoration: none;
  }
  .paper-note { align-self: center; font-size: 12px; color: #333; }
  .empty { padding: 2rem; text-align: center; color: #555; }
  .cut-warn { border: 2px solid #000; padding: .6rem .8rem; margin-bottom: 1rem; font-size: 13px; font-weight: 700; text-align: center; }
  @media print {
    .toolbar { display: none; }
    body { padding: 0; background: #fff; }
    .sheet-wrap { height: auto !important; }
    .sheet { width: auto; min-height: 0; padding: 0; margin: 0; box-shadow: none; transform: none !important; }
  }
</style></head>
<body>
  <div class="toolbar">
    <button type="button" onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
    <a href="/orders?kind=${esc(kind)}">← กลับทะเบียนในระบบ</a>
    <span class="paper-note">📄 ขนาดเท่ากระดาษจริง A4 แนวตั้ง (21 × 29.7 ซม.)</span>
  </div>
  <div class="sheet-wrap" id="sheetWrap"><div class="sheet" id="sheet">
  <div class="sheet-head">
    <h1>ทะเบียน${esc(k.label)}</h1>
    <div class="sub">${esc(schoolName())}</div>
    <div class="meta">
      ${truncated ? `แสดง ${fmtCount(rows.length)} จากทั้งหมด ${fmtCount(total)} ฉบับ` : `รวม ${fmtCount(rows.length)} ฉบับ`}
      ${year ? ` · ประจำปี ${year}` : ''} · พิมพ์เมื่อ ${esc(fmtThaiDateLong(todayInBangkok()))}
      ${q ? ` · เงื่อนไข: คำค้น "${esc(q)}"` : ''}
    </div>
  </div>
  ${truncated ? `<div class="cut-warn">
    ⚠️ ทะเบียนนี้ยังไม่ครบ — แสดงเพียง ${fmtCount(MAX_PRINT_ROWS)} ฉบับแรกจากทั้งหมด ${fmtCount(total)} ฉบับ<br/>
    กรุณาเลือกปีที่ต้องการที่หน้าทะเบียนในระบบ แล้วสั่งพิมพ์ทีละเล่ม
  </div>` : ''}
  ${rows.length ? `<table>
    <colgroup><col style="width:7%" /><col style="width:12%" /><col style="width:45%" /><col style="width:13%" /><col style="width:15%" /><col style="width:8%" /></colgroup>
    <thead><tr><th>ลำดับ</th><th>${esc(k.noun)}ที่</th><th>เรื่อง</th><th>ลงวันที่</th><th>ผู้ลงนาม</th><th>ไฟล์</th></tr></thead>
    <tbody>${rows.map((o, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="num">${esc(o.number_display)}</td>
      <td>${esc(o.subject)}</td>
      <td class="num">${esc(o.signed_date ? fmtThaiDateShort(o.signed_date) : '')}</td>
      <td>${esc(o.signer_first ? personName(o.signer_prefix, o.signer_first, o.signer_last) : '')}</td>
      <td class="num">${o.file_count ? '✓' : ''}</td>
    </tr>`).join('')}</tbody>
  </table>
  <div class="sign"><div class="box">
    <div class="line">ลงชื่อ ................................................ ผู้จัดทำ</div>
    <div>( ................................................ )</div>
    <div>ตำแหน่ง ................................................</div>
  </div></div>`
    : '<div class="empty">ไม่มีรายการตามเงื่อนไขที่เลือก</div>'}
  </div></div>
  <script>
    // กระดาษกว้าง 210 มม. (ราว 794 จุดภาพ) ยังกว้างกว่าจอมือถือ จึงย่อทั้งใบให้พอดีจอเฉพาะบนจอ
    // (เวลาพิมพ์ CSS สั่ง transform: none !important อยู่แล้ว ไฟล์ที่พิมพ์ออกมาจึงเต็มขนาดเสมอ)
    function fitSheetToScreen() {
      var sheet = document.getElementById('sheet');
      var wrap = document.getElementById('sheetWrap');
      if (!sheet || !wrap) return;
      sheet.style.transform = 'none';
      wrap.style.height = '';
      var full = sheet.offsetWidth;
      if (!full) return;
      for (var pass = 0; pass < 3; pass++) {
        var avail = wrap.clientWidth;
        if (!avail || avail >= full) { sheet.style.transform = 'none'; wrap.style.height = ''; return; }
        sheet.style.transform = 'scale(' + (avail / full) + ')';
        wrap.style.height = Math.ceil(sheet.offsetHeight * (avail / full)) + 'px';
        if (wrap.clientWidth === avail) return;
      }
    }
    window.addEventListener('load', fitSheetToScreen);
    window.addEventListener('resize', fitSheetToScreen);
  </script>
</body></html>`;
  html(ctx, 200, body);
}));

// ---------------- รายละเอียดฉบับเดียว ----------------

router.get('/orders/:id', requirePage((ctx) => {
  const order = getSchoolOrder(ctx.params.id);
  if (!order) {
    html(ctx, 404, layout({
      user: ctx.user, title: 'ไม่พบเอกสาร', path: '/orders',
      content: emptyState('🔍', 'ไม่พบคำสั่ง/ประกาศฉบับนี้ — อาจถูกลบไปแล้ว'),
    }));
    return;
  }
  const noun = kindNoun(order.kind);
  const k = kindOf(order.kind);
  const manage = canManageOrders(ctx.user);
  const isAdmin = ctx.user.roleCodes.includes('admin');
  const recips = orderRecipients(order.id);
  const iAmRecipient = recips.some((r) => r.user_id === ctx.user.id);
  // บันทึกว่าเปิดอ่านแล้ว "ตอนเปิดหน้านี้" เพราะนี่คือจุดเดียวที่พิสูจน์ได้ว่าเห็นตัวเอกสารจริง
  // (การกดจากแจ้งเตือนอย่างเดียวยังไม่ใช่การอ่าน — เหตุผลเดียวกับ markStepOpened ของหนังสือ)
  if (iAmRecipient) markOrderOpened(order.id, ctx.user.id);
  const files = orderFiles(order.id);

  const shareText = orderShareText({
    noun, numberDisplay: order.number_display, subject: order.subject,
    signedDate: order.signed_date, orderId: order.id,
  });

  const openedCount = recips.filter((r) => r.opened_at).length;
  const recipientCard = !recips.length && !manage ? '' : `
    <div class="card" id="recipientCard">
      <div class="card-header">
        <h3 class="mt-0">👥 ผู้ที่ต้องทราบ ${recips.length ? `${openedCount}/${recips.length} เปิดอ่านแล้ว` : ''}</h3>
      </div>
      ${recips.length ? `<div class="stack" style="gap:.3rem">
        ${recips.map((r) => `<div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <span>${esc(personName(r.prefix, r.first_name, r.last_name))}</span>
          ${r.opened_at
    ? `<span class="badge badge-success" title="${esc(fmtThaiDateLong(r.opened_at))}">อ่านแล้ว ${esc(fmtAgo(r.opened_at))}</span>`
    : '<span class="badge badge-warning">ยังไม่เปิดอ่าน</span>'}
        </div>`).join('')}
      </div>` : '<p class="text-muted">ยังไม่ได้ระบุผู้ที่ต้องทราบ — คนที่ชื่ออยู่ในเอกสารนี้จะไม่ได้รับแจ้งเตือนถึงตัว</p>'}
      ${manage ? `
      <details style="margin-top:.6rem">
        <summary style="cursor:pointer;font-weight:600">➕ เพิ่มผู้ที่ต้องทราบ</summary>
        <div class="chip-row" style="margin:.4rem 0">
          <button class="btn btn-outline btn-sm" type="button" onclick="pickAllRecips(true)">เลือกทุกคน</button>
          <button class="btn btn-outline btn-sm" type="button" onclick="pickAllRecips(false)">ล้างที่เลือก</button>
          <button class="btn btn-primary btn-sm" type="button" onclick="submitRecipients(this)">แจ้งผู้ที่เลือก</button>
        </div>
        <div class="assignee-pick">${recipientCheckboxes(new Set(recips.map((r) => r.user_id)))}</div>
      </details>` : ''}
    </div>`;

  const fileCard = `
    <div class="card" id="fileCard">
      <h3 class="mt-0">📎 ไฟล์${esc(noun)}</h3>
      ${files.length ? `<div class="stack" style="gap:.4rem">
        ${files.map((f) => `<div class="flex gap-2 items-center" style="flex-wrap:wrap">
          <a href="/orders/${order.id}/files/${f.id}"${VIEWABLE_MIME.has(f.mime_type) ? ' target="_blank" rel="noopener"' : ''}>${esc(f.filename)}</a>
          <span class="text-muted" style="font-size:.85rem">${esc(fmtKb(f.filesize))}</span>
          <a class="btn btn-outline btn-sm" href="/orders/${order.id}/files/${f.id}?download=1">⬇️ ดาวน์โหลด</a>
        </div>`).join('')}
      </div>` : `<p class="text-muted">ยังไม่มีไฟล์${esc(noun)}ที่ลงนามแล้ว — ${manage ? 'แนบได้ที่ด้านล่าง' : 'ธุรการยังไม่ได้แนบ'}</p>`}
      ${manage ? `
      <div class="field" style="margin-top:.6rem">
        <input type="file" id="addOrderFile" accept="${ACCEPT_ATTR}" onchange="attachFilePreview(this, 'addOrderFileName')" />
        <div class="help-text" id="addOrderFileName"></div>
        <button class="btn btn-outline btn-sm" type="button" onclick="uploadOrderFile(this)">แนบไฟล์นี้</button>
      </div>` : ''}
    </div>`;

  const editCard = !manage ? '' : `
    <div class="card" id="editCard">
      <h3 class="mt-0">✏️ แก้ไขรายละเอียด</h3>
      <p class="text-muted" style="margin-top:-.4rem;font-size:.85rem">
        แก้ได้เฉพาะเรื่อง วันที่ลงนาม ผู้ลงนาม และหมายเหตุ — <strong>เลขที่แก้ไม่ได้</strong>
        เพราะเอกสารที่มีเลขนี้แจกออกไปและถูกอ้างอิงที่อื่นแล้ว
      </p>
      <div class="stack">
        <div class="field"><label for="edSubject">เรื่อง *</label>
          <input type="text" id="edSubject" maxlength="500" value="${esc(order.subject)}" /></div>
        <div class="form-grid cols-2">
          <div class="field"><label for="edSignedDate">วันที่ลงนาม</label>
            <input type="date" id="edSignedDate" value="${esc(order.signed_date || '')}" /></div>
          <div class="field"><label for="edSigner">ผู้ลงนาม</label>
            <select id="edSigner"><option value="">— ยังไม่ระบุ —</option>${signerOptions(order.signer_id)}</select></div>
        </div>
        <div class="field"><label for="edNote">หมายเหตุ</label>
          <input type="text" id="edNote" maxlength="1000" value="${esc(order.note || '')}" /></div>
        <div class="chip-row">
          <button class="btn btn-primary btn-sm" type="button" onclick="saveOrder(this)">บันทึกการแก้ไข</button>
          ${isAdmin ? `<button class="btn btn-danger btn-sm" type="button" onclick="deleteOrder(this)">ลบฉบับนี้</button>` : ''}
        </div>
      </div>
    </div>`;

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">${k.icon} ${esc(k.label)}ที่ ${esc(order.number_display)}</h2>
        <p class="text-muted" style="margin-top:-.6rem">${esc(order.subject)}</p>
      </div>
      <div class="chip-row"><a class="btn btn-outline btn-sm" href="/orders?kind=${esc(order.kind)}">← ทะเบียน${esc(k.label)}</a></div>
    </div>
    <div class="card">
      <div class="form-grid cols-2">
        <div><div class="text-muted" style="font-size:.82rem">ลงวันที่</div>
          <div>${order.signed_date ? esc(fmtThaiDateLong(order.signed_date)) : '<span class="text-muted">ยังไม่ระบุ</span>'}</div></div>
        <div><div class="text-muted" style="font-size:.82rem">ผู้ลงนาม</div>
          <div>${order.signer_first
    ? `${esc(personName(order.signer_prefix, order.signer_first, order.signer_last))}${order.signer_position ? ` <span class="text-muted">(${esc(order.signer_position)})</span>` : ''}`
    : '<span class="text-muted">ยังไม่ระบุ</span>'}</div></div>
        <div><div class="text-muted" style="font-size:.82rem">ผู้ออกเลข</div>
          <div>${esc(personName(order.creator_prefix, order.creator_first, order.creator_last))}
            <span class="text-muted">· ${esc(fmtAgo(order.created_at))}</span></div></div>
        <div><div class="text-muted" style="font-size:.82rem">เล่มทะเบียน</div>
          <div>ทะเบียน${esc(k.label)} ประจำปี ${order.year_be}</div></div>
      </div>
      ${order.note ? `<div style="margin-top:.6rem"><div class="text-muted" style="font-size:.82rem">หมายเหตุ</div>
        <div>${esc(order.note)}</div></div>` : ''}
      <div style="margin-top:.8rem">
        ${lineShareBlock({
    key: `order-${order.id}`, text: shareText, primary: true,
    title: 'คัดลอกข้อความไปวางในกลุ่มไลน์ของโรงเรียน',
  })}
      </div>
    </div>
    ${recipientCard}
    ${fileCard}
    ${editCard}
    ${attachMimeScript()}
    <script>
      window.pickAllRecips = function (on) {
        document.querySelectorAll('.orderRecip').forEach(function (x) { x.checked = on; });
      };
      window.submitRecipients = function (btn) {
        var ids = [].map.call(document.querySelectorAll('.orderRecip:checked'), function (x) { return x.value; });
        if (!ids.length) { window.toast('ยังไม่ได้เลือกผู้ที่ต้องทราบ', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังแจ้ง...');
        window.postJson('/orders/${order.id}/recipients', { userIds: ids }).then(function (d) {
          if (d === null) { window.restoreBtn(btn); return; }
          window.toast('แจ้งเรียบร้อย ' + d.added + ' คน', 'success');
          setTimeout(function () { location.reload(); }, 900);
        }).catch(function (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
      window.uploadOrderFile = async function (btn) {
        var input = document.getElementById('addOrderFile');
        var file = input.files[0];
        if (!file) { window.toast('ยังไม่ได้เลือกไฟล์', 'warning'); return; }
        if (file.size > 5 * 1024 * 1024) { window.toast('ไฟล์ต้องไม่เกิน 5MB', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังอัปโหลด...');
        var payload;
        try {
          payload = {
            file: {
              fileName: file.name,
              fileType: window.attachMime(file.name, file.type),
              fileDataBase64: await window.fileToBase64(file)
            }
          };
        } catch (err) {
          window.restoreBtn(btn);
          window.toast('อ่านไฟล์ที่แนบไม่สำเร็จ กรุณาลองใหม่', 'danger');
          return;
        }
        window.postJson('/orders/${order.id}/files', payload).then(function (d) {
          if (d === null) { window.restoreBtn(btn); return; }
          window.toast('แนบไฟล์เรียบร้อย', 'success');
          setTimeout(function () { location.reload(); }, 900);
        }).catch(function (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
      window.saveOrder = function (btn) {
        var subject = document.getElementById('edSubject').value.trim();
        if (!subject) { window.toast('กรุณากรอกเรื่อง', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        window.postJson('/orders/${order.id}', {
          subject: subject,
          signedDate: document.getElementById('edSignedDate').value || null,
          signerId: document.getElementById('edSigner').value || null,
          note: document.getElementById('edNote').value.trim()
        }).then(function (d) {
          if (d === null) { window.restoreBtn(btn); return; }
          window.toast('บันทึกเรียบร้อย', 'success');
          setTimeout(function () { location.reload(); }, 900);
        }).catch(function (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
      window.deleteOrder = function (btn) {
        var reason = prompt('ลบ${esc(noun)}ที่ ${esc(order.number_display)} — เลขนี้จะไม่ถูกนำกลับมาใช้ซ้ำ และจะขึ้นเป็น "เลขที่หายไป" ในทะเบียนพร้อมเหตุผลที่ระบุไว้\\n\\nเหตุผลที่ลบ:');
        if (reason === null) return;
        if (!reason.trim()) { window.toast('ต้องระบุเหตุผลที่ลบ', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังลบ...');
        window.postJson('/orders/${order.id}/delete', { reason: reason.trim() }).then(function (d) {
          if (d === null) { window.restoreBtn(btn); return; }
          window.toast('ลบ' + d.noun + 'ที่ ' + d.numberDisplay + ' แล้ว', 'success');
          setTimeout(function () { location.href = '/orders?kind=${esc(order.kind)}'; }, 900);
        }).catch(function (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: `${k.label}ที่ ${order.number_display}`, path: '/orders', content }));
}));

router.get('/orders/:id/files/:fileId', requirePage((ctx) => {
  const order = getSchoolOrder(ctx.params.id);
  const file = order ? getOrderFile(ctx.params.fileId) : null;
  // ต้องตรวจว่าไฟล์เป็นของฉบับนี้จริง ไม่ใช่เชื่อ id ไฟล์เดี่ยวๆ — ไม่งั้นเส้นทางนี้กลายเป็นช่องดึงไฟล์
  // ของฉบับไหนก็ได้ด้วยการเดา/ใช้ id ที่เคยเห็น โดยที่ส่วน :id ไม่มีผลอะไรเลย
  //
  // ตอบเป็นหน้า 404 ไม่ใช่โยน error ขึ้นไป — เส้นทางส่งไฟล์เขียนหัวตอบเองทั้งชุด (ชนิดไฟล์/ขนาด/
  // ชื่อไฟล์) ตัวจัดการ error กลางจะเขียนหัวซ้ำไม่ได้ถ้าเริ่มส่งไปแล้ว (เกณฑ์เดียวกับ /files/:id)
  if (!file || file.order_id !== order.id) return html(ctx, 404, '<h1>404</h1><p>ไม่พบไฟล์นี้</p>');
  const download = ctx.query.download === '1' || !VIEWABLE_MIME.has(file.mime_type);
  // node:sqlite คืน BLOB มาเป็น Uint8Array ไม่ใช่ Buffer — ต้องแปลงก่อน ไม่ใช่ส่งดิบๆ (เกณฑ์เดียวกับ
  // เส้นทางส่งร่างหนังสือของคำขอเลข) ค่าที่ไม่ใช่ Buffer ทำให้ที่รับปลายทางบางตัวแปลงเป็นข้อความก่อน
  const buf = Buffer.from(file.content);
  ctx.res.writeHead(200, {
    'Content-Type': file.mime_type,
    'Content-Length': buf.length,
    'Content-Disposition': contentDispositionHeader(file.filename, fallbackFilename(file.mime_type), download ? 'attachment' : 'inline'),
    'Cache-Control': 'private, no-store',
  });
  ctx.res.end(buf);
}));

// ---------------- API ----------------

router.post('/orders', requireApi((ctx) => {
  const res = createSchoolOrder({
    kind: ctx.body?.kind, subject: ctx.body?.subject, signedDate: ctx.body?.signedDate,
    signerId: ctx.body?.signerId, note: ctx.body?.note, recipientIds: ctx.body?.recipientIds,
    file: ctx.body?.file, actorUser: ctx.user,
  });
  json(ctx, 200, { ...res, noun: kindNoun(ctx.body?.kind) });
}));

router.post('/orders/:id', requireApi((ctx) => {
  json(ctx, 200, updateSchoolOrder({
    orderId: ctx.params.id, subject: ctx.body?.subject, signedDate: ctx.body?.signedDate,
    signerId: ctx.body?.signerId, note: ctx.body?.note, actorUser: ctx.user,
  }));
}));

router.post('/orders/:id/delete', requireApi((ctx) => {
  json(ctx, 200, deleteSchoolOrder({ orderId: ctx.params.id, reason: ctx.body?.reason, actorUser: ctx.user }));
}));

router.post('/orders/:id/files', requireApi((ctx) => {
  json(ctx, 200, addOrderFile({ orderId: ctx.params.id, file: ctx.body?.file, actorUser: ctx.user }));
}));

router.post('/orders/:id/recipients', requireApi((ctx) => {
  json(ctx, 200, addOrderRecipients({ orderId: ctx.params.id, userIds: ctx.body?.userIds, actorUser: ctx.user }));
}));

export { MAX_ORDER_RECIPIENTS };
