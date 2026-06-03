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

```bash
# Secure MySQL
sudo mysql_secure_installation
# - Set root password
# - Remove anonymous users: YES
# - Disallow root login remotely: YES
# - Remove test database: YES

# Create database & user
sudo mysql
```

```sql
CREATE DATABASE lib1 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'biroperpustakaan'@'localhost' IDENTIFIED BY 'Perpustakaan@2025!.';
GRANT ALL PRIVILEGES ON lib1.* TO 'biroperpustakaan'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
# Import data (jika ada backup dari Windows)
mysql -u biroperpustakaan -p lib1 < backup_database.sql
```

#### Step 4: Configure Application

```bash
cd ~/apps/server_chatbot

# Install Node modules
npm install --production

# Setup environment
cp .env.example .env
nano .env
# Update semua values untuk production
# Terutama:
# - DB_HOST=localhost
# - ADMIN_PASS (password kuat!)
# - NODE_ENV=production

# Set permissions
chmod 600 .env
chmod 600 analytics.db
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
# Watch logs untuk QR code
pm2 logs chatbot-gateway

# QR code akan muncul di terminal
# Scan dengan WhatsApp di HP Anda:
# WhatsApp > Menu > Linked Devices > Link a Device
```

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
- [ ] MySQL installed & running (`systemctl status mysql`)
- [ ] Chromium & dependencies installed
- [ ] PM2 installed globally (`pm2 --version`)
- [ ] Nginx installed & running (`systemctl status nginx`)
- [ ] Certbot installed (for SSL)
- [ ] Fail2Ban installed (for security)

### Database Setup

- [ ] MySQL secured (`mysql_secure_installation`)
- [ ] Database `lib1` created
- [ ] User `biroperpustakaan` created with privileges
- [ ] Table structures created
- [ ] Data imported (if any)
- [ ] Connection tested from app

### Application Configuration

- [ ] Project uploaded/cloned to `~/apps/server_chatbot`
- [ ] `npm install` completed without errors
- [ ] `.env` configured dengan values production
- [ ] File permissions set correctly:
  - [ ] `.env` = 600 (read/write owner only)
  - [ ] `logs/` = 700 (rwx owner only)
  - [ ] `analytics.db` = 600
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
- [ ] QR code displayed in logs
- [ ] QR code scanned with WhatsApp
- [ ] WhatsApp connection established
- [ ] Session saved in `.wwebjs_auth/`
- [ ] Test message sent & received

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
mysql -u biroperpustakaan -p lib1 -e "SELECT 1;"
sudo systemctl status mysql
cat .env | grep DB_
```

### WhatsApp Not Connecting

```bash
pm2 logs chatbot-gateway --lines 100
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
