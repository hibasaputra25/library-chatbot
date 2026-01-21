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
        initTable(); // Buat tabel otomatis saat start
    }
});

// Fungsi Membuat Tabel (Hanya jika belum ada)
function initTable() {
    const query = `
    CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
    )`;
    
    db.run(query, (err) => {
        if (err) console.error('[SQLITE] Gagal buat tabel:', err.message);
        else console.log('[SQLITE] Tabel chat_logs siap.');
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

module.exports = { db, run, get, all };