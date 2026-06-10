// analytics_db.js — PostgreSQL version
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Koneksi pool ke PostgreSQL
const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'chatbot_analytics',
    user:     process.env.PG_USER     || 'postgres',
    password: process.env.PG_PASSWORD || '',
    // Maksimal 10 koneksi aktif sekaligus
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
    console.log('[PG] Koneksi baru ke PostgreSQL berhasil.');
});

pool.on('error', (err) => {
    console.error('[PG] Unexpected error on idle client:', err.message);
});

// =======================================================
// WRAPPER QUERY — kompatibel dengan kode lama
// SQLite pakai ? sebagai placeholder, PostgreSQL pakai $1 $2 dst
// Fungsi ini otomatis konversi ? ke $1, $2, ...
// =======================================================
function convertPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
    const query = convertPlaceholders(sql);
    const result = await pool.query(query, params);
    // Kembalikan object mirip SQLite: { lastID, changes }
    return {
        lastID: result.rows[0]?.id || null,
        changes: result.rowCount
    };
}

async function get(sql, params = []) {
    const query = convertPlaceholders(sql);
    const result = await pool.query(query, params);
    return result.rows[0] || null;
}

async function all(sql, params = []) {
    const query = convertPlaceholders(sql);
    const result = await pool.query(query, params);
    return result.rows;
}

// =======================================================
// INIT TABEL — buat semua tabel jika belum ada
// =======================================================
async function initTable() {
    try {
        // 1. TABEL: CHAT_LOGS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_logs (
                id          SERIAL PRIMARY KEY,
                user_id     TEXT NOT NULL,
                message_in  TEXT,
                message_out TEXT,
                context     TEXT,
                timestamp   TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('[PG] Tabel chat_logs siap.');

        // 2. TABEL: LINKED USERS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS linked_users (
                nomor_wa           TEXT PRIMARY KEY,
                identitas_id       TEXT NOT NULL,
                nama               TEXT NOT NULL,
                role               TEXT NOT NULL,
                status_verifikasi  TEXT NOT NULL,
                timestamp          TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('[PG] Tabel linked_users siap.');

        // 3. TABEL: USER STATUS (human/bot mode)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_status (
                phone_number TEXT PRIMARY KEY,
                mode         TEXT DEFAULT 'bot'
            )
        `);
        console.log('[PG] Tabel user_status siap.');

        // 4. TABEL: ADMIN USERS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id            SERIAL PRIMARY KEY,
                username      TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                nama          TEXT NOT NULL,
                nomor_wa      TEXT NOT NULL,
                created_at    TIMESTAMPTZ DEFAULT NOW(),
                last_login    TIMESTAMPTZ
            )
        `);
        console.log('[PG] Tabel admin_users siap.');

        // 5. TABEL: OTP TOKENS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS otp_tokens (
                id         SERIAL PRIMARY KEY,
                username   TEXT NOT NULL,
                otp_code   TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used       INTEGER DEFAULT 0
            )
        `);
        console.log('[PG] Tabel otp_tokens siap.');

        // 6. Tambah kolom nama & identitas_id ke chat_logs jika belum ada
        await pool.query(`ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS nama TEXT`).catch(() => {});
        await pool.query(`ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS identitas_id TEXT`).catch(() => {});
        console.log('[PG] Kolom nama & identitas_id di chat_logs siap.');

        // Jalankan bootstrap setelah tabel siap
        await bootstrapAdminUser();

    } catch (err) {
        console.error('[PG] Gagal inisialisasi tabel:', err.message);
        process.exit(1);
    }
}

// Test koneksi lalu init tabel
pool.query('SELECT NOW()')
    .then(() => {
        console.log('[PG] Terhubung ke database PostgreSQL.');
        initTable();
    })
    .catch(err => {
        console.error('[PG] Gagal terhubung ke PostgreSQL:', err.message);
        process.exit(1);
    });

// =======================================================
// BOOTSTRAP ADMIN PERTAMA
// =======================================================
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
        if (existing) return;

        const hash = await bcrypt.hash(adminPass, 12);
        await pool.query(
            `INSERT INTO admin_users (username, password_hash, nama, nomor_wa) VALUES ($1, $2, $3, $4)`,
            [adminUser, hash, adminNama, adminWa]
        );
        console.log(`[ADMIN] Akun admin pertama '${adminUser}' berhasil dibuat dari .env.`);
    } catch (err) {
        console.error('[ADMIN] Gagal bootstrap admin user:', err.message);
    }
}

// =======================================================
// CRUD ADMIN USERS
// =======================================================
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
    return run(`UPDATE admin_users SET last_login = NOW() WHERE id = ?`, [id]);
}

// =======================================================
// OTP HELPERS
// =======================================================
async function createOtp(username) {
    await pool.query(`DELETE FROM otp_tokens WHERE username = $1`, [username]);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 menit dari sekarang

    await pool.query(
        `INSERT INTO otp_tokens (username, otp_code, expires_at) VALUES ($1, $2, $3)`,
        [username, code, expiresAt]
    );
    return code;
}

async function verifyOtp(username, code) {
    const result = await pool.query(
        `SELECT * FROM otp_tokens
         WHERE username = $1 AND otp_code = $2 AND used = 0
           AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [username, code]
    );
    const row = result.rows[0];
    if (!row) return false;
    await pool.query(`UPDATE otp_tokens SET used = 1 WHERE id = $1`, [row.id]);
    return true;
}

// =======================================================
// LINKED USERS
// =======================================================
function getLinkedUser(nomor_wa) {
    return get(`SELECT * FROM linked_users WHERE nomor_wa = ?`, [nomor_wa]);
}

function saveLinkedUser(nomor_wa, identitas_id, nama, role, status_verifikasi) {
    // PostgreSQL: INSERT ... ON CONFLICT DO UPDATE (setara REPLACE INTO di SQLite)
    return pool.query(
        `INSERT INTO linked_users (nomor_wa, identitas_id, nama, role, status_verifikasi)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nomor_wa) DO UPDATE
         SET identitas_id = EXCLUDED.identitas_id,
             nama = EXCLUDED.nama,
             role = EXCLUDED.role,
             status_verifikasi = EXCLUDED.status_verifikasi`,
        [nomor_wa, identitas_id, nama, role, status_verifikasi]
    );
}

module.exports = {
    pool, run, get, all,
    getLinkedUser, saveLinkedUser,
    getAllAdminUsers, getAdminUserByUsername, getAdminUserById,
    createAdminUser, updateAdminUser, updateAdminPassword, deleteAdminUser, updateLastLogin,
    createOtp, verifyOtp
};
