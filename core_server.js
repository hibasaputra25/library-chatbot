/**
 * CHATBOT CORE SERVICE
 * PORT: 3001
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
const axios = require('axios'); // Tambahkan ini di baris atas
const basicAuth = require('express-basic-auth');
const path = require('path'); // Bawaan node.js, biar path folder aman

// IMPORT GEMINI
// const { GoogleGenAI } = require("@google/genai");

// IMPORT GROQ
const Groq = require("groq-sdk");

const dbService = require('./db_service');
const analyticsDb = require('./analytics_db');

const app = express();
const port = 3001;

// Izinkan pesan JSON hingga 1MB (default cuma 100kb)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cors());

// =======================================================
// KEAMANAN ADMIN PANEL (BASIC AUTH)
// =======================================================

const adminUser = process.env.ADMIN_USER;
const adminPass = process.env.ADMIN_PASS;

// Cek apakah env sudah diset?
if (!adminUser || !adminPass) {
    console.warn("⚠️ PERINGATAN: ADMIN_USER dan ADMIN_PASS belum diset di .env. Admin panel tidak aman/tidak bisa diakses.");
}

// Konfigurasi Middleware Autentikasi
const authMiddleware = basicAuth({
    users: { [adminUser]: adminPass }, // Ambil dari .env
    challenge: true, // Memunculkan popup login bawaan browser
    unauthorizedResponse: 'Akses Ditolak: Anda bukan Pustakawan!'
});

// TERAPKAN PROTEKSI:
// Semua URL yang berawalan "/admin" WAJIB Login dulu.
// Ini melindungi Halaman HTML DAN API Save/Delete sekaligus.
app.use('/admin', authMiddleware);

// =======================================================
// ROUTE HALAMAN ADMIN
// =======================================================

// Saat buka http://localhost:3001/admin -> Tampilkan file dari folder public
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

// 3. Fungsi Auto-Backup
const createBackup = () => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `responses-${timestamp}.json`;
        const backupPath = path.join(BACKUP_DIR, backupFilename);
        
        // Copy file responses.json saat ini ke folder backup
        fs.copyFileSync(RESPONSES_FILE_PATH, backupPath);
        console.log(`[BACKUP] Berhasil membuat backup: ${backupFilename}`);
        return true;
    } catch (error) {
        console.error("[BACKUP ERROR] Gagal membuat backup:", error);
        return false;
    }
};

const logInteraction = async (userId) => {
    try {
        // Simpan ke SQLite Lokal
        // Pastikan tabel chat_logs sudah dibuat otomatis oleh analytics_db.js
        await analyticsDb.run("INSERT INTO chat_logs (user_id) VALUES (?)", [userId]);
    } catch (error) {
        console.error("Gagal mencatat log analytics:", error);
    }
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
        return { reply_message: "⚠️ Format NIM salah. Harap masukkan angka saja." };
    }

    const data = await dbService.cekStatusAnggota(nim);

    if (!data) {
        return { reply_message: `⚠️ Data anggota dengan NIM *${nim}* tidak ditemukan di sistem perpustakaan.` };
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
const createResponse = async (message, from, userName) => {

    // 1. CATAT LOG KE SQLITE (Jalankan tanpa await agar tidak memperlambat balasan)
    logInteraction(from);
    
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
    
    const normalizedMessage = normalize(message);

    // =======================================================
    // LOGIKA SESI TERINTEGRASI (UNIFIED SESSION)
    // =======================================================
    
    let isNewSession = false;

    // 1. Cek apakah data sesi user ada?
    // Jika !sessionHistory[from] (KOSONG), berarti:
    //    a. User baru pertama kali chat.
    //    b. ATAU User lama yang datanya sudah DIHAPUS oleh Timer (Satpam) karena diam > 1 menit.
    if (!sessionHistory[from]) {
        sessionHistory[from] = { last_time: currentTime, state: "main_menu" };
        isNewSession = true; // Tandai ini sebagai sesi baru
    }

    let userSession = sessionHistory[from]; 
    
    // 2. Update waktu terakhir chat (PENTING!)
    // Ini agar Timer tahu user ini aktif lagi, jadi jangan dihapus dulu.
    userSession.last_time = currentTime;

    // --- LOGIKA TAMPILAN MENU & GREETING ---

    // SKENARIO A: SESI BENAR-BENAR BARU (Pertama kali chat / setelah timeout)
    if (isNewSession) {
        // --- AMBIL NAMA & BERSIHKAN (SECURE) ---
        let rawName = userName;
        if (rawName && rawName.startsWith('+')) rawName = "Pemustaka";
        let displayName = sanitizeName(rawName);

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
                return { reply_message: searchResult.reply_message };
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
                return { reply_message: searchResult.reply_message };
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
            // Supaya tidak error/looping aneh, kita anggap dia minta panduan ulang
            if (inputUser === '1') {
                return { reply_message: "Silakan ketik Judul, Pengarang, atau ID Buku yang Anda cari." };
            }

            console.log(`[HYBRID] Mencoba cek ID: ${inputUser}`);
            
            // A. COBA SEBAGAI ID DULU
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

                return { reply_message: reply };
            }

            // --- SKENARIO D: GAGAL SEMUA ---
            // Jika sampai sini, berarti ID gagal, Judul gagal, Pengarang gagal.
            
            // Cek apakah gagal karena validasi panjang karakter?
            if (inputUser.length < 3) {
                return { 
                    reply_message: `⚠️ Input *"${inputUser}"* terlalu pendek.\nHarap masukkan minimal 3 huruf untuk mencari Judul atau Pengarang.` 
                };
            }

            return {
                reply_message: `⚠️ *Tidak Ditemukan*\n` +
                            `Input *"${inputUser}"* tidak valid sebagai ID Buku, Judul Buku maupun Pengarang.\n\n` +
                            `Silakan masukkan ID yang benar atau Judul buku yang lain.`
            };
        }
        
        // >>> STATE: MENUNGGU NPM/NIM <<<
        if (userSession.state === "waiting_for_nim") {
            const nim = message.trim();
            
            if (nim.toLowerCase() === 'menu') {
                resetSessionState(from);
                return { reply_message: responsesData.system_commands.menu };
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
        
        // 1. Ubah State agar pesan berikutnya dianggap NIM
        userSession.state = "waiting_for_nim"; 
        
        // 2. Berikan balasan minta NIM
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

    // --- 7. AI Fallback (GROQ) ---
    if (isTooSimilarToStatic(normalizedMessage)) {
        return { reply_message: responsesData.flow_messages.ai_safety_warning };
    }

    console.log("[AI] Meneruskan pesan ke GROQ (Context-Aware)...");

    const systemContext = `
    PERAN:
    Anda adalah "PustakaBot", asisten virtual Perpustakaan Universitas Mercu Buana (UMB).
    Tugas Anda adalah memahami pertanyaan user dan MENGARAHKAN mereka ke NOMOR MENU yang tepat.
    Jangan menjawab detail panjang lebar jika informasi tersebut sudah tersedia di menu statis.

    PETA INFORMASI & MENU (Gunakan ini sebagai acuan):
    
    Menu "1" (Pencarian Buku):
       - Gunakan jika user bertanya: "Cari buku X", "Ada novel Y?", "Cek stok buku", "Cara cari pengarang".

    Menu "2" (Cek Status Anggota):
       - Gunakan jika user bertanya: "Cek denda saya", "Buku apa yang saya pinjam", "Kapan harus balikin buku". (Butuh NIM).
    
    Menu "3" (Tata Tertib & Jam Buka):
       - Gunakan jika user bertanya: "Jam buka perpustakaan?", "Hari sabtu buka?", "Boleh pinjam berapa buku?", "Aturan denda", "Syarat peminjaman".
       - Konteks ringkas: Senin-Jumat (08.00-16.00), Sabtu (08.00-17.00). S1 max 8 buku, S2 max 10 buku.
    
    Menu "4" (Bebas Pustaka / SKBP):
       - Gunakan jika user bertanya: "Cara bebas pustaka", "Link SKBP", "Syarat wisuda", "Formulir bebas pinjaman".
       - Mencakup link untuk Kampus Meruya, Menteng, dan Warung Buncit.
    
    Menu "5" (Penyerahan Tugas Akhir / TA):
       - Gunakan jika user bertanya: "Upload TA dimana?", "Link penyerahan skripsi", "Format PDF TA", "Template skripsi", "Syarat yudisium".
       - Mencakup link upload online dan aturan hardcopy untuk S3.
    
    Menu "6" (E-Resources & Jurnal Online):
       - Gunakan jika user bertanya: "Cara akses jurnal", "Password Emerald/IEEE", "Cari referensi online", "E-book ProQuest".
       - Mencakup akses ke GALE, Emerald, IEEE, ProQuest, EBSCO, dan Repository UMB.

    Menu "7" (Layanan Cek Similarity (Turnitin) Tugas Akhir):
       - Gunakan jika user bertanya: "cek turnitin", "similarity", "turnitin studio", "turnitin draft coach", "plagiarisme".
       - Mencakup informasi seputar cek similarity atau plagiarisme menggunakan turnitin studio. diwajibkan sebagai salah satu syarat sidang fakultas ekonomi dan bisnis.

    ATURAN MENJAWAB:
    1. Jawablah dengan ramah dan ringkas (maksimal 2 kalimat).
    2. JIKA pertanyaan user cocok dengan salah satu menu di atas, KATAKAN: "Untuk informasi tersebut, silakan ketik angka *[NOMOR]*".
       - Contoh: "Untuk panduan upload Tugas Akhir, silakan ketik angka *4*."
       - Contoh: "Jam layanan kami tersedia di menu Tata Tertib. Silakan ketik angka *2*."
    3. JIKA user hanya menyapa (Halo/Pagi), tawarkan bantuan dan arahkan ketik *MENU* dan juga jawab sesuai waktu jika user mengirim saat malam jawab dengan selamat malam atau semacamnya.
    4. PENANGANAN INPUT TIDAK RELEVAN (GIBBERISH / LOREM IPSUM / LUAR TOPIK):
       - JIKA user mengirim teks acak (seperti Lorem Ipsum), teks tidak bermakna, atau topik di luar perpustakaan (misal: resep masakan, politik):
       - JANGAN mencoba mengartikannya.
       - JANGAN minta maaf berlebihan (misal: "Mohon maaf saya tidak dapat memahami bla bla").
       - JAWABLAH DENGAN TEGAS & SINGKAT dan arahkan user untuk ke kembali ke MENU.

    Gaya Bahasa: Sopan, Formal, Bahasa Indonesia yang baik.
    `;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            
            const chatCompletion = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile", 
                
                messages: [
                    { role: "system", content: systemContext }, // Instruksi Sistem
                    { role: "user", content: message }          // Pesan User
                ],
                temperature: 0.5, // 0.5 agar jawaban stabil/tidak halusinasi
                max_tokens: 300,  // Batas panjang jawaban
            });

            const replyText = chatCompletion.choices[0]?.message?.content;
            
            if (replyText) {
                return { reply_message: replyText };
            } else {
                throw new Error("Empty AI Response");
            }

        } catch (error) {
            console.error("Gagal memanggil Groq AI:", error);
            return { reply_message: "⚠️ Maaf, sistem AI sedang sibuk. Silakan ketik *MENU* untuk menggunakan layanan manual." };
        }

        // ---- BLOCK CODE UNTUK GEMINI ----
        //     const result = await genAI.models.generateContent({
        //         model: "gemini-1.5-flash-8b",
        //         contents: [{ role: "user", parts: [{ text: message }] }],
        //         config: {
        //             systemInstruction: systemContext,
        //             maxOutputTokens: 200, // Batasi panjang jawaban biar tidak cerewet
        //         },
        //     });

        //     const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        //     if (text) return { reply_message: text };
        //     throw new Error("Empty AI response");
        // } catch (error) {
        //     // Cek spesifik Error 429 (Kuota Habis)
        //     if (error.status === 429 || error.message.includes('429')) {
        //         console.warn("[GEMINI] Kuota Habis (Rate Limit Hit).");
        //         return { 
        //             reply_message: "⚠️ _Layanan AI sedang sibuk/penuh._\nSilakan gunakan menu manual dengan mengetik *MENU*." 
        //         };
        //     }

        //     // Retry hanya jika error server (503/500), bukan error kuota
        //     if (error.status === 503 && attempt < maxRetries) {
        //         await delay(2000 * Math.pow(2, attempt - 1));
        //     } else {
        //         console.error("Gagal memanggil Gemini AI:", error);
        //         return { reply_message: "Maaf, sedang ada gangguan pada sistem AI kami." };
        //     }
        // }
    }
};

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
}, 1000); // Jalankan setiap 60 detik (1 menit)

// =======================================================
// ROUTES API
// =======================================================

app.post("/process-message", async (req, res) => {
    try {
        const { from, text, userName } = req.body;
        
        // Panggil logika utama bot
        const response = await createResponse(text, from, userName);

        // --- PERBAIKAN DI SINI ---
        
        // Cek 1: Jika response NULL (berarti kena Spam Filter), jangan lakukan apa-apa
        if (!response) {
            // Kirim status 200 OK (Sukses) tapi JSON kosong. 
            // Gateway tidak akan membalas apa-apa.
            return res.status(200).json({}); 
        }

        // Cek 2: Jika response ada isinya, baru kirim reply_message
        res.json({ 
            reply: response.reply_message,
            // Jika ada opsi tambahan (seperti linkPreview)
            options: response.options 
        });

    } catch (error) {
        console.error("Error processing message:", error);
        res.status(500).send("Internal Server Error");
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

app.get("/admin/stats/summary", authMiddleware, async (req, res) => {
    try {
        // --- DATA DARI SQLITE (LOG CHAT) ---
        
        // 1. Statistik Dasar
        const totalRows = await analyticsDb.get("SELECT COUNT(*) as count FROM chat_logs");
        const userRows = await analyticsDb.get("SELECT COUNT(DISTINCT user_id) as count FROM chat_logs");
        const todayRows = await analyticsDb.get("SELECT COUNT(*) as count FROM chat_logs WHERE date(timestamp) = date('now', 'localtime')");

        // 2. Grafik Tren 7 Hari
        const chartRows = await analyticsDb.all(`
            SELECT date(timestamp) as date, COUNT(*) as count 
            FROM chat_logs 
            WHERE date(timestamp) >= date('now', '-6 days', 'localtime')
            GROUP BY date(timestamp) ORDER BY date ASC
        `);

        // 3. Grafik Jam Sibuk (00 - 23)
        // Mengelompokkan berdasarkan JAM
        const peakHourRows = await analyticsDb.all(`
            SELECT strftime('%H', timestamp) as hour, COUNT(*) as count
            FROM chat_logs
            GROUP BY hour ORDER BY hour ASC
        `);

        // 4. Top 5 User Teraktif
        const topUsersRows = await analyticsDb.all(`
            SELECT user_id, COUNT(*) as total
            FROM chat_logs
            GROUP BY user_id ORDER BY total DESC LIMIT 5
        `);

        // --- DATA DARI MYSQL UNIVERSITAS (READ ONLY) ---
        // Kita gunakan try-catch terpisah agar kalau MySQL mati, dashboard tetap jalan (partial)
        let libraryStats = { total_books: 0, borrowed: 0 };
        try {
            const [booksCount] = await dbService.pool.query("SELECT COUNT(*) as count FROM books");
            // Asumsi tabel 'transactions' punya status 'borrowed'
            const [borrowedCount] = await dbService.pool.query("SELECT COUNT(*) as count FROM transactions WHERE status = 'borrowed'");
            
            libraryStats.total_books = booksCount[0].count;
            libraryStats.borrowed = borrowedCount[0].count;
        } catch (dbError) {
            console.error("Gagal koneksi MySQL Univ:", dbError.message);
        }

        res.json({
            summary: {
                total_chats: totalRows.count,
                unique_users: userRows.count,
                today_chats: todayRows.count
            },
            charts: {
                trend_7_days: chartRows,
                peak_hours: peakHourRows,
                library_composition: libraryStats
            },
            top_users: topUsersRows
        });

    } catch (error) {
        console.error("Gagal ambil stats:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

app.listen(port, () => {
    console.log(`Chatbot Core Service berjalan di http://localhost:${port}/admin`);
});