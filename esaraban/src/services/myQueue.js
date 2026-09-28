// คิวงานที่รอผู้ใช้คนนี้อยู่ — และการไล่ดำเนินการต่อเนื่องทีละฉบับ
//
// ทำไมต้องมี: วันที่ธุรการเสนอหนังสือขึ้นไปเป็นปึก ผอ. เปิดหน้า "งานของฉัน" เห็นแปดบรรทัด แล้ววงจร
// ที่ต้องทำคือ กดเข้าฉบับที่ 1 → อ่าน → เลือกความเห็น → ใส่ PIN → กด → หน้าโหลดกลับมาที่ฉบับเดิม
// ซึ่งตอนนี้ไม่มีอะไรให้ทำแล้ว → กด back → หาบรรทัดถัดไปในตาราง → กดเข้าไป → วนใหม่
//
// แปดฉบับจึงเท่ากับเดินกลับไปกลับมาแปดรอบ โดยที่ "กลับไปหาที่เดิมในตาราง" คือขั้นที่เสียเวลาและน่ารำคาญ
// ที่สุด เพราะตารางเรียงใหม่ทุกครั้งที่โหลด (ฉบับที่เพิ่งทำเสร็จหายไป บรรทัดที่เหลือเลื่อนขึ้น)
//
// ไฟล์นี้ทำให้คิวมีลำดับที่แน่นอนหนึ่งชุด ใช้ร่วมกันทั้งหน้า "งานของฉัน" ตัวบอกตำแหน่งบนหน้าเอกสาร
// ("ฉบับที่ 3 จาก 8") และการเด้งไปฉบับถัดไปหลังกดเสร็จ — ถ้าสามที่นี้เรียงคนละแบบ ตัวเลขที่บอกจะโกหก
import { db, todayInBangkok } from '../db.js';
import { canUserSeeDocument } from './workflow.js';

/**
 * งานของฉัน = ขั้นที่มอบหมายถึงเราตรงๆ + ขั้นของคนที่มอบให้เรารักษาการแทน (ที่ยัง active วันนี้)
 *
 * ต้องผูก :me และ :today เสมอ ผู้เรียกจึงต้องส่งทั้งสองค่าเข้ามาใน params
 */
export const MY_OR_DELEGATED_STEP_SQL = `(ws.assignee_id = :me OR ws.assignee_id IN (
  SELECT delegator_id FROM user_delegations
  WHERE delegate_id = :me AND cancelled_at IS NULL AND start_date <= :today AND end_date >= :today
))`;

// เพดานแถวของหน้า "งานของฉัน" — ปกติงานค้างของคนหนึ่งคนมีไม่กี่สิบฉบับ แต่ถ้าเรื่องไปค้างสะสมอยู่ที่
// ใครคนหนึ่ง (เช่นคนที่ย้ายออกไปแล้วแต่ยังมีเรื่องจ่อคิว) หน้าจะโตขึ้นเรื่อยๆ ไม่มีที่สิ้นสุด
export const MAX_TASK_ROWS = 300;

/**
 * ลำดับของคิว — เรียงตามวันครบกำหนดก่อน แล้วค่อยตามเวลาที่ถูกมอบหมาย
 *
 * ฉบับที่ไม่มีวันครบกำหนดไปอยู่ท้ายสุดเสมอ ไม่ใช่ขึ้นก่อนเพราะค่าว่างเรียงมาก่อนใน SQL —
 * เดิมหน้านี้เรียงตามชั้นความเร็วอย่างเดียว ทำให้หนังสือ "ปกติ" ที่เลยกำหนดมา 5 วันไปจมอยู่ท้ายตาราง
 */
function byDueThenAssigned(a, b) {
  const da = a.due_date || '';
  const dbb = b.due_date || '';
  if (!da && dbb) return 1;
  if (!dbb && da) return -1;
  if (da && dbb && da !== dbb) return da < dbb ? -1 : 1;
  return String(a.assigned_at).localeCompare(String(b.assigned_at));
}

/**
 * แถวงานที่รอผู้ใช้คนนี้อยู่ พร้อมธงว่าถูกตัดเพราะเกินเพดานหรือไม่
 *
 * กรองชั้นความลับซ้ำอีกชั้นเสมอ — ปกติคนที่ถูกมอบหมายก็เห็นอยู่แล้ว แต่ถ้าชั้นความลับของเอกสารถูก
 * ยกระดับขึ้นทีหลัง แถวเก่าต้องหายไปด้วย ไม่ใช่ยังโชว์ชื่อเรื่องค้างไว้
 */
export function myWaitingTasks(user, { today = todayInBangkok() } = {}) {
  const rawRows = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, ws.created_at as assigned_at, (ws.assignee_id != :me) as is_delegated
    FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' AND d.deleted_at IS NULL
    ORDER BY d.priority DESC, ws.created_at ASC
    LIMIT ${MAX_TASK_ROWS + 1}
  `).all({ me: user.id, today });
  // ดึงมาเกินหนึ่งแถวเพื่อรู้ว่าถูกตัดหรือเปล่า แล้วบอกผู้ใช้ตรงๆ ไม่ใช่ตัดทิ้งเงียบๆ
  const truncated = rawRows.length > MAX_TASK_ROWS;
  const rows = rawRows.slice(0, MAX_TASK_ROWS)
    .filter((d) => canUserSeeDocument(user, d))
    .sort(byDueThenAssigned);
  return { rows, truncated };
}

/**
 * ตำแหน่งของเอกสารฉบับนี้ในคิวของผู้ใช้ พร้อมฉบับก่อนหน้า/ถัดไป
 *
 * คืน null เมื่อเอกสารฉบับนี้ไม่ได้อยู่ในคิวของเขา (เปิดดูเฉยๆ ไม่ได้ถืออยู่) — หน้าเอกสารจะได้ไม่ขึ้น
 * แถบไล่ฉบับให้คนที่ไม่ได้กำลังไล่ทำงานอยู่
 */
export function queuePosition(user, documentId) {
  const { rows, truncated } = myWaitingTasks(user);
  const index = rows.findIndex((r) => r.id === documentId);
  if (index === -1) return null;
  return {
    index: index + 1,
    total: rows.length,
    truncated,
    prevId: index > 0 ? rows[index - 1].id : null,
    nextId: index < rows.length - 1 ? rows[index + 1].id : null,
  };
}

/**
 * ฉบับถัดไปที่ควรเปิดต่อ หลังเพิ่งทำฉบับ afterId เสร็จ
 *
 * คำนวณสดตอนถูกเรียก ไม่ใช่ใช้ค่าที่ฝังไว้ตอนเรนเดอร์หน้า — ระหว่างที่ ผอ. นั่งอ่านอยู่ ธุรการอาจเสนอ
 * ฉบับใหม่ขึ้นมา หรือคนอื่นอาจดึงเรื่องไป คิว ณ ตอนกดเสร็จจึงไม่เท่ากับคิวตอนเปิดหน้า
 *
 * ตัด afterId ออกเสมอ เผื่อกรณีที่ขั้นตอนยังไม่หลุดจากคิว (เช่นกดไม่สำเร็จบางส่วน) — ไม่งั้นจะเด้งวนกลับ
 * มาที่ฉบับเดิมซ้ำๆ ซึ่งอ่านเหมือนระบบค้าง
 */
export function nextInQueue(user, afterId) {
  const { rows } = myWaitingTasks(user);
  const remaining = rows.filter((r) => r.id !== afterId);
  return remaining.length ? { id: remaining[0].id, remaining: remaining.length } : { id: null, remaining: 0 };
}
