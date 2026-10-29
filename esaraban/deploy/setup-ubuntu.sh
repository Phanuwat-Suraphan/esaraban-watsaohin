#!/usr/bin/env bash
#
# ติดตั้งระบบสารบรรณบนเซิร์ฟเวอร์ Ubuntu/Debian ใหม่ ด้วยคำสั่งเดียว
#
# ทำไมต้องมีสคริปต์นี้ ทั้งที่ DEPLOY.md เขียนทุกขั้นไว้แล้ว: ขั้นตอนในคู่มือมี 7 ตอน ต้องคัดลอกไปวาง
# ทีละก้อน และมีสองจุดที่พลาดแล้ว "ระบบดูเหมือนทำงานปกติ" จนกว่าจะมีคนมาเจอทีหลัง
#
#   1. ลืมลงฟอนต์ไทย — ตราประทับบนหนังสือราชการจะออกมาเป็นสี่เหลี่ยมว่างทั้งแผ่น ไม่มี error ใดๆ
#      (คู่มือเดิมไม่ได้บอกให้ลงเลย ทั้งที่ฝั่ง Docker ลงไว้ — เป็นบั๊กของคู่มือที่เพิ่งเจอ)
#   2. ชื่อไบนารี chromium ไม่ตรงกับที่แอปเรียก — ปุ่มประทับตราจะขึ้น error 501 เฉพาะตอนกดใช้จริง
#      Ubuntu รุ่นใหม่ติดตั้ง chromium เป็น snap ซึ่งไบนารีอยู่คนละที่กับที่แอปมองหา
#
# สคริปต์นี้จึงลงให้ครบ แล้ว "ตรวจผลจริง" ทั้งสองข้อตอนจบ ไม่ใช่แค่ลงแล้วจบ
#
# วิธีใช้ (บนเซิร์ฟเวอร์ใหม่):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/esaraban/deploy/setup-ubuntu.sh -o setup.sh
#   sudo bash setup.sh
#
# หรือถ้าโคลน repo มาแล้ว:  sudo bash esaraban/deploy/setup-ubuntu.sh
#
# ส่วนที่สคริปต์นี้ "ไม่ทำ" ให้ เพราะต้องใช้ชื่อโดเมนของโรงเรียน: Nginx + ใบรับรอง HTTPS
# ทำต่อเองตามขั้นที่ 5 ของ DEPLOY.md หลังสคริปต์นี้จบ
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Phanuwat-Suraphan/esaraban-watsaohin.git}"
BRANCH="${BRANCH:-claude/school-e-saraban-srs-0uzy7x}"
APP_DIR="${APP_DIR:-/opt/esaraban}"
APP_USER="${APP_USER:-esaraban}"
PORT="${PORT:-3000}"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '   \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "ต้องรันด้วย sudo — ลองใหม่: sudo bash $0"
command -v apt-get >/dev/null || die "สคริปต์นี้ใช้ได้กับ Ubuntu/Debian เท่านั้น (ไม่พบ apt-get)"

say "1/7 ติดตั้งโปรแกรมที่ระบบต้องใช้"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# fonts-thai-tlwg + fontconfig: ตัวอักษรไทยบนตราประทับที่ถูกพิมพ์ลงไฟล์ PDF จริง
#   ถ้าขาด → ตราออกมาเป็นสี่เหลี่ยมว่าง โดยไม่มีข้อความผิดพลาดใดๆ บอก
# poppler-utils: ภาพตัวอย่างหน้าแรกของไฟล์แนบ (ใช้ลากวางตำแหน่งตรา)
# qpdf: วางแผ่นตราทับหน้าแรกของ PDF เดิมโดยไม่แตะหน้าอื่น
# sqlite3: ไว้เปิดดู/สำรองฐานข้อมูลด้วยมือเวลาต้องตรวจสอบ
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git ufw \
  poppler-utils qpdf sqlite3 \
  fonts-thai-tlwg fontconfig
ok "ลงโปรแกรมพื้นฐานแล้ว"

say "2/7 เตรียมหน่วยความจำสำรอง (swap) ให้เครื่องที่ RAM น้อย"
# ที่มาของขั้นนี้: เครื่องฟรีของผู้ให้บริการบางรายมี RAM แค่ 1 GB (เช่น Google Cloud e2-micro)
# ซึ่งพอใช้งานปกติ แต่ตอนประทับตราลง PDF ต้องเปิด Chromium ซึ่งกินหน่วยความจำเพิ่มเป็นก้อน
#
# วัดจากของจริงใต้เพดานหน่วยความจำ 1 GB (cgroup) ด้วยไฟล์และโปรแกรมชุดเดียวกับที่ใช้งานจริง:
#   ประทับตรา 1 รายการพร้อมกัน  ใช้สูงสุด 309 MB  ผ่าน
#   ประทับตรา 3 รายการพร้อมกัน  ใช้สูงสุด 870 MB  ผ่าน แต่เหลือที่ว่างแค่ 154 MB
# ตัวเลข 870 MB นั้น "ยังไม่รวม" ตัวระบบปฏิบัติการกับตัวแอปที่ค้างอยู่ในหน่วยความจำอีกราว 300 MB
# แปลว่าบนเครื่อง 1 GB จริง ถ้าครูสามคนกดประทับตราพร้อมกัน เคอร์เนลจะฆ่าโปรเซสทิ้ง (OOM)
# ซึ่งอาการที่ครูเห็นคือหน้าเว็บค้างหรือระบบหลุดไปเฉยๆ โดยไม่มีข้อความบอกสาเหตุ
#
# swap ทำให้กรณีนั้นกลายเป็น "ช้าลง" แทนที่จะเป็น "ระบบล่ม" — ช้ากว่าแต่ยังได้งาน
RAM_MB="$(free -m | awk '/^Mem:/{print $2}')"
SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
ok "RAM ที่เครื่องนี้มี: ${RAM_MB} MB · swap เดิม: ${SWAP_MB} MB"
if [ "$RAM_MB" -ge 2048 ]; then
  ok "RAM ตั้งแต่ 2 GB ขึ้นไป ไม่ต้องเพิ่ม swap"
elif [ "$SWAP_MB" -ge 1024 ]; then
  ok "มี swap พออยู่แล้ว ไม่ต้องเพิ่ม"
elif [ -f /swapfile ]; then
  warn "มี /swapfile อยู่แล้วแต่ยังไม่ได้เปิดใช้ — ข้ามไป ตรวจเองด้วย: swapon --show"
else
  # 2 GB พอรับกรณีประทับตราพร้อมกันหลายรายบนเครื่อง 1 GB โดยไม่กินดิสก์มาก
  if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; then
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    # ต้องใส่ /etc/fstab ด้วย ไม่งั้น swap หายทุกครั้งที่เครื่องรีสตาร์ท แล้วปัญหากลับมาเงียบๆ
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # เครื่อง RAM น้อยควรยอมใช้ swap เร็วขึ้นกว่าค่าเริ่มต้น (60) แต่ไม่ถึงกับใช้ตลอดเวลา
    sysctl -q -w vm.swappiness=20
    grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=20' >> /etc/sysctl.conf
    ok "เพิ่ม swap 2 GB แล้ว และตั้งให้กลับมาเองหลังรีสตาร์ท"
  else
    warn "สร้างไฟล์ swap ไม่สำเร็จ (ดิสก์อาจไม่พอ) — ระบบยังใช้ได้ แต่ถ้าประทับตราพร้อมกันหลายคนอาจล่ม"
  fi
fi

say "3/7 ติดตั้ง Chromium (ใช้พิมพ์ตราประทับลงไฟล์ PDF)"
# Ubuntu รุ่นใหม่ให้ chromium เป็น snap ส่วน Debian ให้เป็น .deb ธรรมดา — ลองตามลำดับแล้วค่อยหาไบนารีจริง
if ! apt-get install -y -qq --no-install-recommends chromium 2>/dev/null; then
  apt-get install -y -qq --no-install-recommends chromium-browser 2>/dev/null \
    || warn "ลง chromium ผ่าน apt ไม่สำเร็จ — เดี๋ยวขั้นตรวจสอบจะบอกว่าต้องทำอะไรต่อ"
fi

CHROME_BIN=""
for c in chromium chromium-browser /snap/bin/chromium /usr/lib/chromium/chromium google-chrome; do
  if command -v "$c" >/dev/null 2>&1; then CHROME_BIN="$c"; break; fi
done
if [ -n "$CHROME_BIN" ]; then ok "พบ Chromium ที่: $CHROME_BIN"; else warn "ยังไม่พบ Chromium"; fi

say "4/7 ติดตั้ง Node.js 22"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
ok "Node $(node -v)"

say "5/7 สร้างผู้ใช้และวางตัวแอป"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR.tmp"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR.tmp"
  mkdir -p "$APP_DIR"
  cp -a "$APP_DIR.tmp/." "$APP_DIR/"
  rm -rf "$APP_DIR.tmp"
fi
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/esaraban/data" "$APP_DIR/esaraban/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ok "ตัวแอปอยู่ที่ $APP_DIR (สาขา $BRANCH)"

say "6/7 ตั้งค่าและเปิดเป็นบริการ (systemd)"
ENV_FILE="/etc/esaraban.env"
if [ ! -f "$ENV_FILE" ]; then
  # SESSION_SECRET ต้องสุ่มของตัวเองเสมอ และต้องไม่เปลี่ยนทีหลัง ไม่งั้นทุกคนหลุดออกจากระบบ
  {
    echo "NODE_ENV=production"
    echo "PORT=$PORT"
    echo "SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
    echo "DB_PATH=$APP_DIR/esaraban/data/esaraban.db"
    [ -n "$CHROME_BIN" ] && echo "CHROME_BIN=$CHROME_BIN"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "สร้าง $ENV_FILE พร้อมรหัสลับที่สุ่มใหม่"
else
  warn "$ENV_FILE มีอยู่แล้ว — ไม่แตะของเดิม (รหัสลับเดิมต้องคงไว้ ไม่งั้นทุกคนหลุดออกจากระบบ)"
fi

cat > /etc/systemd/system/esaraban.service <<UNIT
[Unit]
Description=ระบบสารบรรณอิเล็กทรอนิกส์
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/esaraban
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --no-warnings server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now esaraban >/dev/null
sleep 2
systemctl is-active --quiet esaraban && ok "บริการทำงานอยู่" || die "บริการไม่ขึ้น — ดูสาเหตุด้วย: journalctl -u esaraban -n 50"

say "7/7 ตรวจผลจริง (ไม่ใช่แค่ลงแล้วจบ)"
FAIL=0

# ก) ตัวระบบตอบกลับไหม
if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  ok "ตัวระบบตอบที่พอร์ต $PORT"
else
  warn "ยังเรียก /health ไม่ได้ — ดู: journalctl -u esaraban -n 50"; FAIL=1
fi

# ข) ฟอนต์ไทย — จุดที่พลาดแล้วตราประทับกลายเป็นสี่เหลี่ยมว่างโดยไม่มีอะไรเตือน
THAI_FONT="$(fc-match -f '%{file}' ':lang=th' 2>/dev/null || true)"
if [ -n "$THAI_FONT" ] && [ -f "$THAI_FONT" ]; then
  ok "ฟอนต์ไทยที่จะถูกใช้พิมพ์ลงตรา: $THAI_FONT"
else
  warn "ไม่พบฟอนต์ไทย — ตราประทับจะออกมาเป็นสี่เหลี่ยมว่าง แก้ด้วย: sudo apt-get install -y fonts-thai-tlwg"; FAIL=1
fi

# ค) โปรแกรมที่ฟีเจอร์ประทับตราต้องใช้
for prog in qpdf pdftoppm; do
  command -v "$prog" >/dev/null && ok "พบ $prog" || { warn "ไม่พบ $prog"; FAIL=1; }
done
if [ -n "$CHROME_BIN" ]; then
  ok "Chromium: $("$CHROME_BIN" --version 2>/dev/null | head -1 || echo "$CHROME_BIN")"
else
  warn "ไม่พบ Chromium — ปุ่ม 'ประทับตราลงไฟล์ PDF จริง' จะขึ้นข้อผิดพลาดตอนกดใช้"
  warn "ลองลงเอง แล้วใส่ CHROME_BIN=<ที่อยู่ไบนารี> ลงใน $ENV_FILE แล้ว: sudo systemctl restart esaraban"
  FAIL=1
fi

# ง) หน่วยความจำรวม (RAM + swap) ต้องพอรับการประทับตราพร้อมกันหลายราย
# เกณฑ์ 1.5 GB มาจากที่วัดจริง: 3 รายพร้อมกันใช้ 870 MB บวกระบบปฏิบัติการกับตัวแอปอีกราว 300 MB
TOTAL_MB=$(( $(free -m | awk '/^Mem:/{print $2}') + $(free -m | awk '/^Swap:/{print $2}') ))
if [ "$TOTAL_MB" -ge 1536 ]; then
  ok "หน่วยความจำรวม (RAM+swap): ${TOTAL_MB} MB — พอรับการประทับตราพร้อมกันหลายราย"
else
  warn "หน่วยความจำรวมแค่ ${TOTAL_MB} MB — ถ้าครูหลายคนกดประทับตราพร้อมกัน ระบบอาจถูกเคอร์เนลฆ่าทิ้ง"
  warn "แก้โดยเพิ่ม swap: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
  FAIL=1
fi

say "เสร็จแล้ว"
if [ "$FAIL" -eq 0 ]; then
  ok "ตรวจผ่านทุกข้อ"
else
  warn "มีข้อที่ยังไม่ผ่านข้างบน — แก้ให้ครบก่อนเอาไปใช้กับหนังสือจริง"
fi
cat <<NEXT

ขั้นต่อไป (ยังต้องทำเองเพราะต้องใช้ชื่อโดเมนของโรงเรียน):

  1. เปิดพอร์ต 80/443 — Oracle Cloud ต้องเปิด "สองชั้น" ดู deploy/ORACLE_CLOUD.md ข้อ 3
     ส่วน Google Cloud ติ๊กสองช่องตอนสร้างเครื่อง ดู deploy/GOOGLE_CLOUD.md ข้อ 2
  2. Nginx + ใบรับรอง HTTPS — ดู DEPLOY.md ข้อ 5
  3. ตั้ง PUBLIC_BASE_URL=https://<โดเมนของโรงเรียน> ใน $ENV_FILE แล้ว systemctl restart esaraban
  4. ถ้าย้ายมาจากที่เดิม — คัดลอกฐานข้อมูลกับไฟล์แนบเข้ามา ดู deploy/ORACLE_CLOUD.md หัวข้อ "ย้ายมาจาก Render"
  5. ตั้งสำรองข้อมูลรายวัน — ดู DEPLOY.md ข้อ 6

คำสั่งที่ใช้บ่อย:
  systemctl status esaraban        ดูว่าทำงานอยู่ไหม
  journalctl -u esaraban -f        ดูบันทึกสดๆ
  systemctl restart esaraban       เริ่มใหม่หลังแก้ $ENV_FILE
NEXT
