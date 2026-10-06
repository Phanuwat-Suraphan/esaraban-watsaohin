import { db, beYear } from './db.js';
import { outgoingNumberPrefix, outgoingNumberFloor } from './services/settings.js';

/**
 * เลขพื้นของเล่มทะเบียน — เลขถัดไปต้องไม่ต่ำกว่านี้
 *
 * ใช้กับทะเบียนหนังสือส่งทั่วไปเท่านั้น ไม่ใช่ทะเบียนเวียนและไม่ใช่ทะเบียนรับ: ค่าที่โรงเรียนกรอกคือ
 * "เลขหนังสือส่งล่าสุดที่ออกไปแล้วก่อนมาใช้ระบบนี้" ซึ่งมาจากเล่มหนังสือส่งเล่มเดียว เอาไปใช้กับเล่มอื่น
 * จะดันเลขของเล่มที่ไม่เกี่ยวให้กระโดดตามไปด้วย (ดู CIRCULAR_REGISTER — สองเล่มมีเลข 1 ของตัวเองได้)
 */
function floorFor(direction, isCircular, year) {
  return direction === 'outgoing' && !isCircular ? outgoingNumberFloor(year) : 0;
}

/**
 * ออกเลขทะเบียนหนังสือแบบอะตอมมิก — นับเป็น "ชุดเดียวทั้งโรงเรียนต่อปี" แยกแค่หนังสือเข้ากับหนังสือออก
 * ตรงตามทะเบียนหนังสือรับ/ส่งที่โรงเรียนใช้จริง คือเล่มเดียวเรียงเลข 1, 2, 3 ไปเรื่อยๆ ไม่ว่าฝ่ายไหนจะเป็น
 * ผู้รับผิดชอบเรื่องนั้น
 *
 * เดิมนับแยกตาม ฝ่าย + ประเภทหนังสือ ด้วย แต่เลขที่แสดง/ประทับลงเอกสารจริงเป็น "0001/2569" เฉยๆ
 * ไม่มีรหัสฝ่ายกำกับ ผลคือหนังสือคนละฉบับคนละฝ่ายได้เลขเดียวกัน — ทดสอบแล้วว่าหนังสือของฝ่ายบริหารทั่วไป
 * กับฝ่ายงบประมาณได้ "0001/2569" ทั้งคู่ ซึ่งใช้อ้างอิงไม่ได้เลยในงานสารบรรณ
 *
 * รันอยู่ใน transaction ของผู้เรียก node:sqlite ทำงานแบบ synchronous และโปรเซสนี้เป็น single-thread
 * การอ่าน-บวก-เขียนข้างล่างจึงแทรกกันไม่ได้ ตราบใดที่ไม่มี await คั่นกลาง
 */
export function nextRunningNumber({ direction, year = beYear(), isCircular = false }) {
  // หนังสือเวียนมีเล่มทะเบียนของตัวเอง ตามระเบียบงานสารบรรณ (ดู CIRCULAR_REGISTER)
  const register = registerOf(direction, isCircular);
  const existing = db
    .prepare('SELECT running_number FROM document_number_counters WHERE year_be = ? AND direction = ?')
    .get(year, register);

  const floor = floorFor(direction, isCircular, year);

  let next;
  if (existing) {
    // พื้นต้องกันไว้ที่นี่ด้วย ไม่ใช่แค่ตอนสร้างตัวนับครั้งแรก — ฐานข้อมูลที่ออกเลขไปแล้วก่อนที่โรงเรียน
    // จะกรอกค่านี้ มีตัวนับอยู่แล้วที่เลขต่ำกว่าพื้น (เช่นนับไปถึง 3 แล้วค่อยกรอกว่าเล่มกระดาษอยู่ที่ 205)
    // ถ้ากันแค่ตอนสร้าง ค่าที่กรอกจะไม่มีผลอะไรเลยและไม่มีอะไรบอกว่าเพราะอะไร
    next = Math.max(existing.running_number, floor) + 1;
    db.prepare('UPDATE document_number_counters SET running_number = ? WHERE year_be = ? AND direction = ?')
      .run(next, year, register);
  } else {
    // ปีแรกที่ยังไม่มีตัวนับ ต้องเริ่มนับต่อจากเลขสูงสุดที่เคยออกไปแล้วจริงๆ ไม่ใช่เริ่มที่ 1 —
    // ไม่งั้นฐานข้อมูลที่ใช้งานมาก่อนจะออกเลขซ้ำกับหนังสือที่ลงทะเบียนไปแล้ว (นับรวมเอกสารที่ถูกลบด้วย
    // เพราะเลขที่ออกไปแล้วต้องไม่ถูกนำกลับมาใช้ซ้ำ ตามหลักงานสารบรรณ)
    const issued = db
      .prepare(`SELECT COALESCE(MAX(running_number), 0) m FROM documents
        WHERE year_be = ? AND direction = ? AND is_circular = ?`)
      .get(year, direction, isCircular ? 1 : 0).m;
    next = Math.max(issued, floor) + 1;
    db.prepare('INSERT INTO document_number_counters (year_be, direction, running_number) VALUES (?, ?, ?)')
      .run(year, register, next);
  }

  return {
    runningNumber: next, yearBe: year,
    display: formatNumber({ direction, runningNumber: next, year, isCircular }),
  };
}

/**
 * ทะเบียนที่ใช้นับเลข — หนังสือเวียนนับแยกเล่มจากหนังสือส่งทั่วไป
 *
 * ตามระเบียบงานสารบรรณ หนังสือเวียน (หนังสือที่มีถึงผู้รับจำนวนมากโดยมีใจความอย่างเดียวกัน) ใช้
 * "ทะเบียนหนังสือส่งซึ่งกำหนดเป็นเลขที่หนังสือเวียนโดยเฉพาะ" เริ่มตั้งแต่เลข 1 เรียงไปจนสิ้นปีปฏิทิน
 * — คนละเล่มกับทะเบียนหนังสือส่งทั่วไป ทั้งสองเล่มจึงมีเลข 1 ของตัวเองได้พร้อมกัน ไม่ถือว่าซ้ำ
 *
 * ค่านี้เป็น "เล่มทะเบียน" ไม่ใช่ทิศทางของหนังสือ — หนังสือเวียนยังเป็นหนังสือส่ง
 * (documents.direction = 'outgoing') อยู่เหมือนเดิม
 */
export const CIRCULAR_REGISTER = 'outgoing_circular';
function registerOf(direction, isCircular) {
  return direction === 'outgoing' && isCircular ? CIRCULAR_REGISTER : direction;
}

/**
 * รูปแบบเลขที่แสดงบนหนังสือ
 *
 * หนังสือส่ง: ถ้าโรงเรียนตั้ง "รหัสหนังสือ" ไว้ (เช่น ศธ 04056.12) จะได้ "ศธ 04056.12/45" ซึ่งเป็น
 * รูปแบบตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ ข้อ 11.1/12.1 — ช่อง "ที่" คือรหัสตัวพยัญชนะ
 * และเลขประจำของเจ้าของเรื่อง ทับ เลขทะเบียนหนังสือส่ง โดยไม่มีปีอยู่ในตัวเลขที่ (ปีอยู่บรรทัด "วันที่")
 *
 * ไม่เติมศูนย์นำหน้าเมื่อมีรหัส เพราะบนหนังสือจริงเขียน "ศธ 04056.12/45" ไม่ใช่ ".../0045"
 *
 * หนังสือรับ และหนังสือส่งของโรงเรียนที่ยังไม่ได้ตั้งรหัส: ใช้รูปแบบเดิม 0045/2569
 * เลขทะเบียนรับเป็นเลขของสมุดทะเบียนภายใน ไม่ใช่เลขที่ปรากฏบนหนังสือที่ส่งออกไปข้างนอก
 * จึงไม่ต้องมีรหัสส่วนราชการนำหน้า และการมีปีกำกับช่วยให้อ้างอิงข้ามปีได้สะดวก
 */
export function formatNumber({ direction, runningNumber, year = beYear(), isCircular = false }) {
  // "ว" อยู่หลังเครื่องหมายทับ นำหน้าเลขทะเบียนหนังสือส่งเสมอ เช่น ศธ 0527.10/ว 256
  const circular = direction === 'outgoing' && isCircular;
  if (direction === 'outgoing') {
    const prefix = outgoingNumberPrefix();
    if (prefix) return `${prefix}/${circular ? 'ว ' : ''}${runningNumber}`;
  }
  // ยังไม่ได้ตั้งรหัสโรงเรียน — คงรูปแบบเดิมไว้ แต่ต้องยังบอกได้ว่าเป็นหนังสือเวียน ไม่งั้นเลข 1 ของ
  // ทะเบียนเวียนจะดูเหมือนซ้ำกับเลข 1 ของทะเบียนหนังสือส่งทั่วไปทั้งที่เป็นคนละเล่ม
  return `${circular ? 'ว ' : ''}${String(runningNumber).padStart(4, '0')}/${year}`;
}

/** ตัวอย่างเลขถัดไปที่จะออก — ใช้โชว์ให้ผู้ดูแลเห็นก่อนบันทึกค่ารหัส ไม่แตะตัวนับจริง */
export function previewNextNumber(direction, prefixOverride, isCircular = false) {
  const year = beYear();
  const register = registerOf(direction, isCircular);
  const counter = db.prepare('SELECT running_number FROM document_number_counters WHERE year_be = ? AND direction = ?')
    .get(year, register);
  const issued = db.prepare(`SELECT COALESCE(MAX(running_number), 0) m FROM documents
    WHERE year_be = ? AND direction = ? AND is_circular = ?`).get(year, direction, isCircular ? 1 : 0).m;
  // ต้องคิดพื้นด้วยสูตรเดียวกับ nextRunningNumber เป๊ะ — ตัวอย่างที่โชว์ให้ธุรการเห็นก่อนกดออกเลข
  // ถ้าไม่ตรงกับเลขที่ออกจริง ธุรการจะกดยืนยันโดยเชื่อเลขที่ผิด แล้วเลขจริงไปโผล่บนหนังสือราชการ
  const next = Math.max(counter ? counter.running_number : issued, floorFor(direction, isCircular, year)) + 1;
  const circular = direction === 'outgoing' && isCircular;
  if (direction === 'outgoing') {
    const prefix = prefixOverride === undefined ? outgoingNumberPrefix() : String(prefixOverride || '').trim();
    if (prefix) return `${prefix}/${circular ? 'ว ' : ''}${next}`;
  }
  return `${circular ? 'ว ' : ''}${String(next).padStart(4, '0')}/${year}`;
}
