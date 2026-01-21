require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("API Key tidak ditemukan di .env");
    process.exit(1);
}

const genAI = new GoogleGenAI(apiKey);

async function listModels() {
    console.log("Sedang menghubungi Google AI...");
    console.log("Mencari model yang mendukung 'generateContent' (Text Chat)...");
    console.log("-------------------------------------------------------------");
    
    try {
        const response = await genAI.models.list();
        
        let count = 0;
        
        for await (const model of response) {
            // SAFEGUARD: Cek apakah properti supportedGenerationMethods ada?
            // Jika tidak ada, anggap array kosong agar tidak error
            const methods = model.supportedGenerationMethods || [];
            
            // Kita cari yang bisa generateContent (Chat)
            if (methods.includes("generateContent")) {
                // Tampilkan nama teknisnya (ini yang dicopy ke core_server.js)
                // Hapus prefix 'models/' agar bersih
                const cleanName = model.name.replace('models/', '');
                
                console.log(`✅ ID: "${cleanName}"`);
                // console.log(`   Nama: ${model.displayName}`); // Opsional
                console.log("-------------------------------------------------------------");
                count++;
            }
        }

        if (count === 0) {
            console.log("Tidak ada model yang ditemukan.");
        }

    } catch (error) {
        console.error("Gagal mengambil daftar model:", error);
    }
}

listModels();