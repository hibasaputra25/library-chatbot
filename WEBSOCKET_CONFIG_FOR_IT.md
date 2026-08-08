# KONFIGURASI WEBSOCKET - UNTUK TIM IT KAMPUS
## Chatbot Perpustakaan - Universitas Mercu Buana

---

## MASALAH YANG TERJADI

**Error di Browser:**
```
Gagal menghubungi gateway: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

**URL yang Bermasalah:**
- `ws://ols-chat.mercubuana.ac.id/admin/ws-gateway`

**Root Cause:**
Reverse proxy kampus TIDAK meneruskan WebSocket Upgrade header ke backend server, sehingga WebSocket connection gagal dan browser menerima HTML response alih-alih WebSocket connection.

---

## VERIFIKASI MASALAH

### Test 1: Cek apakah WebSocket Upgrade berhasil
```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  http://ols-chat.mercubuana.ac.id/admin/ws-gateway
```

**Expected Response (BENAR):**
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
```

**Actual Response (SALAH - ini yang terjadi sekarang):**
```
HTTP/1.1 200 OK
Content-Type: text/html
<!DOCTYPE html>...
```

### Test 2: Cek Header yang Diteruskan
```bash
# Di server backend (10.10.20.xxx), jalankan:
sudo tcpdump -i any -A 'port 3003' | grep -i upgrade
```

Jika tidak muncul "Upgrade: websocket", berarti reverse proxy kampus membuang header tersebut.

---

## SOLUSI: KONFIGURASI REVERSE PROXY

### Jika Menggunakan Apache (mod_proxy_wstunnel)

**1. Enable module yang diperlukan:**
```bash
sudo a2enmod proxy
sudo a2enmod proxy_http
sudo a2enmod proxy_wstunnel
sudo systemctl restart apache2
```

**2. Konfigurasi VirtualHost:**
```apache
<VirtualHost *:80>
    ServerName ols-chat.mercubuana.ac.id
    
    # PENTING: WebSocket HARUS didefinisikan SEBELUM location lain
    # Karena Apache memproses dari atas ke bawah
    
    # WebSocket untuk admin panel
    <Location "/admin/ws-gateway">
        ProxyPass "ws://10.10.20.XXX:3003/admin/ws-gateway"
        ProxyPassReverse "ws://10.10.20.XXX:3003/admin/ws-gateway"
        
        # WAJIB untuk WebSocket
        RewriteEngine On
        RewriteCond %{HTTP:Upgrade} =websocket [NC]
        RewriteRule ^/admin/ws-gateway(.*)$ ws://10.10.20.XXX:3003/admin/ws-gateway$1 [P,L]
        RewriteCond %{HTTP:Upgrade} !=websocket [NC]
        RewriteRule ^/admin/ws-gateway(.*)$ http://10.10.20.XXX:3003/admin/ws-gateway$1 [P,L]
    </Location>
    
    # HTTP biasa untuk endpoint lain
    ProxyPass "/admin" "http://10.10.20.XXX:3003/admin"
    ProxyPassReverse "/admin" "http://10.10.20.XXX:3003/admin"
    
    ProxyPass "/wa-gateway" "http://10.10.20.XXX:3002/"
    ProxyPassReverse "/wa-gateway" "http://10.10.20.XXX:3002/"
    
    ProxyPass "/" "http://10.10.20.XXX:3003/"
    ProxyPassReverse "/" "http://10.10.20.XXX:3003/"
    
    # Preserve headers
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "http"
</VirtualHost>
```

### Jika Menggunakan Nginx

**Konfigurasi Nginx Reverse Proxy:**
```nginx
server {
    listen 80;
    server_name ols-chat.mercubuana.ac.id;
    
    # WebSocket endpoint - HARUS ada Upgrade header
    location /admin/ws-gateway {
        proxy_pass http://10.10.20.XXX:3003;
        proxy_http_version 1.1;
        
        # CRITICAL untuk WebSocket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Standard headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeout untuk WebSocket (24 jam)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_connect_timeout 86400s;
    }
    
    # HTTP endpoints
    location /admin {
        proxy_pass http://10.10.20.XXX:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    location / {
        proxy_pass http://10.10.20.XXX:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Jika Menggunakan HAProxy

```haproxy
frontend http_front
    bind *:80
    
    # ACL untuk WebSocket
    acl is_websocket hdr(Upgrade) -i WebSocket
    acl is_websocket_path path_beg /admin/ws-gateway
    
    # Gunakan backend khusus untuk WebSocket
    use_backend websocket_backend if is_websocket is_websocket_path
    
    # Backend default untuk HTTP
    default_backend http_backend

backend websocket_backend
    # PENTING: mode http untuk WebSocket
    mode http
    option http-server-close
    option forceclose
    
    # Timeout panjang untuk WebSocket
    timeout server 86400s
    timeout connect 5s
    
    server backend1 10.10.20.XXX:3003 check

backend http_backend
    mode http
    server backend1 10.10.20.XXX:3003 check
```

---

## TESTING SETELAH KONFIGURASI

### 1. Test dengan curl
```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://ols-chat.mercubuana.ac.id/admin/ws-gateway
```

**Expected Output:**
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: ...
```

### 2. Test dengan wscat (Install: npm install -g wscat)
```bash
wscat -c ws://ols-chat.mercubuana.ac.id/admin/ws-gateway
```

**Expected:** Connection established dan menerima status message dari server

### 3. Test dari Browser
1. Buka http://ols-chat.mercubuana.ac.id/admin
2. Login
3. Klik "Hubungkan WhatsApp"
4. Seharusnya muncul status "WebSocket terhubung ke gateway"
5. Lalu muncul QR code untuk scan

---

## DEBUGGING

### Check 1: Apakah module WebSocket enabled?

**Apache:**
```bash
apache2ctl -M | grep proxy_wstunnel
# Expected: proxy_wstunnel_module (shared)
```

**Nginx:**
```bash
nginx -V 2>&1 | grep --color http_upgrade
# Should show http_upgrade support
```

### Check 2: Monitor header yang diteruskan

Di server backend (10.10.20.XXX), test apakah header Upgrade sampai:
```bash
# Monitor di server backend
sudo tcpdump -i any -A 'port 3003 and host [IP_REVERSE_PROXY]' | grep -i "upgrade"
```

Kemudian dari komputer lain, akses:
```bash
curl -H "Upgrade: websocket" http://ols-chat.mercubuana.ac.id/admin/ws-gateway
```

Jika di tcpdump TIDAK muncul "Upgrade: websocket", berarti reverse proxy membuangnya.

### Check 3: Cek log reverse proxy

**Apache:**
```bash
sudo tail -f /var/log/apache2/access.log
sudo tail -f /var/log/apache2/error.log
```

**Nginx:**
```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

Look for errors like:
- "upstream sent invalid header"
- "no live upstreams"
- "connection refused"

---

## CATATAN PENTING

1. **WebSocket BUTUH Upgrade header** - Ini bukan opsional, tanpa ini WebSocket tidak akan berfungsi
2. **Order matters di Apache** - WebSocket location HARUS didefinisikan SEBELUM location HTTP biasa
3. **Timeout harus panjang** - WebSocket connection long-lived, butuh timeout 24 jam atau unlimited
4. **Tidak ada caching** - Jangan cache WebSocket response
5. **HTTP/1.1 minimum** - WebSocket butuh HTTP/1.1, tidak bisa HTTP/1.0

---

## KONTAK

Jika ada pertanyaan teknis atau butuh bantuan implementasi, silakan hubungi:
- Developer: [Nama Anda]
- Email: [Email Anda]
- Server Backend IP: 10.10.20.XXX
- Port Backend: 3003 (Core), 3002 (Gateway)

---

## REFERENSI

- Apache WebSocket Proxy: https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html
- Nginx WebSocket Proxy: https://nginx.org/en/docs/http/websocket.html
- RFC 6455 - The WebSocket Protocol: https://tools.ietf.org/html/rfc6455
