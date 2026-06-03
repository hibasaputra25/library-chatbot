# 🚀 PUSTAKABOT - DEPLOYMENT PACKAGE

## 📦 Paket Deployment Lengkap untuk Ubuntu Server

Repository ini sudah dilengkapi dengan semua file yang dibutuhkan untuk deployment ke server Ubuntu.

---

## 📁 FILE-FILE DEPLOYMENT

### 1. Dokumentasi Utama

#### `DEPLOYMENT_UBUNTU.md` ⭐ **BACA INI DULU**
- Panduan deployment lengkap 50+ halaman
- Step-by-step dari instalasi sampai production
- Troubleshooting guide
- Security best practices
- Monitoring & backup strategies

#### `DEPLOYMENT_CHECKLIST.md`
- Checklist lengkap deployment
- Quick start guide
- Post-deployment monitoring
- Contact information template

#### `TESTING_MANUAL_WHATSAPP.md`
- 15 skenario testing
- Expected responses
- Human mode testing
- Edge cases & troubleshooting

---

### 2. Script & Konfigurasi

#### `install_ubuntu.sh` (Executable Script)
**Fungsi:** Install semua dependencies secara otomatis

**Yang diinstall:**
- Node.js (via NVM)
- MySQL Server
- Chromium & dependencies (untuk WhatsApp Web.js)
- PM2 Process Manager
- Nginx Web Server
- Certbot (SSL certificates)
- Fail2Ban (security)

**Cara pakai:**
```bash
chmod +x install_ubuntu.sh
./install_ubuntu.sh
```

#### `ecosystem.config.js` (PM2 Configuration)
**Fungsi:** Konfigurasi PM2 untuk manage 2 services

**Services:**
- `chatbot-core` (port 3001) - Main chatbot logic
- `chatbot-gateway` (port 3002) - WhatsApp gateway

**Features:**
- Auto-restart on crash
- Memory limit & auto-restart
- Log rotation
- Graceful shutdown
- Zero-downtime reload

**Cara pakai:**
```bash
pm2 start ecosystem.config.js
pm2 status
pm2 logs
```

#### `nginx.conf` (Nginx Configuration)
**Fungsi:** Reverse proxy & load balancer

**Features:**
- Rate limiting (API & Admin)
- SSL/TLS support
- Gzip compression
- Security headers
- Static file caching
- Request buffering

**Cara pakai:**
```bash
sudo cp nginx.conf /etc/nginx/sites-available/chatbot
sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### `.gitignore`
**Fungsi:** Prevent committing sensitive files

**Excluded:**
- `node_modules/`
- `.env` files
- `logs/`
- `.wwebjs_auth/` (WhatsApp session)
- `*.db` (SQLite databases)
- SSL certificates & keys
- Backups

#### `.env.example`
**Fungsi:** Template untuk environment variables

**Variables:**
- API keys (Gemini, Groq, Twilio)
- Database credentials
- Admin credentials
- Admin WhatsApp number

**Cara pakai:**
```bash
cp .env.example .env
nano .env
# Update all values for production
```

---

### 3. Testing Tools

#### `test_chatbot_simulator.js`
**Status:** ❌ Tidak bisa digunakan
**Alasan:** Chatbot tidak menerima request langsung via API, hanya dari WhatsApp

#### `run_automated_test.js`
**Status:** ❌ Tidak bisa digunakan
**Alasan:** Same as above - requires WhatsApp integration

**Alternatif:** Gunakan `TESTING_MANUAL_WHATSAPP.md` untuk testing via WhatsApp real

---

## 🎯 QUICK START (5 MENIT)

### 1. Upload Project ke Server

**Option A: Via Git (Recommended)**
```bash
ssh ubuntu@your-server-ip
cd ~/apps
git clone https://github.com/your-username/server_chatbot.git
cd server_chatbot
```

**Option B: Via SCP**
```powershell
# Dari Windows
scp -r C:\chatbot\server_chatbot ubuntu@your-server-ip:~/apps/
```

### 2. Install Dependencies

```bash
cd ~/apps/server_chatbot
chmod +x install_ubuntu.sh
./install_ubuntu.sh
```

**Script akan install semua yang dibutuhkan (~10 menit)**

### 3. Setup Database

```bash
sudo mysql_secure_installation
sudo mysql
```

```sql
CREATE DATABASE lib1;
CREATE USER 'biroperpustakaan'@'localhost' IDENTIFIED BY 'YourPassword';
GRANT ALL PRIVILEGES ON lib1.* TO 'biroperpustakaan'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 4. Configure & Start

```bash
npm install
cp .env.example .env
nano .env  # Update values
pm2 start ecosystem.config.js
pm2 logs  # Watch for QR code
```

### 5. Configure Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/chatbot
sudo nano /etc/nginx/sites-available/chatbot  # Update domain
sudo ln -s /etc/nginx/sites-available/chatbot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 6. Scan WhatsApp QR Code

```bash
pm2 logs chatbot-gateway
# Scan QR dengan WhatsApp di HP
```

### 7. Test!

```bash
curl http://localhost:3001/health
curl http://your-server-ip/admin
# Kirim pesan WhatsApp ke bot: "Halo"
```

---

## 📚 DOKUMENTASI LENGKAP

Untuk deployment detail, baca file-file berikut **berurutan**:

1. **DEPLOYMENT_UBUNTU.md** - Main deployment guide
2. **DEPLOYMENT_CHECKLIST.md** - Checklist & quick reference
3. **TESTING_MANUAL_WHATSAPP.md** - Testing guide

---

## 🔧 COMMON ISSUES

### WhatsApp QR Code Tidak Muncul

```bash
pm2 logs chatbot-gateway --lines 100
# Pastikan tidak ada error
# QR code akan muncul setelah "WhatsApp client initialized"
```

### Database Connection Error

```bash
# Test connection
mysql -u biroperpustakaan -p lib1 -e "SELECT 1;"

# Check .env
cat .env | grep DB_
```

### PM2 Process Crashed

```bash
pm2 logs chatbot-core --err
pm2 restart chatbot-core
```

### Nginx 502 Bad Gateway

```bash
pm2 status  # Check if apps running
sudo nginx -t  # Test nginx config
pm2 restart all
sudo systemctl reload nginx
```

---

## 🛡️ SECURITY CHECKLIST

- [ ] `.env` file permissions: `chmod 600 .env`
- [ ] Change default admin password
- [ ] MySQL root password set
- [ ] UFW firewall enabled
- [ ] SSH key authentication only
- [ ] Fail2Ban installed
- [ ] SSL certificate obtained
- [ ] Node.js ports (3001, 3002) blocked from external
- [ ] Nginx rate limiting enabled
- [ ] Regular backups scheduled

---

## 📞 SUPPORT

### Dokumentasi
- Main Guide: `DEPLOYMENT_UBUNTU.md`
- Checklist: `DEPLOYMENT_CHECKLIST.md`
- Testing: `TESTING_MANUAL_WHATSAPP.md`

### Troubleshooting
1. Check PM2 logs: `pm2 logs`
2. Check Nginx logs: `sudo tail -f /var/log/nginx/chatbot-error.log`
3. Check MySQL: `sudo systemctl status mysql`
4. Review `.env` configuration

### Files Modified for Deployment

**Yang perlu diupdate:**
- `.env` - All values for production
- `nginx.conf` - Domain name (line 47)
- `core_server.js` - Line 27, ganti hardcoded URL dengan env var:
  ```javascript
  const WA_GATEWAY_URL = process.env.WA_GATEWAY_URL || 'http://127.0.0.1:3002/send-direct';
  ```

**Tambahkan di .env:**
```env
WA_GATEWAY_URL="http://localhost:3002/send-direct"
```

---

## ✅ DEPLOYMENT SUCCESS CRITERIA

Chatbot dinyatakan **PRODUCTION READY** jika:

- ✅ PM2 processes running (`pm2 status`)
- ✅ No errors in logs (`pm2 logs`)
- ✅ Database connection working
- ✅ WhatsApp connected (QR scanned)
- ✅ Admin panel accessible
- ✅ Test message via WhatsApp berhasil
- ✅ All menu options working
- ✅ Nginx reverse proxy working
- ✅ SSL certificate active (if using domain)
- ✅ Firewall configured
- ✅ Backups scheduled

---

## 📊 MONITORING

### Real-time
```bash
pm2 monit          # Process monitoring
htop              # System resources
pm2 logs          # Application logs
```

### Daily
```bash
pm2 status        # Check uptime
df -h             # Disk usage
free -h           # Memory usage
```

### Weekly
```bash
# Review logs
pm2 logs --lines 1000 > weekly_logs.txt

# Check backups
ls -lh ~/backups/

# Security updates
sudo apt update && sudo apt upgrade
```

---

## 🔄 UPDATE PROCEDURE

### Code Update (Zero Downtime)

```bash
cd ~/apps/server_chatbot
git pull origin main
npm install
pm2 reload ecosystem.config.js
```

### Configuration Update

```bash
nano .env
pm2 restart all
```

### Nginx Update

```bash
sudo nano /etc/nginx/sites-available/chatbot
sudo nginx -t
sudo systemctl reload nginx
```

---

## 🎓 NEXT STEPS AFTER DEPLOYMENT

1. **First 24 Hours**
   - Monitor logs closely
   - Test all features
   - Check resource usage
   - Verify backups running

2. **First Week**
   - Daily log review
   - Performance tuning
   - Collect user feedback
   - Document issues

3. **Ongoing**
   - Weekly backup verification
   - Monthly security updates
   - Quarterly dependency updates
   - Performance optimization

---

## 📄 LICENSE & CREDITS

**Project:** PustakaBot  
**Organization:** Universitas Mercu Buana  
**Purpose:** Library Chatbot Assistant  
**Deployment Date:** [Fill in]  
**Deployed By:** [Fill in]  

---

**Good luck with your deployment! 🚀**

Untuk pertanyaan lebih lanjut, refer to:
- `DEPLOYMENT_UBUNTU.md` untuk detail teknis
- `DEPLOYMENT_CHECKLIST.md` untuk quick reference
- `TESTING_MANUAL_WHATSAPP.md` untuk testing procedures
