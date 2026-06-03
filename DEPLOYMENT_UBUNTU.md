# DEPLOYMENT PUSTAKABOT KE SERVER UBUNTU (TESTED)

## INFORMASI SERVER
```
IP:         10.1.1.129
Username:   chatbot
Password:   Perpus@26!
Database:   10.1.3.244 (remote MySQL)
```

## RINGKASAN ERROR YANG SUDAH DIPERBAIKI

| Error | Penyebab | Solusi |
|-------|----------|--------|
| `[: Illegal number` | Pakai `sh` bukan `bash` | Jalankan `bash install_ubuntu.sh` |
| `[[: not found` | Shell `dash` tidak support bash syntax | Gunakan `bash` |
| `MODULE_NOT_FOUND` | `npm install` belum jalan | Jalankan `npm install` |
| `Could not find Chrome` | Puppeteer download corrupt | Set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser` |
| `dotenv not found` | `wa_gateway.js` tidak load `.env` | Tambah `require('dotenv').config()` di baris 1 |
| `connect ETIMEDOUT` | MySQL belum running atau remote | Setup MySQL atau koneksi ke DB remote |
| `pm2 not found` | NVM belum loaded | Load NVM dulu: `. ~/.nvm/nvm.sh` |

---

## STEP-BY-STEP DEPLOYMENT (COPY-PASTE READY)

### Step 0: Login ke Server

```bash
ssh chatbot@10.1.1.129
# Password: Perpus@26!
```

### Step 1: Load NVM (WAJIB setiap buka terminal baru)

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

### Step 2: Install Dependencies

```bash
bash install_ubuntu.sh
```

**JANGAN:** `sh install_ubuntu.sh` (akan error!)

### Step 3: Clone Repository

```bash
cd ~
git clone https://github.com/hibasaputra25/library-chatbot.git
cd library-chatbot
```

### Step 4: Install Node Modules

```bash
npm install
```

Tunggu sampai selesai (bisa 1-2 menit).

### Step 5: Setup Environment

```bash
cp .env.example .env
nano .env
```

**Isi file .env:**

```env
GEMINI_API_KEY=your_key_here
GROQ_API_KEY=your_key_here
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_NUMBER=

DB_HOST=10.1.3.244
DB_USER=biroperpustakaan
DB_PASSWORD=Perpustakaan@2025!.
DB_NAME=lib1

ADMIN_USER=perpus_umb
ADMIN_PASS=perpus2026
ADMIN_WA_NUMBER=6285158398447@c.us

WA_GATEWAY_URL=http://localhost:3002/send-direct
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
NODE_ENV=production
```

**Save:** `Ctrl+O` → `Enter` → `Ctrl+X`

### Step 6: Start dengan PM2

```bash
pm2 start ecosystem.config.js
pm2 status
```

Harus muncul 2 service **online**:
- `chatbot-core` (port 3001)
- `chatbot-gateway` (port 3002)

### Step 7: Scan QR Code WhatsApp

**Cara 1: Jalankan langsung (recommended untuk pertama kali)**

```bash
node wa_gateway.js
```

QR code akan muncul penuh di terminal.
Scan dengan WhatsApp: Menu → Linked Devices → Link a Device.

Setelah scan berhasil, tekan `Ctrl+C` lalu jalankan PM2:

```bash
pm2 start ecosystem.config.js
```

**Cara 2: Lihat di PM2 logs (QR mungkin terpotong)**

```bash
pm2 logs chatbot-gateway --raw
```

### Step 8: Test Admin Panel

Buka browser di komputer yang sama:
```
http://localhost:3001/admin
```

Username: `perpus_umb`
Password: `perpus2026`

### Step 9: Save PM2 Configuration

```bash
pm2 save
```

### Step 10: Setup PM2 Auto-Start (opsional)

```bash
pm2 startup
# Jalankan perintah sudo yang muncul
```

---

## PENTING: LOAD NVM SETIAP LOGIN

Tambahkan ke `~/.bashrc` agar otomatis:

```bash
echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> ~/.bashrc
source ~/.bashrc
```

Setelah itu, buka terminal baru dan NVM akan otomatis loaded.

---

## TROUBLESHOOTING

### PM2 process crash/restart terus

```bash
pm2 logs chatbot-core --err --lines 50
pm2 logs chatbot-gateway --err --lines 50
```

### Chrome tidak ditemukan

```bash
# Cek chromium terinstall
which chromium-browser

# Jika tidak ada, install
sudo apt install chromium-browser -y

# Cek .env ada PUPPETEER_EXECUTABLE_PATH
grep PUPPETEER .env
# Harus output: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### Database timeout

```bash
# Test koneksi ke MySQL remote
mysql -h 10.1.3.244 -u biroperpustakaan -p lib1 -e "SELECT 1;"
# Password: Perpustakaan@2025!.
```

### QR Code tidak muncul

```bash
# Hapus session lama
rm -rf .wwebjs_auth/

# Jalankan ulang
node wa_gateway.js
```

### Port sudah digunakan

```bash
# Cek siapa yang pakai port
sudo lsof -i :3001
sudo lsof -i :3002

# Kill process
sudo kill -9 <PID>
```

### PM2 tidak ditemukan

```bash
# Load NVM dulu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Cek PM2
pm2 --version
```

---

## PERINTAH PM2 YANG SERING DIPAKAI

```bash
pm2 status                    # Lihat status semua service
pm2 logs                      # Lihat semua logs
pm2 logs chatbot-core         # Lihat logs core saja
pm2 logs chatbot-gateway      # Lihat logs gateway saja
pm2 restart all               # Restart semua service
pm2 stop all                  # Stop semua service
pm2 delete all                # Hapus semua dari PM2
pm2 save                      # Simpan konfigurasi PM2
pm2 monit                     # Monitor real-time
```

---

## STRUKTUR FILE

```
~/library-chatbot/
├── .env                  # Environment variables (EDIT INI)
├── .env.example          # Template
├── core_server.js        # Chatbot core service (port 3001)
├── wa_gateway.js         # WhatsApp gateway (port 3002)
├── db_config.js          # Database MySQL config
├── db_service.js         # Database service
├── analytics_db.js       # SQLite analytics
├── responses.json        # Chatbot responses
├── ecosystem.config.js   # PM2 config
├── install_ubuntu.sh     # Installation script
├── nginx.conf            # Nginx config (optional)
├── levenshtein.js        # Typo tolerance
├── package.json          # Node.js dependencies
└── node_modules/         # Dependencies (after npm install)
```

---

**Last updated:** 03 Juni 2026
**Tested on:** Ubuntu 22.04 LTS (VMware)
**Status:** PRODUCTION READY
