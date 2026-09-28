// การตอบหนังสือ — "หนังสือเข้าฉบับนี้ตอบหรือยัง ตอบด้วยฉบับไหน"
//
// หนังสือเข้าจากเขตพื้นที่/หน่วยงานอื่นจำนวนมากต้องทำหนังสือตอบกลับภายในกำหนด (ขอข้อมูล ขอรายชื่อ
// ตอบรับเข้าร่วม ฯลฯ) ระบบเดิมเก็บหนังสือเข้ากับหนังสือส่งเป็นคนละเล่มที่ไม่รู้จักกันเลย — เวลาปลายทาง
// ทวงว่า "ยังไม่ได้รับหนังสือตอบ" หรือผู้ตรวจถามว่า "เรื่องนี้ตอบไปว่าอย่างไร" ธุรการต้องค้นชื่อเรื่อง
// ในทะเบียนหนังสือส่งเอาเอง แล้วเดาว่าฉบับไหนคือตัวตอบ
//
// แยกสองเรื่องออกจากกันโดยตั้งใจ:
//   - needs_reply อยู่ที่หนังสือ "เข้า" — ธุรการเป็นคนชี้ว่าฉบับนี้ต้องทำหนังสือตอบ เพราะหนังสือเข้า
//     ส่วนใหญ่เป็นเรื่องแจ้งให้ทราบที่ไม่ต้องตอบ ถ้าถือว่าทุกฉบับต้องตอบ รายการที่ได้จะไร้ประโยชน์ทันที
//   - reply_to_id อยู่ที่หนังสือ "ส่ง" ที่เป็นตัวตอบ — หนังสือเข้าหนึ่งฉบับมีหนังสือตอบได้มากกว่าหนึ่ง
//     (ตอบไปแล้วส่งข้อมูลเพิ่มทีหลัง) แต่หนังสือส่งหนึ่งฉบับตอบหนังสือเข้าได้ฉบับเดียว
import { db, nowIso, audit } from '../db.js';
import { httpError } from './validate.js';

/** ทะเบียนหนังสือเป็นสมุดของธุรการ การผูกคู่หนังสือเข้า-ตอบจึงเป็นงานของธุรการ/ผู้ดูแล */
export const canLinkReply = (user) =>
  Boolean(user) && (user.roleCodes.includes('admin') || user.roleCodes.includes('registrar'));

/** ติ๊ก/ยกเลิกธง "ต้องทำหนังสือตอบ" ของหนังสือเข้า */
export function setNeedsReply({ documentId, needsReply, actorUser }) {
  if (!canLinkReply(actorUser)) throw httpError(403, 'ระบุว่าต้องทำหนังสือตอบได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.direction !== 'incoming') throw httpError(400, 'ธง "ต้องทำหนังสือตอบ" ใช้กับหนังสือเข้าเท่านั้น');
  const value = needsReply ? 1 : 0;
  if (doc.needs_reply === value) return { ok: true, changed: false, needsReply: Boolean(value) };
  db.prepare('UPDATE documents SET needs_reply = ?, updated_at = ? WHERE id = ?').run(value, nowIso(), doc.id);
  audit({
    userId: actorUser.id, action: value ? 'document_marked_needs_reply' : 'document_unmarked_needs_reply',
    tableName: 'documents', recordId: doc.id, detail: {},
  });
  return { ok: true, changed: true, needsReply: Boolean(value) };
}

/** ผูกหนังสือส่งฉบับนี้ว่าเป็นตัวตอบของหนังสือเข้าฉบับไหน (ส่ง null = ไม่ใช่หนังสือตอบ) */
export function setReplyTarget({ documentId, replyToId, actorUser }) {
  if (!canLinkReply(actorUser)) throw httpError(403, 'ผูกหนังสือตอบได้เฉพาะเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบเท่านั้น');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.direction !== 'outgoing') throw httpError(400, 'ผูกได้เฉพาะหนังสือส่ง — ตัวหนังสือตอบคือหนังสือที่เราส่งออกไป');

  if (!replyToId) {
    if (!doc.reply_to_id) return { ok: true, changed: false };
    db.prepare('UPDATE documents SET reply_to_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), doc.id);
    audit({ userId: actorUser.id, action: 'document_reply_unlinked', tableName: 'documents', recordId: doc.id, detail: { before: doc.reply_to_id } });
    return { ok: true, changed: true };
  }

  const target = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(replyToId);
  if (!target) throw httpError(404, 'ไม่พบหนังสือเข้าที่เลือก');
  if (target.direction !== 'incoming') throw httpError(400, 'ต้องเลือกหนังสือเข้าเท่านั้น');
  // ผูกกับตัวเองหรือผูกเป็นวงไม่ได้ (หนังสือส่งกับหนังสือเข้าคนละทิศอยู่แล้ว แต่กันไว้ให้ชัด)
  if (target.id === doc.id) throw httpError(400, 'ผูกกับตัวเองไม่ได้');

  db.prepare('UPDATE documents SET reply_to_id = ?, updated_at = ? WHERE id = ?').run(target.id, nowIso(), doc.id);
  audit({
    userId: actorUser.id, action: 'document_reply_linked', tableName: 'documents', recordId: doc.id,
    detail: { replyTo: target.id, replyToNumber: target.doc_number_display },
  });
  return { ok: true, changed: true, replyTo: { id: target.id, docNumberDisplay: target.doc_number_display, title: target.title } };
}

/** หนังสือส่งที่เป็นตัวตอบของหนังสือเข้าฉบับนี้ (มีได้หลายฉบับ) */
export function repliesOf(incomingId) {
  return db.prepare(`
    SELECT id, doc_number_display, title, status, sent_at, created_at
    FROM documents WHERE reply_to_id = ? AND deleted_at IS NULL ORDER BY created_at
  `).all(incomingId);
}

/** หนังสือเข้าที่ฉบับนี้ตอบอยู่ */
export function replyTargetOf(doc) {
  if (!doc?.reply_to_id) return null;
  return db.prepare('SELECT id, doc_number_display, title, received_date, created_at FROM documents WHERE id = ? AND deleted_at IS NULL')
    .get(doc.reply_to_id) || null;
}

/** หนังสือเข้าที่ติ๊กว่าต้องตอบ แต่ยังไม่มีหนังสือตอบผูกอยู่ — รายการที่ธุรการต้องตามเคลียร์ */
export function awaitingReplySql() {
  return `d.direction = 'incoming' AND d.needs_reply = 1
    AND d.status NOT IN ('voided', 'destroyed')
    AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.reply_to_id = d.id AND r.deleted_at IS NULL)`;
}

export function countAwaitingReply(visibleSql, visibleParams) {
  return db.prepare(`
    SELECT COUNT(*) c FROM documents d WHERE d.deleted_at IS NULL AND ${awaitingReplySql()} AND ${visibleSql}
  `).get(visibleParams).c;
}

/** หนังสือเข้าที่ยังรอตอบ — ใช้ทำตัวเลือกในหน้าหนังสือส่ง ("ฉบับนี้ตอบเรื่องไหน") */
export function replyCandidates(limit = 50, includeId = null) {
  return db.prepare(`
    SELECT id, doc_number_display, title, received_date, created_at FROM documents d
    WHERE d.deleted_at IS NULL AND (${awaitingReplySql()} OR d.id = :includeId)
    ORDER BY d.created_at DESC LIMIT :limit
  `).all({ limit, includeId });
}
