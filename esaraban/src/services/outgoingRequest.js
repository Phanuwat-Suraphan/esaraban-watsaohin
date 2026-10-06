// คำขอเลขหนังสือส่ง — ครูขอ ธุรการเป็นคนออกเลขให้
//
// ทำไมต้องมีขั้นตอนนี้: ตามระเบียบงานสารบรรณ ทะเบียนหนังสือส่งเป็นสมุดของเจ้าหน้าที่ธุรการ ครูที่จะส่ง
// หนังสือออกต้อง "ขอเลข" จากธุรการก่อน ไม่ใช่ดึงเลขถัดไปมาใช้เอง — เลขทะเบียนส่งที่ออกไปแล้วนำกลับมา
// ใช้ซ้ำไม่ได้ ถ้าใครก็กดออกเลขได้เอง จะเกิดเลขที่จองไว้แล้วไม่ได้ใช้จริง กลายเป็นเลขขาดหายในทะเบียน
// ที่อธิบายไม่ได้ตอนตรวจ และธุรการซึ่งเป็นผู้รับผิดชอบทะเบียนก็ไม่รู้ว่าเลขนั้นหายไปไหน
//
// สิ่งที่ห้ามพลาดในไฟล์นี้:
//   1. คำขอ "ไม่ใช่" หนังสือ และต้องยังไม่กินเลขทะเบียน จนกว่าธุรการจะกดออกเลข
//   2. ออกเลขให้คำขอเดิมซ้ำสองครั้งไม่ได้ ไม่งั้นหนังสือเรื่องเดียวจะมีสองเลข
//   3. เลขที่ออกไปแล้วยกเลิกไม่ได้ ต้องไปยกเลิกที่ตัวหนังสือ (ซึ่งบันทึกเหตุผลไว้)
import { db, uuid, nowIso, audit, getUserRoles, todayInBangkok } from '../db.js';
import { fmtThaiDateLong } from '../render.js';
import { httpError, asText, asTextOrNull, assertMaxLength, normalizeDate } from './validate.js';
import { notifyUser } from './notify.js';
import { createDocument } from './workflow.js';
import { saveAttachment } from './attachments.js';

/**
 * ประเภทเอกสารเริ่มต้นของหนังสือที่ออกจากคำขอ — หนังสือส่งของโรงเรียนคือหนังสือภายนอกเป็นหลัก
 * (ส่งถึง สพป./หน่วยงานอื่น) ถอยไปใช้ประเภทแรกที่มีถ้าโรงเรียนตั้งชื่อประเภทไว้ต่างออกไป
 * ตัวเดียวกับที่หน้าลงทะเบียนหนังสือใช้ — ต้องมีค่าเสมอ เพราะคอลัมน์นี้เป็น NOT NULL
 */
function defaultDocTypeId() {
  const row = db.prepare("SELECT id FROM document_types WHERE name = 'หนังสือภายนอก'").get()
    || db.prepare('SELECT id FROM document_types ORDER BY name LIMIT 1').get();
  if (!row) throw httpError(500, 'ไม่พบประเภทเอกสารเริ่มต้นในระบบ (ตาราง document_types ว่างเปล่า)');
  return row.id;
}

const MAX_TITLE = 300;
const MAX_NOTE = 300;

// กันคำขอค้างเป็นพันใบจากการกดซ้ำ — ถ้าค้างเกินนี้แปลว่าธุรการตามไม่ทันอยู่แล้ว
const MAX_PENDING = 200;

export const canIssueOutgoingNumber = (user) =>
  Boolean(user) && (user.roleCodes.includes('admin') || user.roleCodes.includes('registrar'));

/** ครูยื่นคำขอเลขหนังสือส่ง — ยังไม่กินเลขทะเบียน */

/** ร่างที่แนบมากับคำขอ (ไม่ดึงเนื้อไฟล์ เพราะใช้แค่ทำรายการ) */
export function listRequestDrafts(requestId) {
  return db.prepare('SELECT id, request_id, filename, mime_type, filesize, created_at FROM outgoing_request_files WHERE request_id = ? ORDER BY created_at')
    .all(requestId);
}

/** เนื้อไฟล์ของร่าง — ใช้ตอนเปิดดู/ดาวน์โหลด และตอนย้ายเข้าไฟล์แนบของหนังสือ */
export function getRequestDraft(fileId) {
  return db.prepare('SELECT * FROM outgoing_request_files WHERE id = ?').get(fileId);
}

/**
 * ชื่อผู้ขอที่เอาไปใส่ช่อง "จาก" ให้เองเมื่อไม่ได้กรอกมา
 *
 * ช่อง "จาก" ของเล่มทะเบียนหนังสือส่งคือเจ้าของเรื่องในโรงเรียน ซึ่งเกือบทุกครั้งคือคนที่กดขอเลขเอง
 * จึงเติมให้เลยแทนที่จะบังคับให้พิมพ์ชื่อตัวเองทุกครั้ง — แก้เป็นชื่อฝ่าย/กลุ่มงานได้ตามต้องการ
 */
function defaultFromName(user) {
  const name = `${user.prefix || ''}${user.first_name || ''} ${user.last_name || ''}`.trim();
  return user.position ? `${name} (${user.position})` : name;
}

/**
 * ใครเป็น "ผู้ขอ" ของคำขอใบนี้
 *
 * ครูบางท่านฝากให้ธุรการลงให้ (บอกปากเปล่า/ทางไลน์) คำขอใบนั้นต้องขึ้นชื่อครูเจ้าของเรื่อง ไม่ใช่ชื่อ
 * ธุรการ เพราะหนังสือที่ออกมาจะมีครูคนนั้นเป็นผู้บันทึกเอกสารและเป็นคนที่ต้องแนบไฟล์/เสนอต่อเอง
 * ถ้าขึ้นชื่อธุรการ ครูจะเปิดหนังสือของตัวเองไม่ได้และไม่ได้รับแจ้งเตือนอะไรเลย
 */
function resolveRequester(actor, onBehalfOfId) {
  const target = asTextOrNull(onBehalfOfId);
  if (!target || target === actor.id) return actor;
  if (!canIssueOutgoingNumber(actor)) {
    throw httpError(403, 'บันทึกคำขอแทนคนอื่นได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(target);
  if (!row) throw httpError(400, 'ไม่พบครูที่เลือกเป็นผู้ขอ หรือบัญชีนั้นถูกปิดไปแล้ว');
  return row;
}

/**
 * คำขอเลขหนังสือส่งไม่รับไฟล์แนบแล้ว
 *
 * ตอนแรกให้แนบร่างได้เพราะคิดว่าธุรการต้องเห็นตัวหนังสือก่อนตัดสินใจออกเลข แต่ของจริงไม่ได้ทำงานแบบนั้น
 * — ครูมา "ขอเลข" เพื่อเอาไปพิมพ์ลงหัวหนังสือที่ยังร่างไม่เสร็จด้วยซ้ำ ไม่ได้มาส่งไฟล์ ช่องแนบไฟล์จึง
 * เป็นขั้นตอนที่ไม่มีใครใช้ แต่กินที่บนหน้าจอและทำให้ฟอร์มที่ควรมีสี่ช่องดูยาวเกินจำเป็น
 *
 * ไฟล์ที่แนบมาก่อนหน้านี้ยังเปิดดูได้และยังถูกย้ายเข้าเป็นไฟล์แนบของหนังสือตอนออกเลขเหมือนเดิม
 * (ดู listRequestDrafts/getRequestDraft และขั้นย้ายไฟล์ใน issueOutgoingNumber) ตัดแค่ขาเข้าเท่านั้น
 * เพื่อไม่ให้ของที่ยื่นไว้แล้วหายไปเงียบๆ — เมื่อคำขอเก่าหมดแล้ว ตาราง outgoing_request_files
 * กับเส้นทางเปิดไฟล์จะถูกรื้อทิ้งได้ทั้งก้อน
 */
export function submitOutgoingRequest({ title, correspondentName, fromName, actionNote, departmentId, priority, secretLevel, note, isCircular, requester: actor, onBehalfOfId }) {
  const requester = resolveRequester(actor, onBehalfOfId);
  const onBehalf = requester.id !== actor.id;
  title = asText(title);
  correspondentName = asText(correspondentName);
  note = asTextOrNull(note);
  fromName = asText(fromName) || defaultFromName(requester);
  actionNote = asTextOrNull(actionNote);
  assertMaxLength(title, MAX_TITLE, 'ชื่อเรื่อง');
  assertMaxLength(correspondentName, MAX_TITLE, 'หน่วยงาน/บุคคลปลายทาง');
  assertMaxLength(fromName, MAX_TITLE, 'จาก (เจ้าของเรื่อง)');
  assertMaxLength(actionNote, MAX_NOTE, 'การปฏิบัติ');
  assertMaxLength(note, MAX_NOTE, 'ข้อความถึงธุรการ');
  if (!title) throw httpError(400, 'กรุณากรอกชื่อเรื่องของหนังสือที่จะส่ง');
  if (!correspondentName) throw httpError(400, 'กรุณากรอกหน่วยงาน/บุคคลที่จะส่งถึง');

  const deptId = asTextOrNull(departmentId) || requester.department_id || null;
  if (deptId && !db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(deptId)) {
    throw httpError(400, 'ไม่พบฝ่ายที่เลือก');
  }
  const pending = db.prepare("SELECT COUNT(*) c FROM outgoing_number_requests WHERE status = 'pending'").get().c;
  if (pending >= MAX_PENDING) throw httpError(429, 'ตอนนี้มีคำขอเลขค้างอยู่เป็นจำนวนมาก กรุณาติดต่อธุรการโดยตรง');

  // กดปุ่มซ้ำด้วยเรื่องเดิมที่ยังรออยู่ — ไม่ต้องสร้างใบใหม่ให้ธุรการมานั่งลบ (เทียบเฉพาะคำขอของคนเดียวกัน
  // เพราะครูสองคนขอเลขให้หนังสือชื่อเรื่องเดียวกันคนละฉบับเป็นเรื่องปกติ เช่น "รายงานผลการอบรม")
  const dup = db.prepare(`
    SELECT id FROM outgoing_number_requests WHERE requester_id = ? AND title = ? AND status = 'pending'
  `).get(requester.id, title);
  if (dup) return { id: dup.id, duplicate: true, requesterId: requester.id, onBehalf };

  const id = uuid();
  db.prepare(`
    INSERT INTO outgoing_number_requests
      (id, requester_id, title, correspondent_name, from_name, action_note, department_id, priority, secret_level, note, is_circular, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, requester.id, title, correspondentName, fromName, actionNote, deptId, priority || 'normal', secretLevel || 'normal', note,
    isCircular ? 1 : 0, nowIso());

  const who =`${requester.prefix || ''}${requester.first_name} ${requester.last_name}`.trim();
  // ธุรการที่พิมพ์ใบนี้เองไม่ต้องได้แจ้งเตือนว่า "มีคำขอใหม่" จากตัวเอง — ใบที่ธุรการลงแทนครูถูกออกเลข
  // ต่อทันทีในคำสั่งเดียวอยู่แล้ว การแจ้งเตือนรอบนี้จึงเป็นเสียงรบกวนล้วนๆ
  if (!onBehalf) {
    // บอกธุรการทันที ไม่ใช่รอให้บังเอิญเปิดหน้านั้นเจอเอง — ครูที่ขอเลขมักกำลังรอส่งหนังสือให้ทัน
    for (const staff of db.prepare(`
      SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.name IN ('registrar', 'admin') AND u.deleted_at IS NULL AND u.status = 'active'
    `).all()) {
      notifyUser({
        userId: staff.id, linkUrl: '/outgoing-requests',
        title: 'มีคำขอเลขหนังสือส่งใหม่',
        message: `${who} ขอเลขสำหรับเรื่อง "${title}"`,
        priority: 'info',
      });
    }
  }
  // userId = คนที่ "กดจริง" ไม่ใช่เจ้าของคำขอ — บันทึกตรวจสอบต้องตอบได้ว่าใครเป็นคนพิมพ์ใบนี้เข้าระบบ
  audit({
    userId: actor.id, action: 'outgoing_number_requested', tableName: 'outgoing_number_requests', recordId: id,
    detail: { title, requesterId: requester.id, onBehalf },
  });
  return { id, duplicate: false, requesterId: requester.id, onBehalf };
}

export function listPendingOutgoingRequests(limit = 100) {
  return db.prepare(`
    SELECT r.*, d.name AS department_name,
      u.prefix AS requester_prefix, u.first_name AS requester_first, u.last_name AS requester_last, u.position AS requester_position
    FROM outgoing_number_requests r
    JOIN users u ON u.id = r.requester_id
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status = 'pending' ORDER BY r.created_at LIMIT ?
  `).all(limit);
}

export function countPendingOutgoingRequests() {
  return db.prepare("SELECT COUNT(*) c FROM outgoing_number_requests WHERE status = 'pending'").get().c;
}

/** คำขอของคนคนหนึ่ง (ทุกสถานะ) — ครูต้องเห็นว่าของตัวเองถึงไหนแล้ว และได้เลขอะไรมา */
export function listMyOutgoingRequests(userId, limit = 30) {
  return db.prepare(`
    -- doc_deleted_at: หนังสือถูกลบเป็น soft-delete แถวยังอยู่ ถ้าไม่ดูตรงนี้จะทำลิงก์พาไปหน้า
    -- "ไม่พบเอกสาร" โดยที่ครูไม่รู้ว่าเกิดอะไรขึ้นกับหนังสือของตัวเอง
    SELECT r.*, doc.doc_number_display, doc.id AS doc_id, doc.deleted_at AS doc_deleted_at,
      -- ค่าที่ "ออกจริง" อยู่ที่ตัวหนังสือ ไม่ใช่ที่แถวคำขอ — ธุรการแก้ได้ทั้งตอนออกเลขและหลังออกเลข
      -- แถวคำขอเก็บไว้ว่าครูขออะไรมา (ไม่แก้ตามทีหลัง) เพื่อให้ยังเทียบกันได้ว่าถูกแก้เป็นอะไร
      doc.external_doc_date AS doc_date, doc.title AS doc_title,
      doc.correspondent_name AS doc_to, doc.from_name AS doc_from, doc.action_note AS doc_action
    FROM outgoing_number_requests r
    LEFT JOIN documents doc ON doc.id = r.document_id
    WHERE r.requester_id = ? ORDER BY r.created_at DESC LIMIT ?
  `).all(userId, limit);
}

export function recentReviewedOutgoingRequests(limit = 20) {
  return db.prepare(`
    SELECT r.*, doc.doc_number_display, doc.id AS doc_id, doc.status AS doc_status, doc.deleted_at AS doc_deleted_at,
      doc.external_doc_date AS doc_date, doc.title AS doc_title,
      doc.correspondent_name AS doc_to, doc.from_name AS doc_from, doc.action_note AS doc_action,
      u.prefix AS requester_prefix, u.first_name AS requester_first, u.last_name AS requester_last,
      rv.first_name AS reviewer_first, rv.last_name AS reviewer_last
    FROM outgoing_number_requests r
    JOIN users u ON u.id = r.requester_id
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN documents doc ON doc.id = r.document_id
    WHERE r.status != 'pending' ORDER BY r.reviewed_at DESC LIMIT ?
  `).all(limit);
}

/**
 * ธุรการกดออกเลขให้ — สร้างหนังสือส่งจริงจากคำขอ
 *
 * ปิดคำขอกับสร้างหนังสือต้องสำเร็จหรือล้มไปด้วยกัน ถ้าสร้างหนังสือแล้วแต่ปิดคำขอไม่สำเร็จ ธุรการจะเห็น
 * คำขอเดิมค้างอยู่แล้วกดออกเลขซ้ำ จนหนังสือเรื่องเดียวมีสองเลข ซึ่งแก้ทีหลังไม่ได้แล้วเพราะเลขที่ออกไป
 * แล้วนำกลับมาใช้ซ้ำไม่ได้ตามระเบียบ
 */
export async function issueOutgoingNumber({
  requestId, customDocNumber, docDate, isCircular,
  title, correspondentName, fromName, actionNote, departmentId, priority, secretLevel,
  actorUser,
}) {
  if (!canIssueOutgoingNumber(actorUser)) {
    throw httpError(403, 'ออกเลขหนังสือส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare("SELECT * FROM outgoing_number_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้ หรือมีคนออกเลขให้ไปแล้ว');

  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(req.requester_id);
  if (!requester || requester.deleted_at) throw httpError(409, 'เจ้าของคำขอนี้ถูกปิดบัญชีไปแล้ว');

  // ธุรการเป็นผู้ตรวจและแก้ได้ทุกช่องก่อนกดออกเลข — ค่าที่ไม่ได้ส่งมา (undefined) ใช้ของที่ครูกรอกไว้
  // แยก undefined กับค่าว่างให้ชัด: ส่งค่าว่างมา = ตั้งใจล้างช่องนั้น ไม่ใช่ "ไม่ได้แก้"
  const pick = (over, fallback) => (over === undefined ? fallback : asTextOrNull(over));
  const finalTitle = pick(title, req.title);
  const finalTo = pick(correspondentName, req.correspondent_name);
  const finalFrom = pick(fromName, req.from_name);
  const finalAction = pick(actionNote, req.action_note);
  const finalDept = pick(departmentId, req.department_id);
  if (!finalTitle) throw httpError(400, 'ชื่อเรื่องของหนังสือเว้นว่างไม่ได้');
  if (!finalTo) throw httpError(400, 'ช่อง "ถึง" เว้นว่างไม่ได้ — หนังสือส่งต้องมีปลายทาง');
  if (!finalDept) throw httpError(400, 'คำขอนี้ไม่มีฝ่ายที่รับผิดชอบ — กรุณาเลือกฝ่ายก่อนออกเลข');
  assertMaxLength(finalFrom, MAX_TITLE, 'จาก (เจ้าของเรื่อง)');
  assertMaxLength(finalAction, MAX_NOTE, 'การปฏิบัติ');

  // "ออกวันที่" คือวันที่ลงบนหัวหนังสือที่ส่งออกไปข้างนอกจริง ไม่ใช่เวลาที่กดปุ่มในระบบ ปกติคือวันนี้
  // (ธุรการออกเลขแล้วครูเอาไปพิมพ์ลงหนังสือทันที) แต่ต้องแก้ย้อนหลังได้ เพราะหนังสือที่พิมพ์ลงวันที่
  // ไปแล้วเมื่อวานแต่มาขอเลขวันนี้เกิดขึ้นจริง และวันที่บนกระดาษกับในทะเบียนต้องตรงกัน
  const issuedDate = normalizeDate(docDate, 'วันที่ออกหนังสือ') || todayInBangkok();

  let doc;
  db.exec('BEGIN IMMEDIATE');
  try {
    // ผู้บันทึกเอกสารคือ "ผู้ขอ" ไม่ใช่ธุรการที่กดออกเลข — หนังสือฉบับนี้เป็นเรื่องของครูคนนั้น
    // เขาต้องแก้ไข แนบไฟล์ และเสนอต่อได้เองเหมือนหนังสือที่ตัวเองลงทะเบียน
    doc = createDocument({
      direction: 'outgoing',
      title: finalTitle,
      correspondentName: finalTo,
      fromName: finalFrom,
      actionNote: finalAction,
      externalDocDate: issuedDate,
      departmentId: finalDept,
      docTypeId: defaultDocTypeId(),
      priority: pick(priority, req.priority) || 'normal',
      secretLevel: pick(secretLevel, req.secret_level) || 'normal',
      // ครูระบุมาตั้งแต่ตอนขอว่าเป็นหนังสือเวียนหรือไม่ — ธุรการเปลี่ยนตอนออกเลขได้
      isCircular: isCircular === undefined ? Boolean(req.is_circular) : Boolean(isCircular),
      customDocNumber: asTextOrNull(customDocNumber),
      createdBy: requester.id,
      allowDuplicate: true, // ธุรการตรวจแล้วว่าจะออกเลขให้ ไม่ต้องให้ด่านกันกดซ้ำมาขวางอีกชั้น
      inTransaction: true,
    });
    db.prepare(`
      UPDATE outgoing_number_requests SET status = 'issued', reviewed_by = ?, reviewed_at = ?, document_id = ?
      WHERE id = ?
    `).run(actorUser.id, nowIso(), doc.id, req.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // ย้ายร่างที่ครูแนบมาเข้าเป็นไฟล์แนบของหนังสือ — ครูจะได้ไม่ต้องแนบซ้ำอีกรอบ และธุรการที่เพิ่งดูร่าง
  // เพื่อตัดสินใจออกเลขก็เห็นไฟล์เดียวกันนั้นอยู่กับหนังสือทันที
  //
  // อยู่นอกธุรกรรมโดยตั้งใจ: การย้ายไฟล์อาจต้องอัปโหลดขึ้น Google Drive ซึ่งช้าและล้มได้จากเน็ตโรงเรียน
  // ถ้าเอาไปไว้ในธุรกรรมเดียวกัน เน็ตสะดุดครั้งเดียวจะย้อนการออกเลขทั้งก้อน ทั้งที่เลขทะเบียนออกไปแล้ว
  // — ถ้าย้ายไม่สำเร็จ หนังสือยังอยู่ครบ แค่บอกให้ไปแนบไฟล์เองที่หน้าหนังสือ
  const drafts = listRequestDrafts(req.id);
  const failedDrafts = [];
  for (const d of drafts) {
    try {
      const row = getRequestDraft(d.id);
      // saveAttachment เช็คสิทธิ์การเห็นหนังสือ (เพื่อคำเตือนไฟล์ซ้ำ) จาก user.roleCodes — แถวดิบจาก
      // ตาราง users ไม่มีฟิลด์นั้น ต้องเติมบทบาทให้ครบเหมือนผู้ใช้ที่ล็อกอินเข้ามาจริง
      const uploader = { ...requester, roleCodes: getUserRoles(requester.id).map((r) => r.name) };
      await saveAttachment({
        documentId: doc.id, fileName: row.filename, fileType: row.mime_type,
        fileDataBase64: Buffer.from(row.content).toString('base64'), uploader,
      });
      db.prepare('DELETE FROM outgoing_request_files WHERE id = ?').run(d.id);
    } catch (err) {
      failedDrafts.push(`${d.filename}: ${err.message}`);
    }
  }

  // ครูที่ขอเลขกำลังรออยู่เพื่อพิมพ์เลขลงหัวหนังสือ ข้อความนี้จึงต้องมีทุกอย่างที่ต้องพิมพ์ลงกระดาษ
  // ครบในตัวเอง (เลขที่ + ลงวันที่) ไม่ใช่แค่บอกว่า "อนุมัติแล้ว" แล้วให้เปิดเว็บมาดูเองว่าได้เลขอะไร
  //
  // notifyUser ต่อเข้าคิวไลน์ให้เองสำหรับคนที่เชื่อมบัญชีไว้ (ดู services/notify.js) — ไม่ต้องยิงไลน์
  // ซ้ำที่นี่ ถ้ายิงเองจะได้สองข้อความต่อการอนุมัติหนึ่งครั้ง
  notifyUser({
    userId: requester.id, documentId: doc.id,
    title: `ได้เลขหนังสือส่งแล้ว: ${doc.docNumberDisplay}`,
    message: [
      `เรื่อง ${finalTitle}`,
      `ที่ ${doc.docNumberDisplay}`,
      `ลงวันที่ ${fmtThaiDateLong(issuedDate)}`,
      finalTo ? `ถึง ${finalTo}` : '',
      'พิมพ์เลขที่และวันที่นี้ลงบนหนังสือได้เลย',
    ].filter(Boolean).join('\n'),
    priority: 'success',
  });
  audit({
    userId: actorUser.id, action: 'outgoing_number_issued', tableName: 'outgoing_number_requests', recordId: req.id,
    detail: { documentId: doc.id, docNumber: doc.docNumberDisplay, docDate: issuedDate, requesterId: requester.id },
  });
  return {
    ok: true, documentId: doc.id, docNumberDisplay: doc.docNumberDisplay, docDate: issuedDate,
    attachedDrafts: drafts.length - failedDrafts.length,
    draftWarning: failedDrafts.length
      ? `ออกเลขให้เรียบร้อยแล้ว แต่ย้ายร่างที่แนบมาเข้าหนังสือไม่สำเร็จ (${failedDrafts.join(', ')}) — ให้แนบไฟล์เองที่หน้าหนังสือ`
      : null,
  };
}

/** ธุรการปฏิเสธคำขอ — ต้องบอกเหตุผล ไม่งั้นครูไม่รู้ว่าต้องแก้อะไรแล้วยื่นใหม่ */
export function rejectOutgoingRequest({ requestId, reason, actorUser }) {
  if (!canIssueOutgoingNumber(actorUser)) {
    throw httpError(403, 'ออกเลขหนังสือส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  reason = asTextOrNull(reason);
  assertMaxLength(reason, MAX_NOTE, 'เหตุผล');
  if (!reason) throw httpError(400, 'กรุณาระบุเหตุผลที่ยังออกเลขให้ไม่ได้ — ผู้ขอต้องรู้ว่าต้องแก้อะไรก่อนยื่นใหม่');
  const req = db.prepare("SELECT * FROM outgoing_number_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้ หรือมีคนตรวจไปแล้ว');

  db.prepare(`
    UPDATE outgoing_number_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reject_reason = ?
    WHERE id = ?
  `).run(actorUser.id, nowIso(), reason, req.id);

  notifyUser({
    userId: req.requester_id,
    linkUrl: '/outgoing-requests/mine',
    title: 'คำขอเลขหนังสือส่งยังออกให้ไม่ได้',
    message: `${req.title} — ${reason}`,
    priority: 'warning',
  });
  // ร่างที่แนบมาไม่ได้ใช้แล้ว ทิ้งไปพร้อมกัน ไม่ปล่อยให้ก้อนข้อมูลค้างอยู่ในฐานข้อมูล (ซึ่งถูกสำรองทุกรอบ)
  db.prepare('DELETE FROM outgoing_request_files WHERE request_id = ?').run(req.id);
  audit({
    userId: actorUser.id, action: 'outgoing_number_rejected', tableName: 'outgoing_number_requests', recordId: req.id,
    detail: { reason },
  });
  return { ok: true };
}

/** ผู้ขอถอนคำขอของตัวเองที่ยังไม่ได้ออกเลข */
export function cancelOutgoingRequest({ requestId, actorUser }) {
  const req = db.prepare('SELECT * FROM outgoing_number_requests WHERE id = ?').get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.requester_id !== actorUser.id && !actorUser.roleCodes.includes('admin')) {
    throw httpError(403, 'ถอนได้เฉพาะคำขอของตัวเองเท่านั้น');
  }
  if (req.status !== 'pending') {
    throw httpError(409, req.status === 'issued'
      ? 'คำขอนี้ออกเลขไปแล้ว ถอนไม่ได้ — เลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ ถ้าไม่ได้ใช้จริงให้ยกเลิกที่ตัวหนังสือ'
      : 'คำขอนี้ถูกตรวจไปแล้ว');
  }
  db.prepare('DELETE FROM outgoing_request_files WHERE request_id = ?').run(requestId);
  db.prepare('DELETE FROM outgoing_number_requests WHERE id = ?').run(requestId);
  audit({ userId: actorUser.id, action: 'outgoing_number_request_cancelled', tableName: 'outgoing_number_requests', recordId: requestId, detail: { title: req.title } });
  return { ok: true };
}

// ---------------- แก้/ลบหนังสือส่งที่ออกเลขไปแล้ว ----------------
//
// ข้อ 3 ข้างบนยังจริงอยู่: เลขที่ "ออกไปแล้ว" นำกลับมาใช้ซ้ำไม่ได้ และหนังสือที่ไม่ได้ใช้จริงต้องยกเลิก
// ที่ตัวหนังสือเพื่อให้เลขคงอยู่ในลำดับ — สิ่งที่สองฟังก์ชันนี้แก้คือคนละเรื่องกัน คือ "กรอกผิด"
// กับ "แถวคำขอที่ไม่ควรอยู่ในรายการแล้ว" ซึ่งเดิมไม่มีทางแก้เลยทั้งคู่ ต้องเข้าไปแก้ฐานข้อมูลเองเท่านั้น
//
// เปิดให้ธุรการแก้ได้ ไม่ใช่เฉพาะผู้ดูแลระบบ: ทะเบียนหนังสือส่งเป็นสมุดของเจ้าหน้าที่ธุรการตามระเบียบ
// งานสารบรรณ คนที่ออกเลขและเป็นคนเดียวที่รู้ว่าเล่มกระดาษลงอะไรไว้ก็คือธุรการ การบังคับให้รอผู้ดูแล
// ระบบมาแก้คำผิดให้ทำให้งานค้างโดยไม่ได้เพิ่มความปลอดภัยอะไร — ด่านจริงคือ PIN (ตรวจที่ชั้น route)
// ซึ่งยืนยันตัวคนที่กดจริง และทุกการแก้ถูกบันทึกใน audit log พร้อมค่าก่อน/หลังทุกช่อง
//
// "ลบแถวคำขอ" ยังเป็นของผู้ดูแลระบบเท่านั้น เพราะนั่นคือการทำให้บันทึกหายไปจากรายการ ไม่ใช่การแก้ค่า

const MAX_DOC_NUMBER = 100;

/**
 * แก้หนังสือส่งที่ออกเลขให้ไปแล้ว — แก้ที่ตัวหนังสือจริง ทะเบียน/ตราประทับ/หน้าพิมพ์จึงตรงกันหมด
 *
 * รับได้ทุกช่องที่ธุรการเห็นในหน้าออกเลข (เลขที่ ออกวันที่ จาก ถึง เรื่อง การปฏิบัติ) — ช่องที่ไม่ส่งมา
 * (undefined) ไม่ถูกแตะ จึงยิงมาแก้ช่องเดียวก็ได้ และฟอร์มเดิมที่ส่งมาแต่ docNumber ยังทำงานเหมือนเดิม
 */
export function editIssuedOutgoing({ requestId, docNumber, docDate, fromName, correspondentName, title, actionNote, allowDuplicate, actorUser }) {
  if (!canIssueOutgoingNumber(actorUser)) {
    throw httpError(403, 'แก้หนังสือส่งที่ออกเลขไปแล้วได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare('SELECT * FROM outgoing_number_requests WHERE id = ?').get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.status !== 'issued' || !req.document_id) throw httpError(409, 'คำขอนี้ยังไม่ได้ออกเลข จึงไม่มีเลขให้แก้');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(req.document_id);
  if (!doc) throw httpError(409, 'หนังสือของคำขอนี้ถูกลบออกจากระบบไปแล้ว');

  // เลขที่: ส่งมาเป็นค่าว่างถือว่าผิด ไม่ใช่ "ล้างช่อง" — หนังสือทุกฉบับต้องมีเลขทะเบียน
  // ต่างจากช่องอื่นที่ค่าว่างคือการล้างช่องได้จริง (เช่นลบการปฏิบัติที่พิมพ์ผิดทิ้ง)
  let num = doc.doc_number_display;
  if (docNumber !== undefined) {
    num = asText(docNumber);
    if (!num) throw httpError(400, 'เลขหนังสือส่งเว้นว่างไม่ได้ — หนังสือทุกฉบับต้องมีเลขทะเบียน');
    assertMaxLength(num, MAX_DOC_NUMBER, 'เลขหนังสือส่ง');
  }

  // เลขซ้ำเกิดขึ้นได้จริงตอนแก้ให้ตรงกับเล่มกระดาษ จึงถามยืนยันแทนที่จะห้าม — แต่ห้ามผ่านเงียบๆ
  // เพราะเลขทะเบียนคือสิ่งที่ใช้อ้างอิงหนังสือฉบับนั้นไปตลอด (เกณฑ์เดียวกับการแก้ทะเบียนที่หน้าหนังสือ)
  let dup = null;
  if (num !== doc.doc_number_display) {
    dup = db.prepare('SELECT id FROM documents WHERE doc_number_display = ? AND id != ? AND deleted_at IS NULL').get(num, doc.id);
    if (dup && allowDuplicate !== true) {
      throw httpError(409, `เลข "${num}" ซ้ำกับหนังสืออีกฉบับที่มีอยู่แล้ว`, {
        confirmRetry: { field: 'allowDuplicate', message: `เลข "${num}" ซ้ำกับหนังสืออีกฉบับในระบบ — ยืนยันใช้เลขซ้ำหรือไม่?` },
      });
    }
  }

  const next = {
    doc_number_display: num,
    external_doc_date: docDate === undefined ? doc.external_doc_date : normalizeDate(docDate, 'วันที่ออกหนังสือ'),
    from_name: fromName === undefined ? doc.from_name : asTextOrNull(fromName),
    correspondent_name: correspondentName === undefined ? doc.correspondent_name : asText(correspondentName),
    title: title === undefined ? doc.title : asText(title),
    action_note: actionNote === undefined ? doc.action_note : asTextOrNull(actionNote),
  };
  if (!next.title) throw httpError(400, 'ชื่อเรื่องของหนังสือเว้นว่างไม่ได้');
  if (!next.correspondent_name) throw httpError(400, 'ช่อง "ถึง" เว้นว่างไม่ได้ — หนังสือส่งต้องมีปลายทาง');
  assertMaxLength(next.title, MAX_TITLE, 'ชื่อเรื่อง');
  assertMaxLength(next.correspondent_name, MAX_TITLE, 'ถึง (หน่วยงาน/บุคคลปลายทาง)');
  assertMaxLength(next.from_name, MAX_TITLE, 'จาก (เจ้าของเรื่อง)');
  assertMaxLength(next.action_note, MAX_NOTE, 'การปฏิบัติ');

  const changed = Object.entries(next).filter(([col, value]) => (doc[col] ?? null) !== (value ?? null));
  if (!changed.length) return { ok: true, changed: false, docNumberDisplay: num };

  db.prepare(`UPDATE documents SET doc_number_display = ?, external_doc_date = ?, from_name = ?,
    correspondent_name = ?, title = ?, action_note = ?, updated_at = ? WHERE id = ?`)
    .run(next.doc_number_display, next.external_doc_date, next.from_name,
      next.correspondent_name, next.title, next.action_note, nowIso(), doc.id);

  // ผู้ขอได้เลขเดิมไปแล้วและอาจพิมพ์ลงหนังสือจริงไปแล้ว — ต้องรู้ว่าเปลี่ยน ไม่ใช่มาเจอเองทีหลัง
  // เลขที่กับวันที่คือสองค่าที่ถูกพิมพ์ลงกระดาษ จึงบอกค่าใหม่ไปในข้อความให้ใช้ได้ทันทีโดยไม่ต้องเปิดเว็บ
  const numChanged = next.doc_number_display !== doc.doc_number_display;
  notifyUser({
    userId: req.requester_id, documentId: doc.id,
    title: numChanged ? `แก้เลขหนังสือส่งเป็น ${num}` : `แก้ข้อมูลหนังสือส่ง ${num}`,
    message: [
      numChanged
        ? `${next.title} — เลขเดิม ${doc.doc_number_display} ถูกแก้เป็น ${num} กรุณาใช้เลขใหม่บนหนังสือ`
        : `${next.title} — เจ้าหน้าที่ธุรการแก้ข้อมูลหนังสือฉบับนี้`,
      next.external_doc_date ? `ลงวันที่ ${fmtThaiDateLong(next.external_doc_date)}` : '',
      `ช่องที่แก้: ${changed.map(([col]) => EDITABLE_LABEL[col] || col).join(', ')}`,
    ].filter(Boolean).join('\n'),
    priority: 'warning',
  });
  audit({
    userId: actorUser.id, action: 'outgoing_number_edited', tableName: 'documents', recordId: doc.id,
    detail: {
      requestId: req.id,
      // before/after ของเลขที่อยู่ที่ระดับบนสุดเหมือนเดิม — มีของที่อ่าน audit log เก่าอยู่
      before: doc.doc_number_display, after: num,
      fields: Object.fromEntries(changed.map(([col, value]) => [col, { before: doc[col] ?? null, after: value ?? null }])),
      duplicateAllowed: Boolean(dup),
    },
  });
  return { ok: true, changed: true, docNumberDisplay: num, changedFields: changed.map(([col]) => col) };
}

const EDITABLE_LABEL = {
  doc_number_display: 'เลขที่', external_doc_date: 'ออกวันที่', from_name: 'จาก',
  correspondent_name: 'ถึง', title: 'เรื่อง', action_note: 'การปฏิบัติ',
};

/**
 * ลบคำขอเลขหนังสือส่งออกจากรายการ
 *
 * ลบเฉพาะ "บันทึกคำขอ" เท่านั้น ถ้าออกเลขไปแล้วตัวหนังสือยังอยู่ในทะเบียนตามเดิมโดยตั้งใจ — ลบหนังสือ
 * ทิ้งพร้อมกันจะทำให้เลขทะเบียนขาดเป็นรูโหว่ในเล่มที่อธิบายไม่ได้ตอนตรวจ ถ้าหนังสือไม่ได้ใช้จริงต้อง
 * ไป "ยกเลิกเอกสาร" ที่ตัวหนังสือ ซึ่งเลขยังคงอยู่ในลำดับพร้อมเหตุผลกำกับ ตามหลักงานสารบรรณ
 *
 * เปิดให้ธุรการลบได้เหมือนกับการแก้ ด้วยเหตุผลเดียวกัน: รายการคำขอเป็นหน้าทำงานของธุรการ ใบที่กดซ้ำ
 * ใบที่พิมพ์เล่น ใบที่ครูขอมาแล้วไม่ได้ใช้ ล้วนเป็นขยะบนหน้าจอของธุรการเอง ซึ่งคนที่ต้องเก็บกวาดก็คือ
 * ธุรการ ไม่ใช่คนที่ต้องไปตามผู้ดูแลระบบมาลบให้ทีละใบ
 *
 * สิ่งที่กันไว้แทนคือ: ด่าน PIN ที่ชั้น route, ตัวหนังสือที่ออกเลขไปแล้วไม่ถูกแตะเลย (เลขยังอยู่ในเล่ม)
 * และ audit log ที่เก็บเนื้อใบที่ลบทิ้งไว้ครบ จึงยังตอบได้เสมอว่าใบที่หายไปคืออะไรและใครลบ
 */
export function deleteOutgoingRequest({ requestId, actorUser }) {
  if (!canIssueOutgoingNumber(actorUser)) {
    throw httpError(403, 'ลบคำขอเลขหนังสือส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare('SELECT * FROM outgoing_number_requests WHERE id = ?').get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');

  db.prepare('DELETE FROM outgoing_request_files WHERE request_id = ?').run(requestId);
  db.prepare('DELETE FROM outgoing_number_requests WHERE id = ?').run(requestId);
  // เก็บเนื้อใบไว้ให้ครบ ไม่ใช่แค่ชื่อเรื่อง — ใบที่ลบไปแล้วเรียกคืนจากตารางไม่ได้ ถ้าลบผิดใบ
  // บันทึกนี้คือสิ่งเดียวที่บอกได้ว่าในใบนั้นมีอะไรเขียนไว้ และพิมพ์กลับเข้าไปใหม่ได้
  audit({
    userId: actorUser.id, action: 'outgoing_number_request_deleted', tableName: 'outgoing_number_requests', recordId: requestId,
    detail: {
      title: req.title, status: req.status, documentId: req.document_id || null, requesterId: req.requester_id,
      correspondentName: req.correspondent_name, fromName: req.from_name || null, actionNote: req.action_note || null,
      note: req.note || null, createdAt: req.created_at,
    },
  });
  return { ok: true, documentKept: Boolean(req.document_id), documentId: req.document_id || null };
}
