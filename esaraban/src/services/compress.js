// บีบอัดคำตอบก่อนส่งออก (gzip)
//
// ทำไมต้องมี: หน้าเว็บของระบบนี้เป็น HTML ที่เซิร์ฟเวอร์ประกอบเองทั้งหน้า และหน้าที่เปิดบ่อยที่สุด
// (ทะเบียนหนังสือ 50 แถว) วัดได้เกือบ 200 KB ต่อการเปิดหนึ่งครั้ง — ทั้งหมดนั้นวิ่งผ่านเน็ตมือถือของครู
// แบบดิบๆ เพราะเดิมไม่มีการบีบอัดเลยสักจุด HTML ที่ประกอบจากเทมเพลตซ้ำๆ แบบนี้บีบอัดได้ราว 8-12 เท่า
// จึงเป็นการลดเวลาโหลดที่ถูกที่สุดที่ทำได้ โดยไม่ต้องแตะโค้ดหน้าไหนเลยสักหน้า
//
// วิธีที่เลือก: ครอบ res ที่ชั้นเดียวตอนรับ request ไม่ใช่ไปแก้ทุกที่ที่ตอบกลับ — เพราะจุดที่เขียน
// คำตอบมีหลายสิบแห่ง (html/json/ไฟล์นิ่ง/หน้า 404/ตัวจับ error) และจุดที่เพิ่มใหม่ในอนาคตจะลืมได้ง่าย
//
// สิ่งที่ตั้งใจ "ไม่" บีบ:
//   - ชนิดที่บีบแล้วไม่ได้อะไร (PDF, JPEG, PNG, xlsx ซึ่งเป็น zip อยู่แล้ว) — เสีย CPU ฟรีๆ
//     และไฟล์แนบเป็นของที่ไหลผ่านแบบ stream อยู่แล้ว ไม่ควรเอามากองในหน่วยความจำ
//   - คำตอบสั้นๆ (ต่ำกว่า MIN_COMPRESS_BYTES) — หัว gzip เองก็กินที่ ผลลัพธ์มักใหญ่กว่าเดิม
//   - เมื่อเบราว์เซอร์ไม่ได้บอกว่ารับ gzip ได้
import zlib from 'node:zlib';

/**
 * ชนิดเนื้อหาที่บีบอัดแล้วได้ผลจริง — ข้อความล้วนทั้งหมด
 *
 * ไล่จาก Content-Type ไม่ใช่จากนามสกุลไฟล์ เพราะคำตอบส่วนใหญ่ของระบบนี้ไม่ได้มาจากไฟล์บนดิสก์
 * (เป็น HTML ที่ประกอบขึ้นมาสดๆ) และ Content-Type คือสิ่งเดียวที่ทุกเส้นทางตั้งไว้เหมือนกันหมด
 */
const COMPRESSIBLE = [
  /^text\//,
  /^application\/json\b/,
  /^application\/javascript\b/,
  /^application\/manifest\+json\b/,
  /^image\/svg\+xml\b/,
];
export const isCompressibleType = (contentType) =>
  COMPRESSIBLE.some((re) => re.test(String(contentType || '').trim().toLowerCase()));

/**
 * เล็กกว่านี้ไม่ต้องบีบ — หัวของ gzip เองราว 20 ไบต์ และคำตอบสั้นๆ อย่าง {"ok":true} บีบแล้วใหญ่ขึ้น
 * 1 KB เป็นจุดที่ผลได้เริ่มชัดโดยไม่ต้องจ่าย CPU กับคำตอบจิ๋วๆ ที่มีเยอะที่สุดในระบบ (ปุ่มต่างๆ)
 */
export const MIN_COMPRESS_BYTES = 1024;

/** เบราว์เซอร์บอกว่ารับ gzip ได้ไหม — ต้องเป็นรายการที่ไม่ได้ตั้ง q=0 ไว้ */
export function acceptsGzip(acceptEncoding) {
  const raw = String(acceptEncoding || '').toLowerCase();
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().split(';').map((x) => x.trim());
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((p) => /^q=([0-9.]+)$/.exec(p)).find(Boolean);
    if (q && Number(q[1]) === 0) continue;
    return true;
  }
  return false;
}

/** สถานะที่ตามสเปกแล้วไม่มีเนื้อความ จึงบีบไม่ได้ (และ 304 ต้องไม่เปลี่ยนหัวที่เกี่ยวกับเนื้อความ) */
const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * ครอบ res ให้บีบอัดเนื้อความที่เป็นข้อความโดยอัตโนมัติ
 *
 * เก็บเนื้อความทั้งก้อนก่อนแล้วค่อยบีบตอน end ไม่ใช่บีบไหลไปทีละชิ้น — เพราะต้องรู้ขนาดจริงก่อนจึงจะ
 * ตัดสินใจได้ว่า "เล็กเกินกว่าจะคุ้มบีบ" และคำตอบที่เข้าเงื่อนไขล้วนเป็นข้อความหลักสิบถึงหลักร้อย KB
 * (ไฟล์แนบซึ่งใหญ่จริงไม่เข้าเงื่อนไขอยู่แล้ว จึงยังไหลผ่านแบบ stream เหมือนเดิมทุกประการ)
 */
export function installCompression(req, res, { minBytes = MIN_COMPRESS_BYTES } = {}) {
  if (req.method === 'HEAD') return;
  if (!acceptsGzip(req.headers?.['accept-encoding'])) return;

  const realWriteHead = res.writeHead.bind(res);
  const realWrite = res.write.bind(res);
  const realEnd = res.end.bind(res);

  let capturing = false;
  let status = 200;
  let captured = null;
  let chunks = [];

  // ของที่เขียนผ่าน writeHead มาเป็นได้ทั้ง object และ array (รูปแบบ raw ของ Node) — ดึงค่าหัวแบบ
  // ไม่สนตัวพิมพ์ใหญ่เล็ก เพราะแต่ละเส้นทางในโค้ดนี้เขียนชื่อหัวไม่เหมือนกัน
  const pick = (headers, name) => {
    if (!headers || Array.isArray(headers)) return undefined;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  };

  // เส้นทางที่ตอบเป็นไฟล์ตรวจ res.headersSent ก่อนเขียนทับ และตัวจับ error กลางของ server.js ก็ใช้
  // ค่านี้ตัดสินว่ายังตอบอะไรได้อยู่ไหม — ระหว่างที่เรากักหัวไว้ ค่าจริงยังเป็น false ซึ่งจะทำให้ที่อื่น
  // เข้าใจผิดว่ายังไม่ได้ตอบอะไรเลย จึงต้องรายงานว่า "ส่งหัวไปแล้ว" ตั้งแต่ตอนที่กักไว้
  const proto = findHeadersSentDescriptor(res);
  if (proto) {
    Object.defineProperty(res, 'headersSent', {
      configurable: true,
      get() { return capturing || proto.get.call(res); },
    });
  }

  res.writeHead = function writeHead(code, reasonOrHeaders, maybeHeaders) {
    const headers = typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null
      ? reasonOrHeaders : maybeHeaders;
    const contentType = pick(headers, 'content-type') ?? res.getHeader('Content-Type');
    const alreadyEncoded = pick(headers, 'content-encoding') ?? res.getHeader('Content-Encoding');
    if (!alreadyEncoded && !NO_BODY_STATUS.has(code) && isCompressibleType(contentType)) {
      capturing = true;
      status = code;
      captured = { ...(headers || {}) };
      return res;
    }
    return realWriteHead(...[code, reasonOrHeaders, maybeHeaders].filter((x) => x !== undefined));
  };

  res.write = function write(chunk, encoding, callback) {
    if (!capturing) return realWrite(chunk, encoding, callback);
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
    if (typeof callback === 'function') callback();
    return true;
  };

  res.end = function end(chunk, encoding, callback) {
    if (!capturing) return realEnd(chunk, encoding, callback);
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
    const body = Buffer.concat(chunks);
    chunks = [];

    // Content-Length ต้องเป็นขนาด "หลังบีบ" เสมอ ถ้าเส้นทางไหนตั้งค่าเดิมมาก็ต้องถูกทับ ไม่งั้น
    // เบราว์เซอร์จะรอไบต์ที่ไม่มีวันมา (หรือตัดเนื้อความทิ้งกลางคัน) ซึ่งเป็นความพังแบบเงียบที่สุด
    const flush = (buf, extra) => {
      capturing = false;
      realWriteHead(status, { ...captured, ...extra, 'Content-Length': buf.length });
      realEnd(buf, callback);
    };

    // Vary ต้องติดไปทุกครั้งที่ "คำตอบขึ้นกับ Accept-Encoding" ไม่ใช่เฉพาะครั้งที่บีบจริง — ไม่งั้น
    // ตัวแคชที่อยู่ข้างหน้าจะเอาคำตอบที่บีบแล้วไปจ่ายให้เบราว์เซอร์ที่รับ gzip ไม่ได้
    if (body.length < minBytes) return flush(body, { Vary: 'Accept-Encoding' });
    zlib.gzip(body, (err, gz) => {
      // บีบไม่ผ่าน หรือบีบแล้วไม่เล็กลง ก็ส่งของเดิมไป ไม่ใช่ทำให้ทั้งคำตอบล้ม
      if (err || !gz || gz.length >= body.length) return flush(body, { Vary: 'Accept-Encoding' });
      flush(gz, { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    });
    return res;
  };
}

/** หา getter ของ headersSent จากสายโปรโตไทป์ของ res (ไม่ใช่ own property) */
function findHeadersSentDescriptor(res) {
  for (let o = Object.getPrototypeOf(res); o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, 'headersSent');
    if (d && typeof d.get === 'function') return d;
  }
  return null;
}
