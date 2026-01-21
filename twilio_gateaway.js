/**
 * TWILIO WEBHOOK GATEWAY SERVICE (Menggunakan Pola Microservices)
 *
 * File ini berfungsi sebagai "adapter" khusus untuk Twilio.
 * 1. Mendengarkan pesan masuk dari Twilio Webhook (Port 3002).
 * 2. Meneruskan pesan masuk ke Chatbot Core Service (Port 3001) untuk diproses.
 * 3. Mengirim balasan yang diterima dari Core Service menggunakan Twilio API.
 *
 * PENTING: Untuk menjalankan file ini, Anda WAJIB menjalankan Chatbot Core Service
 * di http://localhost:3001/process-message.
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config(); // Mengaktifkan dotenv

// --- TWILIO API CONFIGURATION ---
// Kredensial diambil dari environment variables (harus diatur saat menjalankan service)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_NUMBER;
const client = require('twilio')(accountSid, authToken);

const app = express();
const PORT = 3002; // Port khusus untuk Twilio Gateway
const CORE_SERVICE_URL = 'http://localhost:3001/process-message';


// --- MIDDLEWARE ---

// Middleware untuk Twilio (menggunakan body-parser untuk x-www-form-urlencoded)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public')); 

// --- WHATSAPP MESSAGE SENDER (Twilio API) ---

/**
 * Mengirim pesan balasan menggunakan Twilio API.
 * @param {string} to - Nomor tujuan (misal: 'whatsapp:+62812xxxxxx').
 * @param {string} body - Isi pesan.
 */
const sendTwilioMessage = async (to, body) => {
    try {
        if (!accountSid || !authToken || !twilioNumber) {
            console.error("Twilio credentials tidak lengkap. Cek TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, dan TWILIO_NUMBER.");
            return;
        }

        const from = `whatsapp:${twilioNumber}`;
        console.log(`[TWILIO GATEWAY] Mengirim dari ${from} ke ${to}: ${body.substring(0, 50)}...`);

        await client.messages.create({
            from: from,
            to: to,
            body: body
        });

    } catch (error) {
        console.error("[TWILIO GATEWAY] Gagal mengirim pesan Twilio:", error.message);
    }
};


// --- TWILIO WEBHOOK ROUTE (Menerima pesan masuk dari Twilio)
app.post('/webhook', async (req, res) => {
    // Twilio mengirim data sebagai form data (req.body):
    const from = req.body.From; // whatsapp:+62812xxxxxx
    const incomingMessage = req.body.Body;
    
    if (!from || !incomingMessage) {
        console.log("[TWILIO GATEWAY] Webhook diterima, tetapi data From atau Body hilang.");
        return res.status(400).send('Missing message data');
    }

    console.log(`[TWILIO GATEWAY] Pesan masuk dari: ${from}, Isi: ${incomingMessage}`);

    // --- Langkah Kritis: Meneruskan ke Chatbot Core Service ---
    try {
        const twilioFromNumber = from.replace('whatsapp:', '');
        
        // --- START MODIFIKASI: Menghasilkan nama user dari nomor telepon ---
        let displayUserName;
        if (twilioFromNumber.length > 5) {
            // Contoh: +6281234567890 -> +62812...7890
            const prefix = twilioFromNumber.substring(0, 6);
            const suffix = twilioFromNumber.substring(twilioFromNumber.length - 4);
            displayUserName = `${prefix}...${suffix}`;
        } else {
            displayUserName = 'Pengguna WA';
        }
        // --- END MODIFIKASI ---
        
        const coreResponse = await axios.post(CORE_SERVICE_URL, {
            from: twilioFromNumber, // Mengirim nomor tanpa prefix 'whatsapp:'
            text: incomingMessage,
            userName: displayUserName // Menggunakan nomor telepon yang disingkat
        });

        const replyText = coreResponse.data.reply;
        
        // Kirim balasan menggunakan Twilio API
        await sendTwilioMessage(from, replyText);

        // Kirim respons 200 OK ke Twilio
        res.status(200).send("Message received and processed by Twilio Gateway.");

    } catch (error) {
        console.error(`[TWILIO GATEWAY] Gagal berkomunikasi dengan Chatbot Core (${CORE_SERVICE_URL}):`, error.message);
        // Jika gagal, kirim balasan error default ke pengguna
        await sendTwilioMessage(from, "Maaf, layanan Chatbot inti sedang tidak tersedia. Silakan coba lagi nanti.");
        res.status(500).send("Internal processing error.");
    }
});


// --- SERVER START ---
app.listen(PORT, () => {
    console.log(`Twilio Gateway Service berjalan di http://localhost:${PORT}`);
    console.log(`WAJIB: Pastikan Chatbot Core Service berjalan di http://localhost:3001`);
    console.log(`Pastikan Webhook Twilio dikonfigurasi ke: /webhook di port ${PORT}`);
});
