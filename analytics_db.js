const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

// Nama file database lokal
const dbPath = path.resolve(__dirname, 'analytics.db');

// Koneksi ke SQLite
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[SQLITE] Gagal membuka database analytics:', err.message);
    } else {
        console.log('[SQLITE] Terhubung ke database analytics lokal.');
        
        // ==========================================================
        // PENGATURAN ANTI-BENTROK (Mencegah Database Locked / Busy)
        // ==========================================================
        db.run('PRAGMA journal_mode = WAL;');
        db.run('PRAGMA busy_timeout = 5000;');
        
        initTable(); // Buat tabel otomatis saat start
    }
});

// Fungsi Membuat Tabel (Hanya jika belum ada)
function initTable() {
    // =======================================================
    // 1. TABEL : CHAT_LOGS
    // =======================================================
    const query = `
    CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message_in TEXT,
        message_out TEXT,
        context TEXT,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
    )`;
    
    db.run(query, (err) => {
        if (err) console.error('[SQLITE] Gagal buat tabel:', err.message);
        else console.log('[SQLITE] Tabel chat_logs siap.');
    });

    // =======================================================
    // 2. TABEL BARU: LINKED USERS (Pengikat WA & NIM)
    // =======================================================
    const queryUsers = `
    CREATE TABLE IF NOT EXISTS linked_users (
        nomor_wa TEXT PRIMARY KEY,
        identitas_id TEXT NOT NULL,
        nama TEXT NOT NULL,
        role TEXT NOT NULL,
        status_verifikasi TEXT NOT NULL,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
    )`;

    db.run(queryUsers, (err) => {
        if (err) console.error('[SQLITE] Gagal buat tabel users:', err.message);
        else console.log('[SQLITE] Tabel linked_users siap.');
    });

    // =======================================================
    // 3. TABEL: ADMIN USERS (Login Pustakawan)
    // =======================================================
    const queryAdminUsers = `
    CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nama TEXT NOT NULL,
        nomor_wa TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        last_login DATETIME
    )`;

    db.run(queryAdminUsers, (err) => {
        if (err) console.error('[SQLITE] Gagal buat tabel admin_users:', err.message);
        else {
            console.log('[SQLITE] Tabel admin_users siap.');
            bootstrapAdminUser();
        }
    });

    // =======================================================
    // 4. TABEL: OTP TOKENS (Forgot Password)
    // =======================================================
    const queryOtp = `
    CREATE TABLE IF NOT EXISTS otp_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        otp_code TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0
    )`;

    db.run(queryOtp, (err) => {
        if (err) console.error('[SQLITE] Gagal buat tabel otp_tokens:', err.message);
        else console.log('[SQLITE] Tabel otp_tokens siap.');
    });
}

// Wrapper agar bisa pakai Async/Await (SQLite bawaan pakai callback)
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Bootstrap akun admin pertama dari .env jika tabel masih kosong
async function bootstrapAdminUser() {
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASS;
    const adminNama = process.env.ADMIN_NAMA || 'Administrator';
    const adminWa   = process.env.ADMIN_WA_NUMBER || '';

    if (!adminUser || !adminPass) {
        console.warn('[ADMIN] ADMIN_USER / ADMIN_PASS belum diset di .env, skip bootstrap.');
        return;
    }

    try {
        const existing = await get(`SELECT id FROM admin_users WHERE username = ?`, [adminUser]);
        if (existing) return; // sudah ada, skip

        const hash = await bcrypt.hash(adminPass, 12);
        await run(
            `INSERT INTO admin_users (username, password_hash, nama, nomor_wa) VALUES (?, ?, ?, ?)`,
            [adminUser, hash, adminNama, adminWa]
        );
        console.log(`[ADMIN] Akun admin pertama '${adminUser}' berhasil dibuat dari .env.`);
    } catch (err) {
        console.error('[ADMIN] Gagal bootstrap admin user:', err.message);
    }
}

// --- CRUD admin_users ---

async function getAllAdminUsers() {
    return all(`SELECT id, username, nama, nomor_wa, created_at, last_login FROM admin_users ORDER BY id`);
}

async function getAdminUserByUsername(username) {
    return get(`SELECT * FROM admin_users WHERE username = ?`, [username]);
}

async function getAdminUserById(id) {
    return get(`SELECT * FROM admin_users WHERE id = ?`, [id]);
}

async function createAdminUser(username, password, nama, nomor_wa) {
    const hash = await bcrypt.hash(password, 12);
    return run(
        `INSERT INTO admin_users (username, password_hash, nama, nomor_wa) VALUES (?, ?, ?, ?)`,
        [username, hash, nama, nomor_wa]
    );
}

async function updateAdminUser(id, nama, nomor_wa) {
    return run(
        `UPDATE admin_users SET nama = ?, nomor_wa = ? WHERE id = ?`,
        [nama, nomor_wa, id]
    );
}

async function updateAdminPassword(id, newPassword) {
    const hash = await bcrypt.hash(newPassword, 12);
    return run(`UPDATE admin_users SET password_hash = ? WHERE id = ?`, [hash, id]);
}

async function deleteAdminUser(id) {
    return run(`DELETE FROM admin_users WHERE id = ?`, [id]);
}

async function updateLastLogin(id) {
    return run(`UPDATE admin_users SET last_login = datetime('now', 'localtime') WHERE id = ?`, [id]);
}

// --- OTP helpers ---

async function createOtp(username) {
    // Hapus OTP lama milik user ini dulu
    await run(`DELETE FROM otp_tokens WHERE username = ?`, [username]);

    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit
    // Simpan expires_at dalam UTC agar konsisten dengan datetime('now') SQLite
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
        .toISOString().replace('T', ' ').substring(0, 19);

    await run(
        `INSERT INTO otp_tokens (username, otp_code, expires_at) VALUES (?, ?, ?)`,
        [username, code, expiresAt]
    );
    return code;
}

async function verifyOtp(username, code) {
    const row = await get(
        `SELECT * FROM otp_tokens
         WHERE username = ? AND otp_code = ? AND used = 0
           AND expires_at > datetime('now')
         ORDER BY id DESC LIMIT 1`,
        [username, code]
    );
    if (!row) return false;
    await run(`UPDATE otp_tokens SET used = 1 WHERE id = ?`, [row.id]);
    return true;
}

function getLinkedUser(nomor_wa) {
    return get(`SELECT * FROM linked_users WHERE nomor_wa = ?`, [nomor_wa]);
}

function saveLinkedUser(nomor_wa, identitas_id, nama, role, status_verifikasi) {
    return run(
        `INSERT OR REPLACE INTO linked_users (nomor_wa, identitas_id, nama, role, status_verifikasi) VALUES (?, ?, ?, ?, ?)`, 
        [nomor_wa, identitas_id, nama, role, status_verifikasi]
    );
}

module.exports = {
    db, run, get, all,
    getLinkedUser, saveLinkedUser,
    getAllAdminUsers, getAdminUserByUsername, getAdminUserById,
    createAdminUser, updateAdminUser, updateAdminPassword, deleteAdminUser, updateLastLogin,
    createOtp, verifyOtp
};