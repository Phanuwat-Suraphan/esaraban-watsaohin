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
import { db, uuid, nowIso, audit } from '../db.js';
import { httpError, asText, asTextOrNull, assertMaxLength } from './validate.js';
import { notifyUser } from './notify.js';
import { createDocument } from './workflow.js';

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
export function submitOutgoingRequest({ title, correspondentName, departmentId, priority, secretLevel, note, isCircular, requester }) {
  title = asText(title);
  correspondentName = asText(correspondentName);
  note = asTextOrNull(note);
  assertMaxLength(title, MAX_TITLE, 'ชื่อเรื่อง');
  assertMaxLength(correspondentName, MAX_TITLE, 'หน่วยงาน/บุคคลปลายทาง');
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
  if (dup) return { id: dup.id, duplicate: true };

  const id = uuid();
  db.prepare(`
    INSERT INTO outgoing_number_requests
      (id, requester_id, title, correspondent_name, department_id, priority, secret_level, note, is_circular, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, requester.id, title, correspondentName, deptId, priority || 'normal', secretLevel || 'normal', note,
    isCircular ? 1 : 0, nowIso());

  const who = `${requester.prefix || ''}${requester.first_name} ${requester.last_name}`.trim();
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
  audit({ userId: requester.id, action: 'outgoing_number_requested', tableName: 'outgoing_number_requests', recordId: id, detail: { title } });
  return { id, duplicate: false };
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
    SELECT r.*, doc.doc_number_display, doc.id AS doc_id
    FROM outgoing_number_requests r
    LEFT JOIN documents doc ON doc.id = r.document_id
    WHERE r.requester_id = ? ORDER BY r.created_at DESC LIMIT ?
  `).all(userId, limit);
}

export function recentReviewedOutgoingRequests(limit = 20) {
  return db.prepare(`
    SELECT r.*, doc.doc_number_display, doc.id AS doc_id, doc.status AS doc_status,
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
export function issueOutgoingNumber({ requestId, customDocNumber, isCircular, actorUser }) {
  if (!canIssueOutgoingNumber(actorUser)) {
    throw httpError(403, 'ออกเลขหนังสือส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare("SELECT * FROM outgoing_number_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้ หรือมีคนออกเลขให้ไปแล้ว');

  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(req.requester_id);
  if (!requester || requester.deleted_at) throw httpError(409, 'เจ้าของคำขอนี้ถูกปิดบัญชีไปแล้ว');
  if (!req.department_id) throw httpError(400, 'คำขอนี้ไม่มีฝ่ายที่รับผิดชอบ — กรุณาให้ผู้ขอยื่นใหม่พร้อมระบุฝ่าย');

  let doc;
  db.exec('BEGIN IMMEDIATE');
  try {
    // ผู้บันทึกเอกสารคือ "ผู้ขอ" ไม่ใช่ธุรการที่กดออกเลข — หนังสือฉบับนี้เป็นเรื่องของครูคนนั้น
    // เขาต้องแก้ไข แนบไฟล์ และเสนอต่อได้เองเหมือนหนังสือที่ตัวเองลงทะเบียน
    doc = createDocument({
      direction: 'outgoing',
      title: req.title,
      correspondentName: req.correspondent_name,
      departmentId: req.department_id,
      docTypeId: defaultDocTypeId(),
      priority: req.priority,
      secretLevel: req.secret_level,
      // ครูระบุมาตั้งแต่ตอนขอว่าเป็นหนังสือเวียนหรือไม่ — ธุรการเปลี่ยนตอนออกเลขได้ (ดู issueOutgoingNumber)
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

  notifyUser({
    userId: requester.id, documentId: doc.id,
    title: `ได้เลขหนังสือส่งแล้ว: ${doc.docNumberDisplay}`,
    message: `${req.title} — ใช้เลขนี้บนหนังสือได้เลย`,
    priority: 'success',
  });
  audit({
    userId: actorUser.id, action: 'outgoing_number_issued', tableName: 'outgoing_number_requests', recordId: req.id,
    detail: { documentId: doc.id, docNumber: doc.docNumberDisplay, requesterId: requester.id },
  });
  return { ok: true, documentId: doc.id, docNumberDisplay: doc.docNumberDisplay };
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
  db.prepare('DELETE FROM outgoing_number_requests WHERE id = ?').run(requestId);
  audit({ userId: actorUser.id, action: 'outgoing_number_request_cancelled', tableName: 'outgoing_number_requests', recordId: requestId, detail: { title: req.title } });
  return { ok: true };
}

// ---------------- ผู้ดูแลระบบแก้/ลบเลขหนังสือส่งที่ออกไปแล้ว ----------------
//
// ข้อ 3 ข้างบนยังจริงอยู่: เลขที่ "ออกไปแล้ว" นำกลับมาใช้ซ้ำไม่ได้ และหนังสือที่ไม่ได้ใช้จริงต้องยกเลิก
// ที่ตัวหนังสือเพื่อให้เลขคงอยู่ในลำดับ — สิ่งที่สองฟังก์ชันนี้แก้คือคนละเรื่องกัน คือ "พิมพ์เลขผิด"
// กับ "แถวคำขอที่ไม่ควรอยู่ในรายการแล้ว" ซึ่งเดิมไม่มีทางแก้เลยทั้งคู่ ต้องเข้าไปแก้ฐานข้อมูลเองเท่านั้น
//
// จำกัดไว้ที่ผู้ดูแลระบบ ไม่ใช่ธุรการทุกคน เพราะเป็นการแก้ทะเบียนราชการย้อนหลังหลังจากที่เลขถูกแจ้ง
// ออกไปให้เจ้าตัวแล้ว (และอาจถูกพิมพ์ลงบนหนังสือจริงไปแล้วด้วย)

const MAX_DOC_NUMBER = 100;

/** แก้เลขหนังสือส่งที่ออกให้ไปแล้ว — แก้ที่ตัวหนังสือจริง ทะเบียน/ตราประทับ/หน้าพิมพ์จึงตรงกันหมด */
export function editIssuedOutgoingNumber({ requestId, docNumber, allowDuplicate, actorUser }) {
  if (!actorUser?.roleCodes.includes('admin')) {
    throw httpError(403, 'แก้เลขหนังสือส่งที่ออกไปแล้วได้เฉพาะผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare('SELECT * FROM outgoing_number_requests WHERE id = ?').get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.status !== 'issued' || !req.document_id) throw httpError(409, 'คำขอนี้ยังไม่ได้ออกเลข จึงไม่มีเลขให้แก้');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(req.document_id);
  if (!doc) throw httpError(409, 'หนังสือของคำขอนี้ถูกลบออกจากระบบไปแล้ว');

  const num = asText(docNumber);
  if (!num) throw httpError(400, 'เลขหนังสือส่งเว้นว่างไม่ได้ — หนังสือทุกฉบับต้องมีเลขทะเบียน');
  assertMaxLength(num, MAX_DOC_NUMBER, 'เลขหนังสือส่ง');
  if (num === doc.doc_number_display) return { ok: true, changed: false, docNumberDisplay: num };

  // เลขซ้ำเกิดขึ้นได้จริงตอนแก้ให้ตรงกับเล่มกระดาษ จึงถามยืนยันแทนที่จะห้าม — แต่ห้ามผ่านเงียบๆ
  // เพราะเลขทะเบียนคือสิ่งที่ใช้อ้างอิงหนังสือฉบับนั้นไปตลอด (เกณฑ์เดียวกับการแก้ทะเบียนที่หน้าหนังสือ)
  const dup = db.prepare('SELECT id FROM documents WHERE doc_number_display = ? AND id != ? AND deleted_at IS NULL').get(num, doc.id);
  if (dup && allowDuplicate !== true) {
    throw httpError(409, `เลข "${num}" ซ้ำกับหนังสืออีกฉบับที่มีอยู่แล้ว`, {
      confirmRetry: { field: 'allowDuplicate', message: `เลข "${num}" ซ้ำกับหนังสืออีกฉบับในระบบ — ยืนยันใช้เลขซ้ำหรือไม่?` },
    });
  }

  db.prepare('UPDATE documents SET doc_number_display = ?, updated_at = ? WHERE id = ?').run(num, nowIso(), doc.id);
  // ผู้ขอได้เลขเดิมไปแล้วและอาจพิมพ์ลงหนังสือจริงไปแล้ว — ต้องรู้ว่าเลขเปลี่ยน ไม่ใช่มาเจอเองทีหลัง
  notifyUser({
    userId: req.requester_id, documentId: doc.id,
    title: `แก้เลขหนังสือส่งเป็น ${num}`,
    message: `${req.title} — เลขเดิม ${doc.doc_number_display} ถูกแก้เป็น ${num} โดยผู้ดูแลระบบ กรุณาใช้เลขใหม่บนหนังสือ`,
    priority: 'warning',
  });
  audit({
    userId: actorUser.id, action: 'outgoing_number_edited', tableName: 'documents', recordId: doc.id,
    detail: { requestId: req.id, before: doc.doc_number_display, after: num, duplicateAllowed: Boolean(dup) },
  });
  return { ok: true, changed: true, docNumberDisplay: num };
}

/**
 * ลบคำขอเลขหนังสือส่งออกจากรายการ
 *
 * ลบเฉพาะ "บันทึกคำขอ" เท่านั้น ถ้าออกเลขไปแล้วตัวหนังสือยังอยู่ในทะเบียนตามเดิมโดยตั้งใจ — ลบหนังสือ
 * ทิ้งพร้อมกันจะทำให้เลขทะเบียนขาดเป็นรูโหว่ในเล่มที่อธิบายไม่ได้ตอนตรวจ ถ้าหนังสือไม่ได้ใช้จริงต้อง
 * ไป "ยกเลิกเอกสาร" ที่ตัวหนังสือ ซึ่งเลขยังคงอยู่ในลำดับพร้อมเหตุผลกำกับ ตามหลักงานสารบรรณ
 */
export function deleteOutgoingRequest({ requestId, actorUser }) {
  if (!actorUser?.roleCodes.includes('admin')) {
    throw httpError(403, 'ลบคำขอเลขหนังสือส่งได้เฉพาะผู้ดูแลระบบเท่านั้น');
  }
  const req = db.prepare('SELECT * FROM outgoing_number_requests WHERE id = ?').get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');

  db.prepare('DELETE FROM outgoing_number_requests WHERE id = ?').run(requestId);
  audit({
    userId: actorUser.id, action: 'outgoing_number_request_deleted', tableName: 'outgoing_number_requests', recordId: requestId,
    detail: { title: req.title, status: req.status, documentId: req.document_id || null, requesterId: req.requester_id },
  });
  return { ok: true, documentKept: Boolean(req.document_id), documentId: req.document_id || null };
}
