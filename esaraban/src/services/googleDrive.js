// httpError คัดลอกไว้ในไฟล์นี้เอง (ไม่ import จาก workflow.js) เพื่อเลี่ยง circular import —
// workflow.js เองก็ต้อง import จากไฟล์นี้ (สำหรับ forceDeleteDocument ลบไฟล์บน Drive)
export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// ใช้ Google Drive เป็นที่เก็บไฟล์แนบแทน local disk — เหมาะกับ hosting ที่ไม่มี disk ถาวร
// (เช่น Render free tier) เพราะไฟล์อยู่นอกเซิร์ฟเวอร์ ไม่หายตอน redeploy
// เปิดใช้งานด้วย env var STORAGE_PROVIDER=google_drive (ค่าเริ่มต้นคือ local disk เหมือนเดิม)
//
// ใช้ OAuth2 "act as the real Google account" แทน Service Account — เพราะ Service Account
// ไม่มีโควตาพื้นที่เก็บข้อมูลเป็นของตัวเองบนบัญชี Gmail ทั่วไป (ไม่ใช่ Google Workspace) ทำให้อัปโหลด
// fail ด้วย "Service Accounts do not have storage quota" เสมอ — พิสูจน์แล้วจากการใช้งานจริง
// ไฟล์ที่อัปโหลดจะนับพื้นที่ในโควตา 15GB ของบัญชี Google ที่เชื่อมต่อจริง ไม่ใช่โควตาแยกต่างหาก
// ดูขั้นตอนติดตั้งทั้งหมดใน deploy/GOOGLE_DRIVE.md — เชื่อมต่อผ่านหน้า /admin/google-drive

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const ROOT_FOLDER_NAME = 'ระบบสารบรรณอิเล็กทรอนิกส์ (esaraban)';

export function isGoogleDriveEnabled() {
  return process.env.STORAGE_PROVIDER === 'google_drive';
}

export function getOAuthClientConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw httpError(500, 'ยังไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET — ดูขั้นตอนใน deploy/GOOGLE_DRIVE.md');
  }
  return { clientId, clientSecret };
}

export function isGoogleDriveConnected() {
  return Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

/**
 * ตัวยิงคำขอ HTTP ทั้งหมดของไฟล์นี้ — แยกเป็นตัวแปรเพื่อให้เทสต์สลับเป็น Google Drive จำลองได้
 *
 * ทำไมต้องมี: ทางกู้คืนฐานข้อมูลจากสำเนาบน Drive คือโค้ดที่ข้อมูลทั้งโรงเรียนแขวนอยู่ — ถ้าดิสก์ของ
 * โฮสต์ถูกล้าง (ซึ่งเกิดทุกครั้งที่ deploy) ทะเบียนหนังสือทั้งเล่มกลับมาได้ด้วยเส้นทางนี้เส้นเดียว
 * แต่เดิมทดสอบได้แค่ทางที่ "ไม่ทำอะไร" (ไฟล์ยังอยู่ / ยังไม่ได้เชื่อม Drive) ส่วนทางที่ทำงานจริงคือ
 * ดาวน์โหลดแล้วเขียนไฟล์ ไม่มีเทสต์แตะเลยสักข้อ เพราะต้องยิงเน็ตออกไปหา Google จริง
 *
 * แนวเดียวกับ _setLineApiCallerForTest ใน lineNotify.js — ของจริงยังใช้ fetch ตามปกติทุกประการ
 */
let httpFetch = (...args) => fetch(...args);

export function _setDriveFetchForTest(fn) {
  httpFetch = fn || ((...args) => fetch(...args));
  tokenCache.clear(); // โทเคนที่แคชไว้เป็นของตัวยิงตัวเก่า ต้องทิ้งเสมอตอนสลับ
}

/**
 * โทเคนใช้งานที่แคชไว้ แยกตาม "บัญชีไดรฟ์" ไม่ใช่ตัวเดียวทั้งระบบ
 *
 * ระบบใช้ได้หลายบัญชีพร้อมกัน (ไฟล์เก่าอยู่ไดรฟ์เก่า ไฟล์ใหม่ไปไดรฟ์ใหม่) ถ้าแคชตัวเดียว คำขอของ
 * ไดรฟ์หนึ่งจะได้โทเคนของอีกไดรฟ์หนึ่งสลับกันไปมา แล้วจะกลายเป็น "ไฟล์หาย" ทั้งที่ไฟล์อยู่ครบ
 *
 * ใช้ refresh token เป็นคีย์ตรงๆ เพราะเป็นสิ่งที่ระบุบัญชีได้แน่นอนที่สุด และ Map นี้อยู่ในหน่วยความจำ
 * ของโปรเซสเท่านั้น ไม่ได้ถูกบันทึกหรือส่งออกไปไหน
 */
const tokenCache = new Map(); // refreshToken -> { accessToken, expiresAt }
export function _clearDriveTokenCacheForTest() { tokenCache.clear(); }

/** refresh token ของไดรฟ์ตั้งต้น (ตัวที่ใช้กู้คืนฐานข้อมูลตอนบูต) */
export function bootstrapRefreshToken() { return process.env.GOOGLE_OAUTH_REFRESH_TOKEN; }

async function getAccessToken(refreshTokenArg) {
  const refreshToken = refreshTokenArg || bootstrapRefreshToken();
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
  const { clientId, clientSecret } = getOAuthClientConfig();
  if (!refreshToken) throw httpError(500, 'ยังไม่ได้เชื่อมต่อ Google Drive — ไปที่หน้า /admin/google-drive เพื่อเชื่อมต่อบัญชี Google ก่อน');

  const res = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant = โทเคนถูกเพิกถอนหรือหมดอายุ ซึ่งสาเหตุที่พบบ่อยที่สุดคือแอปบน Google Cloud
    // ยังอยู่สถานะ "Testing" — Google กำหนดให้ refresh token ของโหมดนั้นหมดอายุใน 7 วันเสมอ
    // ข้อความเดิมส่งต่อ error ภาษาอังกฤษของ Google ตรงๆ ("Token has been expired or revoked")
    // ซึ่งไม่ได้บอกว่าต้องทำอะไร ทั้งที่นี่คือจุดที่ทำให้ไฟล์แนบและการสำรองข้อมูลหยุดทำงานทั้งระบบ
    if (data.error === 'invalid_grant') {
      throw httpError(502, 'การเชื่อมต่อ Google Drive หมดอายุแล้ว — สาเหตุที่พบบ่อยที่สุดคือแอปบน Google Cloud ยังเป็นสถานะ "Testing" ซึ่งโทเคนจะหมดอายุทุก 7 วัน วิธีแก้ถาวร: เข้า Google Cloud Console แล้วกด PUBLISH APP ให้เป็น "In production" จากนั้นเพิกถอนสิทธิ์ที่ myaccount.google.com/permissions แล้วเชื่อมต่อใหม่ที่ /admin/google-drive (ดูขั้นตอนที่ 4 ใน deploy/GOOGLE_DRIVE.md)');
    }
    throw httpError(502, `เชื่อมต่อ Google Drive ไม่สำเร็จ (ต่ออายุ token ล้มเหลว): ${data.error_description || data.error || res.statusText} — อาจต้องเชื่อมต่อบัญชีใหม่ที่ /admin/google-drive`);
  }
  tokenCache.set(refreshToken, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

// ทุกคำขอรับ "บัญชีไดรฟ์" ได้เสมอ ไม่ส่งมาก็ใช้ไดรฟ์ตั้งต้น — ผู้เรียกที่รู้ว่าไฟล์อยู่ไดรฟ์ไหนต้องส่งมาด้วย
async function driveFetch(url, opts = {}, refreshToken) {
  const token = await getAccessToken(refreshToken);
  const res = await httpFetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  return res;
}

// ค้นหาโฟลเดอร์ชื่อ name ใต้ parentId ถ้าไม่มีให้สร้างใหม่ — ใช้จัดหมวดหมู่ ปี/ประเภทหนังสือ
// หมายเหตุ: scope drive.file ทำให้แอปมองเห็นเฉพาะไฟล์/โฟลเดอร์ที่แอปสร้างเองเท่านั้น จึงต้องให้แอป
// เป็นผู้สร้างโฟลเดอร์รากเองเสมอ (ห้ามให้ผู้ใช้สร้างโฟลเดอร์เองแล้วส่ง ID มาให้ จะมองไม่เห็น)
async function findOrCreateFolder(name, parentId, refreshToken) {
  const escaped = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await driveFetch(`${API_BASE}?q=${q}&fields=files(id,name)&spaces=drive`, {}, refreshToken);
  const searchData = await searchRes.json().catch(() => ({}));
  if (!searchRes.ok) throw httpError(502, `ค้นหาโฟลเดอร์ Google Drive ไม่สำเร็จ: ${searchData.error?.message || searchRes.statusText}`);
  if (searchData.files?.length) return searchData.files[0].id;

  const createRes = await driveFetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  }, refreshToken);
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw httpError(502, `สร้างโฟลเดอร์ Google Drive ไม่สำเร็จ: ${createData.error?.message || createRes.statusText}`);
  return createData.id;
}

// จัดหมวดหมู่: root (แอปสร้างเอง) / ปี พ.ศ. / ประเภทหนังสือ — ตรงกับที่โรงเรียนคุ้นเคยจากตู้เอกสารจริง
export async function ensureCategoryFolder({ yearBe, typeName, refreshToken }) {
  const root = await findOrCreateFolder(ROOT_FOLDER_NAME, 'root', refreshToken);
  const yearFolder = await findOrCreateFolder(String(yearBe), root, refreshToken);
  return findOrCreateFolder(typeName, yearFolder, refreshToken);
}

export const BACKUP_FOLDER_NAME = 'สำเนาฐานข้อมูล (ห้ามลบ)';

// โฟลเดอร์เก็บสำเนาฐานข้อมูล — แยกจากโฟลเดอร์ไฟล์แนบ เพื่อให้ธุรการไม่เผลอเปิด/ลบปนกับหนังสือ
//
// ไม่รับพารามิเตอร์บัญชีไดรฟ์โดยตั้งใจ: สำเนาฐานข้อมูลต้องอยู่บน "ไดรฟ์ตั้งต้น" เสมอ เพราะตอนโฮสต์
// ล้างดิสก์ ระบบต้องกู้ฐานข้อมูลคืนให้ได้ก่อนที่จะมีฐานข้อมูลให้อ่านว่าไดรฟ์อื่นมีโทเคนอะไรบ้าง
export async function ensureBackupFolder() {
  const root = await findOrCreateFolder(ROOT_FOLDER_NAME, 'root');
  return findOrCreateFolder(BACKUP_FOLDER_NAME, root);
}

/**
 * ไล่เก็บไฟล์แนบทั้งหมดใต้โฟลเดอร์หลักของระบบ (ปี → ประเภทหนังสือ → ไฟล์)
 *
 * ข้ามโฟลเดอร์สำเนาฐานข้อมูลเสมอ เพราะไฟล์ในนั้นไม่ได้ผูกกับตาราง attachments จึงจะถูกมองว่า
 * "ไม่มีเจ้าของ" ทั้งหมด แล้วโดนลบยกโฟลเดอร์ — ซึ่งคือสำเนาที่ใช้กู้ทะเบียนหนังสือทั้งเล่มกลับมา
 * คืน null ถ้ายังไม่มีโฟลเดอร์หลัก (ยังไม่เคยอัปโหลดอะไรเลย) — ไม่สร้างโฟลเดอร์เปล่าทิ้งไว้
 */
export async function listAllAttachmentFiles(refreshToken) {
  const root = await findFolder(ROOT_FOLDER_NAME, 'root', refreshToken);
  if (!root) return [];
  const out = [];
  for (const year of await listSubfolders(root.id, refreshToken)) {
    if (year.name === BACKUP_FOLDER_NAME) continue;
    for (const category of await listSubfolders(year.id, refreshToken)) {
      for (const file of await listFilesInFolder(category.id, { limit: 1000, refreshToken })) {
        out.push({ ...file, yearName: year.name, categoryName: category.name });
      }
    }
  }
  return out;
}

// สร้าง/หาโฟลเดอร์ซ้อนกันหลายชั้นตามลำดับที่ให้มา เช่น ['2569', '2569-08', '2569-08-21']
export async function ensureFolderPath(parentId, names, refreshToken) {
  let current = parentId;
  for (const name of names) current = await findOrCreateFolder(name, current, refreshToken);
  return current;
}

// หาโฟลเดอร์ตามชื่อ — คืน null ถ้าไม่มี (ต่างจาก findOrCreateFolder ที่จะสร้างให้เลย)
// ใช้ตอนไล่หาโฟลเดอร์ของวันที่ผ่านมาแล้ว ซึ่ง "ไม่มี" เป็นคำตอบที่ถูกต้อง ไม่ใช่เหตุให้ไปสร้างโฟลเดอร์เปล่าทิ้งไว้
export async function findFolder(name, parentId, refreshToken) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`);
  const res = await driveFetch(`${API_BASE}?q=${q}&fields=files(id,name)&pageSize=1&spaces=drive`, {}, refreshToken);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `ค้นหาโฟลเดอร์บน Google Drive ไม่สำเร็จ: ${data.error?.message || res.statusText}`);
  return data.files?.[0] || null;
}

// โฟลเดอร์แม่ของไฟล์หนึ่งไฟล์ — ใช้ตรวจว่าไฟล์ที่ผู้ใช้สั่งลบอยู่ในโฟลเดอร์สำเนาสำรองจริงหรือไม่
// โดยไม่ต้องไล่อ่านรายชื่อไฟล์ของทุกวันมาเทียบ (ดู deleteBackupNode ใน dbBackup.js)
export async function getFileParents(fileId, refreshToken) {
  const res = await driveFetch(`${API_BASE}/${encodeURIComponent(fileId)}?fields=id,name,parents&supportsAllDrives=true`, {}, refreshToken);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null; // ไม่มีไฟล์นี้/ไม่มีสิทธิ์ — ตัวเรียกจะปฏิเสธการลบเอง
  return data.parents || [];
}

// เฉพาะโฟลเดอร์ย่อย เรียงตามชื่อจากใหม่ไปเก่า (ชื่อเป็นวันที่แบบ 2569-08-21 จึงเรียงตามตัวอักษรได้ตรงเวลา)
export async function listSubfolders(parentId, refreshToken) {
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveFetch(`${API_BASE}?q=${q}&fields=files(id,name)&pageSize=1000&spaces=drive`, {}, refreshToken);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `อ่านรายการโฟลเดอร์บน Google Drive ไม่สำเร็จ: ${data.error?.message || res.statusText}`);
  return (data.files || []).sort((a, b) => b.name.localeCompare(a.name));
}

// รายชื่อไฟล์ในโฟลเดอร์ เรียงใหม่สุดก่อน — ใช้หาสำเนาฐานข้อมูลล่าสุดตอนกู้คืน และหาไฟล์เก่าที่ต้องลบทิ้ง
export async function listFilesInFolder(folderId, { limit = 100, refreshToken } = {}) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveFetch(`${API_BASE}?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime desc&pageSize=${limit}&spaces=drive`, {}, refreshToken);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `อ่านรายการไฟล์บน Google Drive ไม่สำเร็จ: ${data.error?.message || res.statusText}`);
  return data.files || [];
}

// อัปโหลดไฟล์ด้วย resumable upload (รองรับไฟล์ได้ถึง 10MB ตามเพดานของระบบอย่างน่าเชื่อถือ)
export async function uploadFile({ buffer, filename, mimeType, folderId, refreshToken }) {
  const token = await getAccessToken(refreshToken);
  const initRes = await httpFetch(`${UPLOAD_BASE}?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(buffer.length),
    },
    body: JSON.stringify({ name: filename, parents: [folderId] }),
  });
  if (!initRes.ok) {
    const errData = await initRes.json().catch(() => ({}));
    throw httpError(502, `เริ่มอัปโหลดไป Google Drive ไม่สำเร็จ: ${errData.error?.message || initRes.statusText}`);
  }
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw httpError(502, 'Google Drive ไม่ส่ง upload session URL กลับมา');

  const putRes = await httpFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(buffer.length) },
    body: buffer,
  });
  const putData = await putRes.json().catch(() => ({}));
  if (!putRes.ok) throw httpError(502, `อัปโหลดไฟล์ไป Google Drive ไม่สำเร็จ: ${putData.error?.message || putRes.statusText}`);
  return putData.id; // Google Drive file ID
}

// ดาวน์โหลดเนื้อหาไฟล์ (คืนค่าเป็น web ReadableStream สำหรับ pipe ต่อไปยัง response)
export async function downloadFileStream(fileId, refreshToken) {
  const res = await driveFetch(`${API_BASE}/${fileId}?alt=media`, {}, refreshToken);
  if (res.status === 404) return null;
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw httpError(502, `ดาวน์โหลดไฟล์จาก Google Drive ไม่สำเร็จ: ${errData.error?.message || res.statusText}`);
  }
  return res.body;
}

export async function deleteFile(fileId, refreshToken) {
  const res = await driveFetch(`${API_BASE}/${fileId}`, { method: 'DELETE' }, refreshToken);
  if (!res.ok && res.status !== 404) {
    const errData = await res.json().catch(() => ({}));
    throw httpError(502, `ลบไฟล์บน Google Drive ไม่สำเร็จ: ${errData.error?.message || res.statusText}`);
  }
}

export async function exchangeCodeForTokens({ code, redirectUri }) {
  const { clientId, clientSecret } = getOAuthClientConfig();
  const res = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `แลก authorization code ไม่สำเร็จ: ${data.error_description || data.error || res.statusText}`);
  return data; // { access_token, refresh_token, expires_in, ... } — refresh_token มาเฉพาะครั้งแรกที่ยินยอม (prompt=consent)
}

/**
 * พื้นที่ของบัญชีไดรฟ์ — ใช้บอกผู้ดูแลว่าใกล้เต็มหรือยัง "ก่อน" ที่จะเต็มจริง
 *
 * บัญชี Google ฟรีมี 15GB ที่แชร์กันระหว่าง Drive, Gmail และ Photos ดังนั้นพื้นที่ที่ระบบนี้เห็นว่า
 * ถูกใช้ไปแล้วจึงรวมอีเมลและรูปของเจ้าของบัญชีด้วย ไม่ใช่เฉพาะไฟล์ของระบบ — ซึ่งเป็นสิ่งที่ต้อง
 * บอกผู้ใช้ตรงๆ ไม่งั้นจะงงว่าทำไมเพิ่งใช้ไปนิดเดียวแต่ขึ้นว่าเกือบเต็ม
 *
 * limit เป็น null ได้ (บัญชีองค์กรที่ไม่จำกัดพื้นที่) ผู้เรียกต้องรับมือกรณีนั้นด้วย
 */
export async function driveStorageQuota(refreshToken) {
  const res = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {}, refreshToken);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `อ่านพื้นที่คงเหลือของ Google Drive ไม่สำเร็จ: ${data.error?.message || res.statusText}`);
  const q = data.storageQuota || {};
  const limit = q.limit == null ? null : Number(q.limit);
  const usage = Number(q.usage || 0);
  return {
    limitBytes: Number.isFinite(limit) ? limit : null,
    usageBytes: Number.isFinite(usage) ? usage : 0,
    usedPercent: limit ? Math.min(100, Math.round((usage / limit) * 100)) : null,
  };
}
