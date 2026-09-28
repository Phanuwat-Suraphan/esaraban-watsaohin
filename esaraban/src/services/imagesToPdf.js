// รวมรูปถ่ายหนังสือหลายรูปเป็นไฟล์ PDF ฉบับเดียว
//
// ทำไมต้องมี: ครูถ่ายรูปหนังสือด้วยมือถือแล้วแนบเข้ามาตรงๆ เป็นวิธีที่ใช้จริงมากที่สุด (เร็วกว่าเดินไป
// สแกน) แต่ตราประทับทุกชนิดของระบบทำงานด้วยการซ้อนหน้า PDF — หนังสือที่มีแต่รูปถ่ายจึงประทับตรารับ
// ตราธุรการ และตราความเห็น ผอ. ไม่ได้เลยสักอัน หน้าเอกสารขึ้นเตือนไว้ว่า "ยังไม่มีไฟล์ PDF" แต่เดิม
// ไม่มีทางออกให้ นอกจากให้ครูไปหาแอปแปลงไฟล์เอาเอง ซึ่งบนมือถือของครูส่วนใหญ่แปลว่าไม่ได้ทำ
//
// เขียนไฟล์ PDF เองทั้งหมด ไม่พึ่ง dependency ภายนอก (ทั้งโปรเจกต์ไม่มี npm dependency เลย) และ
// ไม่พึ่งโปรแกรมภายนอกอย่าง ImageMagick ด้วย เพราะบน Render รันได้เฉพาะสิ่งที่อยู่ใน image เท่านั้น
//
// รูป JPEG ฝังลงไฟล์ PDF ได้ตรงๆ (PDF รองรับ DCTDecode = ข้อมูล JPEG ดิบ) จึงไม่ต้องถอดรหัสและ
// ไม่เสียคุณภาพเลย ส่วน PNG ต้องถอดรหัสก่อนเพราะ PDF ไม่รับ PNG ทั้งไฟล์ (รับเฉพาะข้อมูลพิกเซล)
import zlib from 'node:zlib';
import { httpError } from './validate.js';

// A4 ตามหน่วยของ PDF (จุด, 72 จุดต่อนิ้ว) — หนังสือราชการใช้ A4 และตราประทับทุกชนิดคิดตำแหน่ง
// เป็นเปอร์เซ็นต์ของหน้ากระดาษ ถ้าขนาดหน้าเปลี่ยนไปตามขนาดรูป ตราจะไปลงคนละที่ในแต่ละฉบับ
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 14.17; // 5 มม. — กันรูปชนขอบกระดาษเวลาพิมพ์ออกมาจริง

/** ขนาดและจำนวนช่องสีของ JPEG — อ่านจากเครื่องหมาย SOF ไม่ใช่เดาจากชื่อไฟล์ */
function readJpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw httpError(400, 'ไฟล์ JPEG ไม่ถูกต้อง');
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0-3, 5-7, 9-11, 13-15 = เครื่องหมายบอกขนาดภาพ (ข้าม SOF4/8/12 ซึ่งไม่ใช่)
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  throw httpError(400, 'อ่านขนาดของไฟล์ JPEG ไม่ได้');
}

/** คลายรหัส PNG เป็นพิกเซล RGB — PDF รับเฉพาะข้อมูลพิกเซล ไม่ได้รับไฟล์ PNG ทั้งไฟล์ */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw httpError(400, 'ไฟล์ PNG ไม่ถูกต้อง');
  let i = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!ihdr) throw httpError(400, 'ไฟล์ PNG ไม่มีส่วนหัว');
  // รูปที่ระบบรับเข้ามาคือรูปถ่าย/ภาพสแกนจากเบราว์เซอร์ ซึ่งเป็น 8 บิตและไม่ interlace เสมอ
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) {
    throw httpError(400, 'รองรับเฉพาะ PNG แบบ 8 บิตที่ไม่ใช่ interlaced — บันทึกรูปใหม่เป็น JPEG แล้วลองอีกครั้ง');
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw httpError(400, 'ชนิดสีของ PNG นี้ไม่รองรับ');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    // คลายตัวกรองรายบรรทัดตามมาตรฐาน PNG (None/Sub/Up/Average/Paeth)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    line.copy(out, y * stride);
    prev = line;
  }

  // แปลงเป็น RGB ล้วน และทับพื้นหลังขาวให้ส่วนที่โปร่งใส — หนังสือราชการพิมพ์ลงกระดาษขาวอยู่แล้ว
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0, o = 0; p < width * height; p++) {
    let r; let g; let b; let alpha = 255;
    const s = p * bpp;
    if (ihdr.colorType === 0) { r = out[s]; g = out[s]; b = out[s]; }
    else if (ihdr.colorType === 4) { r = out[s]; g = out[s]; b = out[s]; alpha = out[s + 1]; }
    else if (ihdr.colorType === 2) { r = out[s]; g = out[s + 1]; b = out[s + 2]; }
    else if (ihdr.colorType === 6) { r = out[s]; g = out[s + 1]; b = out[s + 2]; alpha = out[s + 3]; }
    else { // colorType 3 = ใช้จานสี
      const idx = out[s] * 3;
      r = palette[idx]; g = palette[idx + 1]; b = palette[idx + 2];
      if (transparency && out[s] < transparency.length) alpha = transparency[out[s]];
    }
    if (alpha !== 255) {
      const k = alpha / 255;
      r = Math.round(r * k + 255 * (1 - k));
      g = Math.round(g * k + 255 * (1 - k));
      b = Math.round(b * k + 255 * (1 - k));
    }
    rgb[o++] = r; rgb[o++] = g; rgb[o++] = b;
  }
  return { width, height, rgb };
}

/** เตรียมรูปหนึ่งรูปให้พร้อมฝังลงไฟล์ PDF */
function toImageObject(file) {
  if (file.mime === 'image/jpeg') {
    const info = readJpegInfo(file.buffer);
    return {
      width: info.width,
      height: info.height,
      colorSpace: info.components === 1 ? '/DeviceGray' : '/DeviceRGB',
      filter: '/DCTDecode',
      data: file.buffer,
    };
  }
  if (file.mime === 'image/png') {
    const png = decodePng(file.buffer);
    return {
      width: png.width,
      height: png.height,
      colorSpace: '/DeviceRGB',
      filter: '/FlateDecode',
      data: zlib.deflateSync(png.rgb, { level: 6 }),
    };
  }
  throw httpError(400, 'รวมได้เฉพาะไฟล์รูปภาพ (JPG/PNG) เท่านั้น');
}

/**
 * รวมรูปเป็นไฟล์ PDF หน้าละหนึ่งรูป ขนาด A4 แนวตั้ง
 *
 * รูปถูกย่อให้พอดีหน้ากระดาษโดยคงสัดส่วนเดิม และวางกึ่งกลาง — รูปถ่ายหนังสือที่ถือมือถือถ่ายมักมี
 * สัดส่วนไม่ตรง A4 ถ้ายืดให้เต็มหน้าตัวหนังสือจะบิดจนอ่านยากและดูไม่เป็นเอกสารราชการ
 */
export function imagesToPdf(files) {
  if (!files?.length) throw httpError(400, 'ไม่มีรูปให้รวม');
  const images = files.map(toImageObject);

  const objects = []; // index = เลขวัตถุ - 1
  const add = (body) => { objects.push(body); return objects.length; };

  const pageIds = [];
  const kidsPlaceholder = add(''); // 1 = Pages (เติมทีหลังเมื่อรู้เลขหน้าทั้งหมด)
  const catalogId = add(`<</Type/Catalog/Pages ${kidsPlaceholder} 0 R>>`);

  for (const img of images) {
    const scale = Math.min((PAGE_W - MARGIN * 2) / img.width, (PAGE_H - MARGIN * 2) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (PAGE_W - w) / 2;
    const y = (PAGE_H - h) / 2;
    const imgId = add({
      dict: `<</Type/XObject/Subtype/Image/Width ${img.width}/Height ${img.height}`
        + `/ColorSpace ${img.colorSpace}/BitsPerComponent 8/Filter ${img.filter}/Length ${img.data.length}>>`,
      stream: img.data,
    });
    const content = Buffer.from(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q\n`, 'latin1');
    const contentId = add({ dict: `<</Length ${content.length}>>`, stream: content });
    pageIds.push(add(`<</Type/Page/Parent ${kidsPlaceholder} 0 R/MediaBox[0 0 ${PAGE_W} ${PAGE_H}]`
      + `/Resources<</XObject<</Im0 ${imgId} 0 R>>>>/Contents ${contentId} 0 R>>`));
  }
  objects[kidsPlaceholder - 1] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageIds.length}>>`;

  // ประกอบไฟล์พร้อมตาราง xref ให้ถูกต้อง — โปรแกรมอ่าน PDF บางตัว (รวมถึงตัวที่ใช้ประทับตรา)
  // ปฏิเสธไฟล์ที่ xref ผิดทันที ทั้งที่เนื้อหาข้างในถูกต้องครบถ้วน
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((obj, idx) => {
    offsets.push(offset);
    const head = Buffer.from(`${idx + 1} 0 obj\n`, 'latin1');
    let body;
    if (typeof obj === 'string') body = Buffer.from(`${obj}\n`, 'latin1');
    else body = Buffer.concat([Buffer.from(`${obj.dict}\nstream\n`, 'latin1'), obj.stream, Buffer.from('\nendstream\n', 'latin1')]);
    const tail = Buffer.from('endobj\n', 'latin1');
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<</Size ${objects.length + 1}/Root ${catalogId} 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
