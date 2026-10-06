// ค่าตั้งค่าของระบบที่แอดมินแก้เองได้จากหน้าเว็บ
//
// ที่มา: ระบบนี้ถูกนำไปใช้ที่โรงเรียนที่สอง ชื่อโรงเรียนเดิมจึงฝังอยู่ในโค้ด 8 จุด (รวมตราประทับบน PDF
// และแบบฟอร์มใบลา) การย้ายมาเป็นค่าตั้งค่าทำให้ติดตั้งที่โรงเรียนใหม่ไม่ต้องแก้โค้ดเลย และที่สำคัญกว่า
// คือโรงเรียนแก้คำผิดในชื่อตัวเองได้ โดยไม่ต้องรอผู้พัฒนาหรือรอ deploy ใหม่
import { db, nowIso, audit } from '../db.js';
import { httpError, asText } from './validate.js';

// ลำดับความสำคัญของค่า: ที่แอดมินตั้งในหน้าเว็บ → env var (ค่าเริ่มต้นตอน deploy) → ค่าตั้งต้นของระบบ
const ENV_FALLBACK = {
  school_name: 'SCHOOL_NAME',
  school_short_name: 'SCHOOL_SHORT_NAME',
  school_initials: 'SCHOOL_INITIALS',
  outgoing_number_prefix: 'OUTGOING_NUMBER_PREFIX',
  outgoing_number_start: 'OUTGOING_NUMBER_START',
  outgoing_number_start_year: 'OUTGOING_NUMBER_START_YEAR',
};

// ค่าเริ่มต้นของระบบ — ใช้เมื่อยังไม่มีใครตั้งค่าและไม่ได้ตั้ง env var ไว้
//
// ตั้งเป็นชื่อโรงเรียนที่ใช้ระบบนี้อยู่จริง ไม่ใช่ข้อความว่างหรือ "ยังไม่ได้ตั้งชื่อ" เพราะบนโฮสต์ฟรี
// (Render free tier) ดิสก์ไม่ถาวร ฐานข้อมูลจึงถูกล้างทุกครั้งที่ deploy — ค่าที่แอดมินตั้งไว้ในหน้าเว็บ
// จะหายไปด้วย ถ้าค่าเริ่มต้นเป็นข้อความกลางๆ หัวหนังสือราชการจะขึ้นว่า "ยังไม่ได้ตั้งชื่อ" ทุกครั้งที่
// deploy จนกว่าจะมีคนสังเกตเห็นแล้วเข้าไปตั้งใหม่
//
// ย้ายโรงเรียนหรือติดตั้งให้ที่ใหม่: แก้ที่หน้า "ตั้งค่าโรงเรียน" (ถ้าข้อมูลอยู่ถาวรแล้ว) หรือตั้ง env var
// SCHOOL_NAME ซึ่งอยู่รอดการล้างดิสก์เหมือนกัน — ไม่ต้องแก้โค้ด ทั้งสองทางชนะค่าตั้งต้นนี้เสมอ
const DEFAULTS = {
  // เตือนงานค้างประจำวัน — เปิดไว้ตั้งแต่ต้นโดยตั้งใจ เพราะเป็นทางเดียวที่ระบบจะบอกครูเองว่ามีงานค้าง
  // โดยไม่ต้องมีใครกดตาม (ดู services/dailyReminder.js) เวลา 07:30 คือก่อนเข้าแถวของโรงเรียน
  daily_reminder_enabled: 'on',
  daily_reminder_time: '07:30',
  school_name: 'โรงเรียนวัดเสาหิน',
  school_short_name: '',
  school_initials: '',
  // รหัสหนังสือของโรงเรียนที่นำหน้าเลขทะเบียนหนังสือส่ง เช่น "ศธ 04056.12"
  //
  // ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ ข้อ 11.1 (หนังสือภายนอก) และข้อ 12.1 (บันทึกข้อความ)
  // ช่อง "ที่" ต้องเป็น "รหัสตัวพยัญชนะและเลขประจำของเจ้าของเรื่อง ทับ เลขทะเบียนหนังสือส่ง"
  // เลขที่ถูกต้องของโรงเรียนจึงหน้าตาแบบ ศธ 04056.12/45 ไม่ใช่ 0045/2569
  //
  // ค่าตั้งต้นเป็นค่าว่างโดยตั้งใจ — รหัสนี้แต่ละโรงเรียนได้มาจากเขตพื้นที่ของตัวเอง เดาแทนไม่ได้
  // และการเดาผิดแย่กว่าการไม่ใส่ เพราะเลขที่ผิดจะไปอยู่บนหนังสือราชการที่ส่งออกไปข้างนอกจริง
  // ตราบใดที่ยังว่าง ระบบออกเลขแบบเดิม (0045/2569) ซึ่งใช้งานได้และไม่ผิดอะไรในทะเบียนภายใน
  outgoing_number_prefix: '',
  // เลขทะเบียนหนังสือส่งล่าสุดที่ "ออกไปแล้วก่อนมาใช้ระบบนี้" และปี พ.ศ. ของเล่มที่เลขนั้นอยู่
  //
  // ทำไมต้องมี: ระบบนับเลขต่อจากเลขสูงสุดที่มีอยู่ในฐานข้อมูล แต่โรงเรียนที่ย้ายมาจากสมุดกระดาษ
  // ออกเลขไปแล้วเป็นร้อยฉบับโดยที่ระบบไม่เคยเห็น ฉบับถัดไปจึงต้องเดินต่อจากเล่มกระดาษ ไม่ใช่เริ่มที่ 1
  // ซึ่งจะออกเลขทับของที่ส่งออกไปข้างนอกจริงแล้ว — และเลขที่ออกไปแล้วแก้ย้อนหลังไม่ได้
  //
  // ผูกกับปีด้วยเสมอ เพราะทะเบียนหนังสือส่งเริ่มนับ 1 ใหม่ทุกวันที่ 1 มกราคม ถ้าเก็บแค่ตัวเลข
  // พอขึ้นปีใหม่ค่านี้จะกลายเป็นพื้นค้างที่ดันเลขของเล่มใหม่ให้เริ่มที่ 206 แทนที่จะเป็น 1 ตลอดไป
  //
  // ค่าตั้งต้นว่างโดยตั้งใจ เหมือน outgoing_number_prefix — เลขของแต่ละโรงเรียนเดาแทนไม่ได้
  // ⚠️ บนโฮสต์ที่ดิสก์ถูกล้างทุกครั้งที่ deploy (Render free tier) ต้องตั้ง env var
  // OUTGOING_NUMBER_START / OUTGOING_NUMBER_START_YEAR ด้วย ไม่ใช่ตั้งแค่ในหน้าเว็บ ไม่งั้น deploy
  // รอบถัดไปทะเบียนจะย้อนไปเริ่มที่ 1 เงียบๆ แล้วหนังสือที่ส่งออกไปจริงจะมีเลขซ้ำกับของเก่า
  outgoing_number_start: '',
  outgoing_number_start_year: '',
};

export const MAX_SETTING_LENGTH = {
  school_name: 200, school_short_name: 100, school_initials: 8, outgoing_number_prefix: 40,
  daily_reminder_time: 5, daily_reminder_enabled: 3,
  outgoing_number_start: 7, outgoing_number_start_year: 4,
};

/** รหัสหนังสือที่นำหน้าเลขทะเบียนส่ง — ค่าว่างแปลว่ายังไม่ได้ตั้ง ให้ออกเลขแบบเดิม */
export function outgoingNumberPrefix() { return getSetting('outgoing_number_prefix'); }

/**
 * เลขพื้นของทะเบียนหนังสือส่งสำหรับปี พ.ศ. ที่ถาม — 0 แปลว่าไม่มีพื้น ให้นับตามปกติ
 *
 * คืนค่าเฉพาะเมื่อปีตรงกับปีที่ตั้งไว้ ปีถัดไปค่านี้หมดอายุเอง ทะเบียนเล่มใหม่จึงเริ่มที่ 1 ตามระเบียบ
 * โดยไม่ต้องมีใครกลับมาล้างค่าทิ้ง (ซึ่งถ้าลืมก็จะไม่มีใครรู้จนกว่าจะออกเลขผิดไปแล้ว)
 */
/**
 * ค่าตั้งเลขทะเบียนหนังสือส่งที่ตั้งไว้ในหน้าเว็บแล้ว แต่ยังไม่ได้ตั้งเป็น env var
 *
 * คืนรายการ { envName, value } ให้ผู้เรียกเอาไปขึ้นเป็นบรรทัดที่ก๊อปไปวางได้ — ว่างเปล่า = ครบแล้ว
 *
 * ทำไมสามค่านี้ต้องเตือนเป็นพิเศษ: บนโฮสต์ที่ดิสก์ถูกล้างทุกครั้งที่ deploy (Render free tier)
 * ค่าที่ตั้งในหน้าเว็บหายไปพร้อมฐานข้อมูล ค่าอื่นที่หายแล้วเห็นได้ทันที (ชื่อโรงเรียนกลับเป็นค่าตั้งต้น
 * ก็เห็นบนหัวจอ) แต่สามตัวนี้หายแล้ว "ระบบยังทำงานปกติ" — มันแค่เงียบๆ ย้อนไปออกเลข 0001/2569
 * ให้หนังสือฉบับถัดไป ซึ่งทับเลขที่ส่งออกไปข้างนอกจริงแล้ว และตามกลับมาแก้ไม่ได้
 */
export function missingOutgoingNumberEnv() {
  return [
    ['OUTGOING_NUMBER_PREFIX', 'outgoing_number_prefix'],
    ['OUTGOING_NUMBER_START', 'outgoing_number_start'],
    ['OUTGOING_NUMBER_START_YEAR', 'outgoing_number_start_year'],
  ].filter(([envName, key]) => getSetting(key) && !asText(process.env[envName]))
    .map(([envName, key]) => ({ envName, value: getSetting(key) }));
}

export function outgoingNumberFloor(yearBe) {
  const year = Number.parseInt(getSetting('outgoing_number_start_year'), 10);
  const start = Number.parseInt(getSetting('outgoing_number_start'), 10);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(start) || start <= 0) return 0;
  return year === Number(yearBe) ? start : 0;
}

// อ่านค่าทุกครั้งที่ render หน้าเว็บ = อ่านฐานข้อมูลหลายสิบครั้งต่อการเปิดหน้าเดียว (ชื่อโรงเรียนถูกใช้
// ในหัวเอกสาร ตราประทับ แถบข้าง และหน้าพิมพ์) จึงแคชไว้ในหน่วยความจำแล้วล้างทิ้งตอนมีการแก้ค่า
let cache = null;
function loadCache() {
  if (cache) return cache;
  cache = new Map(db.prepare('SELECT key, value FROM app_settings').all().map((r) => [r.key, r.value]));
  return cache;
}
export function invalidateSettingsCache() { cache = null; }

export function getSetting(key) {
  const stored = loadCache().get(key);
  if (stored != null && stored !== '') return stored;
  const envName = ENV_FALLBACK[key];
  const fromEnv = envName ? asText(process.env[envName]) : '';
  if (fromEnv) return fromEnv;
  return DEFAULTS[key] ?? '';
}

export function setSetting({ key, value, actorUser }) {
  if (!(key in DEFAULTS)) throw httpError(400, `ไม่รู้จักค่าตั้งค่า "${key}"`);
  const clean = asText(value);
  const max = MAX_SETTING_LENGTH[key];
  if (max && clean.length > max) throw httpError(400, `ค่านี้ยาวเกิน ${max} ตัวอักษร`);
  // สองค่านี้ไปเป็น "เลขพื้น" ของทะเบียนหนังสือส่งโดยตรง ถ้าปล่อยข้อความที่ไม่ใช่ตัวเลขผ่านเข้าไป
  // Number.parseInt จะอ่านได้บางส่วน ("205ก" → 205) หรือได้ NaN แล้วพื้นหายไปเงียบๆ ทั้งสองทาง
  // ลงเอยที่เลขบนหนังสือราชการผิดโดยไม่มีใครรู้ จึงปฏิเสธตรงนี้ให้เห็นทันทีตอนกรอก
  if ((key === 'outgoing_number_start' || key === 'outgoing_number_start_year') && clean) {
    if (!/^\d+$/.test(clean)) throw httpError(400, 'ค่านี้ต้องเป็นตัวเลขเท่านั้น');
    if (Number(clean) <= 0) throw httpError(400, 'ค่านี้ต้องมากกว่า 0');
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(key, clean, actorUser?.id || null, nowIso());
  invalidateSettingsCache();
  audit({ userId: actorUser?.id, action: 'setting_changed', tableName: 'app_settings', recordId: key, detail: { key, value: clean } });
}

/** ชื่อโรงเรียนเต็ม ที่พิมพ์ลงหัวเอกสารราชการทุกใบ — ต้องมีคำว่า "โรงเรียน" นำหน้าอยู่ในตัวค่าเอง
 *  เพราะหลายที่ต่อข้อความตรงๆ เช่น `ผู้อำนวยการ${schoolName()}` และ "เขียนที่ ..." บนใบลา */
export function schoolName() { return getSetting('school_name'); }

/** ชื่อย่อสำหรับแถบข้าง/ชื่อแอป — ถ้าไม่ได้ตั้งไว้ ย่อ "โรงเรียน" เป็น "ร.ร." ให้เอง */
export function schoolShortName() {
  const set = getSetting('school_short_name');
  if (set) return set;
  return schoolName().replace(/^โรงเรียน\s*/, 'ร.ร.');
}

/** ชื่อแอปที่ปรากฏใต้ไอคอนบนหน้าจอมือถือ และในเมนู "แชร์" ของ LINE/แอปอื่น
 *
 *  ต้องมีที่เดียว เพราะถูกใช้สองที่ที่ห้ามไม่ตรงกัน: ตัว manifest ที่กำหนดชื่อจริง และคำแนะนำวิธีใช้
 *  บนหน้าแรกที่บอกครูว่า "ให้เลือกเมนูชื่อนี้" — ถ้าสองที่นี้เพี้ยนกัน ครูจะหาเมนูตามที่บอกไม่เจอ
 *  ตัดที่ 30 ตัวอักษรเพราะระบบปฏิบัติการตัดชื่อที่ยาวกว่านั้นทิ้งเองอยู่แล้ว
 */
export function appShortName() {
  return `สารบรรณ ${schoolShortName()}`.slice(0, 30);
}

/** ตัวอักษรย่อในวงกลมโลโก้ — ถ้าไม่ได้ตั้งไว้ ตัดสระ/วรรณยุกต์ออกแล้วเอาพยัญชนะสองตัวแรกของชื่อ
 *  (ตัดคำว่า "โรงเรียน" ออกก่อน ไม่งั้นทุกโรงเรียนจะได้ "รง" เหมือนกันหมด) */
export function schoolInitials() {
  const set = getSetting('school_initials');
  if (set) return set;
  const base = schoolName().replace(/^โรงเรียน\s*/, '');
  // ตัดสระบน/ล่าง วรรณยุกต์ และเครื่องหมายที่ไม่ใช่พยัญชนะออก เหลือแต่ตัวที่มองเห็นเป็นตัวอักษรจริง
  const consonants = base.replace(/[ะ-ฺ็-๎\s]/g, '');
  return consonants.slice(0, 2) || 'สบ';
}
