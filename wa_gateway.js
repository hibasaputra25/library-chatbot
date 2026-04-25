const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const CORE_SERVICE_URL = 'http://127.0.0.1:3001/process-message';
const GATEWAY_PORT = 3002;

const app = express();
app.use(bodyParser.json());

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, // Biarkan false dulu biar kelihatan
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions'
        ]
    }
    // HAPUS BAGIAN 'webVersionCache' DISINI. 
    // Biarkan library baru mencari versi yang paling cocok sendiri.
});

// --- EVENT LISTENER ---

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
    console.log('📸 QR CODE MUNCUL!');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔐 Authenticated!');
});

client.on('auth_failure', msg => {
    console.error('❌ Gagal Login:', msg);
});

client.on('ready', () => {
    console.log('\n✅ WhatsApp Client SIAP & TERHUBUNG!');
});

// EVENT PENERIMA PESAN (YANG TADI DIAM SAJA)
client.on('message', async (msg) => {
    // Abaikan pesan status
    if (msg.body === "") return; 

    const from = msg.from;
    const userName = msg._data.notifyName || "User";
    const text = msg.body;

    // ==========================================
    // TAMBAHAN BARU: Ambil Nomor HP Asli
    // ==========================================
    let realNumber = "";
    try {
        const contact = await msg.getContact();
        realNumber = contact.number; // Ini akan mengambil nomor murni (misal: 628123456)
    } catch (err) {
        realNumber = from.split('@')[0]; // Fallback jika gagal
    }
    // ==========================================

    console.log(`\n📩 [PESAN MASUK] Dari: ${userName} (${from})`);
    console.log(`💬 Isi: ${text}`);

    // LOGIKA TERUSKAN KE CORE
    try {
        const response = await axios.post(CORE_SERVICE_URL, {
            from: from,
            text: text,
            userName: userName,
            realNumber: realNumber
        });

        if (response.data && response.data.reply) {
            const replyData = response.data.reply;
            
            // Logika kirim balasan (Support Array/String)
            // ... (Copy logika kirim pesan dari kode Anda sebelumnya disini) ...
            
            // SEMENTARA PAKAI INI YANG SIMPEL DULU UNTUK TES:
            if (Array.isArray(replyData)) {
                 for (const txt of replyData) await client.sendMessage(from, txt);
            } else {
                 await client.sendMessage(from, replyData);
            }
            console.log(`✅ [BALASAN TERKIRIM]`);
        }
    } catch (error) {
        console.error(`❌ [ERROR CORE] ${error.message}`);
        // await client.sendMessage(from, "Maaf, server sedang sibuk.");
    }
});

// =========================================================
// MENDETEKSI ADMIN MEMBALAS LANGSUNG VIA HP
// =========================================================
client.on('message_create', async msg => {
    // Jika pesan dikirim oleh nomor ini (Me/Admin)
    if (msg.fromMe) {
        
        // --- DAFTAR PESAN OTOMATIS BOT YANG HARUS DIABAIKAN ---
        const ignoredTexts = [
            "Sesi Operator Berakhir",
            "Menghubungkan ke Pustakawan", 
            "ALERT PUSTAKAWAN",
            "Mode Pustakawan diakhiri" // Pengecualian untuk balasan "!bot"
        ];

        // Cek apakah isi pesan mengandung salah satu teks di atas
        const isAutomatedMessage = ignoredTexts.some(ignoredText => msg.body.includes(ignoredText));

        // Jika ini pesan otomatis dari bot, hentikan proses (jangan reset timer)
        if (isAutomatedMessage) {
            return; 
        }
        // --------------------------------------------------------

        try {
            await axios.post('http://127.0.0.1:3001/api/admin-sync', {
                targetNumber: msg.to 
            });
            console.log(`[ADMIN SYNC] Pustakawan membalas manual ke: ${msg.to}`);
        } catch (error) {
            // Abaikan error ringan
        }
    }
});

// Endpoint PUSH
app.post('/send-direct', async (req, res) => {
    try {
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({ error: "Parameter 'to' dan 'message' wajib diisi." });
        }

        // --- TAMBAHKAN 2 BARIS INI ---
        console.log(`[DEBUG] Mencoba mengirim ke: "${to}"`);
        console.log(`[DEBUG] Tipe data 'to':`, typeof to);
        // -----------------------------

        await client.sendMessage(to, message);

        console.log(`[GATEWAY] Berhasil mengirim pesan direct ke ${to}`);
        return res.status(200).json({ status: "success", message: "Pesan terkirim" });

    } catch (error) {
        console.error("[GATEWAY ERROR] Gagal mengirim pesan direct:", error.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

client.initialize();

app.listen(GATEWAY_PORT, () => {
    console.log(`📡 Gateway Listening on port ${GATEWAY_PORT}`);
});