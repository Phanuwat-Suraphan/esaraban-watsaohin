# อยู่ที่ root ของ repo (ไม่ใช่ใน esaraban/) โดยตั้งใจ — Render (และ Docker host อื่นๆ) มองหา
# ./Dockerfile ที่ root ของ repo เป็นค่าเริ่มต้นเสมอ ถ้าวางไว้ใน esaraban/Dockerfile ต้องไปตั้งค่า
# "Dockerfile Path"/"Docker Build Context Directory" เพิ่มเอง ซึ่งทำให้สับสน/พลาดง่ายเวลาสร้าง
# service ผ่านหน้าเว็บ Render เอง — อยู่ที่ root แล้วไม่ต้องตั้งค่าอะไรเพิ่มเลย ใช้ค่าเริ่มต้นได้ทันที
#
# ใช้เมื่อต้องการให้ฟีเจอร์ประทับตรา/ลงนามลงไฟล์ PDF จริง และภาพตัวอย่างไฟล์แนบ
# ทำงานได้บน Render (หรือ container host อื่นๆ) — runtime แบบ Node ธรรมดาของ Render ไม่อนุญาตให้
# apt install โปรแกรมระบบ (poppler-utils/chromium/qpdf) จึงต้องสร้าง image เองแบบนี้แทน
# ดูขั้นตอนเชื่อมกับ Render ใน esaraban/deploy/RENDER.md
#
# แอปนี้ไม่มี npm dependency เลย (ดู esaraban/package.json) จึงไม่ต้อง COPY package-lock.json /
# npm ci — คัดลอกซอร์สแล้วรันได้ทันที
FROM node:22-slim

# ล้างของที่ไม่ได้ใช้ตอนรันออกจาก image ในคำสั่ง RUN เดียวกัน — ต้องอยู่บรรทัดเดียวกันเท่านั้น
# เพราะ Docker เก็บผลของแต่ละ RUN เป็นชั้นๆ ถ้าแยกไปลบในบรรทัดถัดไป ของเดิมยังอยู่ในชั้นก่อนหน้า
# และ image ไม่เล็กลงเลยสักไบต์
#
# ทำไมถึงสำคัญ: image นี้ใหญ่เพราะต้องมี Chromium (ไว้ประทับตราลง PDF จริง) และทุกครั้งที่ push
# ขึ้น GitHub โฮสต์จะ build แล้วเก็บ image ชุดใหม่ไว้ — ของเก่าสะสมจนเต็มโควตาพื้นที่ได้
#
# ⚠️ ห้ามลบ /usr/share/fonts เด็ดขาด — ฟอนต์ไทยอยู่ตรงนั้น ถ้าหายไปตราประทับบนหนังสือราชการ
# จะกลายเป็นสี่เหลี่ยมว่างทั้งหมด ส่วน /usr/share/locale เป็นคำแปลข้อความของโปรแกรมบรรทัดคำสั่ง
# คนละอย่างกัน ลบได้ ไม่กระทบตัวอักษรไทยที่พิมพ์ลงไฟล์
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    chromium \
    qpdf \
    fonts-thai-tlwg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
             /var/cache/apt/archives/* \
             /usr/share/doc \
             /usr/share/man \
             /usr/share/info \
             /usr/share/lintian \
             /usr/share/locale

WORKDIR /app
COPY esaraban/ .

EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
