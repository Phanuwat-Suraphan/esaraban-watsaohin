// บัญชีแจ้งเวียน — ใครอ่านหนังสือเวียนแล้วบ้าง ใครยังไม่อ่าน
//
// บนกระดาษ หนังสือเวียนมาพร้อม "บัญชีแจ้งเวียน" ให้ครูเซ็นชื่อกำกับว่ารับทราบแล้ว ซึ่งเป็นหลักฐาน
// ว่าแจ้งถึงตัวจริง ไม่ใช่แค่ติดบอร์ดไว้ ระบบเดิมยิงแจ้งเตือนให้ทุกคนแล้วเก็บไว้แค่ "ส่งถึง 38 คน"
// จึงตอบคำถามเดียวที่ธุรการต้องตอบไม่ได้เลย: เวลามีคนบอกว่า "ไม่เห็นได้รับแจ้ง" ก็ไม่มีอะไรยืนยัน
// และเวลาต้องตามให้ครบก่อนวันงาน ก็ไม่รู้ว่าเหลือใครบ้าง ต้องไล่ถามเอาเองทีละคน
//
// ตัวนี้เก็บรายคนว่าใครได้รับและเปิดอ่านเมื่อไร แล้วประกอบเป็นข้อความตามคนที่ยังไม่อ่านให้เลย
// (เหตุผลเดียวกับผู้ที่ต้องทราบของคำสั่งโรงเรียน ดู services/schoolOrder.js)
import { db, nowIso } from '../db.js';

/** บันทึกว่าใครได้รับหนังสือเวียนรอบนี้บ้าง — เรียกอยู่ในธุรกรรมเดียวกับการแจ้งเวียน */
export function recordBroadcastRecipients(broadcastId, userIds) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO document_broadcast_reads
    (broadcast_id, user_id, opened_at, created_at) VALUES (?, ?, NULL, ?)`);
  const now = nowIso();
  for (const userId of userIds) stmt.run(broadcastId, userId, now);
}

/**
 * บันทึกว่าคนนี้เปิดอ่านหนังสือเวียนของเอกสารฉบับนี้แล้ว
 *
 * ปิดทุกรอบการแจ้งเวียนของเอกสารฉบับเดียวกันพร้อมกัน เพราะการอ่านหนังสือหนึ่งครั้งคือการรับทราบ
 * เนื้อหาฉบับนั้น ไม่ได้แยกตามว่าธุรการกดแจ้งซ้ำไปกี่รอบ — ถ้าแยก คนที่อ่านหลังการแจ้งรอบสองจะขึ้น
 * ว่า "ยังไม่อ่านรอบแรก" ตลอดไปทั้งที่อ่านเนื้อหาไปแล้ว
 *
 * ไม่ทับเวลาเดิม เพราะที่ต้องตอบได้คือ "รู้เรื่องนี้ตั้งแต่เมื่อไร" ไม่ใช่ "เปิดล่าสุดเมื่อไร"
 */
export function markBroadcastRead(documentId, userId) {
  return db.prepare(`
    UPDATE document_broadcast_reads SET opened_at = ?
    WHERE user_id = ? AND opened_at IS NULL AND broadcast_id IN (
      SELECT id FROM document_broadcasts WHERE document_id = ?
    )`).run(nowIso(), userId, documentId).changes > 0;
}

// กี่ชื่อที่ยกมาแสดง/ใส่ในข้อความ — โรงเรียนขนาดใหญ่มีครูเป็นร้อย รายชื่อที่ยาวเป็นพืดในกลุ่มไลน์
// คือสิ่งที่ทุกคนเลื่อนผ่าน และบนหน้าเว็บก็ดันเนื้อหาอื่นตกไปท้ายหน้า
export const MAX_UNREAD_SHOWN = 25;

/**
 * สถิติการอ่านของเอกสารฉบับหนึ่ง รวมทุกรอบการแจ้งเวียน
 *
 * `tracked` แยก "ยังไม่มีใครอ่านเลย" ออกจาก "แจ้งเวียนไปก่อนที่ระบบจะเก็บสถิติ" — สองอย่างนี้ต่างกัน
 * มาก การโชว์ 0/38 ให้กับของเก่าจะทำให้ธุรการไล่ตามคนทั้งโรงเรียนใหม่ทั้งที่ทุกคนอาจอ่านไปแล้ว
 */
export function broadcastReadStats(documentId) {
  const rows = db.prepare(`
    SELECT r.user_id, r.opened_at, u.prefix, u.first_name, u.last_name, u.position,
      u.deleted_at, u.status
    FROM document_broadcast_reads r
    JOIN document_broadcasts b ON b.id = r.broadcast_id
    JOIN users u ON u.id = r.user_id
    WHERE b.document_id = ?
  `).all(documentId);
  if (!rows.length) return { tracked: false, total: 0, readCount: 0, unread: [], hiddenCount: 0 };

  // แจ้งเวียนซ้ำหลายรอบทำให้คนเดียวมีหลายแถว — ยุบเป็นคนละหนึ่ง และถือว่าอ่านแล้วถ้าอ่านรอบไหนก็ตาม
  const byUser = new Map();
  for (const r of rows) {
    const prev = byUser.get(r.user_id);
    if (!prev || (!prev.opened_at && r.opened_at)) byUser.set(r.user_id, r);
  }
  // คนที่ลาออก/ถูกปิดบัญชีไปแล้วไม่ต้องตามอีก และไม่ควรถ่วงตัวหารให้ดูเหมือนยังแจ้งไม่ครบตลอดไป
  const active = [...byUser.values()].filter((r) => !r.deleted_at && r.status === 'active');
  const unreadAll = active.filter((r) => !r.opened_at)
    .map((r) => ({
      userId: r.user_id,
      name: `${r.prefix || ''}${r.first_name || ''} ${r.last_name || ''}`.trim(),
      position: r.position || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
  return {
    tracked: true,
    total: active.length,
    readCount: active.length - unreadAll.length,
    unread: unreadAll.slice(0, MAX_UNREAD_SHOWN),
    hiddenCount: Math.max(0, unreadAll.length - MAX_UNREAD_SHOWN),
    unreadCount: unreadAll.length,
  };
}

// กี่ฉบับที่ยกมาเตือนบนแดชบอร์ด — การ์ดเตือนมีไว้ให้ "เห็นแล้วลงมือ" ไม่ใช่แทนหน้าทะเบียน
export const MAX_PENDING_BROADCASTS = 5;

/**
 * หนังสือเวียนที่ยังอ่านไม่ครบ — สำหรับเตือนบนแดชบอร์ดของคนที่แจ้งเวียนได้
 *
 * ถ้าไม่มีที่รวมแบบนี้ สถิติการอ่านจะช่วยได้เฉพาะตอนที่บังเอิญเปิดหนังสือฉบับนั้นอยู่พอดี ซึ่งไม่ใช่
 * สิ่งที่เกิดขึ้น — เวลาที่ต้องใช้จริงคือ "ก่อนวันงาน เหลือใครยังไม่รู้เรื่องบ้าง" ซึ่งต้องเริ่มจาก
 * คำถามว่ามีหนังสือเวียนฉบับไหนที่ยังตามไม่ครบ
 *
 * ดูเฉพาะหนังสือที่แจ้งเวียนไปแล้วไม่เกิน RECENT_DAYS วัน — ของเก่ากว่านั้นตามไปก็ไม่มีประโยชน์แล้ว
 * และจะค้างเป็นเสียงรบกวนถาวรบนแดชบอร์ด
 */
const RECENT_DAYS = 30;
export function pendingBroadcasts(limit = MAX_PENDING_BROADCASTS) {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  const rows = db.prepare(`
    SELECT d.id, d.doc_number_display, d.title, MAX(b.created_at) AS last_sent,
      COUNT(*) AS total,
      SUM(CASE WHEN r.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
    FROM document_broadcast_reads r
    JOIN document_broadcasts b ON b.id = r.broadcast_id
    JOIN documents d ON d.id = b.document_id
    JOIN users u ON u.id = r.user_id
    WHERE d.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active'
      AND b.created_at >= ?
    GROUP BY d.id
    HAVING read_count < total
    ORDER BY last_sent DESC
  `).all(since);
  return {
    total: rows.length,
    // นับจาก rows ทั้งหมด ไม่ใช่เฉพาะที่ยกมาแสดง — ตัวเลขนี้ไปอยู่บนหัวข้อกล่องเตือนที่พับอยู่
    // ซึ่งเป็นสิ่งเดียวที่บอกว่ากองนี้ใหญ่แค่ไหน ("5 ฉบับ" เฉยๆ ไม่ได้บอกว่ามีคนยังไม่รู้เรื่องกี่สิบคน)
    // ถ้านับเฉพาะที่แสดง ตัวเลขจะต่ำกว่าความจริงทุกครั้งที่มีเกินโควตาที่ยกมาแสดง
    unreadTotal: rows.reduce((sum, r) => sum + (r.total - r.read_count), 0),
    docs: rows.slice(0, limit).map((r) => ({
      id: r.id, number: r.doc_number_display, title: r.title,
      readCount: r.read_count, totalCount: r.total, unread: r.total - r.read_count, lastSent: r.last_sent,
    })),
    hiddenCount: Math.max(0, rows.length - limit),
  };
}
