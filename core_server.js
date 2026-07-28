/**
 * CHATBOT CORE SERVICE
 * PORT: 3003
 *
 * Layanan ini berisi logika inti Chatbot:
 * 1. Memuat responses.json.
 * 2. Memproses pesan masuk (dari Gateway Meta atau Twilio).
 * 3. Menghasilkan balasan berdasarkan input dan state pengguna.
 * 4. Berinteraksi dengan Database MySQL untuk data buku real-time.
 *
 * CATATAN: File ini WAJIB di-restart setelah ada perubahan pada responses.json
 * atau saat logic di sini diubah.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const util = require("util"); 
const axios = require('axios');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const path = require('path');

// HUMAN MODE
// Konfigurasi Admin & Gateway
const WA_GATEWAY_URL = process.env.WA_GATEWAY_URL || 'http://127.0.0.1:3002/send-direct';
// Ganti dengan nomor Anda yang dipakai untuk scan bot (format @c.us)
const ADMIN_NUMBER = process.env.ADMIN_WA_NUMBER;

// IMPORT GEMINI
// const { GoogleGenAI } = require("@google/genai");

// IMPORT GROQ
const Groq = require("groq-sdk");

const dbService = require('./db_service');
const { findBestMatch } = require('./levenshtein');
const { db, run, get, all, getLinkedUser, saveLinkedUser } = require('./analytics_db'); // <--- PASTIKAN ADA INI
const analyticsDb = require('./analytics_db');

const app = express();
const port = process.env.PORT || 3003;

// =======================================================
// IN-MEMORY CACHE UNTUK PERFORMA
// =======================================================
// Cache untuk getUserMode dan getLinkedUser dengan TTL 5 menit
const userModeCache = new Map(); // { phoneNumber: { mode: 'bot', expiry: timestamp } }
const linkedUserCache = new Map(); // { nomor_wa: { data: {...}, expiry: timestamp } }
const CACHE_TTL = 5 * 60 * 1000; // 5 menit dalam ms

function getCachedUserMode(phoneNumber) {
    const cached = userModeCache.get(phoneNumber);
    if (cached && cached.expiry > Date.now()) {
        return cached.mode;
    }
    return null;
}

function setCachedUserMode(phoneNumber, mode) {
    userModeCache.set(phoneNumber, { mode, expiry: Date.now() + CACHE_TTL });
}

function invalidateCachedUserMode(phoneNumber) {
    userModeCache.delete(phoneNumber);
}

function getCachedLinkedUser(nomor_wa) {
    const cached = linkedUserCache.get(nomor_wa);
    if (cached && cached.expiry > Date.now()) {
        return cached.data;
    }
    return null;
}

function setCachedLinkedUser(nomor_wa, data) {
    linkedUserCache.set(nomor_wa, { data, expiry: Date.now() + CACHE_TTL });
}

function invalidateCachedLinkedUser(nomor_wa) {
    linkedUserCache.delete(nomor_wa);
}

// =======================================================
// DB SQLITE: FUNGSI HUMAN MODE (CHAT PUSTAKAWAN)
// =======================================================

// Tabel dibuat otomatis oleh analytics_db.js (initTable) saat koneksi berhasil

// 2. Fungsi untuk mengambil status user (dengan cache)
async function getUserMode(phoneNumber) {
    // Cek cache dulu
    const cached = getCachedUserMode(phoneNumber);
    if (cached !== null) {
        return cached;
    }
    
    // Cache miss, query DB
    try {
        const row = await analyticsDb.get(`SELECT mode FROM user_status WHERE phone_number = ?`, [phoneNumber]);
        const mode = row ? row.mode : 'bot';
        setCachedUserMode(phoneNumber, mode);
        return mode;
    } catch (err) {
        console.error("Error getUserMode:", err.message);
        return 'bot';
    }
}

// 3. Fungsi untuk mengubah status user
async function setUserMode(phoneNumber, mode) {
    try {
        // INSERT ... ON CONFLICT DO UPDATE (PostgreSQL, setara REPLACE INTO di SQLite)
        await analyticsDb.run(`
            INSERT INTO user_status (phone_number, mode, updated_at)
            VALUES (?, ?, NOW())
            ON CONFLICT (phone_number) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()
        `, [phoneNumber, mode]);
        
        // Update cache
        setCachedUserMode(phoneNumber, mode);
    } catch (err) {
        console.error("Error setUserMode:", err.message);
    }
}
// =======================================================

// Wrapper getLinkedUser dengan cache
async function getLinkedUserCached(nomor_wa) {
    const cached = getCachedLinkedUser(nomor_wa);
    if (cached !== null) {
        return cached;
    }
    // Cache miss, query DB
    const data = await getLinkedUser(nomor_wa);
    setCachedLinkedUser(nomor_wa, data || false); // simpan false jika tidak ditemukan
    return data || null;
}

// Wrapper saveLinkedUser dengan invalidate cache
async function saveLinkedUserCached(nomor_wa, identitas_id, nama, role, status_verifikasi) {
    await saveLinkedUser(nomor_wa, identitas_id, nama, role, status_verifikasi);
    invalidateCachedLinkedUser(nomor_wa); // invalidate agar next read ambil dari DB
}

// =======================================================

// Izinkan pesan JSON hingga 1MB (default cuma 100kb)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// =======================================================
// SESSION & KEAMANAN ADMIN PANEL
// =======================================================

// Trust reverse proxy (agar session/cookie berfungsi di balik Nginx kampus)
app.set('trust proxy', 1);

// Middleware: konversi header Front-End-Https (dari reverse proxy kampus) ke X-Forwarded-Proto
// Ini diperlukan agar Express trust proxy bisa mendeteksi HTTPS dan set Secure cookie
app.use((req, res, next) => {
    if (req.headers['front-end-https'] === 'on' && !req.headers['x-forwarded-proto']) {
        req.headers['x-forwarded-proto'] = 'https';
    }
    next();
});

const SESSION_SECRET = process.env.SESSION_SECRET || 'chatbot-perpus-secret-key-ganti-ini';

app.use(session({
    store: new pgSession({
        pool: analyticsDb.pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        httpOnly: true,
        secure: 'auto',   // auto: Secure flag ikut protocol yang terdeteksi (HTTPS via proxy)
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000 // 8 jam
    }
}));

// Brute-force protection: in-memory store { ip: { count, lockedUntil } }
const loginAttempts = {};
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 menit

function checkBruteForce(ip) {
    const now = Date.now();
    if (!loginAttempts[ip]) return { locked: false };
    const entry = loginAttempts[ip];
    if (entry.lockedUntil && now < entry.lockedUntil) {
        const sisaMenit = Math.ceil((entry.lockedUntil - now) / 60000);
        return { locked: true, sisaMenit };
    }
    if (entry.lockedUntil && now >= entry.lockedUntil) {
        delete loginAttempts[ip]; // reset setelah lockout selesai
    }
    return { locked: false };
}

function recordFailedLogin(ip) {
    if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0 };
    loginAttempts[ip].count++;
    if (loginAttempts[ip].count >= MAX_LOGIN_ATTEMPTS) {
        loginAttempts[ip].lockedUntil = Date.now() + LOCKOUT_DURATION;
        console.warn(`[AUTH] IP ${ip} dikunci ${LOCKOUT_DURATION / 60000} menit karena ${MAX_LOGIN_ATTEMPTS}x gagal login.`);
    }
}

function resetLoginAttempts(ip) {
    delete loginAttempts[ip];
}

// Middleware: cek apakah sudah login
const requireLogin = (req, res, next) => {
    if (req.session && req.session.adminId) return next();
    // Jika request API (bukan halaman HTML), kembalikan JSON
    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Sesi habis. Silakan login kembali.' });
    }
    return res.redirect('/login');
};

// =======================================================
// ROUTE AUTH: LOGIN, LOGOUT, FORGOT PASSWORD
// =======================================================

// Halaman login
app.get('/', (req, res) => res.redirect('/admin'));

app.get('/login', (req, res) => {
    if (req.session && req.session.adminId) return res.redirect('/admin');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Proses login
app.post('/auth/login', async (req, res) => {
    const ip = req.ip;
    const { username, password } = req.body;

    // Cek brute-force
    const bf = checkBruteForce(ip);
    if (bf.locked) {
        return res.status(429).json({ error: `Terlalu banyak percobaan login. Coba lagi dalam ${bf.sisaMenit} menit.` });
    }

    if (!username || !password) {
        return res.status(400).json({ error: 'Username dan password wajib diisi.' });
    }

    try {
        const user = await analyticsDb.getAdminUserByUsername(username.trim());
        if (!user) {
            recordFailedLogin(ip);
            return res.status(401).json({ error: 'Username atau password salah.' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            recordFailedLogin(ip);
            return res.status(401).json({ error: 'Username atau password salah.' });
        }

        // Login berhasil
        resetLoginAttempts(ip);
        req.session.adminId = user.id;
        req.session.adminUsername = user.username;
        req.session.adminNama = user.nama;
        await analyticsDb.updateLastLogin(user.id);

        return res.json({ success: true, nama: user.nama });
    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        return res.status(500).json({ error: 'Terjadi kesalahan server.' });
    }
});

// Logout
app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// Forgot password: request OTP
app.post('/auth/forgot-password', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username wajib diisi.' });

    try {
        const user = await analyticsDb.getAdminUserByUsername(username.trim());
        // Selalu balas sukses agar tidak bocorkan info username mana yang terdaftar
        if (!user || !user.nomor_wa) {
            return res.json({ success: true, message: 'Jika username terdaftar, OTP akan dikirim ke WhatsApp Anda.' });
        }

        const otp = await analyticsDb.createOtp(user.username);
        const waTarget = user.nomor_wa.replace(/[^0-9]/g, '') + '@c.us';
        const pesanOtp = `*[ADMIN PANEL]*\nKode OTP reset password Anda:\n\n*${otp}*\n\nKode berlaku 5 menit. Jangan berikan kepada siapapun.`;

        await axios.post(WA_GATEWAY_URL, { to: waTarget, message: pesanOtp });
        console.log(`[AUTH] OTP dikirim ke ${user.nomor_wa} untuk user '${user.username}'`);

        return res.json({ success: true, message: 'Jika username terdaftar, OTP akan dikirim ke WhatsApp Anda.' });
    } catch (err) {
        console.error('[AUTH] Forgot password error:', err.message);
        return res.status(500).json({ error: 'Gagal mengirim OTP. Pastikan WhatsApp bot aktif.' });
    }
});

// Reset password: verifikasi OTP lalu ganti password
app.post('/auth/reset-password', async (req, res) => {
    const { username, otp, new_password } = req.body;
    if (!username || !otp || !new_password) {
        return res.status(400).json({ error: 'Username, OTP, dan password baru wajib diisi.' });
    }
    if (new_password.length < 8) {
        return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
    }

    try {
        const valid = await analyticsDb.verifyOtp(username.trim(), otp.trim());
        if (!valid) {
            return res.status(400).json({ error: 'OTP salah atau sudah kadaluarsa.' });
        }

        const user = await analyticsDb.getAdminUserByUsername(username.trim());
        if (!user) return res.status(400).json({ error: 'User tidak ditemukan.' });

        await analyticsDb.updateAdminPassword(user.id, new_password);
        console.log(`[AUTH] Password user '${username}' berhasil direset.`);
        return res.json({ success: true, message: 'Password berhasil direset. Silakan login.' });
    } catch (err) {
        console.error('[AUTH] Reset password error:', err.message);
        return res.status(500).json({ error: 'Terjadi kesalahan server.' });
    }
});

// =======================================================
// ROUTE HALAMAN ADMIN
// =======================================================

app.get('/admin', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API: info sesi yang sedang login
app.get('/admin/me', requireLogin, (req, res) => {
    res.json({ id: req.session.adminId, username: req.session.adminUsername, nama: req.session.adminNama });
});

// =======================================================
// ROUTE API MANAJEMEN USER ADMIN
// =======================================================

// GET semua admin user
app.get('/admin/users', requireLogin, async (req, res) => {
    try {
        const users = await analyticsDb.getAllAdminUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST buat admin user baru
app.post('/admin/users', requireLogin, async (req, res) => {
    const { username, password, nama, nomor_wa } = req.body;
    if (!username || !password || !nama || !nomor_wa) {
        return res.status(400).json({ error: 'Semua field wajib diisi.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password minimal 8 karakter.' });
    }
    try {
        await analyticsDb.createAdminUser(username.trim(), password, nama.trim(), nomor_wa.trim());
        res.json({ success: true, message: `Akun '${username}' berhasil dibuat.` });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Username sudah digunakan.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT update admin user (nama & nomor WA)
app.put('/admin/users/:id', requireLogin, async (req, res) => {
    const { nama, nomor_wa } = req.body;
    if (!nama || !nomor_wa) return res.status(400).json({ error: 'Nama dan nomor WA wajib diisi.' });
    try {
        await analyticsDb.updateAdminUser(req.params.id, nama.trim(), nomor_wa.trim());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT reset password admin user oleh admin lain
app.put('/admin/users/:id/password', requireLogin, async (req, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
        return res.status(400).json({ error: 'Password minimal 8 karakter.' });
    }
    // Cegah admin menghapus password dirinya sendiri via endpoint ini
    if (parseInt(req.params.id) === req.session.adminId) {
        return res.status(403).json({ error: 'Gunakan fitur forgot password untuk mengubah password sendiri.' });
    }
    try {
        await analyticsDb.updateAdminPassword(req.params.id, new_password);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE admin user
app.delete('/admin/users/:id', requireLogin, async (req, res) => {
    if (parseInt(req.params.id) === req.session.adminId) {
        return res.status(403).json({ error: 'Tidak bisa menghapus akun sendiri.' });
    }
    try {
        await analyticsDb.deleteAdminUser(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =======================================================
// MANAGEMENT SESI
// =======================================================
const sessionHistory = {};
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 Menit

const userMonitor = {}; // Database memori untuk mencatat perilaku user

const spamFilter = {}; // <--- Penampung log spam

// Konfigurasi Batas
const SPAM_COOLDOWN = 1000; // 1000 ms = 1 detik jeda antar pesan

const RULES = {
    WINDOW_MS: 60 * 1000,        // Jendela waktu: 1 Menit
    MAX_MSG_PER_WINDOW: 22,      // Maksimal 10 pesan per menit (Wajar)
    BAN_DURATION: 30 * 60 * 1000,// Hukuman Blokir: 30 Menit
    MAX_CHAR: 300
};

// =======================================================
// KONFIGURASI AI
// =======================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error(
        "ERROR: GEMINI_API_KEY tidak ditemukan. Pastikan Anda telah membuat file .env di folder ini dan menginstal dotenv."
    );
    process.exit(1);
}

// KONEKSI KE API GEMINI
// const genAI = new GoogleGenAI(GEMINI_API_KEY, { config: { timeout: 30000 } });

// KONEKSI KE API GROQ
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// File path ke data respons
const RESPONSES_FILE_PATH = "./responses.json";

// =========================================================
// VARIABEL GLOBAL UNTUK ACTIVE TIMER HUMAN MODE
// =========================================================
const humanModeTimers = {};
const HUMAN_MODE_TIMEOUT = parseFloat(process.env.HUMAN_MODE_TIMEOUT_HOURS || '2') * 60 * 60 * 1000;

// Fungsi untuk memulai atau mereset timer aktif
function startActiveHumanTimer(fromWaId) {
    // 1. Bersihkan timer lama jika ada (Reset)
    if (humanModeTimers[fromWaId]) {
        clearTimeout(humanModeTimers[fromWaId]);
    }

    // 2. Mulai hitung mundur baru
    humanModeTimers[fromWaId] = setTimeout(async () => {
        console.log(`[TIMEOUT AKTIF] Waktu habis untuk ${fromWaId}, mengembalikan ke Bot.`);
        
        try {
            // A. Kembalikan state ke Bot di database
            await setUserMode(fromWaId, 'bot');
            
            // B. PROAKTIF: Suruh Gateway mengirim pesan otomatis ke user
            await axios.post(WA_GATEWAY_URL, {
                to: fromWaId,
                message: "⚠️ *Sesi Operator Berakhir*\nKarena tidak ada aktivitas dari operator, sesi ini ditutup otomatis.\n\nKetik *Menu* untuk memanggil bot."
            });
        } catch (err) {
            console.error("Gagal mengeksekusi Active Timeout:", err.message);
        }
        
        // Hapus jejak timer dari memori
        delete humanModeTimers[fromWaId];
    }, HUMAN_MODE_TIMEOUT);
}

// Fungsi untuk menghentikan timer secara manual (jika user ketik !bot)
function stopActiveHumanTimer(fromWaId) {
    if (humanModeTimers[fromWaId]) {
        clearTimeout(humanModeTimers[fromWaId]);
        delete humanModeTimers[fromWaId];
    }
}

// =======================================================
// FUNGSI UTILITY & DATA HANDLING
// =======================================================

/**
 * MEMBERSIHKAN NAMA USER (SECURITY)
 * 1. Menghapus karakter berbahaya (Script tag).
 * 2. Membatasi panjang karakter.
 * 3. Menghapus karakter aneh (Zalgo/Invisible).
 */
function sanitizeName(rawName) {
    if (!rawName) return "Pemustaka";

    // 1. Ambil hanya huruf, angka, spasi, dan tanda baca umum
    // Regex ini membuang simbol aneh dan emoji yang berpotensi merusak layout
    // (Opsional: Jika ingin support Emoji, hapus baris ini)
    let clean = rawName.replace(/[^\w\s\.\-@]/gi, '');

    // 2. Cegah XSS sederhana (Ganti < dan >)
    clean = clean.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // 3. Batasi Panjang Maksimal (Misal 20 karakter)
    if (clean.length > 20) {
        clean = clean.substring(0, 20) + "...";
    }

    // 4. Jika setelah dibersihkan jadi kosong, pakai default
    if (clean.trim().length === 0) return "Pemustaka";

    return clean;
}

// Fungsi untuk membaca dan memuat data respons
const readResponsesData = () => {
    try {
        const data = fs.readFileSync(RESPONSES_FILE_PATH, "utf8");
        return JSON.parse(data);
    } catch (error) {
        console.error(
            "ERROR: Gagal membaca atau parsing responses.json. Menggunakan struktur default.",
            error
        );
        return {
            flow_messages: {},
            system_commands: {},
            general_services: {},
            member_services: {},
            academic_services: {},
        };
    }
};

// Fungsi untuk menulis dan menyimpan data respons ke file
const writeResponsesData = (data) => {
    try {
        if (data.id) delete data.id; 
        fs.writeFileSync(RESPONSES_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
        responsesData = readResponsesData(); 
        return true;
    } catch (error) {
        console.error("ERROR: Gagal menulis responses.json.", error);
        return false;
    }
};

// --- TAMBAHAN BARU: FUNGSI BACKUP & VALIDASI ---

// 1. Buat folder backups jika belum ada
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR);
}

// 2. Fungsi Validasi Struktur JSON
const validateResponseData = (data) => {
    if (typeof data !== 'object' || data === null) return false;
    
    // Cek apakah kategori wajib ada?
    const requiredCategories = ['system_commands', 'flow_messages', 'general_services'];
    for (const cat of requiredCategories) {
        if (!data[cat]) {
            console.error(`[VALIDATION FAIL] Kategori wajib hilang: ${cat}`);
            return false;
        }
    }
    return true;
};

// 3. Fungsi Rotate Backup — simpan MAX_BACKUPS file terbaru, hapus sisanya
const MAX_BACKUPS = 7;
const rotateBackups = () => {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('responses-') && f.endsWith('.json'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(BACKUP_DIR, f)).mtime
            }))
            .sort((a, b) => b.time - a.time); // terbaru di depan

        const toDelete = files.slice(MAX_BACKUPS);
        toDelete.forEach(f => {
            fs.unlinkSync(path.join(BACKUP_DIR, f.name));
            console.log(`[BACKUP] Backup lama dihapus: ${f.name}`);
        });

        if (toDelete.length === 0) {
            console.log(`[BACKUP] Rotasi: tidak ada file lama yang perlu dihapus (total: ${files.length})`);
        } else {
            console.log(`[BACKUP] Rotasi selesai: ${toDelete.length} file dihapus, ${Math.min(files.length, MAX_BACKUPS)} file dipertahankan`);
        }
    } catch (error) {
        console.error("[BACKUP ERROR] Gagal melakukan rotasi backup:", error);
    }
};

// 4. Fungsi Auto-Backup
const createBackup = () => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `responses-${timestamp}.json`;
        const backupPath = path.join(BACKUP_DIR, backupFilename);
        
        // Copy file responses.json saat ini ke folder backup
        fs.copyFileSync(RESPONSES_FILE_PATH, backupPath);
        console.log(`[BACKUP] Berhasil membuat backup: ${backupFilename}`);

        // Rotasi: hapus backup lama jika melebihi MAX_BACKUPS
        rotateBackups();
        return true;
    } catch (error) {
        console.error("[BACKUP ERROR] Gagal membuat backup:", error);
        return false;
    }
};

const logInteraction = async (userId, msgIn, msgOut, context) => {
    try {
        // Cari info identitas user: cek linked_users dulu, fallback ke MySQL anggota
        let nama = null;
        let identitas_id = null;

        try {
            const linked = await analyticsDb.getLinkedUser(userId);
            if (linked) {
                nama = linked.nama;
                identitas_id = linked.identitas_id;
            } else {
                // Fallback: cari di MySQL berdasarkan nomor WA
                const noTelp = userId.replace('@c.us', '');
                const anggota = await dbService.cariAnggotaByTelepon(noTelp);
                if (anggota) {
                    nama = anggota.Nama;
                    identitas_id = anggota.No_Anggota;
                }
            }
        } catch (e) {
            // Gagal lookup identitas tidak menghentikan pencatatan log
        }

        await analyticsDb.run(
            "INSERT INTO chat_logs (user_id, message_in, message_out, context, nama, identitas_id) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, msgIn, msgOut, context, nama, identitas_id]
        );
    } catch (error) {
        console.error("Gagal mencatat log analytics:", error);
    }
};

// Fungsi pembantu untuk menentukan konteks berdasarkan input user
const determineContext = (text) => {
    const menuMap = {
        '1': 'Pencarian Buku',
        '2': 'Cek Pinjaman Buku',
        '3': 'Informasi Tata Tertib',
        '4': 'SKBP',
        '5': 'Informasi Tugas Akhir',
        '6': 'Koleksi Digital',
        '7': 'Uji Similarity (Turnitin)',
        '8': 'Chat Pustakawan'
    };
    return menuMap[text.trim()] || 'General Chat / AI';
};

let responsesData = readResponsesData(); // Muat data saat startup

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (text) => text.toLowerCase().trim();

// =======================================================
// FUNGSI AKSES DATABASE (BARU)
// =======================================================

/**
 * Mencari buku berdasarkan ID_Buku
 * @param {string} idBuku 
 * @returns object buku atau null
 */
async function cariBukuById(idBuku) {
    try {
        // Query disesuaikan dengan kolom tabel yang Anda berikan
        const [rows] = await db.execute(
            'SELECT ID_Buku, Judul_Buku, Pengarang, Tahun, Call_Number, ISBN FROM buku WHERE ID_Buku = ?',
            [idBuku]
        );
        return rows[0]; // Mengembalikan baris pertama atau undefined
    } catch (error) {
        console.error("[DATABASE ERROR] Saat mencari ID Buku:", error);
        return null;
    }
}



/**
 * Mendapatkan semua kata kunci statis untuk AI Safety Check
 */
const getAllStaticKeywords = () => {
    const currentResponses = responsesData;
    const categories = ["general_services", "member_services", "academic_services"];
    let keywords = [];
    categories.forEach(category => {
        if (currentResponses[category]) {
            keywords = keywords.concat(
                Object.keys(currentResponses[category]).filter((k) => isNaN(k) && k.length > 1)
            );
        }
    });
    return keywords;
};

/**
 * Fungsi pencarian kecocokan respons statis
 */
const getStaticReply = (normalizedMessage) => {
    const categories = ["system_commands", "general_services", "member_services", "academic_services"];
    for (const category of categories) {
        if (responsesData[category]) {
            if (responsesData[category][normalizedMessage]) {
                console.log(`[STATIC] Pesan cocok dengan ${category}: ${normalizedMessage}`);
                return responsesData[category][normalizedMessage];
            }
            for (const key in responsesData[category]) {
                if (key.length > 1 && normalizedMessage.includes(key.toLowerCase().trim())) {
                    console.log(`[STATIC] Pesan cocok dengan ${category} (Partial Match): ${key}`);
                    return responsesData[category][key];
                }
            }
        }
    }
    return null;
};

/**
 * AI Safety Check
 */
const isTooSimilarToStatic = (normalizedMessage) => {
    const allStaticKeywords = getAllStaticKeywords();
    return allStaticKeywords.some(
        (key) => normalizedMessage.includes(key.toLowerCase().trim()) && normalizedMessage.length < key.length + 10
    );
};

/**
 * Reset Sesi
 */
const resetSessionState = (from) => {
    if (sessionHistory[from]) {
        sessionHistory[from].state = "main_menu"; 
        console.log(`[SESSION] State pengguna ${from} direset ke 'main_menu'.`);
    }
};

/**
 * FUNGSI HELPER: Menangani logika pencarian judul & formatting teks
 * Digunakan oleh state 'waiting_for_judul' dan 'waiting_for_book_id'
 */
async function handleTitleSearch(keyword, userSession) {
    // 1. Validasi Panjang
    if (keyword.length < 3) {
        return { 
            reply_message: `⚠️ Kata kunci *"${keyword}"* terlalu pendek. Harap masukkan minimal 3 huruf.` 
        };
    }

    // 2. Panggil Database
    const bookList = await dbService.cariBukuByJudul(keyword);

    // 3. Format Hasil (Jika Ada)
    if (bookList.length > 0) {
        // PENTING: Apapun state asalnya, jika berhasil cari judul, 
        // state user dikunci ke 'waiting_for_book_id' agar bisa input ID setelahnya.
        userSession.state = "waiting_for_book_id";

        let reply = `📚 *HASIL PENCARIAN BUKU*\n`;
        reply += `Kata kunci: _"${keyword}"_\n\n`;

        bookList.forEach((buku, index) => {
            reply += `${index + 1}.\n`; 
            reply += `Judul: *${buku.Judul_Buku}*\n`;
            reply += `Pengarang: ${buku.Pengarang}\n`;
            reply += `Tahun: ${buku.Tahun}\n`;
            reply += `ID: ${buku.ID_Buku}\n`;
            reply += `--------------------\n\n`;
        });

        // Tambahkan pesan kaki jika hasil mencapai limit
        if (bookList.length === 10) {
            reply += `_⚠️ Menampilkan 10 buku terbaru. Jika buku yang dicari tidak ada, mohon ulangi pencarian dengan kata kunci yang lebih spesifik._\n\n`;
        }

        reply += `\nSilakan masukkan *ID BUKU* di atas (misal: ${bookList[0].ID_Buku}) untuk melihat detail & ketersediaan buku.\n`;
        reply += `Atau ketik *Judul Lain* untuk mencari ulang.\n`;
        reply += `\nKetik *MENU* untuk layanan lain.`;
        
        return { reply_message: reply, found: true }; // Return found: true
    } 

    // 4. Jika Tidak Ditemukan
    return { found: false }; 
}

/**
 * FUNGSI HELPER: Menangani logika pencarian PENGARANG
 */
async function handleAuthorSearch(keyword, userSession) {
    // 1. Validasi Panjang (Nama pengarang biasanya pendek, misal "Boy", jadi min 3 huruf oke)
    if (keyword.length < 2) {
        return { 
            reply_message: `⚠️ Nama pengarang *"${keyword}"* terlalu pendek. Harap masukkan minimal 3 huruf.` 
        };
    }

    // 2. Panggil Database (Fungsi Baru)
    const bookList = await dbService.cariBukuByPengarang(keyword);

    // 3. Format Hasil
    if (bookList.length > 0) {
        // SETELAH KETEMU, KITA PINDAL KE MODE HYBRID (Bisa input ID)
        userSession.state = "waiting_for_book_id";

        let reply = `👤 *HASIL PENCARIAN PENGARANG*\n`;
        reply += `Kata kunci: _"${keyword}"_\n\n`;

        bookList.forEach((buku, index) => {
            reply += `${index + 1}.\n`; 
            reply += `Pengarang: *${buku.Pengarang}*\n`;
            reply += `Judul: ${buku.Judul_Buku}\n`;
            reply += `Tahun: ${buku.Tahun}\n`;
            reply += `ID: *${buku.ID_Buku}*\n`;
            reply += `--------------------\n\n`;
        });

        if (bookList.length === 10) {
            reply += `_⚠️ Menampilkan 10 buku terbaru._\n\n`;
        }

        reply += `\nSilakan *Ketik ID BUKU* di atas untuk detail.\n`;
        reply += `Atau ketik *Judul/Pengarang Lain* untuk mencari ulang.\n`; // Note: Logic hybrid kita saat ini baru support cari Judul ulang, nanti bisa diupgrade.
        reply += `\n\nKetik *MENU* untuk layanan lain.`;
        
        return { reply_message: reply, found: true };
    } 

    return { found: false }; 
}

/**
 * FUNGSI HELPER: Menangani logika pencarian UNIVERSAL (Judul & Pengarang)
 * Digunakan oleh state 'waiting_for_book_input'
 */
async function handleUniversalSearch(keyword, userSession) {
    // 1. Validasi Panjang
    if (keyword.length < 3) {
        return { 
            reply_message: `⚠️ Kata kunci *"${keyword}"* terlalu pendek. Harap masukkan minimal 3 huruf.` 
        };
    }

    // 2. Panggil Database (Fungsi Universal)
    const bookList = await dbService.searchBooksUniversal(keyword);

    // 3. Format Hasil (Jika Ada)
    if (bookList.length > 0) {
        // PENTING: Kunci state ke 'waiting_for_book_id' agar input selanjutnya dianggap ID
        userSession.state = "waiting_for_book_id";

        let reply = `📚 *HASIL PENCARIAN BUKU*\n`;
        reply += `Kata kunci: _"${keyword}"_\n\n`;

        bookList.forEach((buku, index) => {
            reply += `${index + 1}.\n`; 
            reply += `Judul: *${buku.Judul_Buku}*\n`;
            reply += `Pengarang: ${buku.Pengarang}\n`;
            reply += `Tahun: ${buku.Tahun}\n`;
            reply += `ID: ${buku.ID_Buku}\n`;
            reply += `--------------------\n\n`;
        });

        // Tambahkan pesan kaki jika hasil mencapai limit
        if (bookList.length >= 5) { // Limit di query biasanya 5 atau 10
            reply += `_⚠️ Menampilkan hasil teratas. Jika buku yang dicari tidak ada, mohon ulangi dengan kata kunci yang lebih spesifik._\n\n`;
        }

        reply += `Silakan masukkan *ID BUKU* di atas (misal: *${bookList[0].id || 'B001'}*) untuk melihat detail & ketersediaan.\n`;
        reply += `Atau ketik *Judul Lain* untuk mencari ulang.\n`;
        reply += `\nKetik *MENU* untuk layanan lain.`;
        
        return { reply_message: reply, found: true }; 
    } 

    // 4. Jika Tidak Ditemukan
    return { found: false }; 
}

/**
 * FUNGSI HELPER: Menangani Cek Status Anggota
 */
async function handleMemberCheck(nim, userSession) {
    // Validasi format NIM (Misal harus angka)
    if (!/^\d+$/.test(nim)) {
        return { reply_message: "⚠️ Format NIM salah. Harap masukkan angka saja.\n\nKetik *MENU* untuk layanan lain." };
    }

    const data = await dbService.cekStatusAnggota(nim);

    if (!data) {
        return { 
            reply_message: `⚠️ Data anggota dengan NIM/ID *${nim}* tidak ditemukan di sistem perpustakaan.\n\nSilakan periksa kembali dan ketik ulang, atau ketik *MENU* untuk kembali.`
        };
    }

    // Format Pesan Balasan
    let reply = `👤 *INFO ANGGOTA & PEMINJAMAN*\n\n`;
    reply += `Nama: *${data.Nama}*\n`;
    reply += `NIM: ${data.No_Anggota}\n`;
    
    const jumlahPinjam = data.Pinjaman.length;
    reply += `\n📚 *Status Pinjaman: ${jumlahPinjam} Buku*\n`;

    if (jumlahPinjam > 0) {
        reply += `_Daftar buku yang belum dikembalikan:_\n`;
        data.Pinjaman.forEach((item, idx) => {
            // Format Tanggal agar cantik (Opsional: pakai library moment/date-fns kalau mau lebih rapi)
            const tglKembali = new Date(item.Tgl_Seharusnya).toLocaleDateString('id-ID');
            
            reply += `\n${idx + 1}. *${item.Judul_Buku}*\n`;
            reply += `   🗓️ Tenggat: ${tglKembali}\n`;
        });
        
        reply += `\n⚠️ _Mohon kembalikan tepat waktu untuk menghindari denda._\n`;
    } else {
        reply += `✅ _Tidak ada tanggungan peminjaman._\n`;
    }

    reply += `\nKetik *MENU* untuk layanan lain.`;

    // Reset state karena transaksi selesai
    return { reply_message: reply, success: true };
}

// =======================================================
// LOGIKA UTAMA CHATBOT (CREATE RESPONSE)
// =======================================================
const createResponse = async (message, from, userName, finalNumber) => {
    const normalizedMessage = message.toLowerCase().trim();
    
    const currentTime = Date.now();

    // --- SECURITY LEVEL 1: RATE LIMITER (Anti Spam) ---
    if (spamFilter[from]) {
        const timeDiff = currentTime - spamFilter[from];
        if (timeDiff < SPAM_COOLDOWN) {
            console.warn(`[SPAM] Mengabaikan pesan cepat dari ${from}`);
            return null; // JANGAN BALAS APAPUN (Silent Block)
        }
    }
    // Update waktu terakhir user kirim pesan
    spamFilter[from] = currentTime;

    // --- SECURITY LEVEL 2: INTELLIGENT BAN SYSTEM ---
    
    // 1. Inisialisasi Data User
    if (!userMonitor[from]) {
        userMonitor[from] = { count: 0, windowStart: currentTime, banUntil: 0 };
    }
    const userData = userMonitor[from];

    // 2. CEK STATUS BANNED
    if (userData.banUntil > currentTime) {
        const sisaWaktu = Math.ceil((userData.banUntil - currentTime) / 1000);
        console.log(`[BLOCKED] User ${from} mencoba kirim pesan. Sisa ban: ${sisaWaktu} detik.`);
        return null; 
    }

    // 3. LOGIKA JENDELA WAKTU
    if (currentTime - userData.windowStart > RULES.WINDOW_MS) {
        console.log(`[SECURITY] Reset counter untuk ${from} (Menit baru).`);
        userData.count = 1;
        userData.windowStart = currentTime;
    } else {
        userData.count++;
    }

    // --- LOG DETEKTIF (PENTING BUAT DEBUG) ---
    console.log(`[SECURITY CHECK] User: ${from} | Count: ${userData.count} / ${RULES.MAX_MSG_PER_WINDOW}`);

    // 4. EKSEKUSI HUKUMAN
    if (userData.count > RULES.MAX_MSG_PER_WINDOW) {
        console.warn(`[SECURITY] User ${from} DIBLOKIR sementara.`);
        userData.banUntil = currentTime + RULES.BAN_DURATION;
        return { 
            reply_message: `⛔ *SISTEM KEAMANAN*\n\nAnda mengirim pesan terlalu cepat (Spam).\nAkses diblokir selama 30 menit.` 
        };
    }

    // --- SECURITY LEVEL 3: INPUT SANITIZATION ---
    
    // [DEBUG] Tampilkan panjang pesan di terminal agar kita tahu
    console.log(`[SECURITY] Panjang Pesan User: ${message.length} karakter`);

    // Gunakan RULES.MAX_CHAR yang sudah kita definisikan
    if (message.length > RULES.MAX_CHAR) {
        console.warn(`[SECURITY] Pesan ditolak karena terlalu panjang (${message.length} > ${RULES.MAX_CHAR})`);
        return { 
            reply_message: `⚠️ *Pesan Terlalu Panjang*\n\nPesan Anda mengandung ${message.length} karakter (Batas: ${RULES.MAX_CHAR}).\nMohon persingkat pertanyaan Anda agar bisa diproses.` 
        };
    }

    // =======================================================
    // LOGIKA SESI TERINTEGRASI (UNIFIED SESSION)
    // =======================================================
    
    let isNewSession = false; //

    if (!sessionHistory[from]) {
        sessionHistory[from] = { last_time: currentTime, state: null }; 
        isNewSession = true; // Tandai bahwa ini adalah awal percakapan
    }
    const userSession = sessionHistory[from]; 
    userSession.last_time = currentTime;

    // =========================================================
    // 3. GERBANG PENDAFTARAN (OPTIMISTIC ONBOARDING)
    // =========================================================
    // Skip query DB jika user sedang dalam proses onboarding (pasti belum terdaftar)
    const onboardingStates = ['waiting_for_role', 'waiting_for_nim', 'waiting_for_nidn', 'waiting_for_guest_name', 'waiting_for_dosen_manual_name', 'waiting_for_confirmation'];
    const isOnboarding = onboardingStates.includes(userSession.state);
    const linkedUser = isOnboarding ? null : await getLinkedUserCached(finalNumber);

    let rawName = userName;
    if (rawName && rawName.startsWith('+')) rawName = "Pemustaka";
    let fallbackName = sanitizeName ? sanitizeName(rawName) : rawName; 

    const displayName = linkedUser ? linkedUser.nama : fallbackName;

    if (!linkedUser) {
        // A. Sapaan Awal & Pilih Peran 
        if (!userSession.state) {
            userSession.state = "waiting_for_role";
            return {
                reply_message: `Halo *${displayName}*, selamat datang di PustakaBot! 👋\n\nUntuk menyesuaikan layanan, silakan pilih peran Anda dengan membalas angka:\n\n*1.* Mahasiswa\n*2.* Dosen / Tendik\n*3.* Tamu / Umum`
            };
        }

        // B. Evaluasi Pilihan Peran
        if (userSession.state === "waiting_for_role") {
            const inputRole = message.trim();
            if (inputRole === '1') {
                userSession.state = "waiting_for_nim";
                return { reply_message: "Silakan ketik *NIM* (Nomor Induk Mahasiswa) Anda untuk verifikasi:" };
            } else if (inputRole === '2') {
                userSession.state = "waiting_for_nidn";
                return { reply_message: "Silakan ketik *NIDN / NIP / NIK* Kampus Anda:" };
            } else if (inputRole === '3') {
                userSession.state = "waiting_for_guest_name";
                return { reply_message: "Baik, silakan ketik *Nama Lengkap* Anda:" };
            } else {
                return { reply_message: "⚠️ Pilihan tidak valid. Silakan balas dengan angka *1*, *2*, atau *3*." };
            }
        }

        // C. Alur MAHASISWA (Wajib ada di MySQL)
        if (userSession.state === "waiting_for_nim") {
            const inputNim = message.trim();
            if (inputNim.toLowerCase() === 'batal') {
                userSession.state = "waiting_for_role";
                return { reply_message: "Proses dibatalkan. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
            }
            if (inputNim === '3') {
                userSession.state = "waiting_for_guest_name";
                return { reply_message: "Baik, Anda akan melanjutkan sebagai *Tamu*.\n\nSilakan ketik *Nama Lengkap* Anda:" };
            }
            const cekDb = await dbService.getAnggotaByNim(inputNim);

            if (cekDb) {
                userSession.temp_id = cekDb.No_Anggota;
                userSession.temp_nama = cekDb.Nama;
                userSession.temp_role = "mahasiswa";
                userSession.state = "waiting_for_confirmation";
                return { reply_message: `Ditemukan data mahasiswa:\n\n*Nama:* ${cekDb.Nama}\n*NIM:* ${cekDb.No_Anggota}\n\nApakah data ini benar? Ketik *YA* atau *TIDAK*.` };
            } else {
                return { reply_message: `⚠️ Maaf, NIM *${inputNim}* tidak ditemukan di database.\n\nKemungkinan penyebab:\n• NIM yang dimasukkan salah\n• Data belum terdaftar di sistem perpustakaan\n\nSilakan ketik ulang NIM Anda, ketik *BATAL* untuk kembali ke pilihan peran, atau ketik *3* untuk melanjutkan sebagai *Tamu*.` };
            }
        }

        // D. Alur DOSEN/TENDIK (Cek MySQL, jika tidak ada -> PENDING)
        if (userSession.state === "waiting_for_nidn") {
            const inputNidn = message.trim();
            if (inputNidn.toLowerCase() === 'batal') {
                userSession.state = "waiting_for_role";
                return { reply_message: "Proses dibatalkan. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
            }
            const cekDb = await dbService.getAnggotaByNim(inputNidn); 

            if (cekDb) {
                userSession.temp_id = cekDb.No_Anggota;
                userSession.temp_nama = cekDb.Nama;
                userSession.temp_role = "dosen";
                userSession.state = "waiting_for_confirmation";
                return { reply_message: `Ditemukan data Dosen/Tendik:\n\n*Nama:* ${cekDb.Nama}\n*NIDN/NIP/NIK:* ${cekDb.No_Anggota}\n\nApakah data ini benar? Ketik *YA* atau *TIDAK*.` };
            } else {
                userSession.temp_id = inputNidn;
                userSession.state = "waiting_for_dosen_manual_name";
                return { reply_message: `ℹ️ NIDN/NIP/NIK *${inputNidn}* tidak ditemukan di database perpustakaan.\n\nJika Anda yakin data Anda sudah terdaftar, kemungkinan belum tersinkronisasi. Anda tetap bisa mendaftar secara manual dan akun Anda akan ditinjau oleh admin.\n\nPilihan Anda:\n• Ketik *Nama Lengkap* Anda untuk mendaftar manual (status: menunggu verifikasi admin)\n• Ketik *BATAL* untuk kembali ke pilihan peran\n• Ketik *3* untuk melanjutkan sebagai *Tamu* tanpa verifikasi` };
            }
        }

        // D-2. Lanjutan Dosen Manual (PENDING)
        if (userSession.state === "waiting_for_dosen_manual_name") {
            const inputName = message.trim();
            if (inputName.toLowerCase() === 'batal') {
                userSession.state = "waiting_for_role";
                delete userSession.temp_id;
                return { reply_message: "Proses dibatalkan. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
            }
            if (inputName === '3') {
                delete userSession.temp_id;
                userSession.state = "waiting_for_guest_name";
                return { reply_message: "Baik, Anda akan melanjutkan sebagai *Tamu*.\n\nSilakan ketik *Nama Lengkap* Anda:" };
            }
            await saveLinkedUserCached(finalNumber, userSession.temp_id, inputName, "dosen", "PENDING");
            userSession.state = "main_menu";
            delete userSession.temp_id;
            return {
                reply_message: [
                    `✅ Selamat datang, Bapak/Ibu *${inputName}*.\n\n_Catatan: Akun Anda dalam status peninjauan (Pending) oleh Admin untuk disinkronkan. Namun Anda sudah bisa menggunakan layanan bot._`,
                    responsesData.system_commands.menu
                ]
            };
        }

        // E. Alur TAMU UMUM
        if (userSession.state === "waiting_for_guest_name") {
            const guestName = message.trim();
            if (guestName.toLowerCase() === 'batal') {
                userSession.state = "waiting_for_role";
                return { reply_message: "Proses dibatalkan. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
            }
            const guestId = `GUEST_${finalNumber}`; 
            await saveLinkedUserCached(finalNumber, guestId, guestName, "tamu", "GUEST_ONLY");
            userSession.state = "main_menu";
            return {
                reply_message: [
                    `✅ Selamat datang, *${guestName}*! Anda mengakses layanan sebagai Tamu.`,
                    responsesData.system_commands.menu
                ]
            };
        }

        // F. Konfirmasi Validasi (Untuk Mahasiswa & Dosen yg ada di MySQL)
        if (userSession.state === "waiting_for_confirmation") {
            const jawaban = normalizedMessage;
            if (jawaban === 'ya') {
                await saveLinkedUserCached(finalNumber, userSession.temp_id, userSession.temp_nama, userSession.temp_role, "VERIFIED");
                const namaUser = userSession.temp_nama;
                
                userSession.state = "main_menu";
                delete userSession.temp_id;
                delete userSession.temp_nama;
                delete userSession.temp_role;

                // Setelah beres, tampilkan ucapan berhasil + menu
                return {
                    reply_message: [
                        `✅ *Verifikasi Berhasil!*\n\nNomor WA Anda telah terhubung dengan data atas nama *${namaUser}*.`,
                        responsesData.system_commands.menu
                    ]
                };
            } else if (jawaban === 'batal') {
                userSession.state = "waiting_for_role";
                return { reply_message: "Proses dibatalkan. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
            } else {
                const prevState = userSession.temp_role === "mahasiswa" ? "waiting_for_nim" : "waiting_for_nidn";
                userSession.state = prevState;
                delete userSession.temp_id;
                delete userSession.temp_nama;
                delete userSession.temp_role;
                return { reply_message: "Silakan ketik ulang NIM / NIDN Anda yang benar:" };
            }
        }

        if (normalizedMessage === 'batal') {
            userSession.state = "waiting_for_role";
            return { reply_message: "Pendaftaran diulang. Silakan pilih peran:\n1. Mahasiswa\n2. Dosen/Tendik\n3. Tamu/Umum" };
        }

        return { reply_message: "Silakan selesaikan proses pendaftaran terlebih dahulu, atau ketik *BATAL* untuk mengulang." }; 
    }

    // --- LOGIKA TAMPILAN MENU & GREETING ---

    // SKENARIO A: SESI BENAR-BENAR BARU (Pertama kali chat / setelah timeout)
    if (isNewSession) {
        userSession.state = "main_menu";

        const greetings = `Halo *${displayName}*! `;
        
        // Gabungkan: Sapaan Nama + Pesan Selamat Datang (dari JSON)
        const welcomeText = greetings + (responsesData.flow_messages.welcome_message || "Selamat datang di PustakaBot.");
        const menuText = responsesData.system_commands.menu;

        // Kirim 2 Bubble: [Sapaan+Intro, Menu]
        return { reply_message: [welcomeText, menuText] };
    }

    // SKENARIO B: USER KETIK "MENU" (Di tengah percakapan)
    if (normalizedMessage === "menu") {
        userSession.state = "main_menu";
        
        // Langsung tampilkan Menu saja (Tanpa "Halo Nama")
        // Tapi tetap kirim sebagai array biar konsisten (meski isinya cuma 1)
        return { reply_message: [responsesData.system_commands.menu] };
    }
    
    // --- 2. Cek 'END' Manual ---
    if (normalizedMessage === "end") {
        const reply = responsesData.flow_messages.session_end_message || "Terima kasih, sesi dihentikan.";
        delete sessionHistory[from]; 
        return { reply_message: reply };
    }
    
    // --- 3. LOGIKA STATEFUL (HANDLING INPUT USER BERDASARKAN KONTEKS) ---
    if (userSession.state !== "main_menu") {
        
        // >>> STATE: MENUNGGU JUDUL (UPDATE) <<<
        if (userSession.state === "waiting_for_judul") {
            const keyword = message.trim();
            console.log(`[DB SEARCH] Mencari judul mengandung: ${keyword}`);
            
            // Panggil Helper
            const searchResult = await handleTitleSearch(keyword, userSession);
            
            // Jika Helper mengembalikan balasan (baik sukses atau error validasi)
            if (searchResult.reply_message) {
                return { 
                    reply_message: searchResult.reply_message,
                    context: "Hasil Pencarian Buku By Judul" // <-- SPESIFIK PENCARIAN BUKU BY JUDUL  
                };

            }

            // Jika Helper bilang "found: false" (Tidak ketemu di DB)
            if (!searchResult.found) {
                // Jangan ubah state, beri kesempatan ulang
                return {
                    reply_message: `⚠️ Buku dengan kata kunci *"${keyword}"* tidak ditemukan.\nCoba kata kunci lain atau ketik *MENU*.`
                };
            }
        }

        // >>> STATE: MENUNGGU PENGARANG <<<
        if (userSession.state === "waiting_for_pengarang") {
            const keyword = message.trim();
            console.log(`[DB SEARCH] Mencari pengarang: ${keyword}`);

            // Panggil Helper Pengarang
            const searchResult = await handleAuthorSearch(keyword, userSession);

            if (searchResult.reply_message) {
                return { 
                    reply_message: searchResult.reply_message,
                    context: "Hasil Pencarian Buku By Pengarang" // <-- SPESIFIK PENCARIAN BUKU BY PENGARANG 
                };
            }

            if (!searchResult.found) {
                return {
                    reply_message: `⚠️ Tidak ditemukan buku karya pengarang *"${keyword}"* (20 tahun terakhir).\nCoba nama lain atau ketik *MENU*.`
                };
            }
        }

        // --- STATE: MENUNGGU INPUT BUKU (UNIVERSAL) ---
        if (userSession.state === 'waiting_for_book_input') {
            const input = normalizedMessage; // Input user (bisa judul, pengarang, atau ID)

            try {
                // A. COBA CARI SEBAGAI KATA KUNCI (Judul/Pengarang)
                const searchResult = await handleUniversalSearch(input, userSession);
                
                // Jika ketemu buku, langsung return hasilnya
                if (searchResult.found) {
                    return { reply_message: searchResult.reply_message };
                } else if (searchResult.reply_message) {
                    // Jika error validasi (misal kependekan), return errornya
                    return { reply_message: searchResult.reply_message };
                }

                // B. JIKA TIDAK KETEMU DI PENCARIAN, COBA CEK APAKAH INI ID BUKU?
                // (Fallback logic: User mungkin langsung ngetik ID "B001" tanpa nyari dulu)
                const detailBuku = await dbService.getDetailBukuLengkap(inputUser);

                if (detailBuku) {
                    // === KETEMU SEBAGAI ID ===
                    resetSessionState(from); // Reset ke menu (Selesai)
                    
                    let reply = `📖 *DETAIL BUKU PERPUSTAKAAN*\n\n`;
                    reply += `*Judul*: ${detailBuku.Judul}\n`;      // Gunakan .Judul
                    reply += `*Pengarang*: ${detailBuku.Pengarang}\n`;
                    reply += `*Penerbit*: ${detailBuku.Penerbit || '-'}\n`;
                    reply += `*Tahun*: ${detailBuku.Tahun}\n`;
                    reply += `*Bahasa*: ${detailBuku.Bahasa || '-'}\n`;
                    reply += `*ISBN*: ${detailBuku.ISBN || '-'}\n`;
                    reply += `*Call Number*: ${detailBuku.Call_Number}\n`;
                    reply += `*Kolasi*: ${detailBuku.Kolasi || '-'}\n`;
                    reply += `*Kampus*: ${detailBuku.Kampus || '-'}\n`;
                    
                    reply += `\n📦 *STATUS KETERSEDIAAN (EKSEMPLAR)*\n`;
                    
                    if (detailBuku.Daftar_Eksemplar && detailBuku.Daftar_Eksemplar.length > 0) {
                        detailBuku.Daftar_Eksemplar.forEach((item, idx) => {
                            reply += `\n*Eksemplar ke-${idx + 1}*\n`;
                            reply += `*Barcode:* ${item.Barcode}\n`;
                            reply += `*Lokasi:* ${item.Lokasi} (${item.Kampus || ''})\n`;
                            reply += `*Status:* ${item.Status}\n`; 
                        });
                    } else {
                        reply += `\n⚠️ _Data fisik/barcode buku ini belum terdaftar._`;
                    }

                    reply += `\n\nKetik *MENU* untuk layanan lain.`;
                    return { reply_message: reply };

                }

                // C. JIKA SEMUANYA GAGAL
                return { 
                    reply_message: `Mohon maaf, tidak ditemukan buku dengan kata kunci atau ID *"${input}"*.\n\n` +
                                `Silakan coba ketik judul atau pengarang lain.`
                };

            } catch (error) {
                console.error("Search Error:", error);
                return { reply_message: "Terjadi kesalahan pada sistem pencarian." };
            }
        }

        // >>> STATE: MENUNGGU ID BUKU (TAMPILAN DETAIL LENGKAP) <<<
        if (userSession.state === "waiting_for_book_id") {
            const inputUser = message.trim();
            
            // Cek jika user malah mengetik "Menu"
            if (inputUser.toLowerCase() === 'menu') {
                resetSessionState(from);
                return { reply_message: responsesData.system_commands.menu };
            }

            // Cek apakah user mengetik angka '1' lagi (Iseng/Lupa)
            if (inputUser === '1') {
                return { reply_message: "Silakan ketik Judul, Pengarang, atau ID Buku yang Anda cari.\n\n_Tips: Gunakan prefix untuk hasil lebih spesifik:_\n• *judul: nama buku*\n• *pengarang: nama pengarang*" };
            }

            // ============================================================
            // DETEKSI PREFIX: judul: ... / pengarang: ...
            // ============================================================
            const prefixJudul     = inputUser.match(/^judul\s*:\s*(.+)/i);
            const prefixPengarang = inputUser.match(/^pengarang\s*:\s*(.+)/i);

            if (prefixJudul) {
                const keyword = prefixJudul[1].trim();
                if (keyword.length < 3) {
                    return { reply_message: `⚠️ Kata kunci terlalu pendek. Masukkan minimal 3 huruf setelah *judul:*` };
                }
                const hasil = await dbService.cariBukuByJudul(keyword);
                if (hasil.length === 0) {
                    return { reply_message: `⚠️ *Tidak ditemukan* buku dengan judul mengandung *"${keyword}"*.

Coba kata kunci lain atau ketik *MENU*.`, context: 'Pencarian Buku' };
                }
                const limitTampil = hasil.slice(0, 10);
                let reply = `📚 *HASIL PENCARIAN JUDUL*
Kata kunci: _"${keyword}"_

`;
                limitTampil.forEach((buku, i) => {
                    reply += `${i + 1}.\nJudul: *${buku.Judul_Buku}*\nPengarang: ${buku.Pengarang}\nTahun: ${buku.Tahun}\nID: ${buku.ID_Buku}\n--------------------\n\n`;
                });
                if (hasil.length > 10) reply += `_Menampilkan 10 dari ${hasil.length} hasil._\n`;
                reply += `Ketik *ID BUKU* (misal: ${limitTampil[0].ID_Buku}) untuk melihat detail & stok.\nKetik *MENU* untuk layanan lain.`;
                return { reply_message: reply, context: 'Hasil Pencarian Buku By Judul' };
            }

            if (prefixPengarang) {
                const keyword = prefixPengarang[1].trim();
                if (keyword.length < 2) {
                    return { reply_message: `⚠️ Kata kunci terlalu pendek. Masukkan minimal 2 huruf setelah *pengarang:*` };
                }
                const hasil = await dbService.cariBukuByPengarang(keyword);
                if (hasil.length === 0) {
                    return { reply_message: `⚠️ *Tidak ditemukan* buku karya pengarang *"${keyword}"*.

Coba nama lain atau ketik *MENU*.`, context: 'Pencarian Buku' };
                }
                const limitTampil = hasil.slice(0, 10);
                let reply = `📚 *HASIL PENCARIAN PENGARANG*
Kata kunci: _"${keyword}"_

`;
                limitTampil.forEach((buku, i) => {
                    reply += `${i + 1}.\nJudul: *${buku.Judul_Buku}*\nPengarang: *${buku.Pengarang}*\nTahun: ${buku.Tahun}\nID: ${buku.ID_Buku}\n--------------------\n\n`;
                });
                if (hasil.length > 10) reply += `_Menampilkan 10 dari ${hasil.length} hasil._\n`;
                reply += `Ketik *ID BUKU* (misal: ${limitTampil[0].ID_Buku}) untuk melihat detail & stok.\nKetik *MENU* untuk layanan lain.`;
                return { reply_message: reply, context: 'Hasil Pencarian Buku By Pengarang' };
            }

            console.log(`[HYBRID] Mencoba cek ID: ${inputUser}`);
            
            // A. COBA SEBAGAI ID DULU
            const detailBuku = await dbService.getDetailBukuLengkap(inputUser);

            if (detailBuku) {
                // === KETEMU SEBAGAI ID ===
                // Tetap di state waiting_for_book_id agar mahasiswa bisa langsung cari buku lain
                
                let reply = `📖 *DETAIL BUKU PERPUSTAKAAN*\n\n`;
                reply += `*Judul*: ${detailBuku.Judul}\n`;
                reply += `*Pengarang*: ${detailBuku.Pengarang}\n`;
                reply += `*Penerbit*: ${detailBuku.Penerbit || '-'}\n`;
                reply += `*Tahun*: ${detailBuku.Tahun}\n`;
                reply += `*Bahasa*: ${detailBuku.Bahasa || '-'}\n`;
                reply += `*ISBN*: ${detailBuku.ISBN || '-'}\n`;
                reply += `*Call Number*: ${detailBuku.Call_Number}\n`;
                reply += `*Kolasi*: ${detailBuku.Kolasi || '-'}\n`;
                reply += `*Kampus*: ${detailBuku.Kampus || '-'}\n`;
                
                reply += `\n📦 *STATUS KETERSEDIAAN (EKSEMPLAR)*\n`;
                
                if (detailBuku.Daftar_Eksemplar && detailBuku.Daftar_Eksemplar.length > 0) {
                    detailBuku.Daftar_Eksemplar.forEach((item, idx) => {
                        reply += `\n*Eksemplar ke-${idx + 1}*\n`;
                        reply += `*Barcode:* ${item.Barcode}\n`;
                        reply += `*Lokasi:* ${item.Lokasi} (${item.Kampus || ''})\n`;
                        reply += `*Status:* ${item.Status}\n`; 
                    });
                } else {
                    reply += `\n⚠️ _Data fisik/barcode buku ini belum terdaftar._`;
                }

                reply += `\n\nKetik *judul:* atau *pengarang:* untuk cari buku lain.`;
                reply += `\nKetik *MENU* untuk layanan lain.`;
                return { 
                    reply_message: reply,
                    context: "Detail info Buku"
                };

            }
            // ============================================================
            // LOGIKA BARU: PENCARIAN GABUNGAN (JUDUL + PENGARANG)
            // ============================================================
            console.log(`[HYBRID] Bukan ID, mencari di Judul & Pengarang...`);

            // 1. Ambil data dari KEDUA fungsi database secara bersamaan
            // (Pastikan fungsi dbService.cariBukuByJudul & cariBukuByPengarang mengembalikan Array kosong [] jika tidak ada hasil, bukan error)
            const [hasilJudul, hasilPengarang] = await Promise.all([
                dbService.cariBukuByJudul(inputUser).catch(() => []),
                dbService.cariBukuByPengarang(inputUser).catch(() => [])
            ]);

            // 2. Gabungkan hasil (Merge)
            let semuaBuku = [...hasilJudul, ...hasilPengarang];

            // 3. Hapus Duplikat (Karena satu buku bisa muncul di pencarian judul & pengarang sekaligus)
            const unikBuku = [];
            const idMap = new Map();
            
            for (const buku of semuaBuku) {
                // Asumsi properti ID adalah 'ID_Buku' (sesuaikan dengan output DB Anda)
                if (!idMap.has(buku.ID_Buku)) {
                    idMap.set(buku.ID_Buku, true);
                    unikBuku.push(buku);
                }
            }

            // 4. Jika Ada Hasil
            if (unikBuku.length > 0) {
                // Batasi tampilan (misal max 10 buku agar WA tidak error)
                const limitTampil = unikBuku.slice(0, 10); 
                
                let reply = `📚 *HASIL PENCARIAN BUKU*\n`;
                reply += `Kata kunci: _"${inputUser}"_\n\n`;

                limitTampil.forEach((buku, index) => {
                    reply += `${index + 1}.\n`; 
                    reply += `Judul: *${buku.Judul_Buku}*\n`;
                    reply += `Pengarang: ${buku.Pengarang}\n`;
                    reply += `Tahun: ${buku.Tahun}\n`;
                    reply += `ID: ${buku.ID_Buku}\n`;
                    reply += `--------------------\n\n`;
                });

                reply += `--------------------\n`;
                if (unikBuku.length > 10) reply += `_Menampilkan 10 dari ${unikBuku.length} hasil._\n`;
                
                reply += `Silakan ketik *ID BUKU* (misal: ${limitTampil[0].ID_Buku}) untuk melihat detail & stok.\n`;
                reply += `Atau ketik kata kunci lain untuk mencari ulang.`;
                reply += `\n\nKetik *MENU* untuk layanan lain.`;

                return { 
                    reply_message: reply,
                    context: "Pencarian Buku" // <-- SPESIFIK PENCARIAN BUKU
                };
            }

            // --- SKENARIO D: GAGAL SEMUA ---
            // Jika sampai sini, berarti ID gagal, Judul gagal, Pengarang gagal.
            
            // Cek apakah gagal karena validasi panjang karakter?
            if (inputUser.length < 3) {
                return { 
                    reply_message: `⚠️ Input *"${inputUser}"* terlalu pendek.\nHarap masukkan minimal 3 huruf untuk mencari Judul atau Pengarang.` ,
                    context: "Pencarian Buku" // <-- SPESIFIK PENCARIAN BUKU
                };
            }

            return {
                reply_message: `⚠️ *Tidak Ditemukan*\n` +
                            `Input *"${inputUser}"* tidak valid sebagai ID Buku, Judul Buku maupun Pengarang.\n\n` +
                            `Silakan masukkan ID yang benar atau Judul buku yang lain.`,
                context: "Pencarian Buku" // <-- SPESIFIK PENCARIAN BUKU
            };
        }
        
        // >>> STATE: MENUNGGU NPM/NIM <<<
        if (userSession.state === "waiting_for_nim") {
            const nim = message.trim();
            
            if (nim.toLowerCase() === 'menu') {
                resetSessionState(from);
                return { reply_message: responsesData.system_commands.menu };
            }

            // Saran masuk sebagai tamu jika user ketik TAMU
            if (nim.toLowerCase() === 'tamu') {
                resetSessionState(from);
                return { 
                    reply_message: `Baik, Anda akan melanjutkan sebagai *Tamu*.\n\n` +
                        `Sebagai tamu, fitur cek pinjaman tidak tersedia karena memerlukan data keanggotaan perpustakaan.\n\n` +
                        `Layanan yang tersedia untuk tamu:\n` +
                        `• Pencarian buku\n` +
                        `• Informasi tata tertib\n` +
                        `• Informasi tugas akhir\n` +
                        `• Koleksi digital\n` +
                        `• Chat dengan pustakawan\n\n` +
                        `Ketik *MENU* untuk melihat layanan.`
                };
            }

            console.log(`[MEMBER] Cek NIM: ${nim}`);
            const result = await handleMemberCheck(nim, userSession);
            
            // Jika sukses (data ketemu), reset state
            if (result.success) {
                resetSessionState(from);
            }
            
            return { reply_message: result.reply_message };
        }
        
        // >>> STATE: MEMILIH KRITERIA PENCARIAN <<<
        if (userSession.state === "waiting_for_kriteria") {
            if (normalizedMessage === "judul" || normalizedMessage === "1") {
                userSession.state = "waiting_for_judul";
                return { 
                    reply_message: responsesData.flow_messages.prompt_judul 
                };
            }
            if (normalizedMessage === "pengarang" || normalizedMessage === "2") {
                userSession.state = "waiting_for_pengarang";
                // Ambil prompt dari JSON atau text manual
                return { 
                    reply_message: responsesData.flow_messages.prompt_pengarang
                };
            }
            
            if (normalizedMessage === "menu") {
                resetSessionState(from);
                return { reply_message: responsesData.system_commands.menu };
            }

            // Jika input salah
            return { reply_message: responsesData.flow_messages.invalid_criteria };
        }
        
        resetSessionState(from);
        return { reply_message: responsesData.flow_messages.invalid_menu_selection };
    }
    
    // --- 4. Transisi State dari Menu Utama ---
    
    // Menu 1: Pencarian Koleksi (OLD => INI CODE BILA INGIN ADA FILTERISASI BY JUDUL OR BY PENGARANG SETELAH MENGIRIM "1" DI MENU)
    if (normalizedMessage === "1") {
        userSession.state = "waiting_for_book_id";
        // Update pesan prompt kriteria agar user tahu ada opsi ID
        return {
            reply_message: responsesData.flow_messages.prompt_search_universal
        };
    }

    // // --- 1. PENCARIAN BUKU (MODE UNIVERSAL) ---
    // if (normalizedMessage === "1") {
    //     // Langsung minta input kata kunci, tanpa tanya kategori
    //     userSession.state = 'waiting_for_book_input'; 
    //     return { reply_message: "🔍 Silakan ketik **Judul Buku** atau **Nama Pengarang** yang ingin Anda cari." };
    // }
    
    // Menu 2: Cek Status & Peminjaman (Bisa ketik "a", "A", atau "cek status")
    if (normalizedMessage === "2" || normalizedMessage.includes("pinjaman")) {

        // Cek status verifikasi user
        if (linkedUser && linkedUser.status_verifikasi === 'VERIFIED') {
            // Langsung cek pinjaman tanpa perlu input NIM lagi
            const result = await handleMemberCheck(linkedUser.identitas_id, userSession);
            if (result.success) resetSessionState(from);
            return { reply_message: result.reply_message };
        }

        // PENDING (dosen belum terverifikasi) atau GUEST_ONLY (tamu)
        if (linkedUser && (linkedUser.status_verifikasi === 'PENDING' || linkedUser.status_verifikasi === 'GUEST_ONLY')) {
            userSession.state = "waiting_for_nim";
            const label = linkedUser.status_verifikasi === 'PENDING' ? 'NIDN/NIP/NIK' : 'NIM/ID Anggota';
            return {
                reply_message: `🔍 *Cek Status Pinjaman*\n\nSilakan masukkan *${label}* Anda untuk melanjutkan.\n\n_Ketik *MENU* untuk kembali._`
            };
        }

        // Fallback: minta NIM (seharusnya tidak terjadi jika linkedUser selalu ada)
        userSession.state = "waiting_for_nim";
        return { 
            reply_message: responsesData.general_services["2"] 
        };
    }

    // --- 5. Respons Statis ---
    let staticReply = getStaticReply(normalizedMessage);
    if (staticReply) {
        return { reply_message: staticReply };
    }
    
    // --- 6. Validasi Input Asal (Angka/Huruf tunggal invalid) ---
    const isSingleCharInput = /^[a-zA-Z0-9]$/.test(normalizedMessage);
    if (isSingleCharInput) {
        return { reply_message: responsesData.flow_messages.invalid_menu_selection + responsesData.system_commands.menu };
    }

    // --- 7. LEVENSHTEIN DISTANCE (Toleransi Typo Perintah Menu) ---
    // Dieksekusi sebelum AI fallback untuk mengenali perintah menu
    // yang mengandung typo ringan (maks 1-2 karakter).
    const MENU_KEYWORDS = {
        'menu'           : () => { userSession.state = 'main_menu'; return { reply_message: [responsesData.system_commands.menu] }; },
        'cari buku'      : () => { userSession.state = 'waiting_for_book_id'; return { reply_message: responsesData.flow_messages.prompt_search_universal }; },
        'pinjaman'       : async () => {
            if (linkedUser && linkedUser.status_verifikasi === 'VERIFIED') {
                const result = await handleMemberCheck(linkedUser.identitas_id, userSession);
                if (result.success) resetSessionState(from);
                return { reply_message: result.reply_message };
            }
            if (linkedUser && (linkedUser.status_verifikasi === 'PENDING' || linkedUser.status_verifikasi === 'GUEST_ONLY')) {
                userSession.state = 'waiting_for_nim';
                const label = linkedUser.status_verifikasi === 'PENDING' ? 'NIDN/NIP/NIK' : 'NIM/ID Anggota';
                return { reply_message: `🔍 *Cek Status Pinjaman*\n\nSilakan masukkan *${label}* Anda untuk melanjutkan.\n\n_Ketik *MENU* untuk kembali._` };
            }
            userSession.state = 'waiting_for_nim';
            return { reply_message: responsesData.general_services['2'] };
        },
        'tata tertib'    : () => ({ reply_message: responsesData.general_services['3'] }),
        'skbp'           : () => ({ reply_message: responsesData.general_services['4'] }),
        'tugas akhir'    : () => ({ reply_message: responsesData.general_services['5'] }),
        'koleksi digital': () => ({ reply_message: responsesData.general_services['6'] }),
        'turnitin'       : () => ({ reply_message: responsesData.general_services['7'] }),
        'bantuan'        : async () => {
            await setUserMode(from, 'pilih_cabang');
            return { reply_message: '🏢 *Pilih Cabang Perpustakaan*\n\nSilakan balas dengan angka sesuai lokasi kampus:\n\n*1.* Kampus Meruya\n*2.* Kampus Menteng\n*3.* Kampus Warung Buncit\n\nKetik *MENU* untuk layanan lain.' };
        },
        'selesai'        : () => { delete sessionHistory[from]; return { reply_message: responsesData.flow_messages.session_end_message }; }
    };

    const { match: levenMatch } = findBestMatch(normalizedMessage, Object.keys(MENU_KEYWORDS));
    if (levenMatch) {
        console.log('[LEVENSHTEIN] ' + normalizedMessage + ' -> ' + levenMatch);
        return await MENU_KEYWORDS[levenMatch]();
    }

    // --- 8. AI Fallback (GROQ) ---
    if (isTooSimilarToStatic(normalizedMessage)) {
        return { reply_message: responsesData.flow_messages.ai_safety_warning };
    }

        // Suntikkan waktu saat ini agar AI bisa menyapa sesuai konteks
    const now = new Date().toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long', hour: '2-digit', minute: '2-digit'
    });

    console.log('[AI] Meneruskan pesan ke GROQ (Admin Virtual)...');

    const systemContext = `Identitas:
Nama: PustakaBot
Peran: Admin virtual Perpustakaan Universitas Mercu Buana (UMB)
Waktu saat ini: ${now} WIB

Kamu adalah admin perpustakaan UMB yang ramah, informatif, dan komunikatif.
Jawab pertanyaan layaknya admin manusia sungguhan - natural, hangat, tidak kaku - namun tetap sopan dan profesional.
Gunakan Bahasa Indonesia yang baik. Boleh sesekali menggunakan sapaan seperti "Halo!", "Tentu!", "Siap!" agar terasa lebih manusiawi.

=== PENGETAHUAN FAKTUAL (Gunakan HANYA informasi ini, jangan mengarang) ===

JAM OPERASIONAL:
- Senin - Jumat: 08.00 - 16.00 WIB
- Sabtu: 08.00 - 17.00 WIB
- Minggu & Hari Libur Nasional: Tutup

KETENTUAN PEMINJAMAN - Kampus Meruya:
- Mahasiswa S1: maks. 8 judul, masa pinjam 14 hari
- Mahasiswa S2: maks. 10 judul, masa pinjam 14 hari
- Mahasiswa S3: maks. 12 judul, masa pinjam 14 hari
- Dosen Tetap & Tendik: maks. 12 judul, masa pinjam 90 hari
- Koleksi terbatas/favorit: masa pinjam 7 hari
- Koleksi CD Buku: masa pinjam 2 hari
- Tidak tersedia layanan perpanjangan masa pinjam
- Peminjaman ulang eksemplar yang sama: tunggu 1x24 jam setelah pengembalian

KETENTUAN PEMINJAMAN - Kampus Menteng & Warung Buncit:
- Mahasiswa: maks. 4 judul, masa pinjam 14 hari
- Dosen Tetap & Tendik: maks. 6 judul, masa pinjam 90 hari

SYARAT PEMINJAMAN UMUM:
- Wajib memiliki KTM aktif dan bebas denda
- Mahasiswa yang sudah mengajukan SKBP tidak boleh meminjam lagi

SKBP (Surat Keterangan Bebas Perpustakaan):
- Wajib untuk syarat sidang TA dan pengambilan ijazah
- Syarat: bebas pinjaman buku/loker/tas, bebas denda, bebas tanggungan hilang
- SKBP dikirim otomatis via email, proses maks. 1x24 jam (tidak termasuk Minggu & libur nasional)
- Setelah SKBP terbit, tidak boleh meminjam lagi
- Link pengajuan:
  Kampus Meruya      : bit.ly/skbp_meruya
  Kampus Menteng     : bit.ly/skbp_menteng2
  Kampus Warung Buncit: bit.ly/skbp_warbun

PENYERAHAN TUGAS AKHIR (TA):
- Wajib untuk semua mahasiswa sebagai syarat kelulusan/yudisium
- Template TA: https://bit.ly/templateTA25
- Format file: PDF tanpa watermark dan tanpa password
- Link upload:
  Kampus Meruya      : https://bit.ly/ta_meruya
  Kampus Menteng     : https://bit.ly/ta_menteng
  Kampus Warung Buncit: https://bit.ly/ta_warbun
- Khusus Program Doktor (S3): wajib hardcover, diserahkan langsung ke perpustakaan
- Setelah TA diterima, perpustakaan kirim Form Tanda Terima ke email mahasiswa
- Info lebih lanjut: https://mercubuana.ac.id/biro-perpustakaan

E-RESOURCES:
- GALE (Cengage): jurnal bidang Ekonomi, Sosial/Humaniora, Teknik
- Emerald Insight: jurnal bidang Ekonomi (Akuntansi & Manajemen)
- IEEE Xplore: jurnal bidang Elektro dan Komputer
- ProQuest Ebook Central: e-book semua bidang
- EBSCO eBooks: e-book semua bidang
- Cambridge University Press (Core): e-book semua bidang
- Repository UMB: akses TA dan karya ilmiah UMB
- Link akses: https://mercubuana.ac.id/biro-perpustakaan/e-jurnal-dan-e-book-internasional
- Panduan akses: https://mercubuana.ac.id/biro-perpustakaan/panduan-akses-e-resource
- Info username & password hubungi pustakawan:
  Kampus Meruya      : 082311232229
  Kampus Menteng     : 085219542943
  Kampus Warung Buncit: 082135935955

UJI SIMILARITY TURNITIN:
- Untuk verifikasi orisinalitas TA sebelum sidang
- Format file: MS Word (.doc), gabungkan Cover + Abstrak + Bab 1, 4, 5
- Wajib lampirkan bukti cek mandiri via Turnitin Draft Coach (panduan: s.id/TutorialTurnitinDC)
- Gratis 2 kali, pengajuan ke-3 dst: Rp25.500 via BNI 1976765677 (Yayasan Menara Bhakti)
- Hasil dikirim ke email dalam 3 hari kerja
- Jika similarity < 30%: dapat Surat Keterangan Hasil Uji Turnitin
- Jika similarity > 30%: hanya dapat hasil uji untuk revisi
- Cakupan layanan Perpustakaan Pusat:
  FEB (S1/S2/S3): dilayani Perpustakaan Pusat
  D3: tidak diwajibkan
  Fakultas lain: melalui TU Fakultas masing-masing
- Link upload: https://bit.ly/cek_similarity_perpus

KONTAK PERPUSTAKAAN:
- Website: https://mercubuana.ac.id/biro-perpustakaan
- Kampus Meruya      : 082311232229
- Kampus Menteng     : 085219542943
- Kampus Warung Buncit: 082135935955

=== ATURAN WAJIB ===

1. JAWAB LANGSUNG dan informatif. Jangan hanya mengarahkan ke menu jika kamu sudah punya jawabannya.
   Contoh SALAH : "Untuk info jam buka, silakan ketik *3*."
   Contoh BENAR : "Perpustakaan buka Senin-Jumat jam 08.00-16.00 WIB, Sabtu 08.00-17.00 WIB."

2. SETELAH menjawab, SELALU tambahkan arahan ke nomor menu yang relevan di akhir jawaban (dalam bubble yang sama namun berikan spasi paragraf 2 kali).
   Gunakan format: "Untuk info selengkapnya ketik *[NOMOR]*"
   Peta menu untuk arahan:
   - Topik tata tertib, jam buka, ketentuan peminjaman -> ketik *3*
   - Topik SKBP, bebas pustaka, syarat wisuda          -> ketik *4*
   - Topik tugas akhir, skripsi, yudisium              -> ketik *5*
   - Topik e-resources, jurnal, e-book                 -> ketik *6*
   - Topik turnitin, similarity, plagiarisme           -> ketik *7*
   - Topik pencarian buku                              -> ketik *1*
   - Topik cek pinjaman, denda                         -> ketik *2*
   Jika topik tidak cocok dengan menu manapun, tidak perlu tambahkan arahan.

3. TIGA HAL INI harus diarahkan ke sistem, bukan dijawab AI:
   - Cari buku spesifik / cek stok buku  -> Silakan ketik *1* untuk mencari buku.
   - Cek status pinjaman / denda pribadi -> Silakan ketik *2* dan masukkan NIM kamu.
   - Minta bicara dengan pustakawan      -> Silakan ketik *8* untuk terhubung ke pustakawan.

3. LARANGAN KERAS:
   - DILARANG mengarang informasi yang tidak ada di pengetahuan faktual di atas
   - DILARANG menjawab topik di luar perpustakaan UMB (politik, resep, hiburan, dll.)
   - DILARANG menyebutkan ketersediaan atau lokasi buku spesifik (data ada di database)
   - DILARANG memberikan jawaban lebih dari 4 kalimat
   - DILARANG menggunakan kata "Mohon maaf" lebih dari sekali dalam satu jawaban

4. Jika pertanyaan sama sekali di luar konteks perpustakaan UMB, tolak dengan sopan dan singkat:
   "Wah, itu di luar area saya nih. Saya hanya bisa bantu seputar layanan Perpustakaan UMB. Ada yang bisa saya bantu?"

5. Sesuaikan sapaan dengan waktu saat ini:
   - 05.00-11.00: Selamat pagi
   - 11.00-15.00: Selamat siang
   - 15.00-18.00: Selamat sore
   - 18.00-05.00: Selamat malam
`;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const chatCompletion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: systemContext },
                    { role: 'user',   content: message }
                ],
                temperature: 0.4,
                max_tokens: 250,
            });

            const replyText = chatCompletion.choices[0]?.message?.content;
            if (replyText) return { reply_message: replyText };
            throw new Error('Empty AI Response');

        } catch (error) {
            console.error('[AI] Attempt ' + attempt + ' gagal:', error.message);
            if (attempt === maxRetries) {
                return { reply_message: '⚠️ Maaf, sistem AI sedang sibuk. Silakan ketik *MENU* untuk menggunakan layanan manual.' };
            }
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
};

// ===================================================================
// FUNGSI ANALISIS KONTEKS HUMAN MODE DENGAN AI (GROQ)
// ===================================================================
async function analyzeContextWithAI(text) {
    try {
        // Asumsi Anda sudah inisialisasi objek groq di file ini
        // const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Kamu adalah asisten analis perpustakaan. Tugasmu HANYA mengkategorikan pesan user ke dalam SALAH SATU dari kategori berikut: [Tanya Denda, Info Buku, Fasilitas Kampus, Jam Operasional, Komplain, Kendala Teknis, Lainnya]. Dilarang memberikan penjelasan, cukup balas dengan SATU NAMA KATEGORI yang paling cocok."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            model: "llama-3.3-70b-versatile", // Gunakan model Groq yang ringan dan cepat
            temperature: 0.1, // Suhu rendah agar AI konsisten dan tidak bertele-tele
            max_tokens: 10
        });

        // Ambil hasil tebakan AI, hilangkan spasi berlebih
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error("Gagal menganalisis konteks AI:", error.message);
        return "Uncategorized"; // Fallback jika AI sedang down
    }
}

// =======================================================
// BACKGROUND JOB: CEK SESSION TIMEOUT
// =======================================================
const GATEWAY_URL = 'http://localhost:3002/send-direct'; // URL Gateway baru

// Fungsi pengecekan yang berjalan otomatis
setInterval(async () => {
    const currentTime = Date.now();
    
    // Loop semua user yang ada di sessionHistory
    for (const userId in sessionHistory) {
        const session = sessionHistory[userId];

        // Hitung selisih waktu
        if (session.last_time > 0 && (currentTime - session.last_time > SESSION_TIMEOUT_MS)) {
            console.log(`[TIMEOUT JOB] Sesi ${userId} berakhir.`);

            // 1. Kirim Pesan Notifikasi ke Gateway
            try {
                await axios.post(GATEWAY_URL, {
                    to: userId, // Nomor WA User
                    message: "⏳ *Sesi Berakhir*\n\nSesi percakapan Anda telah habis karena tidak ada aktivitas selama 30 menit.\nSilakan ketik *MENU* untuk memulai kembali."
                });
            } catch (error) {
                console.error(`[TIMEOUT JOB] Gagal mengirim pesan ke ${userId}:`, error.message);
                // Lanjut saja, jangan crash, yang penting sesi dihapus
            }

            // 2. Hapus Sesi dari Memori (Agar tidak dicek lagi)
            delete sessionHistory[userId];
            // ATAU jika ingin mereset state saja tanpa menghapus (pilih salah satu):
            // sessionHistory[userId] = { last_time: 0, state: "main_menu" };
        }
    }

    // --- PEMBERSIHAN MEMORY LEAK ---

    // 1. Bersihkan spamFilter: hapus entry yang sudah tidak aktif lebih dari 1 menit
    //    (spamFilter hanya menyimpan timestamp terakhir kirim pesan)
    const SPAM_EXPIRY = 60 * 1000; // 1 menit
    for (const userId in spamFilter) {
        if (currentTime - spamFilter[userId] > SPAM_EXPIRY) {
            delete spamFilter[userId];
        }
    }

    // 2. Bersihkan userMonitor: hapus entry yang sudah tidak aktif lebih dari 1 jam
    //    dan tidak sedang dalam status banned
    const MONITOR_EXPIRY = 60 * 60 * 1000; // 1 jam
    for (const userId in userMonitor) {
        const userData = userMonitor[userId];
        const isInactive = currentTime - userData.windowStart > MONITOR_EXPIRY;
        const isNotBanned = userData.banUntil < currentTime;

        if (isInactive && isNotBanned) {
            delete userMonitor[userId];
        }
    }

}, 60 * 1000); // Jalankan setiap 60 detik (1 menit)

// =======================================================
// ROUTES API
// =======================================================

app.post("/process-message", async (req, res) => {
    try {
        const { from, text, userName, realNumber } = req.body;
        const finalNumber = realNumber || from.split('@')[0];
        const cleanText = text.toLowerCase().trim();

        // =========================================================
        // 1. PENJAGA GERBANG: FITUR HUMAN MODE / CHAT PUSTAKAWAN
        // =========================================================
        
        // Cek status user dari database SQLite
        const currentMode = await getUserMode(from);

        // A. Perintah Admin untuk mengakhiri sesi obrolan manual
        // Format: "!bot <nomor_mahasiswa>" — admin mengakhiri sesi dari sisi admin
        // Format: "!bot" — user mengakhiri sesi dari sisi mahasiswa
        // CATATAN: handler ini dicek SEBELUM blok human mode agar admin bisa
        // mengirim !bot meski nomor admin sendiri sedang dalam mode human
        if (cleanText.startsWith('!bot')) {
            const parts = text.trim().split(/\s+/);
            const targetNumber = parts[1] ? parts[1].trim() : null;

            if (targetNumber) {
                // Admin kirim "!bot 628xxx" — reset mode mahasiswa yang dituju
                const targetFrom = targetNumber.includes('@c.us') ? targetNumber : `${targetNumber}@c.us`;
                await setUserMode(targetFrom, 'bot');
                stopActiveHumanTimer(targetFrom); // hentikan timer di memory
                return res.json({ reply: `*Sistem:* Sesi obrolan manual dengan *${targetNumber}* telah diakhiri. Chatbot mahasiswa tersebut aktif kembali.` });
            } else {
                // Mahasiswa kirim "!bot" — reset mode diri sendiri
                await setUserMode(from, 'bot');
                stopActiveHumanTimer(from); // hentikan timer di memory
                return res.json({ reply: "*Sistem:* Mode Pustakawan diakhiri. Chatbot aktif kembali.\n\nKetik *Menu* untuk melihat layanan." });
            }
        }

        // B. Jika user SEDANG dalam mode Human, Bot DIAM (cegat pesan disini)
        if (currentMode === 'human') {

            console.log(`[SILENT MODE] Pesan dari ${userName} diabaikan (Sedang obrolan manual).`);

            // ==========================================================
            // SISIPKAN PENCATATAN AI DI SINI (Background Process)
            // ==========================================================
            setTimeout(async () => {
                try {
                    // 1. Minta AI menebak konteks percakapan
                    const aiContext = await analyzeContextWithAI(text);
                    const finalContext = `Human Mode: ${aiContext}`;
                    
                    // 2. Simpan ke database SQLite
                    logInteraction(finalNumber, text, "Diteruskan ke Admin", finalContext);
                } catch (err) {
                    console.error("Gagal log Human Mode:", err);
                }
            }, 50);
            // ==========================================================

            return res.status(200).json({}); // Return kosong agar Gateway diam
        }

        // C. Jika user MEMINTA obrolan manual untuk pertama kali
        if (cleanText === '8' || cleanText === 'admin' || cleanText === 'bantuan admin') {
            await setUserMode(from, 'pilih_cabang');

            return res.json({ 
                reply: "*Pilih Cabang Perpustakaan*\n\nSilakan balas dengan angka sesuai lokasi kampus yang ingin Anda hubungi:\n\n*1.* Kampus Meruya\n*2.* Kampus Menteng\n*3.* Kampus Warung Buncit\n\nKetik *MENU* untuk layanan lain." 
            });
        }

        // D. Jika user berada dalam state memilih cabang
        if (currentMode === 'pilih_cabang') {

            // Jika user ingin membatalkan (Bisa ketik 'batal' atau 'menu')
            if (cleanText === 'batal' || cleanText === 'menu') {
                await setUserMode(from, 'bot');
                return res.json({ 
                    reply: responsesData.system_commands.menu 
                });
            }

            // Opsi 1: Kampus Meruya (Masuk ke Human Mode)
            if (cleanText === '1' || cleanText === 'meruya') {
                await setUserMode(from, 'human');

                // Kirim notifikasi "Alert" ke HP Admin Meruya
                try {
                    const userNumberOnly = from.replace('@c.us', '');
                    const botNumber = ADMIN_NUMBER.replace('@c.us', '');
                    const endSessionLink = `https://wa.me/${botNumber}?text=!bot%20${finalNumber}`;
                    const alertMsg = `🚨 *ALERT PUSTAKAWAN*\n\n` +
                                    `Mahasiswa bernama *${userName}* meminta obrolan manual.\n` +
                                    `Nomor WA: https://wa.me/${finalNumber}\n\n` +
                                    `_Balas pesan mahasiswa tersebut secara manual melalui WA Anda._\n\n` +
                                    `Jika masalah sudah selesai, klik tautan berikut untuk mengakhiri sesi:\n` +
                                    `${endSessionLink}`;

                    await axios.post(WA_GATEWAY_URL, {
                        to: ADMIN_NUMBER,
                        message: alertMsg
                    });
                } catch (err) {
                    console.error("[ERROR] Gagal mengirim alert ke admin:", err.message);
                }

                // Balasan bot ke Mahasiswa
                return res.json({ 
                    reply: "👨‍💻 *Menghubungkan ke Pustakawan...*\n\nAnda sedang terhubung dengan layanan bantuan pustakawan.\n\n*Sembari menunggu admin membalas, silakan kirimkan pertanyaan yang ingin Anda tanyakan. Admin kami akan merespons sesegera mungkin.*\n\n\n_Ketik *!bot* untuk kembali ke layanan chatbot_" 
                });

            } 
            
            // Opsi 2: Kampus Menteng (Lempar Link, kembali ke Bot)
            else if (cleanText === '2' || cleanText === 'menteng') {
                await setUserMode(from, 'bot'); // Kembalikan state ke bot
                return res.json({ 
                    reply: "📍 *Kampus Menteng*\n\nSilakan hubungi Pustakawan Cabang Menteng melalui tautan WhatsApp berikut:\n👉 https://wa.me/6285219542943\n\n_Ketik *Menu* jika masih membutuhkan layanan bot._" 
                });
            } 
            
            // Opsi 3: Kampus Warung Buncit (Lempar Link, kembali ke Bot)
            else if (cleanText === '3' || cleanText === 'warung buncit') {
                await setUserMode(from, 'bot'); // Kembalikan state ke bot
                return res.json({ 
                    reply: "📍 *Kampus Warung Buncit*\n\nSilakan hubungi Pustakawan Cabang Warung Buncit melalui tautan WhatsApp berikut:\n👉 https://wa.me/6282135935955\n\n_Ketik *Menu* jika masih membutuhkan layanan bot._" 
                });
            } 
            
            // Jika balasan tidak sesuai (Bukan 1, 2, 3, atau batal)
            else {
                return res.json({
                    reply: "⚠️ Pilihan tidak valid. Silakan balas dengan angka *1, 2, atau 3*.\n\nKetik *menu* untuk kembali ke menu."
                });
            }
        }
        
        // =========================================================
        // 2. PANGGIL LOGIKA UTAMA BOT (Jika status masih 'bot')
        // =========================================================
        const response = await createResponse(text, from, userName, finalNumber);
        
        // Cek 1: Jika response NULL (berarti kena Spam Filter), jangan lakukan apa-apa
        if (!response) {
            // Kirim status 200 OK (Sukses) tapi JSON kosong. 
            // Gateway tidak akan membalas apa-apa.
            return res.status(200).json({}); 
        }

        // =========================================================
        // 3. CATAT LOG HISTORY KE DATABASE LENGKAP DENGAN KONTEKS
        // =========================================================
        // Kita tangkap pertanyaan (text) dan jawaban bot (response.reply_message)
        res.json({
            reply: response.reply_message,
            options: { ...response.options, linkPreview: false }
        });

        // 2. JALANKAN PENCATATAN DI LATAR BELAKANG (Delay 50ms agar tidak mengganggu pengiriman WA)
        setTimeout(() => {
            try {
                // KITA AMBIL KONTEKS DARI RESPONSE BOT TERLEBIH DAHULU
                const context = response.context || determineContext(text);
                
                const replyText = Array.isArray(response.reply_message) ? response.reply_message.join(" | ") : response.reply_message;
                logInteraction(finalNumber, text, replyText, context);
            } catch (err) {
                console.error("Gagal log background:", err);
            }
        }, 50);

    } catch (error) {
        console.error("Error processing message:", error);

        // Deteksi jenis error untuk pesan yang lebih spesifik
        const isDbTimeout = error.message && (
            error.message.includes('timeout') ||
            error.message.includes('Too many connections') ||
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('queue')
        );

        const fallbackMessage = isDbTimeout
            ? "⚠️ Sistem sedang sibuk melayani banyak permintaan. Mohon tunggu sebentar dan coba lagi dalam beberapa detik."
            : "⚠️ Maaf, terjadi gangguan sementara pada sistem. Silakan coba lagi dalam beberapa saat.\n\nJika masalah berlanjut, ketik *8* untuk menghubungi pustakawan.";

        // Kirim JSON agar gateway bisa meneruskan pesan ke user
        if (!res.headersSent) {
            res.json({ reply: fallbackMessage });
        }
    }
});

// --- ADMIN ROUTES ---
app.get("/admin/data", (req, res) => res.json(readResponsesData()));

app.post("/admin/data/save", (req, res) => {
    const updatedData = req.body;

    // TAHAP 5: VALIDASI INPUT
    // Jangan simpan jika datanya ngawur/kosong
    if (!validateResponseData(updatedData)) {
        return res.status(400).json({ 
            success: false, 
            message: "Data tidak valid! Struktur JSON rusak atau kategori wajib hilang." 
        });
    }

    if (updatedData.id) delete updatedData.id; 

    // TAHAP 3 & 4: AUTO BACKUP SEBELUM SIMPAN
    // Aman: Jika simpan gagal, data lama masih ada di backup
    createBackup();

    // Simpan data baru
    const success = writeResponsesData(updatedData);
    
    if (success) {
        res.status(200).json({ success: true, message: "Berhasil disimpan (Backup dibuat)." });
    } else {
        res.status(500).json({ success: false, message: "Gagal menulis ke file." });
    }
});

app.post("/admin/data/add-key", (req, res) => {
    const { category, key, value } = req.body;
    if (!category || !key || !value) return res.status(400).json({ success: false });
    const current = readResponsesData();
    if (!current[category]) return res.status(404).json({ success: false });
    const normKey = key.toLowerCase().trim();
    if (current[category][normKey]) return res.status(409).json({ success: false });
    
    current[category][normKey] = value;
    createBackup();
    const success = writeResponsesData(current);
    res.status(success ? 200 : 500).json({ success, message: success ? "Ditambahkan." : "Gagal." });
});

app.post("/admin/data/delete-key", (req, res) => {
    const { category, key } = req.body;
    if (!category || !key) return res.status(400).json({ success: false });
    const current = readResponsesData();
    if (current[category] && current[category][key]) {
        delete current[category][key];
        const success = writeResponsesData(current);
        res.status(success ? 200 : 500).json({ success, message: success ? "Dihapus." : "Gagal." });
    } else {
        res.status(404).json({ success: false });
    }
});

// =======================================================
// API DASHBOARD (SUMBER DATA: SQLITE LOKAL)
// =======================================================

app.get("/admin/stats/summary", requireLogin, async (req, res) => {
    try {
        // --- DATA DARI SQLITE (LOG CHAT) ---
        
        // 1. Statistik Dasar
        const totalRows = await analyticsDb.get("SELECT COUNT(*) as count FROM chat_logs");
        const userRows = await analyticsDb.get("SELECT COUNT(DISTINCT user_id) as count FROM chat_logs");
        const todayRows = await analyticsDb.get(`SELECT COUNT(*) as count FROM chat_logs WHERE timestamp::date = CURRENT_DATE`);

        // 2. Grafik Tren 7 Hari
        const chartRows = await analyticsDb.all(`
            SELECT timestamp::date as date, COUNT(*) as count
            FROM chat_logs
            WHERE timestamp >= NOW() - INTERVAL '6 days'
            GROUP BY timestamp::date ORDER BY date ASC
        `);

        // 3. Grafik Jam Sibuk (00 - 23)
        const peakHourRows = await analyticsDb.all(`
            SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as count
            FROM chat_logs
            GROUP BY hour ORDER BY hour ASC
        `);

        // 4. Top 20 User Teraktif (dengan nama & identitas jika tersedia)
        const topUsersRows = await analyticsDb.all(`
            SELECT
                cl.user_id,
                COUNT(*) as total,
                MAX(cl.nama) as nama,
                MAX(cl.identitas_id) as identitas_id
            FROM chat_logs cl
            GROUP BY cl.user_id
            ORDER BY total DESC
            LIMIT 20
        `);

        res.json({
            summary: {
                total_chats: totalRows.count,
                unique_users: userRows.count,
                today_chats: todayRows.count
            },
            charts: {
                trend_7_days: chartRows,
                peak_hours: peakHourRows
            },
            top_users: topUsersRows
        });

    } catch (error) {
        console.error("Gagal ambil stats:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

// =========================================================
// ENDPOINT: SINKRONISASI BALASAN MANUAL DARI HP ADMIN
// =========================================================
app.post("/api/admin-sync", async (req, res) => { // Tambahkan async
    const { targetNumber } = req.body;

    try {
        // PERBAIKAN UTAMA: Cek mode user dulu
        const currentMode = await getUserMode(targetNumber);
        
        // Timer HANYA boleh di-reset jika user sedang dalam mode human
        if (targetNumber && currentMode === 'human') {
            startActiveHumanTimer(targetNumber);
            console.log(`[TIMER RESET] Admin membalas via HP. Timer aktif untuk ${targetNumber} di-reset ke 0.`);
        }
    } catch (err) {
        console.error("Gagal memproses admin-sync:", err.message);
    }

    res.status(200).json({ status: "ok" });
});

// Endpoint untuk mengakhiri human mode dari admin panel
app.post("/api/end-human-mode", requireLogin, async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber wajib diisi.' });

    try {
        const targetFrom = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
        await setUserMode(targetFrom, 'bot');
        stopActiveHumanTimer(targetFrom);

        // Kirim notif ke user bahwa sesi telah diakhiri
        try {
            await axios.post(WA_GATEWAY_URL, {
                to: targetFrom,
                message: "✅ *Sesi Obrolan Selesai*\n\nPustakawan telah mengakhiri sesi obrolan manual.\n\nKetik *Menu* untuk kembali menggunakan layanan bot."
            });
        } catch (err) {
            console.error("[END SESSION] Gagal kirim notif ke user:", err.message);
        }

        console.log(`[END SESSION] Sesi human mode untuk ${phoneNumber} diakhiri oleh admin panel.`);
        res.json({ success: true, message: `Sesi untuk ${phoneNumber} berhasil diakhiri.` });
    } catch (err) {
        console.error("Gagal mengakhiri human mode:", err.message);
        res.status(500).json({ error: 'Gagal mengakhiri sesi.' });
    }
});

// Endpoint untuk mengambil daftar user yang sedang dalam human mode
app.get("/api/active-human-sessions", requireLogin, async (req, res) => {
    try {
        const rows = await analyticsDb.all(
            `SELECT phone_number, updated_at FROM user_status WHERE mode = 'human' ORDER BY updated_at DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error("Gagal ambil active sessions:", err.message);
        res.status(500).json({ error: 'Gagal mengambil data.' });
    }
});

app.get("/api/chat-history", requireLogin, async (req, res) => {
    try {
        const { date_from, date_to } = req.query;

        let whereClauses = [];
        let params = [];

        if (date_from) {
            params.push(date_from);
            whereClauses.push(`timestamp >= $${params.length}::date`);
        }
        if (date_to) {
            params.push(date_to);
            whereClauses.push(`timestamp < ($${params.length}::date + INTERVAL '1 day')`);
        }

        const where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

        const rows = await analyticsDb.all(
            `SELECT user_id, nama, identitas_id, message_in, message_out, context, timestamp 
             FROM chat_logs 
             ${where}
             ORDER BY timestamp DESC 
             LIMIT 500`,
            params
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =======================================================
// WEBSOCKET PROXY: /admin/ws-gateway → wa_gateway ws://localhost:3002/ws
// Agar browser tidak perlu konek langsung ke port 3002
// =======================================================
const http = require('http');
const { WebSocketServer, WebSocket: WS } = require('ws');

const server = http.createServer(app);

const wssProxy = new WebSocketServer({ server, path: '/admin/ws-gateway' });

wssProxy.on('connection', (clientWs, req) => {
    console.log('[WS PROXY] Admin panel terhubung ke proxy gateway.');

    let gatewayWs = null;
    let retryTimer = null;
    let closed = false;

    function connectToGateway() {
        if (closed) return;
        gatewayWs = new WS('ws://127.0.0.1:3002/ws');

        gatewayWs.on('message', (data) => {
            if (clientWs.readyState === WS.OPEN) {
                clientWs.send(data.toString());
            }
        });

        gatewayWs.on('close', () => {
            if (closed) return;
            console.log('[WS PROXY] Koneksi ke gateway terputus, retry dalam 2 detik...');
            retryTimer = setTimeout(connectToGateway, 2000);
        });

        gatewayWs.on('error', (err) => {
            console.error('[WS PROXY] Gateway WS error:', err.message);
        });
    }

    connectToGateway();

    // Forward pesan dari admin panel ke gateway (misal: ping)
    clientWs.on('message', (data) => {
        if (gatewayWs && gatewayWs.readyState === WS.OPEN) {
            gatewayWs.send(data.toString());
        }
    });

    clientWs.on('close', () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (gatewayWs) gatewayWs.close();
    });
});

server.listen(port, () => {
    console.log(`Chatbot Core Service berjalan di http://localhost:${port}/admin`);
});