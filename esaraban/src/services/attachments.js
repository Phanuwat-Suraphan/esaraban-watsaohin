// ไฟล์แนบ: ชนิดไฟล์ที่รับได้ การตรวจลายเซ็นไฟล์ และการบันทึกลงที่เก็บจริง
//
// อยู่ที่นี่เพราะมีผู้ใช้สองฝั่ง: หน้าหนังสือ (แนบเข้าเอกสารโดยตรง) และคำขอเลขหนังสือส่ง (ครูแนบร่าง
// มาก่อน แล้วไฟล์ย้ายเข้าหนังสือเองตอนธุรการออกเลขให้) ถ้าแยกกันทำคนละชุด สิ่งที่จะเกิดคือรายการชนิด
// ไฟล์ที่รับได้ของสองที่ไม่ตรงกัน — ครูแนบรูปถ่ายมากับคำขอไม่ได้ทั้งที่หน้าหนังสือแนบได้ โดยไม่มีอะไรฟ้อง
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, uuid, nowIso, audit } from '../db.js';
import { httpError } from './validate.js';
import { visibleDocumentsSqlFilter } from './workflow.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile } from './googleDrive.js';
import { truncateFilename } from '../router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
/**
 * ชนิดไฟล์แนบที่รับได้ พร้อม "ลายเซ็นไฟล์" ที่ต้องตรงจริง ไม่ใช่เชื่อ MIME ที่เบราว์เซอร์แจ้งมา
 *
 * เดิมรับเฉพาะ PDF แต่หนังสือที่ส่งมาจากเขตพื้นที่/หน่วยงานอื่นมาเป็น .doc/.docx/.xls/.xlsx ด้วย
 * ธุรการจึงต้องแปลงเป็น PDF เองก่อนทุกครั้ง หรือไม่ก็แนบไม่ได้เลยแล้วเก็บไฟล์ไว้นอกระบบ
 * ซึ่งทำให้ทะเบียนหนังสือไม่ครบ — ซึ่งเป็นเหตุผลทั้งหมดที่ระบบนี้มีอยู่
 *
 * ตรวจลายเซ็นไฟล์เสมอ เพราะ MIME ที่ส่งมาเป็นค่าที่ฝั่งผู้ใช้กำหนดเองได้ทั้งหมด:
 *   - PDF       : "%PDF-"
 *   - docx/xlsx : เป็นไฟล์ ZIP ข้างใน จึงขึ้นต้นด้วย PK\x03\x04
 *   - doc/xls   : รูปแบบเก่า OLE2 Compound File ขึ้นต้นด้วย D0CF11E0A1B11AE1
 * docx กับ xlsx ใช้ลายเซ็นเดียวกัน (ZIP) แยกจากกันที่ระดับนี้ไม่ได้ และไม่จำเป็นต้องแยก —
 * สิ่งที่ต้องกันคือ "ไฟล์ที่ไม่ใช่เอกสารเลย" เช่นไฟล์รันได้ที่เปลี่ยนนามสกุลมา
 */
export const FILE_KINDS = [
  { mime: 'application/pdf', ext: 'pdf', label: 'PDF', sig: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', label: 'Word (.docx)', sig: isZip },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', label: 'Excel (.xlsx)', sig: isZip },
  { mime: 'application/msword', ext: 'doc', label: 'Word รุ่นเก่า (.doc)', sig: isOle2 },
  { mime: 'application/vnd.ms-excel', ext: 'xls', label: 'Excel รุ่นเก่า (.xls)', sig: isOle2 },
  // รูปภาพ — ครูถ่ายรูปหนังสือด้วยมือถือแล้วแนบเข้ามาตรงๆ เป็นเรื่องปกติที่สุดของโรงเรียน
  // (เร็วกว่าเดินไปสแกนมาก) เดิมต้องไปหาแอปแปลงเป็น PDF ก่อน ซึ่งบนมือถือทำไม่ได้ง่ายๆ
  // รับเฉพาะ JPG/PNG ที่เบราว์เซอร์แสดงได้จริง — ไม่รับ SVG เด็ดขาด เพราะ SVG รันสคริปต์ได้
  { mime: 'image/jpeg', ext: 'jpg', label: 'รูปภาพ (.jpg)', sig: (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff' },
  { mime: 'image/png', ext: 'png', label: 'รูปภาพ (.png)', sig: (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
];
function isZip(b) { return b.subarray(0, 4).toString('latin1') === 'PK\x03\x04'; }
function isOle2(b) { return b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'; }

/**
 * ไฟล์ที่เบราว์เซอร์เปิดดูเองได้ — เปิดในแท็บได้ และดูตัวอย่างในหน้าได้
 *
 * PDF กับรูปภาพเท่านั้น ส่วน Word/Excel ต้องบังคับดาวน์โหลดเพราะเบราว์เซอร์เปิดเองไม่ได้
 * (ถ้าปล่อยเป็น inline ผู้ใช้จะได้หน้าว่างๆ แทนที่จะได้ไฟล์ไปเปิดด้วยโปรแกรมของเครื่อง)
 */
export const VIEWABLE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const isImageMime = (m) => m === 'image/jpeg' || m === 'image/png';
export const ALLOWED_MIME = new Set(FILE_KINDS.map((k) => k.mime));
export const ACCEPT_ATTR = FILE_KINDS.map((k) => `.${k.ext}`).concat([...ALLOWED_MIME]).join(',');
export const ALLOWED_LABEL = FILE_KINDS.map((k) => k.label).join(' / ');

/**
 * ไฟล์ที่ "ประทับตราลงไปได้จริง" — มีแต่ PDF เท่านั้น
 *
 * ตราประทับทุกชนิดทำงานด้วยการซ้อนหน้า PDF (ดู services/pdfStamp.js) ไฟล์ Word/Excel จึงประทับไม่ได้
 * และนี่คือจุดที่พลาดง่ายที่สุดของการเปิดรับไฟล์ชนิดอื่น: ทุกที่ที่ประทับตราเดิมหยิบ "ไฟล์แรกของหนังสือ"
 * ถ้าธุรการบังเอิญแนบ .docx ขึ้นก่อน ตราลงรับ/ตราธุรการ/ตรา ผอ. จะไปลงไฟล์ที่ประทับไม่ได้แล้วล้มทั้งหมด
 * ทั้งที่หนังสือฉบับนั้นมี PDF แนบอยู่ด้วย — จึงต้องเลือก "ไฟล์ PDF ไฟล์แรก" เสมอ ไม่ใช่ไฟล์แรกเฉยๆ
 */
export const STAMPABLE_MIME = 'application/pdf';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// จำนวนไฟล์ที่เลือกแนบพร้อมกันได้ต่อหนึ่งครั้ง — ไม่ใช่เพดานของหนังสือหนึ่งฉบับ (แนบเพิ่มอีกกี่รอบก็ได้
// ที่หน้าเอกสาร) เดิมฟอร์มลงทะเบียนมีช่องแนบไฟล์ตายตัวแค่ 3 ช่อง ซึ่งไม่พอกับหนังสือที่มีสิ่งที่ส่งมาด้วย
// หลายฉบับ และช่องที่เพิ่มเข้ามาเรื่อยๆ ก็ทำให้ฟอร์มยาวขึ้นทุกช่องทั้งที่ส่วนใหญ่ไม่ได้ใช้
//
// ตั้งไว้ที่ 8 เพราะไฟล์ถูกส่งเป็น base64 ใน JSON ทีละคำขอ (ไฟล์ละไม่เกิน 10MB) — เลือกทีละมากกว่านี้
// แปลว่ารอนานหลายสิบวินาทีบนเน็ตโรงเรียน โดยที่ถ้าหลุดกลางคันต้องมาไล่ดูเองว่าไฟล์ไหนขึ้นไปแล้วบ้าง
export const MAX_ATTACH_FILES = 8;

// ลำดับไฟล์แนบ — ต้องใช้ตัวเดียวกันทุกที่ เพราะ "ไฟล์แรก" ไม่ใช่แค่ลำดับที่แสดง แต่เป็นไฟล์ที่ตรา
// ประทับรับและความเห็นของผู้อำนวยการจะไปลงจริง ถ้าหน้าเอกสารเรียงแบบหนึ่งแล้วตัวเลือกไฟล์ตอน
// ประทับตราเรียงอีกแบบ ตัวอย่างบนหน้าจอจะโชว์ว่าตราลงที่ไฟล์ A แต่ของจริงไปลงไฟล์ B โดยไม่มีอะไรฟ้อง
//
// เติม rowid เป็นตัวตัดสินรอง: created_at ละเอียดระดับมิลลิวินาที ซึ่งพอสำหรับการแนบทีละไฟล์ (วัดจาก
// การแนบ 8 ไฟล์รวดผ่านเบราว์เซอร์จริง ไม่มีคู่ไหน created_at ชนกันเลย) แต่ถ้าชนกันเมื่อไร SQLite จะ
// เลือกแถวไหนก็ได้ และ "ไฟล์หลัก" จะสลับตัวเองได้ระหว่างสองคำขอ — ตัวตัดสินรองทำให้ผลคงที่เสมอ
export const ATTACHMENT_ORDER = 'ORDER BY created_at, rowid';

export function fileKindOf(mimeType) {
  return FILE_KINDS.find((k) => k.mime === mimeType) || null;
}


export function fallbackFilename(mimeType) {
  const kind = fileKindOf(mimeType);
  return `document.${kind ? kind.ext : 'pdf'}`;
}


// ผู้ใช้เลือกไฟล์มาแล้ว แต่ไฟล์นั้นไม่มีข้อมูลเลย (0 ไบต์) — เกิดขึ้นจริงเวลาสแกนค้างกลางคัน ไฟล์เสีย
// หรือคัดลอกจากมือถือ/แฟลชไดรฟ์ไม่จบ เดิมเงื่อนไข `if (!fileDataBase64)` กลืนกรณีนี้รวมกับ "ไม่ได้แนบ
// ไฟล์มาเลย" ซึ่งเป็นคนละเรื่องกัน ผลคือผู้ใช้กด "แนบไฟล์เพิ่ม" แล้วได้หน้าเดิมกลับมาเหมือนสำเร็จ
// โดยไม่มีไฟล์แนบจริงและไม่มีข้อความอะไรบอกเลย (ทดสอบผ่านฟอร์มจริงยืนยันแล้ว) กว่าจะรู้ว่าหนังสือ
// ฉบับนั้นไม่มีไฟล์สแกนก็ตอนต้องหยิบมาใช้ ซึ่งอาจเป็นเดือนถัดไป
export const EMPTY_UPLOAD_MESSAGE = 'ไฟล์ที่แนบมาไม่มีข้อมูล (0 ไบต์) — อาจสแกนไม่สำเร็จหรือไฟล์เสียหาย กรุณาตรวจสอบไฟล์แล้วแนบใหม่อีกครั้ง';

// "เลือกไฟล์มาแล้วแต่ไฟล์ว่าง" ต่างจาก "ไม่ได้เลือกไฟล์" — หน้าเว็บส่ง fileName/fileType/fileDataBase64
// มาพร้อมกันทั้งชุดเฉพาะตอนที่ผู้ใช้เลือกไฟล์จริงเท่านั้น จึงใช้ตรงนี้แยกสองกรณีออกจากกันได้
export function isEmptyUpload(b) {
  const supplied = typeof b?.fileDataBase64 === 'string' || b?.fileName != null || b?.fileType != null;
  return supplied && !(typeof b?.fileDataBase64 === 'string' && b.fileDataBase64.trim());
}

export async function saveAttachment({ documentId, fileName, fileType, fileDataBase64, uploader }) {
  if (!fileDataBase64) return null;
  // ตัดชื่อไฟล์ตั้งแต่ตอนบันทึก ไม่ใช่ตอนส่งออกอย่างเดียว — ผู้ใช้จะได้เห็นชื่อเดียวกันทั้งในหน้าเว็บและ
  // ตอนดาวน์โหลด (ชื่อยาวเกินทำให้หัว HTTP ล้นจนดาวน์โหลดไม่ได้เลย ดู truncateFilename ใน router.js)
  fileName = truncateFilename(fileName);
  const kind = fileKindOf(fileType);
  if (!kind) throw httpError(400, `ชนิดไฟล์นี้แนบไม่ได้ — รับเฉพาะ ${ALLOWED_LABEL}`);
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
  // ตรวจลายเซ็นไฟล์จริง ไม่ใช่เชื่อ MIME ที่แจ้งมา — ค่านั้นฝั่งผู้ใช้กำหนดเองได้ทั้งหมด
  if (!kind.sig(buf)) {
    throw httpError(400, `ไฟล์นี้ไม่ใช่ ${kind.label} ที่ถูกต้อง (ตรวจลายเซ็นไฟล์ไม่ผ่าน) — ถ้าเปลี่ยนนามสกุลไฟล์เอง ให้บันทึกเป็นชนิดที่ถูกต้องก่อน`);
  }
  const hash = createHash('sha256').update(buf).digest('hex');
  // คำเตือน "ไฟล์นี้ซ้ำกับเอกสาร 0042/2569" ต้องบอกได้เฉพาะเลขของหนังสือที่ผู้อัปโหลดมีสิทธิ์เห็น —
  // เดิมค้นทั้งฐานข้อมูล ครูที่บังเอิญอัปโหลดไฟล์เดียวกับที่แนบอยู่กับหนังสือ "ลับมาก" จึงได้เลขที่หนังสือ
  // ฉบับนั้นมาฟรีๆ ทั้งที่เปิดอ่านไม่ได้ (ยืนยันแล้วว่าเกิดขึ้นจริง)
  const dupVisible = visibleDocumentsSqlFilter(uploader);
  const dup = db.prepare(`
    SELECT a.*, d.doc_number_display FROM attachments a JOIN documents d ON d.id = a.document_id
    WHERE a.hash_sha256 = :hash AND d.deleted_at IS NULL AND ${dupVisible.sql}
  `).get({ ...dupVisible.params, hash });
  const id = uuid();
  // เก็บนามสกุลจริงไว้ในชื่อไฟล์บนดิสก์ด้วย ไม่ใช่ตั้งเป็น .pdf หมดทุกไฟล์เหมือนเดิม — ถ้าตั้งผิด
  // ตอนเปิดจาก Google Drive หรือตอนกู้ไฟล์จากดิสก์ตรงๆ จะเปิดไม่ถูกโปรแกรม
  const safeName = `${id}.${kind.ext}`;

  let storageProvider = 'local';
  let filepath = null;
  let driveFileId = null;

  if (isGoogleDriveEnabled()) {
    const doc = db.prepare(`
      SELECT d.year_be, dt.name as type_name FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id WHERE d.id = ?
    `).get(documentId);
    const folderId = await ensureCategoryFolder({ yearBe: doc.year_be, typeName: doc.type_name });
    driveFileId = await uploadFile({ buffer: buf, filename: `${safeName}__${fileName || `document.${kind.ext}`}`, mimeType: fileType, folderId });
    storageProvider = 'google_drive';
  } else {
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
    filepath = safeName;
  }

  db.prepare(`
    INSERT INTO attachments (id, document_id, filename, storage_provider, filepath, drive_file_id, filesize, mime_type, hash_sha256, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentId, fileName || `document.${kind.ext}`, storageProvider, filepath, driveFileId, buf.length, fileType, hash, uploader.id, nowIso());
  audit({ userId: uploader.id, action: 'attachment_uploaded', tableName: 'attachments', recordId: id, detail: { documentId, hash, storageProvider, duplicateOf: dup ? dup.doc_number_display : null } });
  return { id, duplicateWarning: dup ? `พบไฟล์นี้ซ้ำกับเอกสาร ${dup.doc_number_display} (Hash ตรงกัน)` : null };
}

/**
 * ตัวช่วยฝั่งเบราว์เซอร์: เดาชนิดไฟล์จากนามสกุลเมื่อเบราว์เซอร์ไม่ได้บอกมา
 *
 * เบราว์เซอร์บนมือถือหลายรุ่น (และแอปที่แชร์ไฟล์เข้ามา เช่น LINE) ส่ง File.type มาเป็นค่าว่างหรือ
 * application/octet-stream ให้กับไฟล์ Word/Excel ถ้าส่งค่านั้นขึ้นไปตรงๆ เซิร์ฟเวอร์จะปฏิเสธทั้งที่
 * ไฟล์ถูกต้อง — และปฏิเสธหลังจากที่ผู้ใช้กรอกฟอร์มจนเสร็จแล้ว ซึ่งเสียเวลาเปล่าทั้งรอบ
 *
 * สร้างตารางจาก FILE_KINDS ตัวเดียวกับที่เซิร์ฟเวอร์ใช้ตรวจ จะได้ไม่มีตารางชนิดไฟล์สองชุดที่หลุดจากกันได้
 * และการเดาผิดไม่ทำให้ไฟล์แปลกปลอมหลุดเข้าไป เพราะเซิร์ฟเวอร์ตรวจลายเซ็นไฟล์จริงซ้ำอยู่ดี
 */
export function attachMimeScript() {
  const extToMime = {};
  for (const k of FILE_KINDS) extToMime[k.ext] = k.mime;
  return `<script>
    (function(){
      var EXT_MIME = ${JSON.stringify(extToMime)};
      var KNOWN = Object.keys(EXT_MIME).map(function (e) { return EXT_MIME[e]; });
      window.attachMime = function (name, type) {
        if (type && KNOWN.indexOf(type) !== -1) return type;
        var m = /\\.([A-Za-z0-9]+)$/.exec(String(name || ''));
        var ext = m ? m[1].toLowerCase() : '';
        return EXT_MIME[ext] || type || 'application/octet-stream';
      };
    })();
  </script>`;
}
