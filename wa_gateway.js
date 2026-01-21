/**
 * WA WEB GATEWAY (Jalur Alternatif Tanpa API Berbayar)
 * * Cara Kerja:
 * 1. Menjalankan simulasi WhatsApp Web di terminal.
 * 2. Anda scan QR Code menggunakan WA pribadi/khusus bot.
 * 3. Pesan masuk -> Diteruskan ke Core Server -> Dibalas langsung.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express'); // TAMBAH INI
const bodyParser = require('body-parser'); // TAMBAH INI

// Konfigurasi URL Core Server Anda
const CORE_SERVICE_URL = 'http://localhost:3001/process-message';
const GATEWAY_PORT = 3002; // Port khusus untuk Gateway

// Setup Server Express (Agar bisa dipanggil Core)
const app = express();
app.use(bodyParser.json());

// Inisialisasi Client
const client = new Client({
    authStrategy: new LocalAuth(), // Menyimpan sesi login agar tidak perlu scan QR tiap kali restart
    puppeteer: {
        headless: true, // Ubah ke false jika ingin melihat browser Chrome terbuka
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// 1. Generate QR Code untuk Login
client.on('qr', (qr) => {
    console.log('\n=== SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP ===\n');
    qrcode.generate(qr, { small: true });
});

// 2. Notifikasi saat Berhasil Login
client.on('ready', () => {
    console.log('\n✅ WhatsApp Client sudah SIAP!');
    console.log('Bot sekarang aktif menggunakan nomor Anda sendiri.');
});

// 3. Menangani Pesan Masuk
client.on('message', async (msg) => {
    // Abaikan pesan status atau grup (opsional, bisa diatur)
    if (msg.body === "") return; 

    // Ambil info pengirim (Metode Aman / Bypass Error)
    const from = msg.from;
    
    // Kita ambil nama langsung dari metadata pesan, tanpa memanggil getContact()
    // msg._data.notifyName biasanya berisi nama tampilan (Pushname)
    const userName = msg._data.notifyName || "Pengguna WA"; 
    
    const text = msg.body;

    console.log(`[WA] Pesan dari ${userName} (${from}): ${text}`);

    try {
        // --- KIRIM KE CORE SERVER ---
        // Kita kirim ke core_server.js yang sudah Anda buat sebelumnya
        const response = await axios.post(CORE_SERVICE_URL, {
            from: from,       // ID unik pengirim
            text: text,       // Isi pesan
            userName: userName // Nama user
        });

        // --- TERIMA BALASAN & KIRIM BALIK ---
        if (response.data && response.data.reply) {
            const replyData = response.data.reply;

            // Cek: Apakah ini ARRAY (Banyak Pesan/Bubble)?
            if (Array.isArray(replyData)) {
                // Loop dan kirim satu per satu
                for (const singleMsg of replyData) {
                    if (singleMsg) {
                        try {
                            // Bungkus sendMessage dengan try-catch agar kalau 1 gagal, yang lain tetap lanjut
                            await client.sendMessage(from, String(singleMsg) + '\u200B', { linkPreview: false });
                            
                            // Jeda sedikit biar aman
                            await new Promise(r => setTimeout(r, 500)); 
                        } catch (sendError) {
                            console.error(`[WA ERROR] Gagal kirim bubble: ${sendError.message}`);
                            // Lanjut ke pesan berikutnya (continue)
                        }
                    }
                }
            } 
            // Jika cuma STRING biasa (Satu Pesan)
            else {
                try {
                    await client.sendMessage(from, String(replyData) + '\u200B', { linkPreview: false });
                } catch (sendError) {
                     console.error(`[WA ERROR] Gagal kirim pesan: ${sendError.message}`);
                }
            }
            
            console.log(`[WA] Membalas ke ${userName}: Sukses.`);
        }

    } catch (error) {
        console.error('[ERROR] Gagal menghubungi Core Server:', error.message);
        // Opsi: Kirim pesan error ke user jika core mati
        // await msg.reply("Maaf, server sedang offline.");
    }
});

// --- 2. ENDPOINT BARU: MENERIMA PERINTAH KIRIM PESAN (PUSH) ---
// Ini yang akan dipanggil oleh Core Server saat Session Timeout
app.post('/send-direct', async (req, res) => {
    try {
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({ status: 'error', message: 'Missing parameters' });
        }

        // Kirim pesan via WA
        await client.sendMessage(to, message);
        console.log(`[PUSH] Pesan Timeout dikirim ke ${to}`);
        
        res.json({ status: 'success' });
    } catch (error) {
        console.error('[PUSH ERROR]', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Jalankan Client
console.log('Menjalankan WhatsApp Gateway...');
client.initialize();

// Jalankan Server Express Gateway
app.listen(GATEWAY_PORT, () => {
    console.log(`📡 Gateway Listening on port ${GATEWAY_PORT}`);
});