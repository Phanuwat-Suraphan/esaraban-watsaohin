// ทะเบียนคำสั่งและประกาศของโรงเรียน
//
// คำสั่งโรงเรียนเป็นหนังสือสั่งการที่โรงเรียนออกเอง ("คำสั่งโรงเรียนวัดเสาหิน ที่ 45/2569 เรื่อง แต่งตั้ง
// คณะกรรมการดำเนินงานวันเด็ก") โรงเรียนหนึ่งออกเดือนละหลายฉบับ — แต่งตั้งกรรมการ เวรรักษาการณ์
// มอบหมายงาน ไปราชการ ทั้งหมดนี้มี "เล่มทะเบียนคำสั่ง" ของตัวเอง เรียงเลข 1 ไปจนสิ้นปีปฏิทิน
// ไม่กินเลขทะเบียนหนังสือส่ง ส่วนประกาศโรงเรียนเป็นอีกเล่มหนึ่งแยกจากคำสั่งอีกที
//
// สองปัญหาที่ระบบนี้แก้ (ทั้งคู่เจอในโรงเรียนจริงทั้งนั้น):
//   1. เลขคำสั่งซ้ำ/ข้าม เพราะเล่มทะเบียนเป็นสมุดเขียนมือที่ใครหยิบไปก็ได้ แล้วคนสองคนเขียนเลขเดียวกัน
//      — คำสั่งที่มีเลขซ้ำกันสองฉบับใช้อ้างอิงไม่ได้เลย และแก้ย้อนหลังไม่ได้เพราะแจกออกไปแล้ว
//   2. ครูที่ชื่ออยู่ในคำสั่งไม่รู้ตัว เพราะคำสั่งติดไว้ที่บอร์ดหรืออยู่ในแฟ้มห้องธุรการ
//      — ระบบจึงให้ระบุ "ผู้ที่ต้องทราบ" แล้วแจ้งเตือนถึงตัว และบอกได้ว่าใครเปิดอ่านแล้วหรือยัง
import { db, uuid, nowIso, audit, beYear } from '../db.js';
import { httpError, asText, asTextOrNull, assertMaxLength } from './validate.js';
import { notifyUser } from './notify.js';
import { fileKindOf, ALLOWED_LABEL } from './attachments.js';
import { truncateFilename } from '../router.js';

/**
 * เล่มทะเบียน — คำสั่งกับประกาศนับเลขแยกกัน ทั้งสองเล่มจึงมีเลข 1 ของตัวเองได้พร้อมกัน ไม่ถือว่าซ้ำ
 *
 * `noun` ใช้ประกอบข้อความที่ผู้ใช้อ่าน ("คำสั่งที่ 45/2569") จึงต้องอ่านเป็นภาษาไทยได้ตรงๆ
 * ไม่ใช่เอาโค้ดภาษาอังกฤษไปต่อกับข้อความเอง
 */
export const ORDER_KINDS = [
  { code: 'order', noun: 'คำสั่ง', label: 'คำสั่งโรงเรียน', icon: '📜' },
  { code: 'notice', noun: 'ประกาศ', label: 'ประกาศโรงเรียน', icon: '📣' },
];
const KIND_CODES = new Set(ORDER_KINDS.map((k) => k.code));
export const kindOf = (code) => ORDER_KINDS.find((k) => k.code === code) || null;
export const kindNoun = (code) => kindOf(code)?.noun || 'คำสั่ง';

/**
 * ใครออกเลขคำสั่ง/ประกาศได้ — ชุดเดียวกับผู้ที่แจ้งเวียนหนังสือได้
 *
 * ในทางปฏิบัติธุรการเป็นคนพิมพ์และออกเลขให้ ส่วน ผอ./รอง ผอ. เป็นผู้ลงนาม แต่เปิดให้ผู้บริหาร
 * ออกเลขเองได้ด้วยจะได้ไม่ติดขัดเวลาธุรการไม่อยู่ (คำสั่งเวรรักษาการณ์ต้องออกก่อนวันหยุดเสมอ)
 */
const MANAGE_ROLES = ['admin', 'director', 'vice_director', 'registrar'];
export const canManageOrders = (user) => user.roleCodes.some((r) => MANAGE_ROLES.includes(r));

const MAX_SUBJECT = 500;
const MAX_NOTE = 1000;
const MAX_REASON = 500;
// คำสั่งบางฉบับ (เวรรักษาการณ์ มอบหมายงานตามโครงสร้าง) ระบุชื่อครูทั้งโรงเรียน เพดานนี้จึงต้องกว้าง
// กว่าจำนวนบุคลากรของโรงเรียนขนาดใหญ่ มีไว้กันการยิง API ด้วยรายการเป็นพันเท่านั้น
export const MAX_ORDER_RECIPIENTS = 300;
/**
 * ไฟล์คำสั่งที่ลงนามแล้ว เก็บเป็นก้อนข้อมูลในฐานข้อมูล (ดูเหตุผลใน db.js) ซึ่งฐานข้อมูลทั้งไฟล์ถูกสำรอง
 * ขึ้น Google Drive ทุกรอบ — คำสั่งของจริงเป็น PDF ไม่กี่หน้า ขนาดหลักร้อยกิโลไบต์
 */
const MAX_ORDER_FILE_BYTES = 5 * 1024 * 1024;

/**
 * ออกเลขถัดไปแบบอะตอมมิก — กติกาเดียวกับเลขทะเบียนหนังสือ (ดู numbering.js)
 *
 * ปีแรกที่ยังไม่มีตัวนับต้องเริ่มนับต่อจากเลขสูงสุดที่เคยออกไปแล้วจริง รวมฉบับที่ถูกลบไปแล้วด้วย —
 * เลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ เพราะคำสั่งฉบับนั้นแจกออกไปและถูกอ้างอิงในที่อื่นแล้ว
 */
function nextOrderNumber(kind, year) {
  const existing = db.prepare('SELECT running_number FROM school_order_counters WHERE year_be = ? AND kind = ?')
    .get(year, kind);
  let next;
  if (existing) {
    next = existing.running_number + 1;
    db.prepare('UPDATE school_order_counters SET running_number = ? WHERE year_be = ? AND kind = ?')
      .run(next, year, kind);
  } else {
    const issued = db.prepare('SELECT COALESCE(MAX(running_number), 0) m FROM school_orders WHERE year_be = ? AND kind = ?')
      .get(year, kind).m;
    next = issued + 1;
    db.prepare('INSERT INTO school_order_counters (year_be, kind, running_number) VALUES (?, ?, ?)')
      .run(year, kind, next);
  }
  return next;
}

/**
 * รูปแบบเลขที่ — "45/2569" ไม่เติมศูนย์นำหน้า
 *
 * ต่างจากเลขทะเบียนหนังสือรับที่เขียน 0045/2569 เพราะบนหัวคำสั่งจริงเขียน "ที่ 45/2569" ตรงๆ
 * (เทียบกับสมุดทะเบียนคำสั่งของโรงเรียน) ถ้าเติมศูนย์ให้ เลขในระบบจะไม่ตรงกับเลขบนกระดาษที่แจกไปแล้ว
 */
export const formatOrderNumber = (runningNumber, year) => `${runningNumber}/${year}`;

/** เลขถัดไปที่จะได้ — โชว์ในฟอร์มก่อนกดบันทึก ไม่แตะตัวนับจริง */
export function previewOrderNumber(kind, year = beYear()) {
  const counter = db.prepare('SELECT running_number FROM school_order_counters WHERE year_be = ? AND kind = ?')
    .get(year, kind);
  const issued = db.prepare('SELECT COALESCE(MAX(running_number), 0) m FROM school_orders WHERE year_be = ? AND kind = ?')
    .get(year, kind).m;
  return formatOrderNumber((counter ? counter.running_number : issued) + 1, year);
}

function activeUserIds(ids) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  if (!list.length) return [];
  if (list.length > MAX_ORDER_RECIPIENTS) {
    throw httpError(400, `ระบุผู้ที่ต้องทราบได้ไม่เกิน ${MAX_ORDER_RECIPIENTS} คน`);
  }
  const placeholders = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders})
    AND deleted_at IS NULL AND status = 'active'`).all(...list);
  const found = new Set(rows.map((r) => r.id));
  const missing = list.filter((id) => !found.has(id));
  if (missing.length) throw httpError(400, `มีผู้รับ ${missing.length} คนที่ไม่พบในระบบ หรือบัญชีถูกปิดใช้งานแล้ว`);
  return list;
}

/**
 * บันทึกคำสั่ง/ประกาศพร้อมออกเลขให้
 *
 * ทุกอย่างอยู่ในธุรกรรมเดียว รวมทั้งการตรวจไฟล์แนบ — ถ้าไฟล์ที่แนบมาไม่ผ่าน (ชนิดผิด/ลายเซ็นไม่ตรง)
 * ต้องไม่กินเลขคำสั่งทิ้งไว้ ไม่งั้นทะเบียนจะมีเลขขาดหายโดยที่ไม่มีคำสั่งฉบับนั้นอยู่จริง แล้วต้องมาไล่
 * อธิบายทีหลังว่าเลข 46 หายไปไหน (ซึ่งเป็นสิ่งที่ตัวตรวจทะเบียนจะฟ้องขึ้นมาเองด้วย)
 */
export function createSchoolOrder({ kind, subject, signedDate, signerId, note, recipientIds, file, actorUser }) {
  if (!canManageOrders(actorUser)) throw httpError(403, 'ออกเลขคำสั่ง/ประกาศได้เฉพาะธุรการและผู้บริหารเท่านั้น');
  if (!KIND_CODES.has(kind)) throw httpError(400, 'ประเภท (คำสั่ง/ประกาศ) ไม่ถูกต้อง');
  subject = asText(subject);
  if (!subject) throw httpError(400, 'กรุณากรอกเรื่อง');
  assertMaxLength(subject, MAX_SUBJECT, 'เรื่อง');
  note = asTextOrNull(note);
  assertMaxLength(note, MAX_NOTE, 'หมายเหตุ');
  signedDate = asTextOrNull(signedDate);
  if (signedDate && !/^\d{4}-\d{2}-\d{2}$/.test(signedDate)) throw httpError(400, 'วันที่ลงนามไม่ถูกต้อง');
  if (signerId) {
    const signer = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(signerId);
    if (!signer) throw httpError(400, 'ไม่พบผู้ลงนามที่เลือก หรือบัญชีนั้นถูกปิดใช้งานแล้ว');
  }
  const recipients = activeUserIds(recipientIds);
  // ตรวจไฟล์ให้จบก่อนเริ่มธุรกรรม เพื่อไม่ให้การแนบไฟล์ผิดชนิดกินเลขคำสั่งทิ้ง
  const prepared = file ? prepareOrderFile(file) : null;

  const year = beYear();
  const id = uuid();
  let running;
  db.exec('BEGIN IMMEDIATE');
  try {
    running = nextOrderNumber(kind, year);
    db.prepare(`
      INSERT INTO school_orders (id, kind, running_number, year_be, number_display, subject, signed_date, signer_id, note, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, kind, running, year, formatOrderNumber(running, year), subject, signedDate || null,
      signerId || null, note, actorUser.id, nowIso(), nowIso());
    for (const userId of recipients) {
      db.prepare('INSERT INTO school_order_recipients (order_id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, userId, nowIso());
    }
    if (prepared) storeOrderFile(id, prepared);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const numberDisplay = formatOrderNumber(running, year);
  audit({
    userId: actorUser.id, action: 'school_order_created', tableName: 'school_orders', recordId: id,
    detail: { kind, numberDisplay, subject, recipients: recipients.length, hasFile: Boolean(prepared) },
  });
  notifyRecipients({ orderId: id, kind, numberDisplay, subject, userIds: recipients, actorUser });
  return { id, numberDisplay, runningNumber: running, yearBe: year };
}

/**
 * แจ้งผู้ที่ต้องทราบทีละคน — ตั้งใจให้เป็นข้อความต่อคน ไม่ใช่ข้อความสรุปรวมเหมือนการมอบหมายเป็นชุด
 *
 * เพราะเป็นคนละเรื่องกัน: คำสั่งหนึ่งฉบับถึงครูหนึ่งคนคือหนึ่งข้อความอยู่แล้ว (ไม่ใช่ครูคนเดียวได้
 * สิบข้อความ) ถ้ายุบรวมก็ไม่มีอะไรให้ยุบ — ส่วนที่ต้องระวังคือการออกคำสั่งรัวๆ ทีละฉบับ ซึ่งจำนวน
 * คำสั่งของจริงไม่กี่ฉบับต่อเดือน
 */
function notifyRecipients({ orderId, kind, numberDisplay, subject, userIds, actorUser }) {
  const noun = kindNoun(kind);
  for (const userId of userIds) {
    if (userId === actorUser.id) continue; // คนที่ออกเลขเองไม่ต้องแจ้งตัวเอง
    notifyUser({
      userId,
      linkUrl: `/orders/${orderId}`,
      title: `${noun}ที่ ${numberDisplay} — มีชื่อท่านอยู่ในเอกสารนี้`,
      message: subject,
      priority: 'info',
    });
  }
}

function prepareOrderFile({ fileName, fileType, fileDataBase64 }) {
  if (!fileDataBase64) return null;
  const kind = fileKindOf(fileType);
  if (!kind) throw httpError(400, `ชนิดไฟล์นี้แนบไม่ได้ — รับเฉพาะ ${ALLOWED_LABEL}`);
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (!buf.length) throw httpError(400, 'ไฟล์ที่แนบมาไม่มีข้อมูล (0 ไบต์) — อาจสแกนไม่สำเร็จหรือไฟล์เสียหาย');
  if (buf.length > MAX_ORDER_FILE_BYTES) throw httpError(413, 'ไฟล์คำสั่งต้องไม่เกิน 5MB');
  // ตรวจลายเซ็นไฟล์จริง ไม่ใช่เชื่อ MIME ที่แจ้งมา (เกณฑ์เดียวกับไฟล์แนบของหนังสือ)
  if (!kind.sig(buf)) {
    throw httpError(400, `ไฟล์นี้ไม่ใช่ ${kind.label} ที่ถูกต้อง (ตรวจลายเซ็นไฟล์ไม่ผ่าน) — ถ้าเปลี่ยนนามสกุลไฟล์เอง ให้บันทึกเป็นชนิดที่ถูกต้องก่อน`);
  }
  return { filename: truncateFilename(asText(fileName)) || `document.${kind.ext}`, mimeType: fileType, buf };
}

function storeOrderFile(orderId, prepared) {
  const id = uuid();
  db.prepare(`INSERT INTO school_order_files (id, order_id, filename, mime_type, filesize, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orderId, prepared.filename, prepared.mimeType, prepared.buf.length, prepared.buf, nowIso());
  return id;
}

/** แนบไฟล์คำสั่งที่ลงนามแล้วเพิ่มภายหลัง — ตอนออกเลขมักยังไม่มีไฟล์ที่ ผอ. ลงนามแล้ว */
export function addOrderFile({ orderId, file, actorUser }) {
  if (!canManageOrders(actorUser)) throw httpError(403, 'แนบไฟล์คำสั่งได้เฉพาะธุรการและผู้บริหารเท่านั้น');
  const order = getSchoolOrder(orderId);
  if (!order) throw httpError(404, 'ไม่พบคำสั่ง/ประกาศฉบับนี้');
  const prepared = prepareOrderFile(file || {});
  if (!prepared) throw httpError(400, 'ยังไม่ได้เลือกไฟล์');
  const id = storeOrderFile(orderId, prepared);
  audit({
    userId: actorUser.id, action: 'school_order_file_added', tableName: 'school_order_files', recordId: id,
    detail: { orderId, numberDisplay: order.number_display, filename: prepared.filename },
  });
  return { id };
}

export function getSchoolOrder(id) {
  return db.prepare(`
    SELECT o.*,
      s.prefix AS signer_prefix, s.first_name AS signer_first, s.last_name AS signer_last, s.position AS signer_position,
      c.prefix AS creator_prefix, c.first_name AS creator_first, c.last_name AS creator_last,
      dl.prefix AS deleter_prefix, dl.first_name AS deleter_first, dl.last_name AS deleter_last
    FROM school_orders o
    LEFT JOIN users s ON s.id = o.signer_id
    LEFT JOIN users c ON c.id = o.created_by
    LEFT JOIN users dl ON dl.id = o.deleted_by
    WHERE o.id = ? AND o.deleted_at IS NULL
  `).get(id);
}

export const orderFiles = (orderId) => db.prepare(`
  SELECT id, order_id, filename, mime_type, filesize, created_at FROM school_order_files
  WHERE order_id = ? ORDER BY created_at, rowid
`).all(orderId);

export const getOrderFile = (fileId) => db.prepare('SELECT * FROM school_order_files WHERE id = ?').get(fileId);

export const orderRecipients = (orderId) => db.prepare(`
  SELECT r.*, u.prefix, u.first_name, u.last_name, u.position
  FROM school_order_recipients r JOIN users u ON u.id = r.user_id
  WHERE r.order_id = ? ORDER BY r.opened_at IS NULL DESC, u.first_name
`).all(orderId);

/**
 * บันทึกว่าผู้ที่ต้องทราบเปิดอ่านแล้ว — เขียนครั้งแรกครั้งเดียว
 *
 * ไม่ทับเวลาเดิมเมื่อเปิดซ้ำ เพราะที่ต้องตอบได้คือ "รู้เรื่องนี้ตั้งแต่เมื่อไร" ไม่ใช่ "เปิดล่าสุดเมื่อไร"
 */
export function markOrderOpened(orderId, userId) {
  return db.prepare(`UPDATE school_order_recipients SET opened_at = ?
    WHERE order_id = ? AND user_id = ? AND opened_at IS NULL`).run(nowIso(), orderId, userId).changes > 0;
}

/** จำนวนคำสั่งที่ยังไม่ได้เปิดอ่านของคนนี้ — ใช้ขึ้นตัวเลขข้างเมนู */
export const unreadOrderCount = (userId) => db.prepare(`
  SELECT COUNT(*) c FROM school_order_recipients r JOIN school_orders o ON o.id = r.order_id
  WHERE r.user_id = ? AND r.opened_at IS NULL AND o.deleted_at IS NULL
`).get(userId).c;

function listQuery({ kind, year, q, mine, userId }) {
  const where = ['o.deleted_at IS NULL'];
  const params = {};
  if (kind && KIND_CODES.has(kind)) { where.push('o.kind = :kind'); params.kind = kind; }
  if (year) { where.push('o.year_be = :year'); params.year = Number(year); }
  if (q) {
    where.push('(o.subject LIKE :like OR o.number_display LIKE :like OR o.note LIKE :like)');
    params.like = `%${q}%`;
  }
  if (mine) {
    where.push('EXISTS (SELECT 1 FROM school_order_recipients r WHERE r.order_id = o.id AND r.user_id = :me)');
    params.me = userId;
  }
  return { whereSql: where.join(' AND '), params };
}

export function countSchoolOrders(filters) {
  const { whereSql, params } = listQuery(filters);
  return db.prepare(`SELECT COUNT(*) c FROM school_orders o WHERE ${whereSql}`).get(params).c;
}

export function listSchoolOrders(filters, { limit = 50, offset = 0 } = {}) {
  const { whereSql, params } = listQuery(filters);
  return db.prepare(`
    SELECT o.*,
      s.prefix AS signer_prefix, s.first_name AS signer_first, s.last_name AS signer_last,
      (SELECT COUNT(*) FROM school_order_files f WHERE f.order_id = o.id) AS file_count,
      (SELECT COUNT(*) FROM school_order_recipients r WHERE r.order_id = o.id) AS recipient_count,
      (SELECT COUNT(*) FROM school_order_recipients r WHERE r.order_id = o.id AND r.opened_at IS NOT NULL) AS opened_count
    FROM school_orders o
    LEFT JOIN users s ON s.id = o.signer_id
    WHERE ${whereSql}
    ORDER BY o.year_be DESC, o.running_number DESC
    LIMIT :limit OFFSET :offset
  `).all({ ...params, limit, offset });
}

/** ปีที่มีคำสั่ง/ประกาศอยู่จริง — ใช้ทำตัวเลือกปีในทะเบียน ไม่ใช่ไล่ปีเดาเอง */
export const listOrderYears = (kind) => db.prepare(`
  SELECT DISTINCT year_be FROM school_orders
  WHERE deleted_at IS NULL ${kind ? 'AND kind = ?' : ''} ORDER BY year_be DESC
`).all(...(kind ? [kind] : [])).map((r) => r.year_be);

/**
 * ลบคำสั่ง/ประกาศ — ลบแบบซ่อน และเลขไม่ถูกนำกลับมาใช้ซ้ำ
 *
 * ตัวนับไม่ถอยกลับโดยเจตนา: คำสั่งที่ออกเลขไปแล้วมักถูกแจกและอ้างอิงไปแล้ว การเอาเลขนั้นกลับมาใช้
 * กับคำสั่งฉบับใหม่จะทำให้มีคำสั่งสองฉบับที่เลขเดียวกันในความเป็นจริง — เลขที่ขาดหายไปจะถูกตัวตรวจ
 * ทะเบียนฟ้องขึ้นมาพร้อมบอกว่าใครลบและเพราะอะไร ซึ่งตรวจสอบย้อนหลังได้ ปลอดภัยกว่าเลขซ้ำมาก
 */
export function deleteSchoolOrder({ orderId, reason, actorUser }) {
  if (!actorUser.roleCodes.includes('admin')) throw httpError(403, 'ลบคำสั่ง/ประกาศได้เฉพาะผู้ดูแลระบบเท่านั้น');
  const order = getSchoolOrder(orderId);
  if (!order) throw httpError(404, 'ไม่พบคำสั่ง/ประกาศฉบับนี้');
  reason = asText(reason);
  if (!reason) throw httpError(400, 'กรุณาระบุเหตุผลที่ลบ — เลขที่หายไปจากทะเบียนต้องอธิบายได้ว่าหายเพราะอะไร');
  assertMaxLength(reason, MAX_REASON, 'เหตุผลที่ลบ');
  db.prepare('UPDATE school_orders SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), actorUser.id, reason, nowIso(), orderId);
  audit({
    userId: actorUser.id, action: 'school_order_deleted', tableName: 'school_orders', recordId: orderId,
    detail: { kind: order.kind, numberDisplay: order.number_display, subject: order.subject, reason },
  });
  return { numberDisplay: order.number_display, noun: kindNoun(order.kind) };
}

/** แก้ไขรายละเอียด (ไม่แก้เลข) — พิมพ์เรื่องผิดหรือใส่วันลงนามทีหลังเป็นเรื่องปกติ */
export function updateSchoolOrder({ orderId, subject, signedDate, signerId, note, actorUser }) {
  if (!canManageOrders(actorUser)) throw httpError(403, 'แก้ไขคำสั่ง/ประกาศได้เฉพาะธุรการและผู้บริหารเท่านั้น');
  const order = getSchoolOrder(orderId);
  if (!order) throw httpError(404, 'ไม่พบคำสั่ง/ประกาศฉบับนี้');
  subject = asText(subject);
  if (!subject) throw httpError(400, 'กรุณากรอกเรื่อง');
  assertMaxLength(subject, MAX_SUBJECT, 'เรื่อง');
  note = asTextOrNull(note);
  assertMaxLength(note, MAX_NOTE, 'หมายเหตุ');
  signedDate = asTextOrNull(signedDate);
  if (signedDate && !/^\d{4}-\d{2}-\d{2}$/.test(signedDate)) throw httpError(400, 'วันที่ลงนามไม่ถูกต้อง');
  if (signerId) {
    const signer = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(signerId);
    if (!signer) throw httpError(400, 'ไม่พบผู้ลงนามที่เลือก หรือบัญชีนั้นถูกปิดใช้งานแล้ว');
  }
  db.prepare(`UPDATE school_orders SET subject = ?, signed_date = ?, signer_id = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(subject, signedDate || null, signerId || null, note, nowIso(), orderId);
  audit({
    userId: actorUser.id, action: 'school_order_updated', tableName: 'school_orders', recordId: orderId,
    detail: { numberDisplay: order.number_display, before: { subject: order.subject, signedDate: order.signed_date }, after: { subject, signedDate } },
  });
  return { numberDisplay: order.number_display };
}

/** เพิ่มผู้ที่ต้องทราบภายหลัง — คำสั่งแก้ไข/เพิ่มเติมผู้ได้รับแต่งตั้งเกิดขึ้นจริงบ่อย */
export function addOrderRecipients({ orderId, userIds, actorUser }) {
  if (!canManageOrders(actorUser)) throw httpError(403, 'เพิ่มผู้ที่ต้องทราบได้เฉพาะธุรการและผู้บริหารเท่านั้น');
  const order = getSchoolOrder(orderId);
  if (!order) throw httpError(404, 'ไม่พบคำสั่ง/ประกาศฉบับนี้');
  const wanted = activeUserIds(userIds);
  if (!wanted.length) throw httpError(400, 'ยังไม่ได้เลือกผู้ที่ต้องทราบ');
  const already = new Set(db.prepare('SELECT user_id FROM school_order_recipients WHERE order_id = ?')
    .all(orderId).map((r) => r.user_id));
  const added = wanted.filter((id) => !already.has(id));
  for (const userId of added) {
    db.prepare('INSERT INTO school_order_recipients (order_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(orderId, userId, nowIso());
  }
  if (added.length) {
    audit({
      userId: actorUser.id, action: 'school_order_recipients_added', tableName: 'school_orders', recordId: orderId,
      detail: { numberDisplay: order.number_display, added: added.length },
    });
    notifyRecipients({
      orderId, kind: order.kind, numberDisplay: order.number_display, subject: order.subject,
      userIds: added, actorUser,
    });
  }
  return { added: added.length, skipped: wanted.length - added.length };
}

/**
 * ตรวจความครบถ้วนของเล่มทะเบียน — เลขขาด เลขซ้ำ และเลขที่หายไปไหน
 *
 * เหตุผลเดียวกับตัวตรวจทะเบียนหนังสือ (services/registerAudit.js): สมุดทะเบียนที่มีเลขขาดหายโดยไม่มี
 * คำอธิบายคือสิ่งที่ผู้ตรวจราชการถามถึงก่อนอย่างอื่น และธุรการต้องตอบได้ทันทีว่าเลขนั้นหายเพราะอะไร
 */
export function auditOrderRegister({ kind, year = beYear() }) {
  const rows = db.prepare(`SELECT running_number, deleted_at FROM school_orders
    WHERE kind = ? AND year_be = ? ORDER BY running_number`).all(kind, year);
  const live = rows.filter((r) => !r.deleted_at);
  const highest = rows.reduce((m, r) => Math.max(m, r.running_number), 0);
  const byNumber = new Map();
  for (const r of live) byNumber.set(r.running_number, (byNumber.get(r.running_number) || 0) + 1);

  const deleted = new Map();
  for (const r of rows.filter((x) => x.deleted_at)) deleted.set(r.running_number, true);

  const missing = [];
  for (let n = 1; n <= highest; n++) {
    if (byNumber.has(n)) continue;
    const info = deleted.has(n)
      ? db.prepare(`SELECT o.delete_reason, u.prefix, u.first_name, u.last_name FROM school_orders o
          LEFT JOIN users u ON u.id = o.deleted_by
          WHERE o.kind = ? AND o.year_be = ? AND o.running_number = ? AND o.deleted_at IS NOT NULL
          ORDER BY o.deleted_at DESC LIMIT 1`).get(kind, year, n)
      : null;
    missing.push({
      number: n,
      reason: info ? 'deleted' : 'unknown',
      deletedByName: info ? `${info.prefix || ''}${info.first_name || ''} ${info.last_name || ''}`.trim() : '',
      deleteReason: info?.delete_reason || '',
    });
  }
  const duplicates = [...byNumber.entries()].filter(([, c]) => c > 1).map(([number, count]) => ({ number, count }));
  return {
    kind, year, total: live.length, highest, missing, duplicates,
    complete: missing.length === 0 && duplicates.length === 0,
  };
}
