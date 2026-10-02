// ไดรฟ์เต็ม → เพิ่มไดรฟ์ใหม่ → ไฟล์เก่าต้องยังเปิดได้ (เดินครบวงในโปรเซสของตัวเอง)
//
// ทำไมต้องแยกโปรเซส: ต้องสลับ STORAGE_PROVIDER เป็น google_drive ตั้งแต่ก่อน import อะไรทั้งนั้น
// และต้องผูก Google Drive จำลองแบบ "สองบัญชีแยกกันจริง" ซึ่งทำพร้อมกับชุดเทสต์หลักไม่ได้
//
// หัวใจของเทสต์นี้คือการจำลองสิ่งที่ scope drive.file ทำกับเราในของจริง: บัญชีหนึ่ง "มองไม่เห็น"
// ไฟล์ของอีกบัญชีหนึ่งเลย ถ้าระบบเผลอใช้บัญชีที่ใช้งานอยู่ไปเปิดไฟล์เก่า จะได้ 404 ทันที
// — ซึ่งคือสิ่งที่เกิดขึ้นจริงถ้าแก้ GOOGLE_OAUTH_REFRESH_TOKEN แล้ว redeploy แบบที่เคยเป็น
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFakeDrive } from './fakeDrive.js';

const dbPath = path.join(os.tmpdir(), `esaraban-multidrive-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.STORAGE_PROVIDER = 'google_drive';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh-ไดรฟ์หนึ่ง';
process.env.SESSION_SECRET = 'multidrive-test-secret';
delete process.env.TEST_MODE_PASSWORD;

const out = {};

try {
  // Google Drive จำลองสองบัญชี แยกคลังไฟล์กันคนละใบจริงๆ
  const drives = new Map([
    ['refresh-ไดรฟ์หนึ่ง', createFakeDrive({ idPrefix: 'drive1' })],
    ['refresh-ไดรฟ์สอง', createFakeDrive({ idPrefix: 'drive2' })],
  ]);
  const accessToken = (refresh) => `access-for:${refresh}`;
  const uploadSessions = new Map(); // session URL -> refresh token ของบัญชีที่เปิด session นั้น

  // ตัวยิงที่แยกคำขอไปยังบัญชีตาม refresh token (ตอนขอโทเคน) และตาม Bearer (ตอนเรียก API)
  const fetchRouter = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      const refresh = new URLSearchParams(String(opts.body)).get('refresh_token');
      if (!drives.has(refresh)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ access_token: accessToken(refresh), expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // ขั้นที่สองของการอัปโหลดแบบ resumable ยิงไปที่ session URL โดยไม่มี Authorization (ตามสเปกของ
    // Google) จึงต้องจำไว้เองว่า session นั้นเป็นของบัญชีไหน ตอนออก Location ให้
    if (u.startsWith('https://fake-upload.local/')) {
      const owner = uploadSessions.get(u);
      if (!owner) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      return drives.get(owner).fetch(url, opts);
    }
    const bearer = String((opts.headers || {}).Authorization || '');
    const refresh = bearer.replace('Bearer access-for:', '');
    const drive = drives.get(refresh);
    if (!drive) return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/upload/drive/v3/files')) {
      const res = await drive.fetch(url, opts);
      const loc = res.headers.get('Location');
      if (loc) uploadSessions.set(loc, refresh);
      return res;
    }
    // ส่งต่อให้ Drive จำลองของบัญชีนั้น — ไฟล์ของอีกบัญชีจะไม่มีอยู่ในคลังนี้เลย (เหมือน scope drive.file)
    return drive.fetch(url, opts);
  };

  const { _setDriveFetchForTest } = await import('../src/services/googleDrive.js');
  _setDriveFetchForTest(fetchRouter);

  const { db } = await import('../src/db.js');
  const { router } = await import('../src/router.js');
  await import('../src/routes/index.js');
  const DA = await import('../src/services/driveAccounts.js');

  const load = (code) => {
    const row = db.prepare("SELECT * FROM users WHERE employee_code = ?").get(code);
    const roleCodes = db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?')
      .all(row.id).map((r) => r.name);
    return { ...row, roleCodes, unreadCount: 0 };
  };
  const reg = load('reg001');
  const admin = load('admin');
  const deptId = db.prepare('SELECT id FROM departments LIMIT 1').get().id;

  const dispatch = async (method, p, { body = {}, query = {}, user = reg } = {}) => {
    let status = 0; const chunks = []; const headers = {};
    const res = {
      headersSent: false, setHeader() {},
      writeHead(c, h) { status = c; Object.assign(headers, h || {}); this.headersSent = true; return this; },
      end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      on() {}, once() {}, emit() {}, write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
    };
    const ctx = { req: { method, headers: {} }, res, url: new URL(`http://x${p}`), query, user, body, ip: '127.0.0.1' };
    await router.dispatch(method, p, ctx);
    await new Promise((r) => setTimeout(r, 120));
    return { status, headers, buffer: Buffer.concat(chunks) };
  };

  const makePdf = (tag) => Buffer.concat([
    Buffer.from(`%PDF-1.4\n% ${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`),
    Buffer.from(Array.from({ length: 2048 }, (_, i) => (i + tag.length) % 251)),
  ]);
  const attach = async (title, pdf) => {
    const r = await dispatch('POST', '/documents', {
      body: {
        title, departmentId: deptId, correspondentName: 'สพป.', direction: 'incoming', allowDuplicate: true,
        fileName: `${title}.pdf`, fileType: 'application/pdf', fileDataBase64: pdf.toString('base64'),
      },
    });
    const docId = /documents\/([0-9a-f-]{36})/.exec(r.buffer.toString())?.[1];
    if (!docId) throw new Error(`สร้างหนังสือไม่สำเร็จ (HTTP ${r.status}): ${r.buffer.toString().slice(0, 200)}`);
    return db.prepare('SELECT * FROM attachments WHERE document_id = ?').get(docId);
  };

  // --- 1) ยุคไดรฟ์ใบแรก: แนบไฟล์ตามปกติ ---
  const pdfOld = makePdf('ไฟล์ยุคไดรฟ์ใบแรก');
  const attOld = await attach('หนังสือยุคไดรฟ์ใบแรก', pdfOld);
  out.oldOnBootstrap = attOld.drive_account_id === null; // ว่าง = ไดรฟ์ตั้งต้น
  out.oldFileInDriveOne = drives.get('refresh-ไดรฟ์หนึ่ง').backupFiles !== undefined;

  const openedBefore = await dispatch('GET', `/files/${attOld.id}`);
  out.openBeforeStatus = openedBefore.status;
  out.openBeforeMatches = openedBefore.buffer.equals(pdfOld);

  // --- 2) ไดรฟ์ใบแรกเต็ม → เพิ่มไดรฟ์ใบใหม่ผ่านหน้าเว็บ ---
  const added = await dispatch('POST', '/admin/google-drive/accounts', {
    user: admin, body: { label: 'ไดรฟ์โรงเรียน ชุดที่ 2', refreshToken: 'refresh-ไดรฟ์สอง' },
  });
  out.addStatus = added.status;
  out.activeIsNew = DA.activeDriveId() !== DA.BOOTSTRAP_DRIVE_ID;

  // --- 3) ไฟล์ใหม่ต้องไปลงไดรฟ์ใบใหม่ ---
  const pdfNew = makePdf('ไฟล์ยุคไดรฟ์ใบสอง');
  const attNew = await attach('หนังสือยุคไดรฟ์ใบสอง', pdfNew);
  out.newOnSecondDrive = attNew.drive_account_id === DA.activeDriveId();

  // --- 4) หัวใจของเรื่อง: ไฟล์เก่าต้องยังเปิดได้ หลังเปลี่ยนไดรฟ์แล้ว ---
  const openedOld = await dispatch('GET', `/files/${attOld.id}`);
  out.openOldAfterSwitchStatus = openedOld.status;
  out.openOldAfterSwitchMatches = openedOld.buffer.equals(pdfOld);

  const openedNew = await dispatch('GET', `/files/${attNew.id}`);
  out.openNewStatus = openedNew.status;
  out.openNewMatches = openedNew.buffer.equals(pdfNew);

  // --- 5) พิสูจน์ว่าสองบัญชีแยกกันจริง: เปิดไฟล์เก่าด้วยกุญแจของไดรฟ์ใหม่ต้องไม่เจอ ---
  // ถ้าข้อนี้ "เจอ" แปลว่า Drive จำลองไม่ได้แยกบัญชีจริง แล้วข้อ 4 ก็ไม่ได้พิสูจน์อะไรเลย
  const { downloadFileStream } = await import('../src/services/googleDrive.js');
  const wrongKey = await downloadFileStream(attOld.drive_file_id, 'refresh-ไดรฟ์สอง');
  out.oldFileInvisibleToNewDrive = wrongKey === null;

  // --- 6) ถอดไดรฟ์ที่ยังมีไฟล์อยู่ไม่ได้ ---
  const removeRes = await dispatch('POST', '/admin/google-drive/accounts/remove',
    { user: admin, body: { id: DA.activeDriveId() } });
  out.removeActiveStatus = removeRes.status;

  // --- 7) สลับกลับไปใช้ไดรฟ์ตั้งต้น แล้วไฟล์ของไดรฟ์ใบสองต้องยังเปิดได้ ---
  const back = await dispatch('POST', '/admin/google-drive/accounts/use',
    { user: admin, body: { id: DA.BOOTSTRAP_DRIVE_ID } });
  out.switchBackStatus = back.status;
  const openedNewAgain = await dispatch('GET', `/files/${attNew.id}`);
  out.openNewAfterSwitchBackStatus = openedNewAgain.status;
  out.openNewAfterSwitchBackMatches = openedNewAgain.buffer.equals(pdfNew);

  out.hashOld = createHash('sha256').update(pdfOld).digest('hex').slice(0, 8);
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
}

console.log(JSON.stringify(out));
