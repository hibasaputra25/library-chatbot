const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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

function getLinkedUser(nomor_wa) {
    return get(`SELECT * FROM linked_users WHERE nomor_wa = ?`, [nomor_wa]);
}

function saveLinkedUser(nomor_wa, identitas_id, nama, role, status_verifikasi) {
    return run(
        `INSERT OR REPLACE INTO linked_users (nomor_wa, identitas_id, nama, role, status_verifikasi) VALUES (?, ?, ?, ?, ?)`, 
        [nomor_wa, identitas_id, nama, role, status_verifikasi]
    );
}

module.exports = { db, run, get, all, getLinkedUser, saveLinkedUser };