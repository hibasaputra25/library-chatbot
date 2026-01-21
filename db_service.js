// db_service.js
const db = require('./db_config');

// 1. Fungsi Cari Buku berdasarkan ID (Sudah ada)
async function cariBukuById(idBuku) {
    try {
        const [rows] = await db.execute(
            'SELECT ID_Buku, Judul_Buku, Pengarang, Tahun, Call_Number, ISBN FROM buku WHERE ID_Buku = ?',
            [idBuku]
        );
        return rows[0]; 
    } catch (error) {
        console.error("[DB ERROR] cariBukuById:", error.message);
        return null;
    }
}

// --- BARU: Cari Buku by Judul (Filter 20 Tahun & Limit 10) ---
async function cariBukuByJudul(keyword) {
    try {
        const currentYear = new Date().getFullYear();
        const minYear = currentYear - 20;
        
        // Tambahkan wildcard % agar bisa mencari kata di tengah kalimat
        const searchKeyword = `%${keyword}%`; 

        const [rows] = await db.execute(
            `SELECT ID_Buku, Judul_Buku, Pengarang, Tahun
             FROM buku 
             WHERE Judul_Buku LIKE ? 
             AND Tahun >= ? 
             ORDER BY Tahun DESC 
             LIMIT 10`, 
            [searchKeyword, minYear]
        );
        return rows; // Mengembalikan array buku (bisa kosong, bisa isi banyak)
    } catch (error) {
        console.error("[DB ERROR] cariBukuByJudul:", error.message);
        return []; // Return array kosong jika error
    }
}


// --- 2. AMBIL DETAIL LENGKAP BUKU & STATUS (JOIN 3 TABEL) ---
async function getDetailBukuLengkap(idBuku) {
    try {
        // Query ini melakukan 3 hal:
        // 1. Mengambil data buku (b)
        // 2. Menggabungkan dengan data eksemplar/barcode (e)
        // 3. Mengecek status pinjaman di sirkulasi (s) khusus yang belum kembali (N)
        
        const query = `
            SELECT 
                b.ID_Buku, 
                b.Judul_Buku AS Judul_Buku,  /* <--- PAKSA JADI Judul_Buku */
                b.Pengarang, 
                b.No_Penerbit, 
                b.Tahun, 
                b.No_Bahasa, 
                b.Call_Number, 
                b.Kolasi, 
                b.ISBN, 
                b.kampus as Kampus_Utama,
                e.No_Barcode, 
                e.Lokasi, 
                e.kampus as Kampus_Lokasi,
                s.Status_Kembali
            FROM buku b
            LEFT JOIN eksemplar_buku e ON b.ID_Buku = e.ID_Buku
            LEFT JOIN sirkulasi s ON e.No_Barcode = s.No_Barcode AND s.Status_Kembali = 'N'
            WHERE b.ID_Buku = ?
        `;

        const [rows] = await db.execute(query, [idBuku]);
        console.log("DATA MENTAH DARI DB:", rows[0]);
        // Jika buku tidak ditemukan sama sekali
        if (rows.length === 0) return null;

        // KITA PERLU RE-STRUKTUR DATA (Grouping)
        // Karena hasil query akan berulang untuk setiap barcode, kita ambil info buku dari baris pertama saja
        const infoBuku = {
            ID_Buku: rows[0].ID_Buku,
            Judul: rows[0].Judul_Buku,      // Sesuai log: Judul_Buku
            Pengarang: rows[0].Pengarang,   // Sesuai log: Pengarang
            Penerbit: rows[0].No_Penerbit,  // Sesuai log: No_Penerbit
            Tahun: rows[0].Tahun,
            Bahasa: rows[0].No_Bahasa,      // Sesuai log: No_Bahasa
            Call_Number: rows[0].Call_Number,
            Kolasi: rows[0].Kolasi,
            ISBN: rows[0].ISBN,
            Kampus: rows[0].Kampus_Utama,
            Daftar_Eksemplar: [] 
        };

        // Loop hasil query untuk mengisi daftar eksemplar
        rows.forEach(row => {
            if (row.No_Barcode) { // Cek jika ada eksemplar
                let statusBuku = "Tersedia";
                
                // Logika: Jika ada record di sirkulasi dengan status 'N', berarti sedang dipinjam
                if (row.Status_Kembali === 'N') {
                    statusBuku = "Sedang Dipinjam";
                }

                infoBuku.Daftar_Eksemplar.push({
                    Barcode: row.No_Barcode,
                    Lokasi: row.Lokasi,
                    Kampus: row.Kampus_Lokasi,
                    Status: statusBuku
                });
            }
        });

        return infoBuku;

    } catch (error) {
        console.error("[DB ERROR] getDetailBukuLengkap:", error.message);
        return null;
    }
}

// --- BARU: Cari Buku by Pengarang ---
async function cariBukuByPengarang(keyword) {
    try {
        const currentYear = new Date().getFullYear();
        const minYear = currentYear - 20;
        const searchKeyword = `%${keyword}%`; 

        const [rows] = await db.execute(
            `SELECT ID_Buku, Judul_Buku, Pengarang, Tahun
             FROM buku 
             WHERE Pengarang LIKE ?  /* <--- Bedanya cuma di sini */
             AND Tahun >= ? 
             ORDER BY Tahun DESC 
             LIMIT 10`, 
            [searchKeyword, minYear]
        );
        return rows; 
    } catch (error) {
        console.error("[DB ERROR] cariBukuByPengarang:", error.message);
        return []; 
    }
}

async function cekStatusAnggota(nim) {
    try {
        // 1. Cek dulu apakah NIM ada di tabel anggota
        const [memberRows] = await db.execute(
            `SELECT No_Anggota, Nama
             FROM anggota 
             WHERE No_Anggota = ?`, 
            [nim]
        );

        if (memberRows.length === 0) {
            return null; // Mahasiswa tidak ditemukan
        }

        const dataMember = memberRows[0];

        // 2. Jika ada, cari buku yang sedang dipinjam (Status_Kembali = 'N')
        // Kita perlu JOIN ke tabel sirkulasi -> eksemplar -> buku
        const [loanRows] = await db.execute(
            `SELECT 
                s.Tgl_Pinjam, 
                s.Tgl_Seharusnya,
                b.Judul_Buku
             FROM sirkulasi s
             JOIN eksemplar_buku e ON s.No_Barcode = e.No_Barcode
             JOIN buku b ON e.ID_Buku = b.ID_Buku
             WHERE s.No_Anggota = ? 
             AND s.Status_Kembali = 'N'`,
            [nim]
        );

        // Gabungkan data profil dan data pinjaman
        return {
            ...dataMember,
            Pinjaman: loanRows // Array buku yang dipinjam
        };

    } catch (error) {
        console.error("[DB ERROR] cekStatusAnggota:", error.message);
        return null;
    }
}


// Jangan lupa export fungsi baru ini
module.exports = {
    cariBukuByJudul,
    cariBukuByPengarang, // <--- Tambahkan ini
    getDetailBukuLengkap,
    cariBukuById,
    cekStatusAnggota
};
