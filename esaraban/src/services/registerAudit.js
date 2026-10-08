// ตรวจความครบถ้วนของทะเบียนหนังสือ — เลขขาด เลขซ้ำ และเลขที่หายไปเพราะเอกสารถูกลบ
//
// ทะเบียนหนังสือรับ/ส่งเป็นเอกสารราชการที่ต้องยืนยันได้ว่า "เลข 1 ถึง N ครบถ้วน" ตอนตรวจสอบภายใน
// หรือตอนส่งมอบงานสารบรรณ เลขที่หายไปหนึ่งเลขโดยอธิบายไม่ได้คือสิ่งที่ผู้ตรวจจะถามทันที และเป็น
// เหตุผลที่ระบบนี้ห้ามนำเลขที่ออกไปแล้วกลับมาใช้ซ้ำตั้งแต่ต้น
//
// เดิมระบบไม่มีทางบอกเลยว่าเล่มไหนครบหรือไม่ครบ ต้องพิมพ์ทะเบียนออกมาแล้วไล่นิ้วดูเองทีละแถว
// ซึ่งเล่มหนึ่งมีพันกว่าแถว — ในทางปฏิบัติแปลว่าไม่มีใครตรวจ จนกว่าจะมีคนมาถามแล้วตอบไม่ได้
//
// สิ่งที่ต้องแยกให้ชัด เพราะสองอย่างนี้ตอบผู้ตรวจคนละแบบ:
//   - เลขที่ยกเลิก (voided) ยังอยู่ในเล่ม มีเหตุผลกำกับ = ถูกต้องตามระเบียบ ไม่ใช่เลขขาด
//   - เลขที่หายเพราะเอกสารถูกลบถาวร = ต้องอธิบายได้ว่าใครลบ เมื่อไร เพราะอะไร (ระบบเก็บ audit ไว้)
import { db } from '../db.js';
import { visibleDocumentsSqlFilter } from './workflow.js';
import { runningNumberFromDisplay } from '../numbering.js';
import { outgoingNumberFloor } from './settings.js';

/**
 * ตรวจเล่มหนึ่งเล่ม (ทะเบียนรับหรือส่ง ของปี พ.ศ. หนึ่งปี)
 *
 * นับจาก running_number ซึ่งเป็นเลขลำดับจริงที่ระบบออกให้ ไม่ใช่ doc_number_display ที่ธุรการพิมพ์
 * ทับเองได้ — เลขที่พิมพ์เองไว้ (เช่นให้ตรงกับเล่มกระดาษ) จึงถูกรายงานแยกไว้ต่างหาก ไม่ปนกับเลขขาด
 */
export function auditRegister({ user, direction, year }) {
  const visible = visibleDocumentsSqlFilter(user);
  const params = { ...visible.params, direction, year };

  // เอกสารที่ยังอยู่ในเล่ม (รวมที่ยกเลิกแล้ว เพราะเลขยังคงอยู่ในลำดับตามระเบียบ)
  const live = db.prepare(`
    SELECT d.id, d.running_number, d.doc_number_display, d.title, d.status
    FROM documents d
    WHERE d.deleted_at IS NULL AND d.direction = :direction AND d.year_be = :year AND ${visible.sql}
    ORDER BY d.running_number
  `).all(params);

  // เอกสารที่ถูกลบถาวรไปแล้ว — เลขของมันคือรูโหว่ในเล่ม ต้องอธิบายได้ว่าหายไปไหน
  const deleted = db.prepare(`
    SELECT d.id, d.running_number, d.doc_number_display, d.title, d.deleted_at,
      (SELECT a.detail FROM audit_logs a
        WHERE a.record_id = d.id AND a.action = 'document_force_deleted'
        ORDER BY a.created_at DESC LIMIT 1) AS delete_detail,
      (SELECT COALESCE(u.prefix, '') || u.first_name || ' ' || u.last_name FROM audit_logs a
        JOIN users u ON u.id = a.user_id
        WHERE a.record_id = d.id AND a.action = 'document_force_deleted'
        ORDER BY a.created_at DESC LIMIT 1) AS deleted_by_name
    FROM documents d
    WHERE d.deleted_at IS NOT NULL AND d.direction = :direction AND d.year_be = :year
    ORDER BY d.running_number
  `).all({ direction, year });

  /*
   * เลขที่แสดงกับเลขลำดับข้างในไม่ตรงกัน — ความผิดปกติคนละชนิดกับ "เลขขาด" และ "เลขซ้ำ"
   *
   * เกิดจากการแก้เลขที่แสดงโดยไม่ได้แก้เลขลำดับตามไปด้วย (บั๊กที่แก้ไปแล้ว แต่แถวเก่ายังค้างอยู่)
   * ถ้าไม่แยกออกมา มันจะไปโผล่เป็น "เลขขาดโดยไม่พบร่องรอย" ที่ตำแหน่งของเลขที่แสดง ซึ่งน่าตกใจ
   * และไม่ตรงความจริง — เลขนั้นมีหนังสืออยู่จริง แค่ระบบบันทึกเลขลำดับไว้ผิดช่อง
   */
  const mismatched = live
    .map((d) => ({ doc: d, shown: runningNumberFromDisplay(d.doc_number_display) }))
    .filter(({ doc, shown }) => shown !== null && shown !== doc.running_number)
    .map(({ doc, shown }) => ({
      id: doc.id, title: doc.title, docNumberDisplay: doc.doc_number_display,
      shown, stored: doc.running_number,
    }));

  // เลขที่ "มีหนังสือถืออยู่จริง" — นับทั้งเลขลำดับและเลขที่แสดง เพราะแถวที่สองค่าไม่ตรงกันถือไว้ทั้งคู่
  const used = new Set(live.map((d) => d.running_number).filter((n) => n > 0));
  const claimed = new Set(used);
  for (const m of mismatched) claimed.add(m.shown);
  const deletedByNumber = new Map(deleted.filter((d) => d.running_number > 0).map((d) => [d.running_number, d]));
  const highest = Math.max(0, ...claimed, ...deletedByNumber.keys());

  /*
   * เล่มไม่ได้เริ่มที่ 1 เสมอไป
   *
   * โรงเรียนที่ย้ายมาจากสมุดกระดาษกลางปีตั้ง "เลขล่าสุดที่ออกไปแล้ว" ไว้ (ดู outgoingNumberFloor)
   * เลขก่อนหน้านั้นอยู่ในเล่มกระดาษ ไม่เคยผ่านระบบนี้ — ถ้านับเป็นเลขขาด ธุรการจะกดตรวจครั้งแรก
   * แล้วเจอ "เลขขาด 205 เลข ไม่พบร่องรอย" ซึ่งน่าตกใจ ไม่เป็นความจริง และทำให้เลิกใช้เครื่องมือนี้ไปเลย
   */
  const floor = direction === 'outgoing' ? outgoingNumberFloor(year) : 0;
  const startsAt = floor + 1;

  const missing = [];
  for (let n = startsAt; n <= highest; n++) {
    if (claimed.has(n)) continue;
    const gone = deletedByNumber.get(n);
    missing.push({
      number: n,
      reason: gone ? 'deleted' : 'unknown',
      docNumberDisplay: gone?.doc_number_display || null,
      title: gone?.title || null,
      deletedAt: gone?.deleted_at || null,
      deletedByName: gone?.deleted_by_name || null,
      deleteReason: (() => {
        try { return JSON.parse(gone?.delete_detail || '{}').reason || null; } catch { return null; }
      })(),
    });
  }

  // เลขซ้ำ: นับจากเลขที่แสดงจริง เพราะนั่นคือเลขที่ใช้อ้างอิงหนังสือฉบับนั้นข้างนอกระบบ
  const byDisplay = new Map();
  for (const d of live) {
    if (!byDisplay.has(d.doc_number_display)) byDisplay.set(d.doc_number_display, []);
    byDisplay.get(d.doc_number_display).push(d);
  }
  const duplicates = [...byDisplay.entries()]
    .filter(([, docs]) => docs.length > 1)
    .map(([number, docs]) => ({ number, docs }));

  const voided = live.filter((d) => d.status === 'voided');
  return {
    direction,
    year,
    total: live.length,
    highest,
    startsAt,
    missing,
    duplicates,
    mismatched,
    voided,
    complete: missing.length === 0 && duplicates.length === 0 && mismatched.length === 0,
  };
}
