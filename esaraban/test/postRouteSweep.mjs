// กวาดทุกเส้นทาง POST ด้วย "ข้อมูลว่าง" — ไม่มีเส้นทางไหนตอบ 5xx หรือพ่นข้อความเครื่องใส่ผู้ใช้
//
// ทำไมต้องมี: เส้นทางที่ลืมตรวจค่าก่อนเอาไปใช้ จะหลุดไปถึงชั้น SQLite แล้วเด้งข้อความอังกฤษดิบ
// กลับมาให้ผู้ใช้อ่าน เช่น "Provided value cannot be bound to SQLite parameter 1."
// ซึ่งครูหรือธุรการอ่านแล้วทำอะไรต่อไม่ถูกเลย และไม่รู้ด้วยซ้ำว่าตัวเองกรอกอะไรขาด
//
// โค้ดเบสนี้เคยแก้บั๊กแบบนี้มาแล้วที่ voidDocument (มีคอมเมนต์อธิบายไว้) แต่แก้เป็นรายจุด
// ตัวกวาดนี้ปิดทั้งคลาส: เส้นทางใหม่ที่ลืมตรวจค่าจะถูกจับได้ทันทีโดยไม่ต้องมีใครไปนึกถึงมัน
//
// แยกโปรเซสเพราะต้องยิงทุกเส้นทางรวมถึงอันที่เขียนฐานข้อมูล — ถ้ารันปนกับชุดเทสต์หลัก
// จะไปกวนสถานะของ describe อื่นที่รันพร้อมกันอยู่
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DB_PATH = path.join(os.tmpdir(), `esaraban-sweep-${process.pid}-${Date.now()}.db`);
process.env.SESSION_SECRET = 'post-route-sweep';
delete process.env.TEST_MODE_PASSWORD;

const out = { checked: 0, offenders: [] };

try {
  const { db } = await import('../src/db.js');
  const { router } = await import('../src/router.js');
  await import('../src/routes/index.js');

  const load = (code) => {
    const row = db.prepare('SELECT * FROM users WHERE employee_code = ?').get(code);
    const roleCodes = db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?')
      .all(row.id).map((r) => r.name);
    return { ...row, roleCodes, roles: roleCodes.map((n) => ({ name: n })), unreadCount: 0 };
  };
  // ใช้แอดมินเพราะเข้าถึงเส้นทางได้กว้างที่สุด — เส้นทางที่แอดมินยังโดนปฏิเสธก็ไม่ต้องตรวจต่อ
  const admin = load('admin');

  // ของจริงอย่างละชิ้น เพื่อให้ :id ที่ต้องมีอยู่จริงชี้ถึงได้ ไม่งั้นทุกเส้นทางจะจบที่ 404
  // ตั้งแต่บรรทัดแรกแล้วไม่ได้ตรวจตัวที่อยู่ลึกกว่านั้นเลย
  const deptId = db.prepare('SELECT id FROM departments LIMIT 1').get().id;
  const typeId = db.prepare('SELECT id FROM document_types LIMIT 1').get().id;
  const docId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO documents (id,direction,running_number,year_be,doc_number_display,title,correspondent_name,
    doc_type_id,department_id,status,priority,retention_class,retention_until,created_by,created_at,updated_at)
    VALUES (?,'incoming',1,2569,'0001/2569','หนังสือสำหรับกวาดเส้นทาง','สพป.',?,?,'registered','normal','normal_10y','2039-12-31',?,?,?)`)
    .run(docId, typeId, deptId, admin.id, now, now);
  const stepId = randomUUID();
  db.prepare(`INSERT INTO workflow_steps (id,document_id,step_order,assignee_id,instruction,status,created_at)
    VALUES (?,?,1,?,'เพื่อทราบ','waiting',?)`).run(stepId, docId, admin.id, now);
  const attId = randomUUID();
  db.prepare(`INSERT INTO attachments (id,document_id,filename,storage_provider,filepath,filesize,mime_type,hash_sha256,uploaded_by,created_at)
    VALUES (?,?, 'a.pdf','local','a.pdf',10,'application/pdf','hash',?,?)`).run(attId, docId, admin.id, now);

  const fill = (p) => p
    .replace(':id', docId).replace(':stepId', stepId)
    .replace(':attId', attId).replace(':attachmentId', attId)
    .replace(/:[A-Za-z]+/g, randomUUID());

  const post = async (p) => {
    let status = 0;
    const chunks = [];
    const res = {
      headersSent: false, setHeader() {}, destroy() {},
      writeHead(c) { status = c; this.headersSent = true; return this; },
      end(c) { if (c) chunks.push(Buffer.from(String(c))); },
      on() {}, once() {}, emit() {}, write(c) { chunks.push(Buffer.from(String(c))); return true; },
    };
    try {
      await router.dispatch('POST', p, {
        req: { method: 'POST', headers: {} }, res, url: new URL(`http://x${p}`),
        query: {}, user: admin, body: {}, ip: '127.0.0.1', params: {},
      });
    } catch (err) {
      return { status: -1, body: `โยน exception ออกมาโดยไม่มีใครรับ: ${err.message}` };
    }
    await new Promise((r) => setTimeout(r, 20));
    return { status, body: Buffer.concat(chunks).toString('utf8') };
  };

  const hasThai = (s) => /[฀-๿]/.test(s);
  for (const route of router.routes.filter((r) => r.method === 'POST')) {
    // เส้นทางที่รับของดิบจากภายนอก ไม่ใช่ฟอร์มที่คนกรอก จึงไม่อยู่ในข่ายนี้
    if (/webhook|\/login|\/logout/.test(route.pattern)) continue;
    const r = await post(fill(route.pattern));
    out.checked++;
    let message = '';
    try { message = String(JSON.parse(r.body).error || ''); } catch { message = ''; }

    if (r.status === -1 || r.status >= 500) {
      out.offenders.push({ pattern: route.pattern, status: r.status, why: 'ตอบ 5xx', message: message || r.body.slice(0, 160) });
    } else if (message && !hasThai(message)) {
      // ข้อความที่ไม่มีตัวอักษรไทยเลย = ข้อความของเครื่อง (SQLite/Node) ไม่ใช่ข้อความที่เขียนให้คนอ่าน
      out.offenders.push({ pattern: route.pattern, status: r.status, why: 'ข้อความไม่มีภาษาไทยเลย', message });
    }
  }
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
}

console.log(JSON.stringify(out));
