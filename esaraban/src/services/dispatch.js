// บันทึกการส่งหนังสือออก — "ออกเลขแล้ว" ไม่เท่ากับ "ส่งออกไปแล้ว"
//
// ปัญหาจริงของงานธุรการ: หนังสือส่งที่ออกเลขทะเบียนไปแล้วอาจยังวางรออยู่บนโต๊ะ รอ ผอ. ลงนาม รอซอง
// รอไปรษณีย์รอบบ่าย หรือรอคนถือไปส่ง — ระบบเดิมบอกได้แค่ว่ามีหนังสือเลขนี้อยู่ในทะเบียน แต่ไม่มีที่ไหน
// บอกว่าฉบับไหน "ส่งออกไปแล้วจริง" ธุรการจึงต้องจำเอง/จดใส่กระดาษแยก และเวลาปลายทางโทรมาถามว่า
// "ส่งมาหรือยัง" ก็ตอบไม่ได้ ทั้งที่เป็นคำถามที่เจอบ่อยที่สุดเกี่ยวกับหนังสือส่ง
//
// เก็บวิธีส่งด้วย ไม่ใช่แค่วันที่ เพราะการตามเรื่องต่างกันสิ้นเชิง: ไปรษณีย์ลงทะเบียนมีเลขพัสดุให้ตาม
// นำส่งเองมีคนเซ็นรับ ส่วนอีเมล/ระบบสารบรรณอิเล็กทรอนิกส์ตามจากที่อยู่ปลายทาง
import { db, nowIso, audit } from '../db.js';
import { httpError, requireDate, asTextOrNull, assertMaxLength } from './validate.js';

/** วิธีส่งที่โรงเรียนใช้จริง — เรียงตามความถี่ที่ใช้ */
export const DISPATCH_METHODS = {
  post_registered: 'ไปรษณีย์ลงทะเบียน',
  post_normal: 'ไปรษณีย์ธรรมดา',
  by_hand: 'นำส่งเอง/ให้คนถือไป',
  e_office: 'ระบบสารบรรณอิเล็กทรอนิกส์ของเขต',
  email: 'อีเมล',
  line: 'ไลน์',
  other: 'อื่นๆ (ระบุในหมายเหตุ)',
};

const MAX_SENT_NOTE = 200;

/** ทะเบียนหนังสือส่งเป็นสมุดของเจ้าหน้าที่ธุรการ การบันทึกการส่งจึงเป็นงานของธุรการ/ผู้ดูแล */
export const canRecordDispatch = (user) =>
  Boolean(user) && (user.roleCodes.includes('admin') || user.roleCodes.includes('registrar'));

export function recordDispatch({ documentId, sentDate, method, note, actorUser }) {
  if (!canRecordDispatch(actorUser)) {
    throw httpError(403, 'บันทึกการส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.direction !== 'outgoing') throw httpError(400, 'บันทึกการส่งได้เฉพาะหนังสือส่งเท่านั้น');
  // ยกเลิก/ทำลายไปแล้วแต่กลับมีบันทึกว่าส่งออกไปแล้ว = ทะเบียนขัดกันเอง
  if (['voided', 'destroyed'].includes(doc.status)) {
    throw httpError(409, 'หนังสือฉบับนี้ถูกยกเลิก/ทำลายไปแล้ว จึงบันทึกการส่งไม่ได้');
  }

  const date = requireDate(sentDate, 'วันที่ส่ง');
  if (!DISPATCH_METHODS[method]) throw httpError(400, 'กรุณาเลือกวิธีส่ง');
  note = asTextOrNull(note);
  assertMaxLength(note, MAX_SENT_NOTE, 'หมายเหตุการส่ง');

  const before = { sent_at: doc.sent_at, sent_method: doc.sent_method, sent_note: doc.sent_note };
  db.prepare('UPDATE documents SET sent_at = ?, sent_method = ?, sent_note = ?, sent_by = ?, updated_at = ? WHERE id = ?')
    .run(date, method, note, actorUser.id, nowIso(), doc.id);
  audit({
    userId: actorUser.id, action: doc.sent_at ? 'document_dispatch_edited' : 'document_dispatched',
    tableName: 'documents', recordId: doc.id,
    detail: { before, after: { sent_at: date, sent_method: method, sent_note: note } },
  });
  return { ok: true, sentAt: date, method, methodLabel: DISPATCH_METHODS[method] };
}

/** ล้างบันทึกการส่ง — บันทึกผิดฉบับเป็นเรื่องที่เกิดได้ และต้องแก้ให้ตรงความจริงเสมอ */
export function clearDispatch({ documentId, actorUser }) {
  if (!canRecordDispatch(actorUser)) {
    throw httpError(403, 'แก้บันทึกการส่งได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  }
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (!doc.sent_at) return { ok: true, changed: false };
  db.prepare('UPDATE documents SET sent_at = NULL, sent_method = NULL, sent_note = NULL, sent_by = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso(), doc.id);
  audit({
    userId: actorUser.id, action: 'document_dispatch_cleared', tableName: 'documents', recordId: doc.id,
    detail: { before: { sent_at: doc.sent_at, sent_method: doc.sent_method, sent_note: doc.sent_note } },
  });
  return { ok: true, changed: true };
}

/** จำนวนหนังสือส่งที่ออกเลขแล้วแต่ยังไม่ได้บันทึกการส่ง — ใช้ชวนให้ธุรการมาเคลียร์ */
export function countUnsentOutgoing(visibleSql, visibleParams) {
  return db.prepare(`
    SELECT COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND d.direction = 'outgoing' AND d.sent_at IS NULL
      AND d.status NOT IN ('voided', 'destroyed') AND ${visibleSql}
  `).get(visibleParams).c;
}
