// ส่งเรื่องเข้ากลุ่มไลน์ของโรงเรียน
//
// ทำไมต้องมี: ที่โรงเรียนนี้ช่องทางแจ้งงานจริงคือกลุ่มไลน์ ไม่ใช่เว็บ ธุรการลงทะเบียนหนังสือเสร็จแล้ว
// ยังต้องไปพิมพ์บอกในกลุ่มไลน์อีกทีว่า "หนังสือเรื่องนี้มาแล้วนะ" ซึ่งพิมพ์เองทุกครั้งก็ตกหล่น
// เลขที่ผิด ชื่อเรื่องพิมพ์ย่อจนหาไม่เจอ และไม่มีลิงก์กลับมาที่ตัวเรื่องจริง
//
// ปุ่มนี้ประกอบข้อความให้เสร็จ แล้วเปิดหน้าต่างแชร์ของ LINE ให้เลือกกลุ่มเอง — ไม่ต้องตั้งค่าอะไรเลย
// ไม่ต้องมี LINE Official Account ไม่ต้องมี token ใช้ได้ทันทีตั้งแต่วันแรก
//
// เรื่องที่ห้ามพลาด: ข้อความที่แชร์ไปอยู่ในกลุ่มไลน์ซึ่งระบบคุมสิทธิ์ไม่ได้ — ใครอยู่ในกลุ่มก็เห็นหมด
// ตัวลิงก์ปลอดภัยอยู่แล้วเพราะกดเข้ามาต้องล็อกอินและระบบเช็คสิทธิ์รายฉบับเหมือนเดิม แต่ "ชื่อเรื่อง"
// ที่อยู่ในตัวข้อความไม่ผ่านการเช็คสิทธิ์ใดๆ ทั้งสิ้น หนังสือชั้นความลับจึงแชร์ไม่ได้ (ดู canShareToLine)
// ซึ่งตรงกับที่ระบบห้ามกด "ประชาสัมพันธ์ให้ทุกคน" กับหนังสือลับอยู่แล้ว
import { absoluteUrl } from './publicUrl.js';
import { fmtThaiDateShort, daysUntil, esc } from '../render.js';

// ชั้นความลับที่ห้ามเอาชื่อเรื่องออกนอกระบบ — ระเบียบว่าด้วยการรักษาความลับของทางราชการ
// กำหนดช่องทางส่งหนังสือลับไว้เฉพาะ กลุ่มไลน์ไม่ใช่หนึ่งในนั้น
const SECRET_LEVELS_NO_SHARE = ['secret', 'top_secret'];

/** แชร์เรื่องนี้เข้าไลน์ได้ไหม — ห้ามเฉพาะหนังสือลับ และหนังสือที่ไม่มีตัวตนให้เปิดดูแล้ว */
export function canShareToLine(doc) {
  if (!doc) return false;
  if (SECRET_LEVELS_NO_SHARE.includes(doc.secret_level)) return false;
  // ทำลายตามระเบียบไปแล้ว/ยกเลิกไปแล้ว — ส่งลิงก์ไปก็ไม่มีอะไรให้อ่าน มีแต่ทำให้เข้าใจผิดว่ายังต้องทำ
  if (['destroyed', 'voided'].includes(doc.status)) return false;
  return true;
}

// LINE ตัดข้อความที่ยาวเกินทิ้ง และที่อยู่เว็บ (URL) ที่ยาวมากๆ ก็มีโอกาสโดนเบราว์เซอร์ตัดกลางทาง
// ชื่อเรื่องหนังสือราชการไทยยาวได้มาก (เช่น "ขอความอนุเคราะห์บุคลากร...") จึงตัดที่ความยาวที่อ่านรู้เรื่อง
const MAX_TITLE_IN_SHARE = 120;
function clip(s, max) {
  const t = String(s || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * ข้อความที่จะไปโผล่ในกลุ่มไลน์
 *
 * รูปแบบตั้งใจให้อ่านจบได้จากหน้าตัวอย่างของ LINE โดยไม่ต้องกดเข้ามา — บรรทัดแรกคือเลขที่กับชื่อเรื่อง
 * เพราะนั่นคือสิ่งที่ครูใช้ตามหาเรื่องจริงๆ ส่วนลิงก์อยู่บรรทัดสุดท้ายเสมอ (LINE ทำตัวอย่างลิงก์ให้
 * เฉพาะ URL ตัวสุดท้ายในข้อความ)
 */
export function documentShareText(doc) {
  const lines = [];
  lines.push(`📄 ${doc.doc_number_display || ''} ${clip(doc.title, MAX_TITLE_IN_SHARE)}`.trim());
  if (doc.correspondent_name) lines.push(`จาก: ${clip(doc.correspondent_name, 80)}`);
  if (doc.due_date) lines.push(`⏰ ครบกำหนด ${fmtThaiDateShort(doc.due_date)}`);
  const url = absoluteUrl(`/documents/${doc.id}`);
  lines.push(`เปิดอ่านในระบบสารบรรณ (ต้องเข้าสู่ระบบก่อน):`);
  lines.push(url);
  return lines.join('\n');
}

/**
 * ข้อความ "ตามเรื่องที่ค้าง" — บอกว่าตอนนี้หนังสือค้างอยู่ที่ใคร และขอให้เข้าไปดำเนินการต่อ
 *
 * ทำไมต้องมีแยกจาก documentShareText: ข้อความแชร์ปกติคือ "มีหนังสือเข้าใหม่นะ" ซึ่งส่งตอนลงทะเบียน
 * เสร็จ แต่งานที่ธุรการต้องทำซ้ำๆ ทุกสัปดาห์คือ "เรื่องนี้ค้างอยู่ที่ใคร แล้วไปตามให้เขาทำ" — ซึ่งเดิม
 * ต้องเปิดไทม์ไลน์ดูเอง จำชื่อไว้ แล้วไปพิมพ์ในกลุ่มไลน์เองทุกครั้ง ตกหล่นและพิมพ์ผิดชื่อได้ง่าย
 *
 * ถ้อยคำใช้แบบหนังสือราชการ ไม่ใส่ครับ/ค่ะ เพราะคนกดส่งเป็นได้ทั้งธุรการ หัวหน้าฝ่าย และ ผอ.
 * ข้อความเดียวกันจึงต้องสุภาพและใช้ได้กับทุกคนที่กดส่ง
 *
 * หนังสือชั้นความลับใช้เกณฑ์เดียวกับการแจ้งเตือนทางไลน์ (composeLineMessage) คือบอกได้แค่ว่า
 * "มีหนังสือลับรอท่านดำเนินการ" ห้ามมีเลขที่และชื่อเรื่องติดออกไปนอกระบบ
 */
export function pendingReminderText(doc, waiting = []) {
  const who = waiting
    .map((w) => (w.position ? `${w.name} (${clip(w.position, 40)})` : w.name))
    .filter(Boolean).join('  ');
  const lines = [];
  if (SECRET_LEVELS_NO_SHARE.includes(doc.secret_level)) {
    lines.push('🔒 แจ้งเรื่องที่รอดำเนินการ');
    if (who) lines.push(`เรียน ${who}`);
    lines.push('มีหนังสือชั้นความลับรอท่านดำเนินการ — ไม่แสดงเลขที่และชื่อเรื่องนอกระบบ ตามระเบียบว่าด้วยการรักษาความลับของทางราชการ');
  } else {
    lines.push(`📄 ${doc.doc_number_display || ''} ${clip(doc.title, MAX_TITLE_IN_SHARE)}`.trim());
    if (who) lines.push(`เรียน ${who}`);
    lines.push('ขณะนี้หนังสือฉบับนี้อยู่ระหว่างรอท่านดำเนินการ');
  }
  if (doc.due_date) lines.push(dueLine(doc.due_date));
  lines.push('จึงเรียนมาเพื่อโปรดเข้าไปอ่านและดำเนินการต่อในระบบสารบรรณ จะขอบคุณยิ่ง');
  lines.push('เปิดอ่านในระบบสารบรรณ (ต้องเข้าสู่ระบบก่อน):');
  lines.push(absoluteUrl(`/documents/${doc.id}`));
  return lines.join('\n');
}

/** บรรทัดบอกวันครบกำหนดแบบสั้น ใช้ทั้งข้อความตามเรื่องเดี่ยวและแบบรวม */
function dueLine(dueDate) {
  if (!dueDate) return '';
  const n = daysUntil(dueDate);
  const when = fmtThaiDateShort(dueDate);
  if (n < 0) return `⏰ ครบกำหนด ${when} (เลยกำหนดมาแล้ว ${Math.abs(n)} วัน)`;
  if (n === 0) return `⏰ ครบกำหนดวันนี้ (${when})`;
  return `⏰ ครบกำหนด ${when} (อีก ${n} วัน)`;
}

/**
 * ข้อความตามงานค้าง "ทีเดียวทั้งหมด" — รวมทุกเรื่องที่ยังค้าง จัดกลุ่มตามคนที่ต้องดำเนินการ
 *
 * ทำไมต้องมีทั้งที่ตามรายฉบับได้แล้ว: ปลายสัปดาห์เรื่องค้างพร้อมกันสิบกว่าฉบับเป็นเรื่องปกติ การตาม
 * ทีละฉบับคือการยิงเข้ากลุ่มสิบกว่าข้อความติดกัน ซึ่งกลบข้อความอื่นในกลุ่มจนคนเลื่อนผ่าน และธุรการ
 * ก็ไม่ทำจริงเพราะเสียเวลา — ข้อความเดียวที่จัดกลุ่มว่า "ใครค้างอะไรบ้าง" อ่านแล้วรู้เรื่องกว่ามาก
 *
 * groups = [{ name, position, docs: [{ number, title, dueDate, secret }] }]
 */
export function pendingDigestText(groups, dateLabel, { hiddenCount = 0 } = {}) {
  const total = groups.reduce((s, g) => s + g.docs.length, 0);
  const lines = [`⏳ หนังสือที่รอดำเนินการ ณ วันที่ ${dateLabel} — ${total + hiddenCount} ฉบับ`];
  groups.forEach((g) => {
    lines.push('');
    lines.push(`เรียน ${g.position ? `${g.name} (${clip(g.position, 40)})` : g.name}`);
    g.docs.forEach((d, i) => {
      // หนังสือลับบอกได้แค่ว่ามี ไม่บอกเลขที่และชื่อเรื่อง — เกณฑ์เดียวกับการแชร์รายฉบับ
      const head = d.secret ? '🔒 หนังสือชั้นความลับ (ดูในระบบ)' : `${d.number || ''} ${clip(d.title, 90)}`.trim();
      const due = d.secret ? '' : dueLine(d.dueDate);
      lines.push(`${i + 1}. ${head}${due ? ` ${due}` : ''}`);
    });
  });
  if (hiddenCount > 0) lines.push('', `(และอีก ${hiddenCount} ฉบับ — ดูทั้งหมดในระบบ)`);
  lines.push('');
  lines.push('จึงเรียนมาเพื่อโปรดเข้าไปอ่านและดำเนินการต่อในระบบสารบรรณ จะขอบคุณยิ่ง');
  lines.push('เปิดงานที่รอท่านดำเนินการ:');
  lines.push(absoluteUrl('/tasks'));
  return lines.join('\n');
}

/** ข้อความประกาศ/ประชาสัมพันธ์ที่จะไปโผล่ในกลุ่มไลน์ */
export function announcementShareText(ann) {
  const lines = [];
  lines.push(`📢 ${clip(ann.title, MAX_TITLE_IN_SHARE)}`);
  if (ann.category) lines.push(`ประเภท: ${clip(ann.category, 40)}`);
  lines.push('เปิดอ่านในระบบสารบรรณ (ต้องเข้าสู่ระบบก่อน):');
  lines.push(absoluteUrl(`/announcements/${ann.id}`));
  return lines.join('\n');
}

/**
 * ที่อยู่ที่กดแล้วเปิดหน้าต่าง "แชร์ไปที่..." ของ LINE พร้อมข้อความที่เตรียมไว้
 *
 * ใช้ line.me/R/share ไม่ใช่ line.me/R/msg/text/ เพราะ /share เปิดหน้าให้เลือกกลุ่ม/คนที่จะส่ง
 * ส่วน /msg/text/ เปิดแชทล่าสุดขึ้นมาเลย ซึ่งเสี่ยงส่งผิดห้อง
 *
 * บนคอมพิวเตอร์ที่ไม่ได้ติดตั้ง LINE ลิงก์นี้จะพาไปหน้าเว็บของ LINE ที่บอกให้เปิดในแอป — ไม่พัง
 * แค่ต้องไปทำต่อบนมือถือ จึงมีข้อความบอกไว้ที่ปุ่มด้วย
 */
export function lineShareUrl(text) {
  return `https://line.me/R/share?text=${encodeURIComponent(String(text || ''))}`;
}

/**
 * ปุ่มส่งเข้าไลน์ + ปุ่มคัดลอกข้อความ + ช่องข้อความจริงให้ดู/คัดลอกเอง
 *
 * ปุ่มคัดลอกเป็นปุ่มหลัก ไม่ใช่ปุ่มสำรอง: ปุ่ม "ส่งเข้าไลน์" เปิดหน้าต่างแชร์ของ *แอป LINE* ซึ่งบนมือถือ
 * ที่ติดตั้งแอปไว้ก็จบในปุ่มเดียว แต่เครื่องที่ธุรการใช้ลงทะเบียนหนังสือจริงๆ คือคอมพิวเตอร์ ซึ่งเปิดได้แค่
 * หน้าเว็บของ LINE ที่บอกให้ไปทำต่อในแอป — ไม่มีข้อความอะไรมาให้เลย ต่อไม่ติดตรงนั้นพอดี (ผู้ใช้แจ้ง
 * เข้ามาเองว่า "กดส่งเข้าไลน์แล้วไม่มีข้อความให้ copy") และที่สำคัญกว่านั้นคือโรงเรียนมีช่องทางส่งให้ครู
 * ของตัวเองอยู่แล้ว (กลุ่มไลน์ที่เปิดบนคอม/ช่องทางอื่น) สิ่งที่ต้องการจริงๆ จึงเป็น "ข้อความที่คัดลอกได้"
 * ไม่ใช่การให้ระบบพาไปส่งเอง — ปุ่มคัดลอกจึงมาก่อนและเป็นปุ่มเด่น ส่วนปุ่มไลน์เป็นทางลัดสำหรับมือถือ
 *
 * ช่องข้อความ (details/textarea) มีไว้สองอย่าง: ให้เห็นก่อนส่งว่าจะไปโผล่ในกลุ่มว่าอย่างไร และเป็น
 * ทางสำรองเวลาคัดลอกอัตโนมัติไม่ได้ (เว็บที่ไม่ใช่ https คัดลอกด้วยสคริปต์ไม่ได้เลย)
 *
 * key ต้องไม่ซ้ำกันในหน้าเดียวกัน เพราะเอาไปทำ id ของช่องข้อความ
 */
export function lineShareBlock({ key, text, copyLabel = '📋 คัดลอกข้อความ', lineLabel = '💬 ส่งเข้าไลน์', primary = false, title = '', inline = false }) {
  const id = `shareText-${String(key).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const rows = Math.min(12, Math.max(3, String(text || '').split('\n').length + 1));
  const buttons = `<button class="btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm" type="button"
        data-share-text="${esc(text)}" data-share-box="${id}"
        title="${esc(title || 'คัดลอกข้อความไปวางในช่องทางที่ใช้ส่งให้ครู — ใช้ได้ทั้งบนคอมและมือถือ')}"
        onclick="window.copyShareText(this)">${copyLabel}</button>
      <a class="btn btn-outline btn-sm" href="${esc(lineShareUrl(text))}" target="_blank" rel="noopener"
        title="ทางลัดสำหรับมือถือที่มีแอป LINE — เปิดหน้าต่างแชร์พร้อมข้อความนี้ให้เลือกกลุ่ม">${lineLabel}</a>`;
  // flex-basis:100% = ช่องข้อความลงไปอยู่บรรทัดของตัวเองเสมอ เวลาวางปนกับปุ่มอื่นในแถวเดียวกัน
  const box = `<details style="${inline ? 'flex-basis:100%;margin:0' : 'margin-top:.4rem'}">
      <summary class="text-muted" style="font-size:.82rem;cursor:pointer">ดูข้อความที่จะส่ง</summary>
      <textarea id="${id}" readonly rows="${rows}" onclick="this.select()"
        style="width:100%;margin-top:.4rem;font:inherit;font-size:.85rem">${esc(text)}</textarea>
    </details>`;
  return inline ? `${buttons}\n    ${box}` : `<div class="chip-row">\n      ${buttons}\n    </div>\n    ${box}`;
}

/**
 * สรุปหนังสือเข้าของวัน สำหรับส่งเข้ากลุ่มไลน์ทีเดียวจบ
 *
 * ทำไมต้องมีทั้งที่แชร์รายฉบับได้อยู่แล้ว: วันที่มีหนังสือเข้า 5-6 ฉบับ การแชร์ทีละฉบับคือการยิงเข้ากลุ่ม
 * 6 ข้อความติดกัน ซึ่งกลบข้อความอื่นในกลุ่มจนคนเลื่อนผ่าน และธุรการก็ไม่ทำจริงเพราะเสียเวลา
 * — สรุปรวมข้อความเดียวอ่านจบได้ในตัวอย่างของ LINE โดยไม่ต้องกดเข้ามา
 *
 * หนังสือชั้นความลับถูกคัดออกด้วยเกณฑ์เดียวกับการแชร์รายฉบับ (canShareToLine) เพราะข้อความในกลุ่มไลน์
 * ไม่ผ่านการตรวจสิทธิ์ใดๆ ทั้งสิ้น ใครอยู่ในกลุ่มก็เห็นชื่อเรื่องหมด
 */
export function incomingDigestText(docs, dateLabel) {
  const shareable = (docs || []).filter(canShareToLine);
  const lines = [`📥 หนังสือเข้าวันที่ ${dateLabel} — ${shareable.length} ฉบับ`];
  shareable.forEach((d, i) => {
    lines.push(`${i + 1}. ${d.doc_number_display || ''} ${clip(d.title, 90)}`.trim());
    if (d.correspondent_name) lines.push(`    จาก ${clip(d.correspondent_name, 60)}`);
  });
  const hidden = (docs || []).length - shareable.length;
  // ต้องบอกว่ามีที่ไม่ได้อยู่ในรายการ ไม่ใช่เงียบ — ไม่งั้นคนอ่านจะนับจำนวนผิดแล้วคิดว่าครบแล้ว
  if (hidden > 0) lines.push(`(อีก ${hidden} ฉบับเป็นหนังสือชั้นความลับ ดูได้ในระบบเท่านั้น)`);
  lines.push('');
  lines.push('เปิดทะเบียนหนังสือเข้าในระบบ (ต้องเข้าสู่ระบบก่อน):');
  lines.push(absoluteUrl('/documents?direction=incoming'));
  return lines.join('\n');
}
