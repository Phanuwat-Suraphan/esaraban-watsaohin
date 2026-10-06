import { router, html, json, contentDispositionHeader, truncateFilename } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { db, uuid, nowIso, beYear, audit } from '../db.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream, deleteFile as deleteDriveFile } from '../services/googleDrive.js';
import { announcementShareText, announcementChaseText, lineShareBlock } from '../services/line.js';
import { notifyUser } from '../services/notify.js';
import {
  recordAnnouncementRecipients, announcementAudience, markAnnouncementRead,
  announcementReadStats, readStatsByAnnouncement,
} from '../services/announcementReads.js';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CATEGORIES = ['ประกาศ', 'ประชาสัมพันธ์'];

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// ใครโพสต์/ลบประกาศได้
//
// เดิมจำกัดไว้ที่ 'admin' อย่างเดียว ซึ่งเป็นบทบาทเชิงเทคนิค (คนดูแลระบบ) ไม่ใช่คนที่ประกาศเรื่องของ
// โรงเรียนจริง — ผลคือ ผอ. ประกาศเรื่องถึงคณะครูเองไม่ได้ และธุรการซึ่งเป็นคนติดประกาศตัวจริง
// ก็ทำไม่ได้ ต้องไปรบกวนคนดูแลระบบทุกครั้ง
const CAN_POST_ROLES = ['admin', 'director', 'vice_director', 'registrar'];
const canPostAnnouncement = (user) => user.roleCodes.some((r) => CAN_POST_ROLES.includes(r));

// เพดานความยาว — ประกาศแสดงเต็มหน้าจอทุกคนที่เปิดเข้ามา ถ้าปล่อยให้ยาวไม่จำกัด ประกาศเดียว
// ทำให้หน้าประกาศพองจนเปิดไม่ไหวบนมือถือ (ทดสอบแล้ว: หัวข้อ 50,000 ตัวอักษรและเนื้อหา 500,000
// ตัวอักษรถูกบันทึกได้ทั้งคู่)
const MAX_TITLE = 300;
const MAX_BODY = 20000;

// จำนวนที่แสดงต่อหมวดในหน้าปกติ และเพดานเมื่อกด "ดูทั้งหมด" — ประกาศเก่ากว่านั้นยังอยู่ในฐานข้อมูล
// (ไม่ได้ลบ) แต่ไม่ต้องส่งมาให้ทุกคนโหลดทุกครั้งที่เปิดหน้า
const LIST_LIMIT = 20;
const MAX_LIST_ALL = 200;

// ความยาวที่แสดงในหน้ารายการ — ประกาศที่ยาวกว่านี้ (ระเบียบ/แนวปฏิบัติ) ตัดแล้วลิงก์ไปหน้าของตัวเอง
//
// ตั้งใจไม่ใช้ <details> พับไว้ เพราะการพับซ่อนแค่ "สายตา" แต่เนื้อหาเต็มยังถูกส่งมาทุกไบต์อยู่ดี —
// วัดแล้วว่าประกาศยาวเต็มเพดานเพียง 20 ฉบับยังทำให้หน้าหนัก 1.3MB ทั้งที่พับไว้หมด
const BODY_PREVIEW_CHARS = 300;
function bodyHtml(a) {
  if (!a.body) return '';
  const style = 'font-size:.85rem;margin:.3rem 0';
  if (a.body.length <= BODY_PREVIEW_CHARS) return `<p class="text-muted" style="${style}">${esc(a.body)}</p>`;
  return `<p class="text-muted" style="${style}">${esc(a.body.slice(0, BODY_PREVIEW_CHARS))}…
    <a href="/announcements/${a.id}">อ่านต่อ</a></p>`;
}

router.get('/announcements', requirePage((ctx) => {
  const isAdmin = canPostAnnouncement(ctx.user);
  // ดึงเฉพาะเท่าที่จะแสดง — เดิมดึง "ทุกประกาศที่เคยลงไว้" แล้วพิมพ์เนื้อหาเต็มทุกฉบับลงหน้าเดียว
  // วัดจริงแล้ว: ประกาศ 160 ฉบับ (สัปดาห์ละ 4 ฉบับ หนึ่งปีการศึกษา) เนื้อหาเฉลี่ยแค่ 500 ตัวอักษร
  // ทำให้หน้านี้หนัก 1.9MB ต่อการเปิดหนึ่งครั้ง และถ้ามีฉบับที่เขียนยาวเต็มเพดานสัก 20 ฉบับจะเป็น 3MB
  // ซึ่งครูต้องโหลดใหม่ทุกครั้งที่เปิดดูประกาศบนมือถือ
  const rows = db.prepare(`
    SELECT a.id, a.category, a.title, a.file_name, a.created_at, u.first_name, u.last_name,
      -- ตัดตั้งแต่ในฐานข้อมูล ไม่ดึงเนื้อหาเต็มขึ้นมาแล้วค่อยตัดในโค้ด (+1 ไว้ให้รู้ว่ายาวเกินหรือไม่)
      substr(a.body, 1, :preview + 1) AS body
    FROM announcements a JOIN users u ON u.id = a.created_by
    WHERE a.deleted_at IS NULL AND a.category = :cat ORDER BY a.created_at DESC LIMIT :limit
  `);
  const totals = db.prepare(`
    SELECT category, COUNT(*) c FROM announcements WHERE deleted_at IS NULL GROUP BY category
  `).all().reduce((m, r) => m.set(r.category, r.c), new Map());
  const showAll = ctx.query.all === '1';
  const limit = showAll ? MAX_LIST_ALL : LIST_LIMIT;
  const grouped = CATEGORIES.map((cat) => ({
    cat,
    items: rows.all({ cat, limit, preview: BODY_PREVIEW_CHARS }),
    total: totals.get(cat) || 0,
  }));
  // สัดส่วนการอ่านของทุกฉบับในหน้าเดียว ดึงทีเดียว ไม่ใช่ยิงคำสั่งต่อหนึ่งแถว — หน้านี้แสดงได้ถึง
  // 200 รายการเมื่อกด "ดูทั้งหมด" ซึ่งจะกลายเป็น 200 คำสั่งทันทีถ้าถามทีละแถว
  const readStats = isAdmin
    ? readStatsByAnnouncement(grouped.flatMap((g) => g.items.map((a) => a.id)))
    : new Map();
  const readChip = (id) => {
    const st = readStats.get(id);
    if (!st) return '';
    return st.readCount >= st.total
      ? ` · <span class="badge badge-success" style="font-size:.7rem">อ่านครบ ${st.total}</span>`
      : ` · <span class="badge badge-warning" style="font-size:.7rem">อ่านแล้ว ${st.readCount}/${st.total}</span>`;
  };

  const content = `
    <div class="card-header">
      <h2 class="mt-0">📢 ประกาศ/ประชาสัมพันธ์</h2>
      ${isAdmin ? `<a class="btn btn-primary btn-sm" href="/announcements/new">+ เพิ่มประกาศ</a>` : ''}
    </div>
    <div class="grid-2">
      ${grouped.map(({ cat, items, total }) => `
        <div class="card">
          <h3 class="mt-0">${cat === 'ประกาศ' ? '📣' : '📌'} ${esc(cat)}ล่าสุด</h3>
          ${items.length ? items.map((a) => `
            <div style="padding:.6rem 0;border-bottom:1px solid var(--border)">
              <div class="flex items-center justify-between" style="gap:.5rem">
                <!-- หัวข้อต้องเป็นลิงก์ไปหน้าของประกาศนั้นเสมอ — เดิมเป็นข้อความเฉยๆ และมีทางเข้า
                     หน้าประกาศรายฉบับอยู่ทางเดียวคือลิงก์ "อ่านต่อ" ซึ่งขึ้นเฉพาะประกาศที่เนื้อหายาว
                     เกิน 300 ตัวอักษร ประกาศสั้นๆ (ซึ่งเป็นส่วนใหญ่) จึงไม่มีหน้าของตัวเองให้เข้าถึงเลย
                     แปลว่าส่งลิงก์ประกาศให้ใครไม่ได้ และไม่มีปุ่มส่งเข้ากลุ่มไลน์ให้กดด้วย -->
                <strong><a class="list-link" href="/announcements/${a.id}">${esc(a.title)}</a></strong>
                ${isAdmin ? `<button type="button" class="btn btn-sm btn-outline" onclick="deleteAnnouncement('${a.id}')" title="ลบ">🗑️</button>` : ''}
              </div>
              ${bodyHtml(a)}
              <div class="text-muted" style="font-size:.78rem">
                ผู้ลงประกาศ ${esc(a.first_name)} ${esc(a.last_name)} · วันที่ ${fmtDate(a.created_at)}
                ${a.file_name ? ` · <a href="/announcement-files/${a.id}" target="_blank" rel="noopener">📄 ${esc(a.file_name)}</a>` : ''}
                ${readChip(a.id)}
              </div>
            </div>`).join('') : emptyState('📭', `ยังไม่มี${cat}`)}
          ${total > items.length ? `<p class="text-muted" style="font-size:.82rem;margin:.6rem 0 0">
            แสดง ${items.length} จาก ${total} รายการ ·
            <a href="/announcements?all=1">ดูทั้งหมด</a>
          </p>` : ''}
        </div>`).join('')}
    </div>
    ${isAdmin ? `<script>
      window.deleteAnnouncement = function(id){
        if (!confirm('ยืนยันลบประกาศนี้?')) return;
        fetch('/announcements/' + id + '/delete', {method:'POST'})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => toast(e.message, 'danger'));
      };
    </script>` : ''}`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ประกาศ/ประชาสัมพันธ์', path: '/announcements', content }));
}));

router.get('/announcements/new', requireRole(...CAN_POST_ROLES)(requirePage((ctx) => {
  const content = `
    <h2>📢 เพิ่มประกาศ/ประชาสัมพันธ์</h2>
    <div class="card">
      <form id="annForm" class="stack">
        <div class="field">
          <label>ประเภท *</label>
          <select name="category">${CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>หัวข้อ *</label><input type="text" name="title" required autocomplete="off" /></div>
        <div class="field"><label>รายละเอียด</label><textarea name="body" placeholder="รายละเอียดประกาศ (ถ้ามี)" autocomplete="off"></textarea></div>
        <div class="field">
          <label>แนบไฟล์ PDF (ถ้ามี)</label>
          <input type="file" id="fileInput" accept="application/pdf" onchange="attachFilePreview(this,'filePreview')" />
          <div id="filePreview" class="help-text"></div>
          <div class="help-text">รองรับเฉพาะไฟล์ PDF ขนาดไม่เกิน 10MB</div>
        </div>
        <div class="field">
          <!-- ช่องซ่อนต้องมาก่อนเสมอ: ช่องติ๊กที่ไม่ได้ติ๊กจะไม่ถูกส่งมาเลย ถ้าไม่มีค่าตั้งต้นคู่กัน
               เซิร์ฟเวอร์จะแยก "ไม่ติ๊ก" กับ "ไม่มีช่องนี้" ไม่ออก แล้วแจ้งเตือนออกไปทั้งที่สั่งไม่ให้แจ้ง -->
          <input type="hidden" name="notify" value="0" />
          <label class="check-inline" style="display:block">
            <input type="checkbox" name="notify" value="1" checked />
            <span><strong>แจ้งเตือนถึงทุกคน</strong> และนับว่าใครอ่านแล้วบ้าง</span>
          </label>
          <div class="help-text">
            ทุกคนจะได้รับแจ้งเตือน (และเข้าไลน์ถ้าเชื่อมบัญชีไว้) และผู้ลงประกาศจะเห็นว่าเหลือใครยังไม่อ่าน
            — ติ๊กออกได้ถ้าเป็นเรื่องที่ตั้งใจให้อยู่บนบอร์ดเป็นข้อมูลอ้างอิงเฉยๆ เช่น ระเบียบ/แนวปฏิบัติ
          </div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกประกาศ</button>
        <a class="btn btn-outline" href="/announcements">ยกเลิก</a>
      </form>
    </div>
    <script>
      document.getElementById('annForm').addEventListener('submit', function(e){
        e.preventDefault();
        submitWithFile(this, 'fileInput', '/announcements', { submitLabel: 'บันทึก' });
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'เพิ่มประกาศ', path: '/announcements/new', content }));
})));

// ต้องประกาศ *หลัง* /announcements/new เสมอ — router จับคู่ตามลำดับที่ลงทะเบียน ถ้าเอา :id
// ไว้ก่อน คำว่า "new" จะถูกจับเป็น id แล้วหน้าฟอร์มเพิ่มประกาศจะกลายเป็น 404 (เคยพลาดมาแล้ว)
// หน้าของประกาศฉบับเดียว — มีไว้เพื่อให้หน้ารายการไม่ต้องแบกเนื้อหาเต็มของทุกฉบับ และเพื่อให้
// ส่งลิงก์ประกาศให้กันได้ตรงๆ (เดิมประกาศไม่มี URL ของตัวเอง ต้องบอกให้ไปหาเอาเองในหน้ารวม)
router.get('/announcements/:id', requirePage((ctx) => {
  const a = db.prepare(`
    SELECT a.*, u.prefix, u.first_name, u.last_name FROM announcements a JOIN users u ON u.id = a.created_by
    WHERE a.id = ? AND a.deleted_at IS NULL`).get(ctx.params.id);
  if (!a) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบประกาศ', path: '/announcements',
      content: emptyState('📭', 'ไม่พบประกาศนี้ หรือถูกลบไปแล้ว') }));
  }
  // เปิดหน้านี้ = ลงชื่อรับทราบ (เกณฑ์เดียวกับหนังสือเวียน ดู services/announcementReads.js)
  markAnnouncementRead(a.id, ctx.user.id);
  const stats = canPostAnnouncement(ctx.user) ? announcementReadStats(a.id) : null;
  const readCard = !stats ? '' : !stats.tracked ? `
    <div class="card"><p class="help-text" style="margin:0">
      ประกาศฉบับนี้ลงไว้ก่อนที่ระบบจะเริ่มแจ้งถึงตัวและเก็บสถิติการอ่าน จึงไม่มีข้อมูลว่าใครอ่านแล้วบ้าง
      — ฉบับที่ลงหลังจากนี้จะนับให้เอง
    </p></div>` : `
    <div class="card" id="announcementReads">
      <h3 class="mt-0">👥 ใครอ่านแล้วบ้าง</h3>
      <div><strong>อ่านแล้ว ${stats.readCount} จาก ${stats.total} ท่าน</strong>
        ${stats.unreadCount
    ? `<span class="badge badge-warning">ยังไม่อ่าน ${stats.unreadCount}</span>`
    : '<span class="badge badge-success">ครบทุกท่านแล้ว</span>'}</div>
      ${stats.unreadCount ? `
        <details style="margin-top:.4rem">
          <summary style="cursor:pointer">ดูรายชื่อท่านที่ยังไม่ได้เปิดอ่าน</summary>
          <ol style="margin:.4rem 0 0;padding-left:1.2rem;font-size:.9rem">
            ${stats.unread.map((u) => `<li>${esc(u.name)}${u.position ? ` <span class="text-muted">(${esc(u.position)})</span>` : ''}</li>`).join('')}
            ${stats.hiddenCount ? `<li class="text-muted">และอีก ${stats.hiddenCount} ท่าน</li>` : ''}
          </ol>
        </details>
        <div style="margin-top:.5rem">
          ${lineShareBlock({
    key: `${a.id}-chase`,
    text: announcementChaseText(a, stats),
    copyLabel: `⏳ คัดลอกข้อความตามท่านที่ยังไม่อ่าน (${stats.unreadCount})`,
    title: 'รวมรายชื่อท่านที่ยังไม่ได้เปิดอ่านเป็นข้อความเดียว คัดลอกไปวางในกลุ่มไลน์ได้เลย',
  })}
        </div>` : ''}
    </div>`;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">${a.category === 'ประกาศ' ? '📣' : '📌'} ${esc(a.title)}</h2>
      <div class="chip-row">
        <!-- ประกาศเป็นเรื่องที่ตั้งใจให้ทุกคนเห็นอยู่แล้ว จึงแชร์เข้ากลุ่มไลน์ได้เสมอ ไม่มีชั้นความลับ
             ให้ต้องกัน (ต่างจากหนังสือ ดู services/line.js) -->
        ${lineShareBlock({
          key: a.id, text: announcementShareText(a), inline: true,
          title: 'เปิดหน้าต่างแชร์ของ LINE พร้อมชื่อประกาศและลิงก์กลับมาที่ประกาศนี้',
        })}
        <a class="btn btn-outline btn-sm" href="/announcements">← กลับหน้าประกาศ</a>
      </div>
    </div>
    <div class="card">
      <div class="text-muted" style="font-size:.85rem;margin-bottom:.8rem">
        ${esc(a.category)} · ผู้ลงประกาศ ${esc(a.prefix || '')}${esc(a.first_name)} ${esc(a.last_name)}
        · วันที่ ${fmtDate(a.created_at)}
      </div>
      ${a.body ? `<div style="white-space:pre-wrap;line-height:1.8">${esc(a.body)}</div>` : '<p class="text-muted">ไม่มีเนื้อหาเพิ่มเติม</p>'}
      ${a.file_name ? `<p style="margin-top:1rem">
        <a class="btn btn-outline btn-sm" href="/announcement-files/${a.id}" target="_blank" rel="noopener">📄 ${esc(a.file_name)}</a>
      </p>` : ''}
    </div>
    ${readCard}`;
  html(ctx, 200, layout({ user: ctx.user, title: a.title, path: '/announcements', content }));
}));

router.post('/announcements', requireRole(...CAN_POST_ROLES)(requireApi(async (ctx) => {
  const b = ctx.body;
  if (!b.category || !CATEGORIES.includes(b.category)) throw httpError(400, 'กรุณาเลือกประเภทให้ถูกต้อง');
  if (!b.title?.trim()) throw httpError(400, 'กรุณากรอกหัวข้อ');
  if (b.title.length > MAX_TITLE) throw httpError(400, `หัวข้อยาวเกินไป (${b.title.length} ตัวอักษร) — จำกัดไม่เกิน ${MAX_TITLE} ตัวอักษร`);
  if (typeof b.body === 'string' && b.body.length > MAX_BODY) {
    throw httpError(400, `เนื้อหายาวเกินไป (${b.body.length} ตัวอักษร) — จำกัดไม่เกิน ${MAX_BODY} ตัวอักษร`);
  }

  let fileFields = {};
  if (b.fileDataBase64) {
    if (!ALLOWED_MIME.has(b.fileType)) throw httpError(400, 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น');
    const buf = Buffer.from(b.fileDataBase64, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');

    const id = uuid();
    if (isGoogleDriveEnabled()) {
      const folderId = await ensureCategoryFolder({ yearBe: beYear(), typeName: 'ประกาศ-ประชาสัมพันธ์' });
      const driveFileId = await uploadFile({ buffer: buf, filename: `${id}__${b.fileName || 'announcement.pdf'}`, mimeType: b.fileType, folderId });
      fileFields = { file_storage_provider: 'google_drive', file_drive_id: driveFileId, file_path: null };
    } else {
      const safeName = `${id}.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
      fileFields = { file_storage_provider: 'local', file_path: safeName, file_drive_id: null };
    }
    fileFields.file_name = truncateFilename(b.fileName) || 'announcement.pdf';
    fileFields.file_size = buf.length;
    fileFields.file_mime = b.fileType;
  }

  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO announcements (id, category, title, body, file_storage_provider, file_path, file_drive_id, file_name, file_size, file_mime, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, b.category, b.title.trim(), b.body?.trim() || null,
    fileFields.file_storage_provider || null, fileFields.file_path || null, fileFields.file_drive_id || null,
    fileFields.file_name || null, fileFields.file_size || null, fileFields.file_mime || null,
    ctx.user.id, now, now);

  // แจ้งถึงตัวทุกคน ไม่ใช่รอให้บังเอิญเปิดหน้าประกาศเอง — เดิมบอร์ดนี้เงียบสนิท ประกาศเรื่องด่วน
  // (เปลี่ยนกำหนดการ งดการเรียนการสอน) จึงอาจไม่ถึงใครเลยโดยไม่มีอะไรฟ้อง
  //
  // ผู้ลงประกาศติ๊กปิดได้ สำหรับเรื่องที่ตั้งใจให้เป็นข้อมูลอ้างอิงบนบอร์ดเฉยๆ (ระเบียบ/แนวปฏิบัติ)
  // ซึ่งถ้ายิงเข้าไลน์ทุกคนทุกครั้งจะกลายเป็นเสียงรบกวนจนคนปิดการแจ้งเตือนทิ้ง
  // ค่าที่ไม่ได้ส่งมาเลยถือว่า "แจ้ง" เพราะนั่นคือเหตุผลหลักที่บอร์ดประกาศมีอยู่ ส่วนการปิดต้องบอก
  // มาให้ชัด (false / '0' / 'false') — ฟอร์มส่ง '0' มาคู่กับช่องติ๊กเสมอ (ดูช่องซ่อนในฟอร์ม)
  const notify = !(b.notify === false || b.notify === '0' || b.notify === 'false');
  const audience = notify ? announcementAudience(ctx.user.id) : [];
  if (audience.length) {
    recordAnnouncementRecipients(id, audience);
    for (const userId of audience) {
      notifyUser({
        userId,
        linkUrl: `/announcements/${id}`,
        title: `${b.category === 'ประกาศ' ? '📣' : '📌'} ${b.category}ใหม่`,
        message: b.title.trim(),
        priority: 'info',
      });
    }
  }
  audit({ userId: ctx.user.id, action: 'announcement_created', tableName: 'announcements', recordId: id, detail: { category: b.category, title: b.title, notified: audience.length } });
  json(ctx, 201, { redirect: `/announcements/${id}`, notified: audience.length });
})));

router.post('/announcements/:id/delete', requireRole(...CAN_POST_ROLES)(requireApi(async (ctx) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(ctx.params.id);
  if (!ann) throw httpError(404, 'ไม่พบประกาศนี้');
  if (ann.file_storage_provider === 'google_drive' && ann.file_drive_id) {
    await deleteDriveFile(ann.file_drive_id).catch(() => {}); // ลบเอกสารเมทาดาต้าต่อได้แม้ลบไฟล์บน Drive ไม่สำเร็จ
  } else if (ann.file_path) {
    const filePath = path.join(UPLOAD_DIR, ann.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('UPDATE announcements SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), ann.id);
  audit({ userId: ctx.user.id, action: 'announcement_deleted', tableName: 'announcements', recordId: ann.id });
  json(ctx, 200, { ok: true });
})));

// ---------------- file serving — เข้าถึงได้ทุกคนที่ login แล้ว (ประกาศเป็นของเปิดเผยทั้งโรงเรียนโดยธรรมชาติ) ----------------
router.get('/announcement-files/:id', requirePage(async (ctx) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(ctx.params.id);
  if (!ann || !ann.file_name) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');

  if (ann.file_storage_provider === 'google_drive') {
    let stream;
    try {
      stream = await downloadFileStream(ann.file_drive_id);
    } catch (err) {
      return html(ctx, err.statusCode || 502, `<h1>เกิดข้อผิดพลาด</h1><p>${esc(err.message)}</p>`);
    }
    if (!stream) return html(ctx, 404, '<h1>ไม่พบไฟล์บน Google Drive</h1>');
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDispositionHeader(ann.file_name, 'announcement.pdf'), 'X-Content-Type-Options': 'nosniff' });
    Readable.fromWeb(stream).pipe(ctx.res);
    return;
  }

  const filePath = path.join(UPLOAD_DIR, ann.file_path);
  if (!fs.existsSync(filePath)) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');
  ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDispositionHeader(ann.file_name, 'announcement.pdf'), 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).pipe(ctx.res);
}));
