// db_config.js
require("dotenv").config();
const mysql = require('mysql2/promise');

// Konfigurasi Connection Pool
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Tes koneksi sederhana (Opsional, untuk debug saat server start)
db.getConnection()
    .then(conn => {
        console.log("✅ [DATABASE] Koneksi pool berhasil dibuat!");
        conn.release();
    })
    .catch(err => {
        console.error("❌ [DATABASE] Gagal membuat koneksi pool:", err.message);
    });

module.exports = db;