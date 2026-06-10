# ✅ DEPLOYMENT CHECKLIST - PUSTAKABOT

## 📦 File-File yang Sudah Disiapkan

### 1. Dokumentasi
- ✅ `DEPLOYMENT_UBUNTU.md` - Panduan deployment lengkap 40+ halaman
- ✅ `TESTING_MANUAL_WHATSAPP.md` - Panduan testing manual
- ✅ `DEPLOYMENT_CHECKLIST.md` - Checklist ini

### 2. Script Instalasi
- ✅ `install_ubuntu.sh` - Script otomatis instalasi dependencies Ubuntu

### 3. Konfigurasi
- ✅ `ecosystem.config.js` - PM2 process manager configuration
- ✅ `nginx.conf` - Nginx reverse proxy configuration
- ✅ `.gitignore` - Git ignore file
- ✅ `.env.example` - Template environment variables

---

## 🎯 QUICK START DEPLOYMENT

### Persiapan di Komputer Windows (Sebelum Upload ke Server)

```bash
# 1. Review dan update .env untuk production
# Buka .env dan update:
# - DB_HOST=localhost (bukan IP Windows)
# - ADMIN_PASS dengan password yang kuat
# - NODE_ENV=production

# 2. Test lokal terakhir kali
node core_server.js
node wa_gateway.js

# 3. Commit ke Git (jika pakai Git)
git add .
git commit -m "Ready for production deployment"
git push origin main
```

### Deployment ke Server Ubuntu

#### Step 1: Upload Files ke Server

**Option A: Via SCP (dari Windows)**
```powershell
# Upload semua file
scp -r C:\chatbot\server_chatbot ubuntu@your-server-ip:~/apps/

# Atau zip dulu untuk lebih cepat
Compress-Archive -Path C:\chatbot\server_chatbot\* -DestinationPath chatbot.zip
scp chatbot.zip ubuntu@your-server-ip:~/
```

**Option B: Via Git (Recommended)**
```bash
# Di server Ubuntu
ssh ubuntu@your-server-ip
mkdir -p ~/apps
cd ~/apps
git clone https://github.com/your-username/server_chatbot.git
cd server_chatbot
```

#### Step 2: Install Dependencies

```bash
# Login ke server
ssh ubuntu@your-server-ip

# Jalankan script instalasi
cd ~/apps/server_chatbot
chmod +x install_ubuntu.sh
./install_ubuntu.sh

# Script akan install:
# - Node.js via NVM
# - MySQL Server
# - Chromium & dependencies
# - PM2
# - Nginx
# - Certbot (optional)
# - Fail2Ban (optional)
```

#### Step 3: Setup Database

**MySQL** — digunakan untuk data buku, anggota, sirkulasi (remote ke server kampus, tidak perlu install).
Pastikan `.env` sudah berisi `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` yang mengarah ke server MySQL kampus.

**PostgreSQL** — digunakan untuk analytics, sessions, admin users.

**Opsi A: PostgreSQL di server yang sama (jalankan otomatis via install_ubuntu.sh)**
```bash
# install_ubuntu.sh akan menanyakan apakah ingin install PostgreSQL lokal
# Jawab 'y' dan ikuti prompt untuk buat database dan user
```

**Opsi B: PostgreSQL di server IT kampus (remote)**
```bash
# Minta IT kampus untuk:
# 1. Buat database: chatbot_analytics
# 2. Buat user dan beri akses ke database tersebut
# 3. Buka koneksi dari IP server chatbot (10.1.1.129)
# Lalu isi .env dengan credentials yang diberikan IT
```

**Verifikasi koneksi PostgreSQL:**
```bash
psql -h <PG_HOST> -U <PG_USER> -d <PG_DATABASE> -c "SELECT NOW();"
# Jika berhasil, tabel akan dibuat otomatis saat aplikasi pertama kali dijalankan
```

#### Step 4: Configure Application

```bash
cd ~/apps/server_chatbot

# Install Node modules
npm install --production

# Setup environment
cp .env.example .env
nano .env
```

Variabel wajib diisi di `.env`:

```env
# MySQL kampus (data buku/anggota)
DB_HOST=<ip_mysql_kampus>
DB_USER=<user_mysql>
DB_PASSWORD=<password_mysql>
DB_NAME=<nama_database>

# PostgreSQL analytics (lokal atau server IT)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=chatbot_analytics
PG_USER=<pg_user>
PG_PASSWORD=<pg_password>

# Admin panel
ADMIN_USER=<username_admin>
ADMIN_PASS=<password_kuat_min_8_karakter>
ADMIN_NAMA=<nama_pustakawan_pertama>
ADMIN_WA_NUMBER=<nomor_wa_admin_format_628xxx>

# Session (generate dengan: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_SECRET=<string_acak_panjang>

# AI
GROQ_API_KEY=<groq_api_key>
GEMINI_API_KEY=<gemini_api_key>

# WhatsApp Gateway
WA_GATEWAY_URL=http://127.0.0.1:3002/send-direct
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
NODE_ENV=production
```

```bash
# Set permissions
chmod 600 .env
mkdir -p logs
chmod 700 logs
```

#### Step 5: Start with PM2

```bash
# Start aplikasi
pm2 start ecosystem.config.js

# Verify
pm2 status
pm2 logs

# Save configuration
pm2 save

# Test
curl http://localhost:3001/api/status
```

#### Step 6: Configure Nginx

```bash
# Copy nginx config
sudo cp nginx.conf /etc/nginx/sites-available/chatbot

# Edit domain name
sudo nano /etc/nginx/sites-available/chatbot
# Update: server_name your-domain.com www.your-domain.com;

# Enable site
sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# Test
curl http://your-server-ip/health
```

#### Step 7: Setup SSL (Jika pakai domain)

```bash
# Pastikan domain sudah pointing ke server IP
# Cek: nslookup your-domain.com

# Obtain SSL certificate
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# Test auto-renewal
sudo certbot renew --dry-run

# Verify
curl https://your-domain.com/health
```

#### Step 8: Configure Firewall

```bash
# Allow SSH (PENTING!)
sudo ufw allow 22/tcp

# Allow HTTP & HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Block Node.js ports
sudo ufw deny 3001/tcp
sudo ufw deny 3002/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

#### Step 9: Scan WhatsApp QR Code

```bash
# Opsi A: Scan via Admin Panel (Recommended)
# Buka browser: http://10.1.1.129/admin
# Login dengan ADMIN_USER / ADMIN_PASS
# Klik menu "Koneksi WhatsApp" di sidebar
# Klik tombol "Hubungkan / Reconnect"
# Scan QR yang muncul dengan WhatsApp di HP:
# WhatsApp > Menu > Linked Devices > Link a Device

# Opsi B: Scan via terminal logs
pm2 logs chatbot-gateway
# QR code akan muncul sebagai ASCII art di terminal
```

> **Tip:** Jika QR tidak muncul, klik tombol "Hubungkan / Reconnect" di admin panel tanpa perlu restart PM2.

#### Step 10: Testing

```bash
# Test admin panel
curl https://your-domain.com/admin

# Test via WhatsApp
# Kirim pesan "Halo" ke nomor bot
# Ikuti checklist di TESTING_MANUAL_WHATSAPP.md
```

---

## 📋 DETAILED CHECKLIST

### Pre-Deployment

- [ ] Server Ubuntu 20.04+ ready
- [ ] Public IP address configured
- [ ] Domain name registered (optional tapi recommended)
- [ ] DNS records pointing to server IP
- [ ] SSH access configured
- [ ] Backup data penting dari Windows
- [ ] .env dikonfigurasi untuk production
- [ ] Hardcoded URLs diganti environment variables

### Installation (via install_ubuntu.sh)

- [ ] System updated (`apt update && upgrade`)
- [ ] Node.js installed & verified (`node --version`)
- [ ] Chromium installed (`which chromium-browser`)
- [ ] PM2 installed globally (`pm2 --version`)
- [ ] PostgreSQL installed atau remote PG server tersedia

### Database Setup

- [ ] MySQL kampus: koneksi dari server chatbot berhasil
- [ ] PostgreSQL: database `chatbot_analytics` siap
- [ ] PostgreSQL: user dengan akses ke database dibuat
- [ ] Koneksi PG diverifikasi (`psql -h <host> -U <user> -d chatbot_analytics -c "SELECT NOW();")`
- [ ] Tabel akan dibuat otomatis oleh aplikasi saat pertama kali start

### Application Configuration

- [ ] Project uploaded/cloned to `~/apps/server_chatbot`
- [ ] `npm install` completed without errors
- [ ] `.env` configured dengan values production
- [ ] Semua variabel wajib diisi:
  - [ ] `DB_*` (MySQL kampus)
  - [ ] `PG_*` (PostgreSQL analytics)
  - [ ] `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_NAMA`, `ADMIN_WA_NUMBER`
  - [ ] `SESSION_SECRET` (string acak panjang)
  - [ ] `GROQ_API_KEY` / `GEMINI_API_KEY`
  - [ ] `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`
- [ ] File permissions set correctly:
  - [ ] `.env` = 600 (read/write owner only)
  - [ ] `logs/` = 700 (rwx owner only)
- [ ] `ecosystem.config.js` reviewed

### PM2 Setup

- [ ] Apps started: `pm2 start ecosystem.config.js`
- [ ] Both processes running (`pm2 status`)
- [ ] Logs accessible (`pm2 logs`)
- [ ] No errors in logs
- [ ] PM2 configuration saved (`pm2 save`)
- [ ] PM2 startup configured (`pm2 startup`)
- [ ] Test restart: `pm2 restart all`

### Nginx Configuration

- [ ] `nginx.conf` copied to `/etc/nginx/sites-available/chatbot`
- [ ] Domain name updated in config
- [ ] Symbolic link created to sites-enabled
- [ ] Configuration tested (`nginx -t`)
- [ ] Nginx reloaded successfully
- [ ] Admin panel accessible via Nginx
- [ ] API endpoints working
- [ ] Rate limiting working

### SSL Certificate (if using domain)

- [ ] DNS propagation complete
- [ ] Certbot ran successfully
- [ ] Certificate obtained
- [ ] HTTPS working
- [ ] Auto-renewal tested (`certbot renew --dry-run`)
- [ ] HTTP redirects to HTTPS

### Security

- [ ] UFW firewall enabled
- [ ] SSH port allowed (22/tcp)
- [ ] HTTP/HTTPS allowed (80/443)
- [ ] Node.js ports blocked (3001, 3002)
- [ ] MySQL bound to localhost only
- [ ] Root login disabled
- [ ] SSH key authentication configured
- [ ] Fail2Ban active and monitoring
- [ ] `.env` protected (chmod 600)
- [ ] Sensitive files in `.gitignore`

### WhatsApp Integration

- [ ] wa_gateway started successfully
- [ ] QR code muncul di Admin Panel (menu Koneksi WhatsApp) atau di logs
- [ ] QR code scanned with WhatsApp
- [ ] WhatsApp connection established (status: Terhubung di admin panel)
- [ ] Session saved in `.wwebjs_auth/`
- [ ] Test message sent & received
- [ ] Reconnect via admin panel berfungsi (tanpa restart PM2)

### Testing

- [ ] Health check endpoint responds: `/health`
- [ ] Admin panel login works
- [ ] Database queries working (test pencarian buku)
- [ ] WhatsApp messages being received
- [ ] Bot responding correctly
- [ ] All menu options tested:
  - [ ] Menu 1: Pencarian Buku
  - [ ] Menu 2: Cek Pinjaman
  - [ ] Menu 3: Tata Tertib
  - [ ] Menu 4: SKBP
  - [ ] Menu 5: Tugas Akhir
  - [ ] Menu 6: Koleksi Digital
  - [ ] Menu 7: Turnitin
  - [ ] Menu 8: Human Mode
- [ ] AI fallback working
- [ ] Typo tolerance working
- [ ] Spam filter working
- [ ] Session management working
- [ ] Human mode working (if applicable)

### Monitoring & Backup

- [ ] PM2 monitoring accessible (`pm2 monit`)
- [ ] Logs rotating properly
- [ ] Backup script created
- [ ] Cron job scheduled for backups
- [ ] Backup tested (create & restore)
- [ ] Alert system configured (optional)

### Documentation

- [ ] Server credentials documented
- [ ] Database credentials documented
- [ ] API endpoints documented
- [ ] Admin panel URL shared with team
- [ ] Runbook created for ops team
- [ ] Emergency procedures documented

---

## 🚨 POST-DEPLOYMENT MONITORING (First 24 Hours)

### Hour 1-2: Immediate Monitoring

```bash
# Watch logs closely
pm2 logs --lines 100

# Monitor resources
pm2 monit
htop

# Check for errors
sudo tail -f /var/log/nginx/chatbot-error.log
```

### Hour 2-8: Active Testing

- [ ] Send test messages via WhatsApp
- [ ] Test all menu options
- [ ] Monitor memory usage
- [ ] Check database performance
- [ ] Review error logs
- [ ] Test admin panel

### Hour 8-24: Stability Check

- [ ] Check PM2 restart count (`pm2 status`)
- [ ] Review accumulated logs
- [ ] Monitor disk space
- [ ] Check database size
- [ ] Verify backups running
- [ ] Test SSL certificate

---

## 🔧 TROUBLESHOOTING QUICK REFERENCE

### Service Won't Start

```bash
pm2 logs chatbot-core --err --lines 50
node core_server.js  # Run directly to see errors
```

### Database Connection Error

```bash
# MySQL kampus
cat .env | grep DB_
mysql -h $DB_HOST -u $DB_USER -p $DB_NAME -e "SELECT 1;"

# PostgreSQL analytics
cat .env | grep PG_
psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -c "SELECT NOW();"
sudo systemctl status postgresql  # jika PostgreSQL lokal
```

### WhatsApp Not Connecting

```bash
pm2 logs chatbot-gateway --lines 100

# Opsi 1: Reconnect via admin panel (tanpa restart)
# Buka http://10.1.1.129/admin → Koneksi WhatsApp → Hubungkan

# Opsi 2: Hapus sesi dan restart (jika opsi 1 gagal)
rm -rf .wwebjs_auth
pm2 restart chatbot-gateway
```

### Nginx 502 Bad Gateway

```bash
pm2 status
curl http://localhost:3001/health
sudo nginx -t
pm2 restart all
sudo systemctl restart nginx
```

### High Memory Usage

```bash
pm2 list
free -h
pm2 restart chatbot-gateway
```

---

## 📞 SUPPORT CONTACTS

### Server Issues
- Server Provider Support
- System Administrator

### Application Issues
- Developer: [Your Contact]
- Technical Lead: [Contact]

### Database Issues
- Database Administrator: [Contact]

### Network/DNS Issues
- Network Administrator: [Contact]
- Domain Registrar Support

---

## 🎉 DEPLOYMENT COMPLETE!

Setelah semua checklist hijau:

1. ✅ **Inform Stakeholders**
   - Chatbot production URL
   - Admin panel credentials
   - Support contacts

2. ✅ **Monitor for 1 Week**
   - Daily log review
   - Performance metrics
   - User feedback

3. ✅ **Schedule Maintenance**
   - Weekly: Review logs & backups
   - Monthly: Security updates
   - Quarterly: Dependency updates

4. ✅ **Document Lessons Learned**
   - What went well
   - What can be improved
   - Update runbook

---

**Deployment Date:** _____________  
**Deployed By:** _____________  
**Verified By:** _____________  
**Production URL:** https://your-domain.com/admin  
**Status:** 🟢 Live
