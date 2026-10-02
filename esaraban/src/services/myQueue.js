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
import { canUserSeeDocument, visibleDocumentsSqlFilter } from './workflow.js';

/**
 * งานของฉัน = ขั้นที่มอบหมายถึงเราตรงๆ + ขั้นของคนที่มอบให้เรารักษาการแทน (ที่ยัง active วันนี้)
 *
 * ต้องผูก :me และ :today เสมอ ผู้เรียกจึงต้องส่งทั้งสองค่าเข้ามาใน params
 */
export const MY_OR_DELEGATED_STEP_SQL = `(ws.assignee_id = :me OR ws.assignee_id IN (
  SELECT delegator_id FROM user_delegations
  WHERE delegate_id = :me AND cancelled_at IS NULL AND start_date <= :today AND end_date >= :today
))`;

// เพดานแถวที่ดึงมาคำนวณคิวในหนึ่งครั้ง — ใช้กับตัวไล่ฉบับ (queuePosition / nextInQueue) ซึ่งต้องรู้
// ลำดับทั้งคิว ไม่ใช่แค่หน้าเดียว ปกติงานค้างของคนหนึ่งคนมีไม่กี่สิบฉบับ แต่ถ้าเรื่องไปค้างสะสมอยู่ที่
// ใครคนหนึ่ง (เช่นคนที่ย้ายออกไปแล้วแต่ยังมีเรื่องจ่อคิว) ต้องมีเพดานไว้ ไม่งั้นโตไม่มีที่สิ้นสุด
export const MAX_TASK_ROWS = 300;

// จำนวนแถวต่อหน้าของ "งานของฉัน" — เท่ากับทะเบียนหนังสือ (ดู PAGE_SIZE ใน routes/documents.js)
//
// วัดจริง: หน้านี้เคยเทแถวทั้งเพดาน 300 แถวลงหน้าเดียว ได้ 260KB ต่อการเปิดหนึ่งครั้ง ซึ่งหนักที่สุด
// ในระบบ และเป็นหน้าที่คนทำงานเปิดบ่อยที่สุดด้วย — ที่แย่กว่าขนาดคือ 300 แถวบนมือถือหาอะไรไม่เจอเลย
export const TASKS_PAGE_SIZE = 50;

/**
 * ลำดับของคิว — เรียงตามวันครบกำหนดก่อน แล้วค่อยตามเวลาที่ถูกมอบหมาย
 *
 * ฉบับที่ไม่มีวันครบกำหนดไปอยู่ท้ายสุดเสมอ ไม่ใช่ขึ้นก่อนเพราะค่าว่างเรียงมาก่อนใน SQL —
 * เดิมหน้านี้เรียงตามชั้นความเร็วอย่างเดียว ทำให้หนังสือ "ปกติ" ที่เลยกำหนดมา 5 วันไปจมอยู่ท้ายตาราง
 *
 * ต้องเรียงใน SQL ไม่ใช่เรียงใน JS หลังดึงมา: พอแบ่งหน้าแล้ว การเรียงทีหลังจะเรียงได้แค่ภายในหน้า
 * ทำให้หน้า 2 ไม่ได้ต่อจากหน้า 1 จริง และของเดิมก็เพี้ยนอยู่แล้ว — SQL ตัดที่เพดานโดยเรียงตาม
 * "ชั้นความเร็ว" แต่หน้าเว็บบอกผู้ใช้ว่าตัดโดยเอา "ที่ใกล้ครบกำหนดที่สุด" ไว้ ซึ่งคนละเกณฑ์กัน
 */
const QUEUE_ORDER_SQL = `
  CASE WHEN d.due_date IS NULL OR d.due_date = '' THEN 1 ELSE 0 END ASC,
  d.due_date ASC,
  ws.created_at ASC`;

/**
 * แถวงานที่รอผู้ใช้คนนี้อยู่ พร้อมจำนวนทั้งหมด (ไม่ใช่แค่จำนวนที่อยู่บนหน้านี้)
 *
 * กรองชั้นความลับทั้งใน SQL และซ้ำอีกชั้นใน JS — ชั้น SQL ทำให้ตัวเลข total ถูกต้องและแบ่งหน้าได้
 * ตรง ส่วนชั้น JS กันกรณีที่สองตัวนี้เลื่อนจากกันในอนาคต (แนวเดียวกับหน้าทะเบียนหนังสือ)
 */
export function myWaitingTasks(user, { today = todayInBangkok(), limit = MAX_TASK_ROWS, offset = 0 } = {}) {
  const vis = visibleDocumentsSqlFilter(user);
  const where = `${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' AND d.deleted_at IS NULL AND ${vis.sql}`;
  const params = { me: user.id, today, ...vis.params };
  const total = db.prepare(`
    SELECT COUNT(*) c FROM workflow_steps ws JOIN documents d ON d.id = ws.document_id WHERE ${where}
  `).get(params).c;
  const rows = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, ws.created_at as assigned_at, (ws.assignee_id != :me) as is_delegated
    FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${where}
    ORDER BY ${QUEUE_ORDER_SQL}
    LIMIT :lim OFFSET :off
  `).all({ ...params, lim: limit, off: offset })
    .filter((d) => canUserSeeDocument(user, d));
  return { rows, total, truncated: total > rows.length + offset };
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
