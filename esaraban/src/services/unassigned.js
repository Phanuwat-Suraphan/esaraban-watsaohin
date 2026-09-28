// หนังสือเข้าที่ลงทะเบียนแล้ว แต่ยังไม่ได้เสนอใครเลย
//
// นี่คือช่องที่หนังสือหายเงียบที่สุดในระบบ และเป็นช่องเดียวที่ไม่มีอะไรจับได้เลยก่อนหน้านี้:
//
//   - ไม่อยู่ใน "งานของฉัน" ของใคร เพราะยังไม่มีขั้นตอน (workflow_steps) สักขั้น
//   - ไม่อยู่ในปุ่มตามงานค้าง เพราะตัวนั้นไล่จากขั้นตอนที่ waiting อยู่ (pendingChaseGroups)
//   - ไม่อยู่ในตัวเลข "งานค้างทั้งหมดทุกฝ่าย" บนแดชบอร์ด ด้วยเหตุผลเดียวกัน
//   - ไม่อยู่ในเตือนงานค้างประจำวัน เพราะยังไม่มีเจ้าของให้เตือน
//
// รวมแล้วคือ "ไม่มีใครถืออยู่" — หนังสือด่วนที่สุดที่ลงทะเบียนไว้แล้วลืมเสนอ จึงนอนอยู่ในทะเบียน
// ปนกับฉบับอื่นจนกว่าจะมีคนโทรมาทวง ซึ่งเป็นเรื่องที่เกิดขึ้นจริงและเป็นเหตุผลที่ระเบียบงานสารบรรณ
// กำหนดให้เสนอหนังสือรับต่อผู้บังคับบัญชาโดยเร็ว
//
// สิ่งที่ไฟล์นี้ทำคือทำให้กองนั้น "มีตัวตน": นับได้ กรองดูได้ในทะเบียน ขึ้นเตือนบนแดชบอร์ด และติดไป
// กับข้อความเตือนประจำวันของธุรการ
// เงื่อนไข SQL ของกองนี้อยู่ที่ documentQuery.js ร่วมกับตัวกรองอื่นของทะเบียน (และร่วมกับ
// CLOSED_STATUSES ที่มันต้องใช้) — ถ้าย้ายมาไว้ที่นี่จะกลายเป็นวงกลมระหว่างสองไฟล์ทันที
import { db, todayInBangkok } from '../db.js';
import { unassignedSql } from './documentQuery.js';
import { countWorkingDays } from './leave.js';
import { holidaySetBetween } from './holidays.js';

/**
 * ใครควรเห็นกองนี้ — คนที่ "เสนอหนังสือ" ได้จริง
 *
 * ธุรการเป็นคนลงทะเบียนและเป็นคนเสนอ ส่วนผู้บริหารต้องเห็นเพราะเป็นตัวชี้ว่างานสารบรรณติดขัดตรงไหน
 * ครูทั่วไปไม่ต้องเห็น เพราะเสนอหนังสือของฝ่ายอื่นไม่ได้อยู่แล้ว การโชว์ให้ก็มีแต่ทำให้สับสน
 */
const SEE_ROLES = ['admin', 'registrar', 'director', 'vice_director'];
export const canSeeUnassigned = (user) => user.roleCodes.some((r) => SEE_ROLES.includes(r));

/**
 * ภายในกี่วันทำการจึงถือว่าช้าเกินควร
 *
 * ระเบียบงานสารบรรณไม่ได้กำหนดเป็นจำนวนวันตายตัว บอกแต่ว่าให้เสนอ "โดยเร็ว" ค่าที่ใช้จึงอิงจาก
 * ชั้นความเร็วของหนังสือเอง ซึ่งเป็นสิ่งที่หน่วยงานต้นทางกำหนดมาแล้วว่าเรื่องนี้เร่งแค่ไหน:
 * ด่วนทุกระดับต้องไม่ข้ามวันทำการ ส่วนหนังสือปกติให้เวลาสองวันทำการ (มาวันศุกร์ เสนอวันอังคารยังทัน)
 *
 * นับเป็น "วันทำการ" ไม่ใช่วันปฏิทิน เพราะหนังสือที่มาถึงเย็นวันศุกร์ไม่ควรขึ้นแดงเช้าวันจันทร์
 * ทั้งที่ยังไม่มีใครมาทำงานเลยสักวัน — และปฏิทินวันหยุดราชการอยู่ในระบบอยู่แล้ว (services/holidays.js)
 */
const DAYS_TO_ASSIGN = { most_urgent: 1, very_urgent: 1, urgent: 1, normal: 2 };
export const daysAllowedToAssign = (priority) => DAYS_TO_ASSIGN[priority] ?? DAYS_TO_ASSIGN.normal;

export function countUnassignedIncoming(visibleSql, visibleParams) {
  return db.prepare(`SELECT COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND ${unassignedSql()} AND (${visibleSql})`).get(visibleParams).c;
}

// กี่ฉบับที่ยกมาแสดงในการ์ดเตือน — การ์ดบนแดชบอร์ดมีไว้ให้ "เห็นแล้วลงมือ" ไม่ใช่แทนหน้าทะเบียน
// ถ้ายาวเป็นพืดจะกลายเป็นสิ่งที่ทุกคนเลื่อนผ่าน ส่วนรายการเต็มกดเข้าไปดูที่ทะเบียนได้
export const MAX_UNASSIGNED_SHOWN = 8;

/**
 * รายการหนังสือเข้าที่ยังไม่ได้เสนอ พร้อมอายุเป็นวันทำการและธงว่าช้าเกินควรหรือยัง
 *
 * เรียงจากที่ควรรีบที่สุดก่อน: ช้าเกินควรขึ้นก่อน แล้วค่อยเรียงตามชั้นความเร็วและอายุ — ไม่ใช่เรียง
 * ตามเลขทะเบียน เพราะคนเปิดการ์ดนี้ต้องการรู้ว่า "ต้องหยิบฉบับไหนก่อน" ไม่ใช่ลำดับในสมุด
 */
export function unassignedIncoming(user, visible, { limit = MAX_UNASSIGNED_SHOWN } = {}) {
  if (!canSeeUnassigned(user)) return { total: 0, lateCount: 0, docs: [], hiddenCount: 0 };
  const rows = db.prepare(`
    SELECT d.id, d.doc_number_display, d.title, d.priority, d.secret_level, d.due_date,
      d.received_date, ${'d.created_at'} AS created_at
    FROM documents d
    WHERE d.deleted_at IS NULL AND ${unassignedSql()} AND (${visible.sql})
    ORDER BY d.created_at
  `).all(visible.params);
  if (!rows.length) return { total: 0, lateCount: 0, docs: [], hiddenCount: 0 };

  const today = todayInBangkok();
  // ดึงวันหยุดครั้งเดียวสำหรับทั้งช่วง ไม่ใช่ถามฐานข้อมูลใหม่ทุกแถว — การ์ดนี้เรนเดอร์ทุกครั้งที่เปิด
  // แดชบอร์ดและหน้าทะเบียน
  const oldest = rows.reduce((min, r) => (dayOf(r) < min ? dayOf(r) : min), today);
  const holidays = holidaySetBetween(oldest, today);

  const docs = rows.map((r) => {
    const from = dayOf(r);
    // นับรวมวันที่ลงทะเบียนเอง ถ้าลงวันนี้จะได้ 1 วันทำการ = ยังไม่ช้า (เพดานต่ำสุดคือ 1 วัน)
    const workingDays = countWorkingDays(from, today, holidays);
    const allowed = daysAllowedToAssign(r.priority);
    return {
      id: r.id, number: r.doc_number_display, title: r.title, priority: r.priority,
      secret: ['secret', 'top_secret'].includes(r.secret_level),
      sinceDate: from, workingDays, allowed, late: workingDays > allowed,
    };
  });

  const PRIORITY_RANK = { most_urgent: 0, very_urgent: 1, urgent: 2, normal: 3 };
  docs.sort((a, b) => Number(b.late) - Number(a.late)
    || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
    || b.workingDays - a.workingDays);

  return {
    total: docs.length,
    lateCount: docs.filter((d) => d.late).length,
    docs: docs.slice(0, limit),
    hiddenCount: Math.max(0, docs.length - limit),
  };
}

/**
 * วันที่เริ่มนับอายุ — "วันที่รับ" ที่ธุรการกรอก ไม่ใช่วันที่กดบันทึกเข้าระบบ
 *
 * ต่างกันจริงเวลาลงย้อนหลัง (หนังสือมาวันศุกร์ ธุรการมาลงวันจันทร์) ซึ่งกรณีนั้นหนังสือค้างมาตั้งแต่
 * วันศุกร์แล้ว ไม่ใช่เพิ่งค้างวันนี้ — ถ้านับจากวันที่บันทึก การลงย้อนหลังจะล้างอายุที่ค้างมาทิ้งหมด
 */
function dayOf(row) {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.received_date || '') ? row.received_date : String(row.created_at).slice(0, 10);
}

/**
 * บรรทัดสรุปสำหรับข้อความเตือนประจำวันของธุรการ — คืนค่าว่างเมื่อไม่มีอะไรค้าง
 *
 * ตั้งใจให้เป็นบรรทัดเดียวจบ ไม่ไล่รายฉบับ เพราะข้อความเตือนประจำวันมีเนื้ออื่นอยู่แล้ว และรายการเต็ม
 * อยู่ห่างออกไปแค่ลิงก์เดียว
 */
export function unassignedReminderLine(summary) {
  if (!summary?.total) return '';
  const late = summary.lateCount ? ` (เกินกำหนดควรเสนอแล้ว ${summary.lateCount} ฉบับ)` : '';
  return `📥 หนังสือเข้าที่ลงทะเบียนแล้วแต่ยังไม่ได้เสนอใคร ${summary.total} ฉบับ${late}`;
}
