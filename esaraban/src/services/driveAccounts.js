// บัญชี Google Drive หลายบัญชี — สำหรับตอนที่ไดรฟ์เดิมเต็ม
//
// Google Drive ฟรีให้ 15GB ต่อบัญชี และเป็น 15GB ที่แชร์กับ Gmail กับ Google Photos ของคนคนนั้นด้วย
// โรงเรียนที่สแกนหนังสือเข้าระบบทุกวันเต็มได้จริงภายในไม่กี่ปี — ซึ่งเป็นปัญหาที่ต้องมีทางออกตั้งแต่
// ก่อนจะเกิด เพราะพอเต็มแล้วทั้งการอัปโหลดไฟล์แนบและการสำรองฐานข้อมูลจะหยุดพร้อมกันทันที
//
// ทางออกเดิมคือไปแก้ GOOGLE_OAUTH_REFRESH_TOKEN เป็นของบัญชีใหม่แล้ว redeploy ซึ่ง "ทำให้ไฟล์เก่า
// ทุกไฟล์เปิดไม่ได้ทันที" — ไม่ใช่เพราะไฟล์หาย แต่เพราะ scope drive.file ให้แอปเห็นเฉพาะไฟล์ที่
// ตัวเองสร้างด้วยบัญชีนั้น บัญชีใหม่จึงมองไม่เห็นไฟล์ของบัญชีเก่าเลยสักไฟล์ ทะเบียนยังอยู่ครบ
// แต่กดเปิดไฟล์แนบไม่ได้สักฉบับ และไม่มีอะไรบอกว่าเกิดอะไรขึ้น
//
// ไฟล์นี้ทำให้เพิ่มไดรฟ์ใหม่ได้โดยของเดิมยังอยู่: จดไว้ที่ตัวไฟล์แต่ละไฟล์ว่าอยู่ไดรฟ์ไหน ของใหม่ไปลง
// ไดรฟ์ที่กำลังใช้งาน ส่วนของเก่าอ่านจากไดรฟ์เดิมต่อไปตลอด ไม่ต้องย้ายไฟล์และไม่ต้อง redeploy
//
// ──────────────────────────────────────────────────────────────────────────────
// ทำไม "ไดรฟ์ตั้งต้น" ไม่ได้อยู่ในตาราง
//
// ตอนโฮสต์ล้างดิสก์ (ซึ่งเกิดทุกครั้งที่ deploy บนโฮสต์ฟรี) ระบบต้องกู้ฐานข้อมูลคืนจาก Drive ให้ได้
// "ก่อน" ที่จะมีฐานข้อมูลให้อ่าน ถ้าเก็บโทเคนของไดรฟ์กู้คืนไว้ในฐานข้อมูลที่กำลังจะกู้ จะวนเป็น
// งูกินหางและกู้ไม่ได้ตลอดกาล — ไดรฟ์ตั้งต้นจึงต้องมาจาก environment variable เสมอ
//
// และด้วยเหตุผลเดียวกัน สำเนาฐานข้อมูลอยู่บนไดรฟ์ตั้งต้นเสมอ ไม่ย้ายตามไดรฟ์ที่ใช้งานอยู่
// (ไฟล์ฐานข้อมูลมีขนาดไม่กี่ MB สิ่งที่ทำให้ไดรฟ์เต็มคือไฟล์แนบที่สแกนมา ไม่ใช่ตัวฐานข้อมูล)
import { db, nowIso, uuid, audit } from '../db.js';
import { bootstrapRefreshToken, driveStorageQuota, httpError } from './googleDrive.js';

/** id ของไดรฟ์ตั้งต้น — ว่าง (NULL) ในคอลัมน์ drive_account_id ก็หมายถึงตัวนี้ */
export const BOOTSTRAP_DRIVE_ID = 'bootstrap';

/**
 * ไดรฟ์ที่ไฟล์ใหม่จะไปลง
 *
 * เก็บเป็นสถานะบนแถวของตารางเอง ไม่ใช่ตัวแปรตั้งค่าแยกอีกที่ — ถ้าเก็บสองที่แล้ววันหนึ่งไม่ตรงกัน
 * (ลบแถวแต่ลืมล้างค่าตั้งค่า) ระบบจะชี้ไปยังไดรฟ์ที่ไม่มีอยู่ แล้วอัปโหลดพังทั้งระบบโดยไม่มีใครรู้
 * ไม่มีแถวไหน active = ใช้ไดรฟ์ตั้งต้น ซึ่งเป็นสภาพของโรงเรียนที่ยังไม่เคยเพิ่มไดรฟ์ที่สอง
 */
export function activeDriveId() {
  const row = db.prepare("SELECT id FROM drive_accounts WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
  return row ? row.id : BOOTSTRAP_DRIVE_ID;
}

/**
 * refresh token ของไดรฟ์หนึ่งบัญชี — หัวใจของการ "อ่านของเก่าจากไดรฟ์เดิม"
 *
 * accountId ว่าง/NULL = ไดรฟ์ตั้งต้น ซึ่งเป็นค่าของไฟล์เก่าทั้งหมดที่บันทึกไว้ก่อนมีระบบหลายไดรฟ์
 */
export function driveTokenFor(accountId) {
  if (!accountId || accountId === BOOTSTRAP_DRIVE_ID) return bootstrapRefreshToken();
  const row = db.prepare('SELECT refresh_token FROM drive_accounts WHERE id = ?').get(accountId);
  if (!row) {
    // ไฟล์ชี้ไปยังไดรฟ์ที่ไม่มีอยู่แล้ว — ต้องบอกให้ชัดว่าเป็นเรื่องการตั้งค่า ไม่ใช่ "ไฟล์หาย"
    // เพราะไฟล์ยังอยู่บน Drive ครบ แค่ระบบไม่มีกุญแจเปิดแล้วเท่านั้น
    throw httpError(500, 'ไฟล์นี้อยู่บนบัญชี Google Drive ที่ถูกถอดออกจากระบบไปแล้ว — เพิ่มบัญชีนั้นกลับเข้ามาที่หน้าเชื่อมต่อ Google Drive แล้วจะเปิดไฟล์ได้ตามเดิม');
  }
  return row.refresh_token;
}

/** refresh token ของไดรฟ์ที่ใช้เก็บไฟล์ใหม่ */
export function activeDriveToken() {
  return driveTokenFor(activeDriveId());
}

/**
 * รายการไดรฟ์ทั้งหมดที่ระบบใช้อยู่ — ไดรฟ์ตั้งต้นมาเป็นแถวแรกเสมอ
 *
 * ไม่คืน refresh token ออกไปไหนเด็ดขาด — หน้าเว็บไม่เคยต้องใช้ และโทเคนหลุดหนึ่งครั้งเท่ากับยกสิทธิ์
 * เข้าถึงไฟล์ทั้งไดรฟ์ให้คนอื่นถาวร
 */
export function listDriveAccounts() {
  const active = activeDriveId();
  const counts = fileCountsByDrive();
  const rows = db.prepare('SELECT id, label, status, created_at, retired_at FROM drive_accounts ORDER BY created_at').all();
  return [
    {
      id: BOOTSTRAP_DRIVE_ID,
      label: 'ไดรฟ์ตั้งต้น (ตั้งค่าไว้ที่เซิร์ฟเวอร์)',
      bootstrap: true,
      connected: Boolean(bootstrapRefreshToken()),
      status: active === BOOTSTRAP_DRIVE_ID ? 'active' : 'readonly',
      isActive: active === BOOTSTRAP_DRIVE_ID,
      files: counts.get(BOOTSTRAP_DRIVE_ID) || 0,
      createdAt: null,
    },
    ...rows.map((r) => ({
      id: r.id,
      label: r.label,
      bootstrap: false,
      connected: true,
      status: r.status,
      isActive: active === r.id,
      files: counts.get(r.id) || 0,
      createdAt: r.created_at,
    })),
  ];
}

/**
 * จำนวนไฟล์ที่อยู่บนแต่ละไดรฟ์ — ตัวเลขนี้คือเหตุผลว่าทำไมห้ามถอดไดรฟ์เก่าทิ้ง
 *
 * นับทั้งไฟล์ต้นฉบับ สำเนาที่ประทับตราแล้ว และไฟล์แนบใบลา เพราะทั้งสามอย่างอยู่บน Drive เหมือนกัน
 */
function fileCountsByDrive() {
  const map = new Map();
  const bump = (id, n) => map.set(id || BOOTSTRAP_DRIVE_ID, (map.get(id || BOOTSTRAP_DRIVE_ID) || 0) + n);
  const q = (sql) => { for (const r of db.prepare(sql).all()) bump(r.k, r.c); };
  q(`SELECT drive_account_id k, COUNT(*) c FROM attachments
     WHERE storage_provider = 'google_drive' AND drive_file_id IS NOT NULL AND destroyed_at IS NULL GROUP BY k`);
  q(`SELECT stamped_drive_account_id k, COUNT(*) c FROM attachments
     WHERE stamped_storage_provider = 'google_drive' AND stamped_drive_file_id IS NOT NULL AND destroyed_at IS NULL GROUP BY k`);
  q(`SELECT drive_account_id k, COUNT(*) c FROM leave_attachments
     WHERE storage_provider = 'google_drive' AND drive_file_id IS NOT NULL GROUP BY k`);
  return map;
}

export const MAX_DRIVE_LABEL = 60;

/**
 * เพิ่มไดรฟ์ใหม่แล้วใช้เก็บไฟล์ใหม่ตั้งแต่วินาทีนั้น — ไดรฟ์เดิมยังอ่านได้ครบและไม่ถูกแตะ
 *
 * ไม่เขียนทับไดรฟ์เดิม ไม่ย้ายไฟล์ และไม่ลบอะไรเลย การย้ายไฟล์เป็นแสนไฟล์ข้ามบัญชีใช้เวลาเป็นวัน
 * และถ้าขาดกลางคันจะเหลือไฟล์ครึ่งๆ กลางๆ สองที่ — ซึ่งแย่กว่าปล่อยให้ของเก่าอยู่ที่เดิมมาก
 */
export function addDriveAccount({ label, refreshToken, actorUser }) {
  const name = String(label || '').trim();
  if (!name) throw httpError(400, 'กรุณาตั้งชื่อเรียกไดรฟ์นี้ เช่น "ไดรฟ์โรงเรียน ชุดที่ 2"');
  if (name.length > MAX_DRIVE_LABEL) throw httpError(400, `ชื่อเรียกไดรฟ์ยาวเกิน ${MAX_DRIVE_LABEL} ตัวอักษร`);
  const token = String(refreshToken || '').trim();
  if (!token) throw httpError(400, 'ไม่มี refresh token ของบัญชีใหม่ — กดเชื่อมต่อบัญชี Google อีกครั้ง');
  if (token === bootstrapRefreshToken()) {
    throw httpError(400, 'นี่คือไดรฟ์ตั้งต้นที่ใช้อยู่แล้ว — ต้องเชื่อมต่อด้วยบัญชี Google คนละบัญชีกับของเดิม');
  }
  if (db.prepare('SELECT 1 x FROM drive_accounts WHERE refresh_token = ?').get(token)) {
    throw httpError(400, 'บัญชีนี้ถูกเพิ่มไว้แล้ว');
  }

  const id = uuid();
  db.prepare(`INSERT INTO drive_accounts (id, label, refresh_token, status, created_at, created_by)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(id, name, token, nowIso(), actorUser?.id || null);
  useDriveForNewFiles(id, actorUser);
  return id;
}

/**
 * เลือกว่าไฟล์ใหม่จะไปลงไดรฟ์ไหน — ไดรฟ์ที่เหลือกลายเป็น "อ่านอย่างเดียว" ไม่ใช่ถูกตัดขาด
 *
 * สลับกลับไปกลับมาได้ตลอด เพราะไม่มีอะไรถูกย้ายหรือถูกลบ ไฟล์แต่ละไฟล์จำไดรฟ์ของตัวเองไว้แล้ว
 */
export function useDriveForNewFiles(id, actorUser) {
  if (id !== BOOTSTRAP_DRIVE_ID && !db.prepare('SELECT 1 x FROM drive_accounts WHERE id = ?').get(id)) {
    throw httpError(404, 'ไม่พบบัญชีไดรฟ์นี้');
  }
  if (id === BOOTSTRAP_DRIVE_ID && !bootstrapRefreshToken()) {
    throw httpError(400, 'ไดรฟ์ตั้งต้นยังไม่ได้เชื่อมต่อ');
  }
  db.prepare("UPDATE drive_accounts SET status = 'readonly', retired_at = ? WHERE status = 'active' AND id != ?")
    .run(nowIso(), id);
  if (id !== BOOTSTRAP_DRIVE_ID) {
    db.prepare("UPDATE drive_accounts SET status = 'active', retired_at = NULL WHERE id = ?").run(id);
  }
  audit({ userId: actorUser?.id || null, action: 'drive_account_activated', tableName: 'drive_accounts', recordId: id });
}

/**
 * ถอดไดรฟ์ออกจากระบบ — ห้ามถ้ายังมีไฟล์อยู่บนนั้น
 *
 * ถอดไดรฟ์ที่ยังมีไฟล์อยู่ = ไฟล์เหล่านั้นเปิดไม่ได้ทันทีทั้งที่ยังอยู่บน Drive ครบ ซึ่งเป็นสิ่งเดียว
 * กับที่ฟีเจอร์นี้ตั้งใจจะป้องกัน จึงกันไว้ตั้งแต่ต้นแทนที่จะเตือนแล้วปล่อยผ่าน
 */
export function removeDriveAccount(id, actorUser) {
  if (id === BOOTSTRAP_DRIVE_ID) throw httpError(400, 'ไดรฟ์ตั้งต้นถอดออกจากหน้านี้ไม่ได้ — ตั้งค่าที่ environment variable ของเซิร์ฟเวอร์');
  const row = db.prepare('SELECT id, label FROM drive_accounts WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'ไม่พบบัญชีไดรฟ์นี้');
  if (activeDriveId() === id) throw httpError(400, 'ไดรฟ์นี้กำลังใช้เก็บไฟล์ใหม่อยู่ — เลือกไดรฟ์อื่นให้เป็นตัวใช้งานก่อน');
  const files = fileCountsByDrive().get(id) || 0;
  if (files) throw httpError(400, `ยังมีไฟล์ ${files} รายการเก็บอยู่บนไดรฟ์นี้ — ถอดออกแล้วจะเปิดไฟล์เหล่านั้นไม่ได้อีก`);
  db.prepare('DELETE FROM drive_accounts WHERE id = ?').run(id);
  audit({ userId: actorUser?.id || null, action: 'drive_account_removed', tableName: 'drive_accounts', recordId: id, detail: { label: row.label } });
}

/** เตือนเมื่อพื้นที่เหลือน้อย — ตัวเลขนี้คือสิ่งที่บอกว่าถึงเวลาเพิ่มไดรฟ์ใหม่แล้ว */
export const DRIVE_NEARLY_FULL_PERCENT = 85;

/** พื้นที่คงเหลือของไดรฟ์หนึ่งบัญชี — คืน error เป็นข้อความ ไม่โยน เพื่อให้หน้ารายการแสดงต่อได้ทั้งหน้า */
export async function driveQuotaOf(accountId) {
  try {
    const q = await driveStorageQuota(driveTokenFor(accountId));
    return { ...q, nearlyFull: q.usedPercent != null && q.usedPercent >= DRIVE_NEARLY_FULL_PERCENT };
  } catch (err) {
    return { error: err.message };
  }
}
