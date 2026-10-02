// ไดรฟ์เต็มกลางคัน: ลงทะเบียนหนังสือแล้วแนบไฟล์ไม่ขึ้น — ต้องไม่ทำให้งานหายทั้งใบ
//
// ทำไมต้องแยกโปรเซส: ต้องตั้ง STORAGE_PROVIDER เป็น google_drive ตั้งแต่ก่อน import อะไรทั้งนั้น
// (เหมือน driveMultiAccount.mjs) และชุดเทสต์หลักรันหลาย describe พร้อมกัน การสลับตัวแปรนี้กลางคัน
// จะไปกระทบเทสต์อื่นที่กำลังเขียนไฟล์ลงดิสก์อยู่
//
// สถานการณ์จริงที่จำลอง: โรงเรียนใช้ไปจนไดรฟ์เต็ม ธุรการกำลังลงรับหนังสือด่วน กรอกครบทุกช่องแล้ว
// กดบันทึก — ตรงนั้นเลขที่หนังสือถูกออกไปแล้วและใช้ซ้ำไม่ได้ตามหลักงานสารบรรณ ถ้าการแนบไฟล์ที่ตาม
// มาทีหลังโยน error ทิ้งทั้งคำขอ ธุรการจะเห็นแค่ "ผิดพลาด" แล้วเข้าใจว่าไม่ได้บันทึกอะไรเลย จึงกรอก
// ใหม่อีกรอบ = ได้หนังสือซ้ำสองฉบับ กินเลขทะเบียนไปสองเลข โดยที่ไฟล์ก็ยังแนบไม่ได้อยู่ดี
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `esaraban-drivefull-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.STORAGE_PROVIDER = 'google_drive';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh-ไดรฟ์ที่เต็มแล้ว';
process.env.SESSION_SECRET = 'drivefull-test-secret';
delete process.env.TEST_MODE_PASSWORD;

const out = {};

try {
  // Google Drive จำลองที่ "เต็ม" — ทุกอย่างทำงานปกติ ยกเว้นตอนขอเริ่มอัปโหลดจะตอบ 403
  // storageQuotaExceeded ซึ่งเป็นสิ่งที่ Google ตอบจริงเมื่อบัญชีใช้พื้นที่ครบ 15GB แล้ว
  let uploadsBlocked = true;
  const fetchRouter = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'fake-access', expires_in: 3600 });
    if (u.includes('/drive/v3/about')) {
      return json({
        user: { emailAddress: 'เต็มแล้ว@example.com', permissionId: 'permission-full' },
        storageQuota: { limit: String(15 * 1024 ** 3), usage: String(15 * 1024 ** 3) },
      });
    }
    if (u.includes('/upload/drive/v3/files')) {
      if (uploadsBlocked) {
        return json({
          error: {
            code: 403,
            message: "The user's Drive storage quota has been exceeded.",
            errors: [{ reason: 'storageQuotaExceeded', domain: 'usageLimits' }],
          },
        }, 403);
      }
      return new Response(null, { status: 200, headers: { Location: 'https://fake-upload.local/ok' } });
    }
    if (u.startsWith('https://fake-upload.local/')) return json({ id: 'uploaded-1' });
    // ค้นหา/สร้างโฟลเดอร์ยังทำงานได้ตามปกติแม้ไดรฟ์จะเต็ม (โฟลเดอร์ไม่กินพื้นที่)
    if (u.includes('/drive/v3/files')) {
      if ((opts.method || 'GET').toUpperCase() === 'POST') return json({ id: 'folder-1', name: 'x' });
      return json({ files: [{ id: 'folder-1', name: 'x', mimeType: 'application/vnd.google-apps.folder' }] });
    }
    throw new Error(`Drive จำลองไม่รู้จักคำขอนี้: ${u}`);
  };

  const { _setDriveFetchForTest } = await import('../src/services/googleDrive.js');
  _setDriveFetchForTest(fetchRouter);

  const { db } = await import('../src/db.js');
  const { router } = await import('../src/router.js');
  await import('../src/routes/index.js');

  const load = (code) => {
    const row = db.prepare('SELECT * FROM users WHERE employee_code = ?').get(code);
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
    await new Promise((r) => setTimeout(r, 60));
    return { status, headers, body: Buffer.concat(chunks).toString('utf8') };
  };

  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n% ไฟล์ทดสอบ\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251)),
  ]);

  const docsBefore = db.prepare('SELECT COUNT(*) c FROM documents').get().c;

  // --- ธุรการลงรับหนังสือด่วน พร้อมแนบ PDF ตอนที่ไดรฟ์เต็มแล้ว ---
  const created = await dispatch('POST', '/documents', {
    body: {
      title: 'หนังสือด่วนที่ลงตอนไดรฟ์เต็ม', departmentId: deptId, correspondentName: 'สพป.',
      direction: 'incoming', priority: 'most_urgent', allowDuplicate: true,
      fileName: 'ด่วน.pdf', fileType: 'application/pdf', fileDataBase64: pdf.toString('base64'),
    },
  });
  out.createStatus = created.status;
  // ข้อความเตือนเดินทางมาเป็น ?warn= ที่ encode ไว้ ต้องถอดก่อนถึงจะเทียบคำได้
  const warnText = decodeURIComponent(/[?&]warn=([^"&]*)/.exec(created.body)?.[1] || '')
    || (() => { try { return JSON.parse(created.body).error || ''; } catch { return created.body; } })();
  out.userMessage = warnText.slice(0, 300);

  const row = db.prepare("SELECT * FROM documents WHERE title = 'หนังสือด่วนที่ลงตอนไดรฟ์เต็ม'").get();
  out.documentSaved = Boolean(row);
  out.hasDocNumber = Boolean(row?.doc_number_display);
  out.docsAdded = db.prepare('SELECT COUNT(*) c FROM documents').get().c - docsBefore;
  out.attachmentCount = row
    ? db.prepare('SELECT COUNT(*) c FROM attachments WHERE document_id = ?').get(row.id).c : -1;

  // ข้อความที่ผู้ใช้เห็น ต้องบอกว่า "ไดรฟ์เต็ม" และบอกว่าต้องทำอะไรต่อ ไม่ใช่สตริงอังกฤษของ Google
  out.saysFull = /เต็ม/.test(warnText);
  out.saysWhatToDo = /เพิ่มไดรฟ์|ผู้ดูแล/.test(warnText);
  out.leaksEnglish = /storage quota has been exceeded/i.test(warnText);
  out.saysDocSaved = /ออกเลขเรียบร้อย/.test(warnText);
  out.saysNoRetry = /ไม่ต้องลงทะเบียนซ้ำ/.test(warnText);

  // --- ผู้ดูแลต้องรู้เองว่าไดรฟ์เต็ม ไม่ใช่รอให้ธุรการเดินมาบอก ---
  const dash = await dispatch('GET', '/', { user: admin });
  out.adminWarned = dash.body.includes('id="driveFullAlert"');
  out.adminHasLink = dash.body.includes('/admin/google-drive');

  // --- ครูทั่วไปไม่ต้องเห็นคำเตือนนี้ (แก้ไม่ได้อยู่แล้ว) ---
  const teacherDash = await dispatch('GET', '/', { user: load('teacher001') });
  out.teacherNotWarned = !teacherDash.body.includes('id="driveFullAlert"');

  // --- พอผู้ดูแลเพิ่มไดรฟ์ใหม่แล้ว แนบไฟล์ได้อีกครั้ง และคำเตือนต้องหายไป ---
  uploadsBlocked = false;
  const retry = await dispatch('POST', `/documents/${row.id}/attachments`, {
    body: { fileName: 'ด่วน.pdf', fileType: 'application/pdf', fileDataBase64: pdf.toString('base64') },
  });
  out.retryStatus = retry.status;
  out.attachmentAfterRetry = db.prepare('SELECT COUNT(*) c FROM attachments WHERE document_id = ?').get(row.id).c;
  const dash2 = await dispatch('GET', '/', { user: admin });
  out.warningCleared = !dash2.body.includes('id="driveFullAlert"');
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
}

console.log(JSON.stringify(out));
