require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const CORE_SERVICE_URL = `http://127.0.0.1:${process.env.CORE_PORT || 3001}/process-message`;
const GATEWAY_PORT = 3002;

const app = express();
app.use(bodyParser.json());

// =======================================================
// HTTP SERVER + WEBSOCKET SERVER
// =======================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// State koneksi WhatsApp
let waStatus = 'disconnected';
let lastQrBase64 = null;
let client = null;
let isInitializing = false;

// Broadcast ke semua WS client yang aktif
function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

// Saat client WS baru konek, kirim status saat ini langsung
wss.on('connection', (ws) => {
    console.log('[WS] Client baru terhubung ke gateway.');
    const initialPayload = { type: 'status', status: waStatus };
    if (waStatus === 'qr' && lastQrBase64) {
        initialPayload.qr = lastQrBase64;
    }
    ws.send(JSON.stringify(initialPayload));

    ws.on('close', () => {
        console.log('[WS] Client WS terputus dari gateway.');
    });
});

// =======================================================
// FUNGSI INISIALISASI CLIENT (BISA DIPANGGIL ULANG)
// =======================================================
async function initClient() {
    if (isInitializing) {
        console.log('[WA] Sudah dalam proses inisialisasi, skip.');
        return;
    }

    // Safety: reset isInitializing setelah 3 menit jika masih stuck
    const initTimeout = setTimeout(() => {
        if (isInitializing) {
            console.warn('[WA] isInitializing stuck selama 3 menit — direset paksa, mencoba ulang...');
            isInitializing = false;
            initClient();
        }
    }, 3 * 60 * 1000);

    // Destroy client lama jika ada
    if (client) {
        console.log('[WA] Menghancurkan client lama...');
        try {
            // Hapus semua listener dulu agar tidak ada event lama yang tertrigger
            client.removeAllListeners();
            await client.destroy();
        } catch (err) {
            console.warn('[WA] Gagal destroy client lama (mungkin sudah mati):', err.message);
        }
        client = null;
        // Beri jeda agar Puppeteer benar-benar bersih sebelum buat instance baru
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    isInitializing = true;
    waStatus = 'loading';
    lastQrBase64 = null;
    broadcast({ type: 'status', status: 'loading', message: 'Menginisialisasi WhatsApp...' });
    console.log('[WA] Membuat client baru...');

    client = new Client({
        authStrategy: new LocalAuth(),
        webVersionCache: {
            type: 'local'
        },
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
    });

    // --- EVENT LISTENERS ---

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading: ${percent}% - ${message}`);
        broadcast({ type: 'status', status: 'loading', percent, message });
    });

    client.on('qr', async (qr) => {
        console.log('📸 QR CODE MUNCUL!');
        qrcode.generate(qr, { small: true });
        try {
            lastQrBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            waStatus = 'qr';
            broadcast({ type: 'qr', qr: lastQrBase64, status: 'qr' });
        } catch (err) {
            console.error('[WS] Gagal generate QR base64:', err.message);
        }
    });

    // Simpan referensi client saat ini untuk validasi event
    const currentClient = client;

    client.on('authenticated', () => {
        if (client !== currentClient) return; // abaikan event dari client lama
        console.log('🔐 Authenticated!');
        waStatus = 'authenticated';
        lastQrBase64 = null;
        broadcast({ type: 'status', status: 'authenticated' });
    });

    client.on('auth_failure', msg => {
        if (client !== currentClient) return;
        console.error('❌ Gagal Login:', msg);
        waStatus = 'disconnected';
        lastQrBase64 = null;
        isInitializing = false;
        clearTimeout(initTimeout);
        broadcast({ type: 'status', status: 'disconnected', reason: 'auth_failure' });
    });

    client.on('ready', () => {
        if (client !== currentClient) return;
        console.log('\n✅ WhatsApp Client SIAP & TERHUBUNG!');
        waStatus = 'connected';
        lastQrBase64 = null;
        isInitializing = false;
        clearTimeout(initTimeout);
        broadcast({ type: 'status', status: 'connected' });
    });

    client.on('disconnected', async (reason) => {
        console.log(`[WA] Terputus: ${reason}`);
        waStatus = 'disconnected';
        lastQrBase64 = null;
        isInitializing = false;
        clearTimeout(initTimeout);
        broadcast({ type: 'status', status: 'disconnected', reason });
        if (reason !== 'LOGOUT') {
            console.log('[WA] Auto-reconnect dalam 5 detik...');
            setTimeout(() => initClient(), 5000);
        }
    });

    // EVENT PENERIMA PESAN
    client.on('message', async (msg) => {
        if (msg.body === '') return;

        const from = msg.from;
        const userName = msg._data.notifyName || 'User';
        const text = msg.body;

        let realNumber = '';
        try {
            const contact = await msg.getContact();
            realNumber = contact.number;
        } catch (err) {
            realNumber = from.split('@')[0];
        }

        console.log(`\n📩 [PESAN MASUK] Dari: ${userName} (${from})`);
        console.log(`💬 Isi: ${text}`);

        try {
            const response = await axios.post(CORE_SERVICE_URL, {
                from, text, userName, realNumber
            });

            if (response.data && response.data.reply) {
                const replyData = response.data.reply;
                if (Array.isArray(replyData)) {
                    for (const txt of replyData) await client.sendMessage(from, txt, { linkPreview: false });
                } else {
                    await client.sendMessage(from, replyData, { linkPreview: false });
                }
                console.log('✅ [BALASAN TERKIRIM]');
            }
        } catch (error) {
            console.error(`❌ [ERROR CORE] ${error.message}`);
        }
    });

    // MENDETEKSI ADMIN MEMBALAS LANGSUNG VIA HP
    client.on('message_create', async msg => {
        if (msg.fromMe) {
            const ignoredTexts = [
                'Sesi Operator Berakhir',
                'Menghubungkan ke Pustakawan',
                'ALERT PUSTAKAWAN',
                'Mode Pustakawan diakhiri'
            ];
            if (ignoredTexts.some(t => msg.body.includes(t))) return;

            try {
                await axios.post('http://127.0.0.1:3001/api/admin-sync', { targetNumber: msg.to });
                console.log(`[ADMIN SYNC] Pustakawan membalas manual ke: ${msg.to}`);
            } catch (error) {}
        }
    });

    try {
        await client.initialize();
    } catch (err) {
        // Execution context destroyed adalah error non-fatal saat WhatsApp Web
        // reload halaman saat inject — bot biasanya tetap berjalan normal
        if (err.message && err.message.includes('Execution context was destroyed')) {
            console.warn('[WA] Execution context destroyed (non-fatal) — bot kemungkinan tetap berjalan.');
            // Jangan set disconnected, tunggu event ready/disconnected yang sebenarnya
            isInitializing = false;
            return;
        }
        console.error('[WA] Gagal initialize:', err.message);
        waStatus = 'disconnected';
        isInitializing = false;
        broadcast({ type: 'status', status: 'disconnected', reason: err.message });
        console.log('[WA] Retry inisialisasi dalam 15 detik...');
        setTimeout(() => initClient(), 15000);
    }
}

// =======================================================
// REST ENDPOINTS
// =======================================================

// Status koneksi WhatsApp
app.get('/status', (req, res) => {
    res.json({
        status: waStatus,
        qr: waStatus === 'qr' ? lastQrBase64 : null
    });
});

// Reconnect — destroy client lama & init ulang
app.post('/reconnect', async (req, res) => {
    try {
        console.log('[WA] Reconnect diminta dari admin panel.');
        res.json({ success: true, message: 'Proses reconnect dimulai. Pantau QR di admin panel.' });
        // Jalankan setelah response dikirim agar tidak timeout
        setTimeout(() => initClient(), 100);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout WhatsApp
app.post('/logout', async (req, res) => {
    try {
        if (client) await client.logout();
        waStatus = 'disconnected';
        lastQrBase64 = null;
        isInitializing = false;
        broadcast({ type: 'status', status: 'disconnected', reason: 'logout' });
        res.json({ success: true, message: 'Berhasil logout. Klik Hubungkan untuk scan QR baru.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint PUSH
app.post('/send-direct', async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!to || !message) {
            return res.status(400).json({ error: "Parameter 'to' dan 'message' wajib diisi." });
        }
        if (!client || waStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp belum terhubung.' });
        }
        console.log(`[DEBUG] Mencoba mengirim ke: "${to}"`);
        await client.sendMessage(to, message, { linkPreview: false });
        console.log(`[GATEWAY] Berhasil mengirim pesan direct ke ${to}`);
        return res.status(200).json({ status: 'success', message: 'Pesan terkirim' });
    } catch (error) {
        console.error('[GATEWAY ERROR] Gagal mengirim pesan direct:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// =======================================================
// GLOBAL ERROR HANDLER — cegah crash karena error non-fatal
// =======================================================
const NON_FATAL_ERRORS = [
    'Execution context was destroyed',
    'Protocol error',
    'Target closed',
    'EBUSY',
    'Session closed',
    'lockfile',
    'already exists!'  // onQRChangedEvent binding duplikat saat reconnect
];

const isNonFatal = (msg) => NON_FATAL_ERRORS.some(e => msg.includes(e));

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (isNonFatal(msg)) {
        console.warn('[WA] Non-fatal error diabaikan:', msg.split('\n')[0]);
        return;
    }
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (isNonFatal(msg)) {
        console.warn('[WA] Non-fatal error diabaikan:', msg.split('\n')[0]);
        return;
    }
    console.error('[UNCAUGHT EXCEPTION]', err);
    process.exit(1);
});

// =======================================================
// HEALTH CHECK — deteksi koneksi stuck tanpa event disconnected
// Cek setiap 5 menit, jika status connected tapi client tidak responsif, reconnect
// =======================================================
let lastHealthCheck = Date.now();

setInterval(async () => {
    // Hanya cek jika status connected dan client ada
    if (waStatus !== 'connected' || !client) return;

    try {
        // Coba ping WhatsApp dengan operasi ringan
        const state = await client.getState();
        if (state !== 'CONNECTED') {
            console.warn(`[HEALTH CHECK] State WhatsApp: ${state} — memulai reconnect...`);
            waStatus = 'disconnected';
            isInitializing = false;
            broadcast({ type: 'status', status: 'disconnected', reason: 'health_check_failed' });
            initClient();
        } else {
            lastHealthCheck = Date.now();
        }
    } catch (err) {
        console.warn(`[HEALTH CHECK] Gagal cek state: ${err.message} — memulai reconnect...`);
        waStatus = 'disconnected';
        isInitializing = false;
        broadcast({ type: 'status', status: 'disconnected', reason: 'health_check_error' });
        initClient();
    }
}, 5 * 60 * 1000); // setiap 5 menit

// =======================================================
// START
// =======================================================
server.listen(GATEWAY_PORT, () => {
    console.log(`📡 Gateway Listening on port ${GATEWAY_PORT}`);
    initClient();
});
