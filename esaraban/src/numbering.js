import { db, beYear } from './db.js';
import { outgoingNumberPrefix } from './services/settings.js';

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
export function nextRunningNumber({ direction, year = beYear() }) {
  const existing = db
    .prepare('SELECT running_number FROM document_number_counters WHERE year_be = ? AND direction = ?')
    .get(year, direction);

  let next;
  if (existing) {
    next = existing.running_number + 1;
    db.prepare('UPDATE document_number_counters SET running_number = ? WHERE year_be = ? AND direction = ?')
      .run(next, year, direction);
  } else {
    // ปีแรกที่ยังไม่มีตัวนับ ต้องเริ่มนับต่อจากเลขสูงสุดที่เคยออกไปแล้วจริงๆ ไม่ใช่เริ่มที่ 1 —
    // ไม่งั้นฐานข้อมูลที่ใช้งานมาก่อนจะออกเลขซ้ำกับหนังสือที่ลงทะเบียนไปแล้ว (นับรวมเอกสารที่ถูกลบด้วย
    // เพราะเลขที่ออกไปแล้วต้องไม่ถูกนำกลับมาใช้ซ้ำ ตามหลักงานสารบรรณ)
    const issued = db
      .prepare('SELECT COALESCE(MAX(running_number), 0) m FROM documents WHERE year_be = ? AND direction = ?')
      .get(year, direction).m;
    next = issued + 1;
    db.prepare('INSERT INTO document_number_counters (year_be, direction, running_number) VALUES (?, ?, ?)')
      .run(year, direction, next);
  }

  return { runningNumber: next, yearBe: year, display: formatNumber({ direction, runningNumber: next, year }) };
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
export function formatNumber({ direction, runningNumber, year = beYear() }) {
  if (direction === 'outgoing') {
    const prefix = outgoingNumberPrefix();
    if (prefix) return `${prefix}/${runningNumber}`;
  }
  return `${String(runningNumber).padStart(4, '0')}/${year}`;
}

/** ตัวอย่างเลขถัดไปที่จะออก — ใช้โชว์ให้ผู้ดูแลเห็นก่อนบันทึกค่ารหัส ไม่แตะตัวนับจริง */
export function previewNextNumber(direction, prefixOverride) {
  const year = beYear();
  const counter = db.prepare('SELECT running_number FROM document_number_counters WHERE year_be = ? AND direction = ?')
    .get(year, direction);
  const issued = db.prepare('SELECT COALESCE(MAX(running_number), 0) m FROM documents WHERE year_be = ? AND direction = ?')
    .get(year, direction).m;
  const next = (counter ? counter.running_number : issued) + 1;
  if (direction === 'outgoing') {
    const prefix = prefixOverride === undefined ? outgoingNumberPrefix() : String(prefixOverride || '').trim();
    if (prefix) return `${prefix}/${next}`;
  }
  return `${String(next).padStart(4, '0')}/${year}`;
}
