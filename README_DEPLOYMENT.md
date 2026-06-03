# PUSTAKABOT - DEPLOYMENT GUIDE

## Quick Start (5 Menit)

```bash
# 1. Login ke server
ssh chatbot@10.1.1.129

# 2. Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# 3. Install dependencies
bash install_ubuntu.sh

# 4. Clone project
cd ~
git clone https://github.com/hibasaputra25/library-chatbot.git
cd library-chatbot

# 5. Install node modules
npm install

# 6. Setup environment
cp .env.example .env
nano .env

# 7. Start
pm2 start ecosystem.config.js
pm2 logs
```

## File Penting

| File | Fungsi |
|------|--------|
| `DEPLOYMENT_UBUNTU.md` | Panduan lengkap + troubleshooting |
| `ecosystem.config.js` | Konfigurasi PM2 |
| `install_ubuntu.sh` | Script install dependencies |
| `.env.example` | Template environment variables |
| `nginx.conf` | Konfigurasi Nginx (optional) |

## Error yang Sering Terjadi

| Error | Solusi |
|-------|--------|
| `sh install_ubuntu.sh` error | Gunakan `bash install_ubuntu.sh` |
| `pm2 not found` | Load NVM dulu |
| `Could not find Chrome` | Set `PUPPETEER_EXECUTABLE_PATH` di `.env` |
| `MODULE_NOT_FOUND` | Jalankan `npm install` |
| `dotenv not found` | `wa_gateway.js` sudah include dotenv (v terbaru) |

## Dokumentasi Lengkap

Baca `DEPLOYMENT_UBUNTU.md` untuk panduan step-by-step lengkap.
