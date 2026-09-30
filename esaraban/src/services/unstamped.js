// หนังสือเข้าที่มีไฟล์ PDF แล้ว แต่ยังไม่ได้ประทับ "ตรารับ" ลงในไฟล์
//
// ตรารับ (เลขรับ / วันที่ / เวลา) คือสิ่งที่ทำให้กระดาษแผ่นนั้นเป็น "หนังสือที่โรงเรียนรับไว้แล้ว"
// ตามระเบียบงานสารบรรณ ไฟล์ที่ไม่มีตรารับคือไฟล์ที่ยังพิสูจน์ไม่ได้ว่ารับเมื่อไหร่ เลขรับเท่าไหร่
// ซึ่งเป็นปัญหาจริงตอนเอาไปเก็บเข้าแฟ้ม ตอบข้อทวงถาม หรือใช้อ้างอิงย้อนหลัง
//
// ระบบแยกการ "ลงทะเบียน" (สร้างแถวในทะเบียน) ออกจากการ "ประทับตราลงไฟล์" (เขียนลง PDF จริง)
// โดยตั้งใจ เพราะธุรการต้องลากวางตำแหน่งตราให้พ้นข้อความบนหนังสือก่อน และบางฉบับยังไม่มีไฟล์
// ตอนลงทะเบียน — แต่ผลข้างเคียงคือ "ลงทะเบียนแล้ว" ไม่ได้แปลว่า "ปั๊มแล้ว" และไม่มีอะไรบอกเลย
// ว่าฉบับไหนยังค้างอยู่ ธุรการที่ลืมกดปุ่มปั๊มจะไม่มีทางรู้ จนกระทั่ง ผอ. เปิดไฟล์แล้วไม่เห็นตรา
//
// ไฟล์นี้ทำให้กองที่ลืมนั้น "มีตัวตน": นับได้ กรองดูได้ในทะเบียน ขึ้นเตือนบนแดชบอร์ด และที่สำคัญ
// ที่สุดคือเตือนตรงหน้าปุ่ม "เสนอ" ก่อนที่เรื่องจะขึ้นไปถึง ผอ. (ดู routes/documents.js — assignBox)
//
// เงื่อนไข SQL อยู่ที่ documentQuery.js ร่วมกับตัวกรองอื่นของทะเบียน ด้วยเหตุผลเดียวกับ unassigned.js
// (ต้องใช้ CLOSED_STATUSES ร่วมกัน ถ้าย้ายมาที่นี่จะกลายเป็นวงกลมระหว่างสองไฟล์)
import { db } from '../db.js';
import { unstampedSql } from './documentQuery.js';

/**
 * ใครควรเห็นกองนี้ — คนที่ประทับตราได้จริงในทุกฉบับ
 *
 * ธุรการคือคนที่ประทับตรารับตามระเบียบ ผู้ดูแลระบบตามมาด้วยเพราะต้องช่วยแก้เวลาธุรการลาหรือติดขัด
 * ผู้บันทึกเอกสารก็ประทับฉบับของตัวเองได้ (ดู canApplyReceivedStamp) แต่ไม่ได้เอามาไว้ในกองนี้ —
 * ครูที่บังเอิญพิมพ์หนังสือเข้าระบบหนึ่งฉบับไม่ควรถูกเตือนเรื่องทะเบียนของโรงเรียนทั้งเล่ม
 *
 * ผอ./รอง ผอ. ก็ไม่ต้องเห็น เพราะกดปั๊มแทนไม่ได้ เห็นแล้วทำอะไรไม่ได้คือเสียงรบกวนล้วนๆ
 */
const SEE_ROLES = ['admin', 'registrar'];
export const canSeeUnstamped = (user) => user.roleCodes.some((r) => SEE_ROLES.includes(r));

export function countUnstampedIncoming(visibleSql, visibleParams) {
  return db.prepare(`SELECT COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND ${unstampedSql()} AND (${visibleSql})`).get(visibleParams).c;
}

// กี่ฉบับที่ยกมาแสดงในการ์ดเตือนบนแดชบอร์ด — การ์ดมีไว้ให้ "เห็นแล้วลงมือ" ไม่ใช่แทนหน้าทะเบียน
export const MAX_UNSTAMPED_SHOWN = 8;

/**
 * รายการหนังสือเข้าที่ยังไม่ได้ประทับตรารับ พร้อมธงว่า "เสนอขึ้นไปแล้วหรือยัง"
 *
 * ธงนี้คือหัวใจของเรื่องทั้งหมด เพราะสองกองนี้ต้องลงมือคนละแบบ:
 *
 *   - ยังไม่เสนอ  → ยังทันแก้เงียบๆ ปั๊มเสร็จแล้วค่อยเสนอ ไม่มีใครรู้ว่าเคยลืม
 *   - เสนอไปแล้ว → ผอ. อาจเปิดดูไปแล้ว ต้องรีบปั๊มที่สุด เพราะไฟล์ที่ท่านเห็นอยู่ยังไม่มีตรารับ
 *
 * เรียงให้กองที่เสนอไปแล้วขึ้นก่อนเสมอ แล้วค่อยเรียงตามชั้นความเร็วและลำดับที่ลงทะเบียน
 */
export function unstampedIncoming(user, visible, { limit = MAX_UNSTAMPED_SHOWN } = {}) {
  if (!canSeeUnstamped(user)) return { total: 0, sentUpCount: 0, docs: [], hiddenCount: 0 };

  // นับกับดึงรายการแยกกัน และเรียงลำดับใน SQL ไม่ใช่ดึงมาทั้งกองแล้วค่อยเรียงด้วย JS
  //
  // กองนี้ต่างจาก "ยังไม่ได้เสนอใคร" ตรงที่มันใหญ่ได้จริง: โรงเรียนที่เพิ่งเริ่มใช้ปุ่มปั๊ม หรือเคย
  // ลืมมาทั้งปี จะมีทั้งเล่มค้างอยู่ในกองนี้ทีเดียว การ์ดบนแดชบอร์ดโชว์แค่ 8 ฉบับ แต่ถ้าดึงมาหมด
  // ก่อนแล้วค่อยตัด ก็เท่ากับอ่านทะเบียนทั้งเล่มขึ้นหน่วยความจำทุกครั้งที่มีใครเปิดหน้าแรก
  const counts = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM workflow_steps ws WHERE ws.document_id = d.id) THEN 1 ELSE 0 END) sent_up
    FROM documents d
    WHERE d.deleted_at IS NULL AND ${unstampedSql()} AND (${visible.sql})
  `).get(visible.params);
  if (!counts.total) return { total: 0, sentUpCount: 0, docs: [], hiddenCount: 0 };

  // ลำดับต้องตรงกับที่อธิบายไว้ข้างบน: เสนอไปแล้วก่อน → ชั้นความเร็ว → ลำดับที่ลงทะเบียน
  const rows = db.prepare(`
    SELECT d.id, d.doc_number_display, d.title, d.priority, d.secret_level,
      EXISTS (SELECT 1 FROM workflow_steps ws WHERE ws.document_id = d.id) AS sent_up
    FROM documents d
    WHERE d.deleted_at IS NULL AND ${unstampedSql()} AND (${visible.sql})
    ORDER BY sent_up DESC,
      CASE d.priority WHEN 'most_urgent' THEN 0 WHEN 'very_urgent' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
      d.created_at, d.rowid
    LIMIT :unstampedLimit
  `).all({ ...visible.params, unstampedLimit: limit });

  return {
    total: counts.total,
    sentUpCount: counts.sent_up || 0,
    docs: rows.map((r) => ({
      id: r.id,
      number: r.doc_number_display,
      title: r.title,
      priority: r.priority,
      secret: ['secret', 'top_secret'].includes(r.secret_level),
      sentUp: Boolean(r.sent_up),
    })),
    hiddenCount: Math.max(0, counts.total - rows.length),
  };
}
