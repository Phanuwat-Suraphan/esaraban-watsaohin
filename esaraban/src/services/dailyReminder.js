// เตือนงานค้างประจำวัน — ตัวเดียวในระบบที่ "วิ่งไปหาคน" เองโดยไม่ต้องมีใครกดอะไร
//
// ทำไมต้องมี: การแจ้งเตือนทุกอย่างในระบบเกิดตอน "มีเหตุการณ์" เท่านั้น (มอบหมายงาน อนุมัติ ออกเลข)
// ถ้าครูพลาดการแจ้งเตือนครั้งนั้นไป ก็ไม่มีอะไรมาบอกอีกเลย เรื่องค้างอยู่เงียบๆ จนเลยกำหนด — ธุรการ
// ต้องคอยไล่ตามเองทุกครั้ง (ซึ่งเป็นที่มาของปุ่ม "ตามงานค้าง" ที่ต้องมีคนกด) ตัวนี้ปิดช่องว่างนั้นด้วย
// การเตือนเจ้าตัวเองทุกเช้าวันทำการ
//
// หลักการที่ยึด:
//   1. วันละครั้งต่อคน ไม่ใช่ต่อฉบับ — คนที่มีงานค้าง 12 เรื่องต้องได้ข้อความเดียวที่สรุปครบ ไม่ใช่
//      12 ข้อความติดกันซึ่งกลบทุกอย่างในไลน์จนคนปิดการแจ้งเตือนทิ้ง
//   2. เตือนเฉพาะของที่ "ถึงเวลาต้องรู้" คือเลยกำหนด/ครบกำหนดวันนี้/ใกล้ครบกำหนด ไม่ใช่ทุกเรื่องที่ค้าง
//      ไม่งั้นข้อความจะเหมือนเดิมทุกวันจนกลายเป็นเสียงรบกวนที่ทุกคนเรียนรู้ที่จะไม่อ่าน
//   3. ไม่เตือนวันหยุด — ใช้ปฏิทินวันหยุดของโรงเรียนที่ผู้ดูแลตั้งไว้ (เสาร์/อาทิตย์ และวันหยุดราชการ)
//   4. กันส่งซ้ำด้วยการจดว่าส่งของวันไหนไปแล้ว เพราะเซิร์ฟเวอร์ถูก deploy/รีสตาร์ทระหว่างวันได้เสมอ
import { db, todayInBangkok, nowIso, audit } from '../db.js';
import { notifyUser } from './notify.js';
import { holidaySetBetween } from './holidays.js';
import { getSetting } from './settings.js';

/** อีกกี่วันถึงจะนับว่า "ใกล้ครบกำหนด" — สั้นพอให้ยังทำทัน และไม่ยาวจนเตือนทุกวันเป็นสัปดาห์ */
const SOON_DAYS = 3;

/** เวลาเริ่มงานของโรงเรียน — เตือนเช้าก่อนเข้าแถว ครูจะได้เห็นตอนเปิดมือถือรอบแรกของวัน */
const DEFAULT_HOUR = 7;
const DEFAULT_MINUTE = 30;

/** ชั่วโมง/นาทีตามเวลาไทยของเวลานี้ — ห้ามใช้เวลาเครื่อง เพราะเซิร์ฟเวอร์บนคลาวด์เป็น UTC */
export function bangkokHourMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { hour: get('hour'), minute: get('minute') };
}

/** เวลาที่ตั้งไว้ว่าจะเตือน (HH:MM) — ค่าที่ใช้ไม่ได้ให้ถอยไปใช้ค่าเริ่มต้น ไม่ใช่พังทั้งตัวเตือน */
export function reminderTime() {
  const raw = String(getSetting('daily_reminder_time') || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  return { hour, minute };
}

export function reminderEnabled() {
  return getSetting('daily_reminder_enabled') !== 'off';
}

/** วันทำการของโรงเรียนไหม — เสาร์/อาทิตย์และวันหยุดที่ผู้ดูแลตั้งไว้ไม่ใช่ */
export function isWorkingDay(date) {
  // อ่านวันในสัปดาห์จากเที่ยงวันของวันนั้นตามเวลาไทย — ถ้าใช้เที่ยงคืน (T00:00:00+07:00) ค่าที่ได้
  // จะเป็นวันของ "เมื่อวาน" ตามเวลา UTC ซึ่งทำให้วันจันทร์กลายเป็นวันอาทิตย์แล้วไม่เตือนทั้งวัน
  const dow = new Date(`${date}T12:00:00+07:00`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySetBetween(date, date).has(date);
}

/**
 * ใครต้องถูกเตือนบ้างในวันนี้ และเรื่องอะไร
 *
 * นับเฉพาะขั้นตอนที่ยังค้างจริงของเอกสารที่ยังอยู่ (ไม่ถูกลบ/ยกเลิก/ปิดไปแล้ว) — เกณฑ์เดียวกับหน้า
 * "งานของฉัน" ไม่งั้นครูจะได้ข้อความเตือนถึงเรื่องที่เปิดเข้าไปแล้วไม่เจอ
 */
export function reminderTargets(today = todayInBangkok()) {
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + SOON_DAYS);
  const soonDate = soon.toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT ws.assignee_id, d.id AS doc_id, d.doc_number_display, d.title, d.due_date
    FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id
    JOIN users u ON u.id = ws.assignee_id
    WHERE ws.status = 'waiting'
      AND d.deleted_at IS NULL
      AND d.status NOT IN ('completed', 'archived', 'voided', 'destroyed', 'rejected')
      AND u.deleted_at IS NULL AND u.status = 'active'
      AND d.due_date IS NOT NULL AND d.due_date != '' AND d.due_date <= :soon
    ORDER BY d.due_date, d.doc_number_display
  `).all({ soon: soonDate });

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.assignee_id)) byUser.set(r.assignee_id, { userId: r.assignee_id, overdue: [], today: [], soon: [] });
    const bucket = r.due_date < today ? 'overdue' : r.due_date === today ? 'today' : 'soon';
    byUser.get(r.assignee_id)[bucket].push(r);
  }
  return [...byUser.values()];
}

/** ข้อความเตือนของคนหนึ่งคน — สั้นพอให้อ่านจบในแจ้งเตือนของไลน์โดยไม่ต้องกดเข้ามา */
export function reminderMessage(target) {
  const parts = [];
  if (target.overdue.length) parts.push(`เลยกำหนดแล้ว ${target.overdue.length} เรื่อง`);
  if (target.today.length) parts.push(`ครบกำหนดวันนี้ ${target.today.length} เรื่อง`);
  if (target.soon.length) parts.push(`ใกล้ครบกำหนด ${target.soon.length} เรื่อง`);
  const head = parts.join(' · ');
  // ยกตัวอย่างเรื่องที่ด่วนที่สุดมาให้เห็นเลย ไม่ใช่มีแต่ตัวเลข — คนอ่านจะได้รู้ว่าเรื่องอะไรโดยไม่ต้องกด
  const first = [...target.overdue, ...target.today, ...target.soon].slice(0, 3)
    .map((d) => `• ${d.doc_number_display || ''} ${d.title}`.trim());
  const more = target.overdue.length + target.today.length + target.soon.length - first.length;
  if (more > 0) first.push(`• และอีก ${more} เรื่อง`);
  return `${head}\n${first.join('\n')}`;
}

/** ส่งเตือนของวันนั้น — กันส่งซ้ำด้วยตารางบันทึกว่าใครได้ของวันไหนไปแล้ว */
export function sendDailyReminders({ today = todayInBangkok(), force = false } = {}) {
  if (!force && !reminderEnabled()) return { skipped: 'ปิดการเตือนไว้', sent: 0 };
  if (!force && !isWorkingDay(today)) return { skipped: 'วันหยุด', sent: 0 };

  const targets = reminderTargets(today);
  let sent = 0;
  for (const t of targets) {
    // กันซ้ำระดับฐานข้อมูล ไม่ใช่ระดับตัวแปรในหน่วยความจำ — เซิร์ฟเวอร์ถูก deploy ระหว่างวันได้เสมอ
    // และของที่ส่งไปแล้วเรียกคืนไม่ได้ (ไปโผล่ในไลน์ของครูแล้ว)
    const already = db.prepare('SELECT 1 x FROM daily_reminder_log WHERE user_id = ? AND sent_date = ?')
      .get(t.userId, today);
    if (already) continue;
    db.prepare('INSERT INTO daily_reminder_log (user_id, sent_date, created_at) VALUES (?, ?, ?)')
      .run(t.userId, today, nowIso());
    notifyUser({
      userId: t.userId,
      linkUrl: '/tasks',
      title: t.overdue.length ? '⏰ มีงานเลยกำหนดรอคุณอยู่' : '📌 งานที่ต้องทำวันนี้',
      message: reminderMessage(t),
      priority: t.overdue.length ? 'urgent' : 'info',
    });
    sent++;
  }
  if (sent) audit({ userId: null, action: 'daily_reminders_sent', detail: { date: today, users: sent } });
  return { sent, targets: targets.length, date: today };
}

/**
 * ส่งเตือนตัวอย่างให้ตัวเองเดี๋ยวนี้ — ผู้ดูแลจะได้เห็นว่าข้อความที่ครูได้รับหน้าตาเป็นอย่างไร
 *
 * ทำไมต้องมี: ของจริงส่งเช้าวันทำการวันละครั้ง ถ้าไม่มีปุ่มนี้ วิธีเดียวที่จะรู้ว่าตั้งค่าถูกและข้อความ
 * อ่านรู้เรื่องไหม คือรอถึงพรุ่งนี้เช้าแล้วไปถามครู — และถ้าตั้งค่าผิด ก็เสียไปอีกหนึ่งวันกว่าจะรู้
 * (เหตุผลเดียวกับปุ่มทดสอบส่งไลน์) ไม่แตะตัวกันส่งซ้ำของวันจริง เพราะนี่คือการทดสอบ ไม่ใช่รอบจริง
 */
export function sendTestReminder(user) {
  const today = todayInBangkok();
  const target = reminderTargets(today).find((t) => t.userId === user.id);
  const body = target
    ? reminderMessage(target)
    : 'ตอนนี้คุณไม่มีงานที่เลยกำหนดหรือใกล้ครบกำหนด — ของจริงจะส่งเฉพาะคนที่มีงานค้างเท่านั้น '
      + 'ครูที่ไม่มีงานค้างจะไม่ได้รับข้อความนี้';
  notifyUser({
    userId: user.id,
    linkUrl: '/tasks',
    title: '🔔 ตัวอย่างการเตือนงานค้างประจำวัน (ทดสอบ)',
    message: body,
    priority: 'info',
  });
  audit({ userId: user.id, action: 'daily_reminder_tested', detail: { hasWork: Boolean(target) } });
  return { ok: true, hasWork: Boolean(target), message: body };
}

// ───────────────────────── ตัวเดินเวลา ─────────────────────────
//
// ไม่ใช้ cron ของระบบปฏิบัติการ เพราะโฮสต์ฟรีหลายเจ้า (รวม Render) ไม่มีให้ใช้ และการติดตั้งเพิ่ม
// แปลว่าโรงเรียนต้องไปตั้งค่าอะไรอีกชุดหนึ่งเอง — เดินเป็นรอบทุกนาทีในโปรเซสเดียวกันนี้แทน
// ราคาถูกมาก (อ่านเวลากับเทียบสตริงวันที่) และตัวกันส่งซ้ำอยู่ที่ฐานข้อมูลอยู่แล้ว
let timer = null;
export function startDailyReminder({ intervalMs = 60000 } = {}) {
  if (timer) return false;
  timer = setInterval(() => {
    try {
      if (!reminderEnabled()) return;
      const today = todayInBangkok();
      const { hour, minute } = reminderTime();
      const now = bangkokHourMinute();
      // ถึงเวลาที่ตั้งไว้หรือเลยมาแล้วของวันนี้ — "เลยมาแล้ว" สำคัญ เพราะเซิร์ฟเวอร์บนแพ็กฟรีหลับ
      // แล้วตื่นตอนมีคนเข้าเว็บ ถ้าเทียบเวลาแบบตรงนาทีเป๊ะ วันที่เซิร์ฟเวอร์หลับข้ามเวลานั้นจะไม่เตือนเลย
      if (now.hour * 60 + now.minute < hour * 60 + minute) return;
      const res = sendDailyReminders({ today });
      if (res.sent) console.log(`[reminder] เตือนงานค้างประจำวัน ${today} ให้ ${res.sent} คน`);
    } catch (err) {
      console.error('[reminder] เตือนงานค้างไม่สำเร็จ (ระบบส่วนอื่นทำงานต่อตามปกติ):', err?.message || err);
    }
  }, intervalMs);
  timer.unref?.();
  return true;
}

export function _stopDailyReminderForTest() {
  if (timer) clearInterval(timer);
  timer = null;
}
