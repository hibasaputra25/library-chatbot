/**
 * levenshtein.js
 * Modul kalkulasi Levenshtein Distance untuk toleransi typo
 * pada pengenalan perintah di state main_menu.
 */

/**
 * Menghitung jarak Levenshtein antara dua string.
 * Menggunakan algoritma pemrograman dinamis dengan optimasi
 * penggunaan memori (two-row DP array).
 *
 * @param {string} a - String sumber (input pengguna)
 * @param {string} b - String target (keyword sistem)
 * @returns {number} Jumlah minimum operasi edit
 */
function levenshteinDistance(a, b) {
    const m = a.length;
    const n = b.length;

    if (m === 0) return n;
    if (n === 0) return m;

    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1);

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j]     + 1,      // Deletion
                curr[j - 1] + 1,      // Insertion
                prev[j - 1] + cost    // Substitution
            );
        }
        [prev, curr] = [curr, prev];
    }

    return prev[n];
}

/**
 * Menentukan threshold dinamis berdasarkan panjang keyword.
 * Mencegah false positive pada kata kunci pendek.
 *
 * @param {number} keywordLength - Panjang string keyword
 * @returns {number} Nilai threshold maksimal yang diizinkan
 */
function getDynamicThreshold(keywordLength) {
    if (keywordLength <= 5) return 1;
    return 2;
}

/**
 * Mencari keyword yang paling mendekati input pengguna.
 *
 * @param {string} input         - Teks input pengguna (sudah dinormalisasi)
 * @param {string[]} keywordList - Daftar keyword yang dikenali sistem
 * @returns {{ match: string|null, distance: number }}
 */
function findBestMatch(input, keywordList) {
    let bestMatch    = null;
    let bestDistance = Infinity;

    for (const keyword of keywordList) {
        // Exact match: langsung kembalikan tanpa kalkulasi lebih lanjut
        if (input === keyword) return { match: keyword, distance: 0 };

        const dist      = levenshteinDistance(input, keyword);
        const threshold = getDynamicThreshold(keyword.length);

        if (dist <= threshold && dist < bestDistance) {
            bestDistance = dist;
            bestMatch    = keyword;
        }
    }

    return { match: bestMatch, distance: bestDistance };
}

module.exports = { levenshteinDistance, findBestMatch, getDynamicThreshold };
