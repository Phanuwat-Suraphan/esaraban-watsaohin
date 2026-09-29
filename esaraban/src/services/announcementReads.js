// ประกาศ/ประชาสัมพันธ์: แจ้งถึงตัว และรู้ว่าใครอ่านแล้วบ้าง
//
// เดิมหน้าประกาศเป็น "บอร์ดเงียบ" — โพสต์แล้วไม่มีการแจ้งเตือนถึงใครเลย ครูต้องบังเอิญเปิดหน้านั้นเอง
// จึงจะเห็น และผู้ลงประกาศก็ไม่มีทางรู้ว่ามีใครเห็นหรือไม่ ผลคือประกาศเรื่องด่วน (เปลี่ยนกำหนดการ
// งดการเรียนการสอน เรียกประชุมกะทันหัน) อาจไม่ถึงใครเลยโดยไม่มีอะไรฟ้อง — ซึ่งตรงข้ามกับเหตุผล
// ทั้งหมดที่บอร์ดประกาศมีอยู่
//
// กติกาเดียวกับบัญชีแจ้งเวียนของหนังสือ (services/broadcastReads.js) แยกไฟล์กันเพราะคนละตาราง
// และคนละวงจรชีวิต แต่ตั้งใจให้ผู้ใช้เห็นหน้าตาเหมือนกันทั้งสองที่
import { db, nowIso } from '../db.js';

/** บันทึกว่าใครได้รับประกาศฉบับนี้บ้าง — เรียกตอนลงประกาศ */
export function recordAnnouncementRecipients(announcementId, userIds) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO announcement_reads
    (announcement_id, user_id, opened_at, created_at) VALUES (?, ?, NULL, ?)`);
  const now = nowIso();
  for (const userId of userIds) stmt.run(announcementId, userId, now);
}

/** รายชื่อผู้รับ ณ ตอนลงประกาศ — ทุกคนที่ใช้งานอยู่ ยกเว้นคนลงประกาศเอง */
export const announcementAudience = (actorId) => db.prepare(`
  SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active' AND id != ?
`).all(actorId).map((r) => r.id);

/**
 * บันทึกว่าคนนี้เปิดอ่านประกาศแล้ว — ครั้งแรกครั้งเดียว
 *
 * ไม่ทับเวลาเดิมเมื่อเปิดซ้ำ เพราะที่ต้องตอบได้คือ "รู้เรื่องนี้ตั้งแต่เมื่อไร" ไม่ใช่ "เปิดล่าสุดเมื่อไร"
 */
export function markAnnouncementRead(announcementId, userId) {
  return db.prepare(`UPDATE announcement_reads SET opened_at = ?
    WHERE announcement_id = ? AND user_id = ? AND opened_at IS NULL`)
    .run(nowIso(), announcementId, userId).changes > 0;
}

// กี่ชื่อที่ยกมาแสดง/ใส่ในข้อความตาม — รายชื่อยาวเป็นพืดในกลุ่มไลน์คือสิ่งที่ทุกคนเลื่อนผ่าน
export const MAX_UNREAD_SHOWN = 25;

/**
 * สถิติการอ่านของประกาศฉบับหนึ่ง
 *
 * `tracked` แยก "ยังไม่มีใครอ่านเลย" ออกจาก "ลงประกาศไว้ก่อนที่ระบบจะเก็บสถิติ" — การโชว์ 0/38
 * ให้กับของเก่าจะทำให้ผู้ลงประกาศไล่ตามคนทั้งโรงเรียนใหม่ทั้งที่อาจอ่านกันไปหมดแล้ว
 */
export function announcementReadStats(announcementId) {
  const rows = db.prepare(`
    SELECT r.user_id, r.opened_at, u.prefix, u.first_name, u.last_name, u.position, u.deleted_at, u.status
    FROM announcement_reads r JOIN users u ON u.id = r.user_id
    WHERE r.announcement_id = ?
  `).all(announcementId);
  if (!rows.length) return { tracked: false, total: 0, readCount: 0, unread: [], unreadCount: 0, hiddenCount: 0 };

  // คนที่ลาออก/ถูกปิดบัญชีไปแล้วไม่ต้องตามอีก และไม่ควรถ่วงตัวหารให้ดูเหมือนแจ้งไม่ครบตลอดไป
  const active = rows.filter((r) => !r.deleted_at && r.status === 'active');
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
    unreadCount: unreadAll.length,
    hiddenCount: Math.max(0, unreadAll.length - MAX_UNREAD_SHOWN),
  };
}

/** สถิติของหลายฉบับพร้อมกัน — หน้ารายการประกาศต้องไม่ยิงคำสั่งต่อหนึ่งแถว */
export function readStatsByAnnouncement(ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT r.announcement_id,
      COUNT(*) AS total,
      SUM(CASE WHEN r.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
    FROM announcement_reads r JOIN users u ON u.id = r.user_id
    WHERE r.announcement_id IN (${placeholders}) AND u.deleted_at IS NULL AND u.status = 'active'
    GROUP BY r.announcement_id
  `).all(...ids);
  return new Map(rows.map((r) => [r.announcement_id, { total: r.total, readCount: r.read_count }]));
}

/** ประกาศที่คนนี้ยังไม่ได้เปิดอ่าน — ใช้ขึ้นตัวเลขข้างเมนู */
export const unreadAnnouncementCount = (userId) => db.prepare(`
  SELECT COUNT(*) c FROM announcement_reads r JOIN announcements a ON a.id = r.announcement_id
  WHERE r.user_id = ? AND r.opened_at IS NULL AND a.deleted_at IS NULL
`).get(userId).c;
