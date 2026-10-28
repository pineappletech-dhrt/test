// ============================================================
// KONFIGURASI BOT FORWARD WHATSAPP
//
// File ini berisi nilai awal/cadangan untuk:
// - Grup sumber yang pesannya dipantau (SOURCE_GROUP_ID)
// - Daftar penerima hasil forward (TARGET_USER_IDS)
// - Jam bot aktif dan jam forwarding
// - Jeda queue, pengaturan OCR, zona waktu
// - Pola nama file Excel yang dianggap report
//
// Nilai di file ini hanya dipakai saat data/runtime-config.json
// belum ada. Pengaturan dari dashboard disimpan di file tersebut
// dan akan menimpa nilai di sini (kecuali zona waktu & OCR,
// yang selalu diambil dari file ini).
// ============================================================

// ============================================================
// SOURCE GROUP
// ============================================================

const SOURCE_GROUP_ID = '120363422141040169@g.us'   // GRUP REPORT


// ============================================================
// TARGET USER
// ============================================================

const TARGET_USER_IDS = [
	'271558048247882@lid'   // MIF
]


// ============================================================
// JAM BOT AKTIF
// Bot hanya menjaga koneksi pada jam ini
// ============================================================

const BOT_ACTIVE_START = '01:00'
const BOT_ACTIVE_END   = '08:00'


// ============================================================
// JAM FORWARD
// Pesan hanya diteruskan pada jam ini
// ============================================================

const FORWARD_START = '01:00'
const FORWARD_END   = '08:00'


// ============================================================
// DUPLICATE
// Jika konten sama muncul berulang dalam waktu ini,
// hanya versi terakhir yang dikirim.
// ============================================================

const DUPLICATE_WAIT = 10000


// ============================================================
// QUEUE
// Jeda antar proses pengiriman
// ============================================================

const QUEUE_DELAY = 1500


// ============================================================
// OCR
// ============================================================

const OCR_ENABLED = true
const OCR_TIMEOUT = 30000


// ============================================================
// TIMEZONE
// ============================================================

const BOT_TIMEZONE = 'Asia/Makassar'


// ============================================================
// EXCEL REPORT
//
// Contoh yang diterima:
//
// 1. Report Harian OKTOBER 2026.xlsx
// 1. Report Harian September 2026.xlsx
// 1. Report Harian NOVEMBER 2027.xlsx
//
// Tidak tergantung huruf besar/kecil.
// ============================================================

const EXCEL_REPORT_PATTERN =
    /^1\.\s*Report Harian\s+[A-Za-zÀ-ÿ]+\s+\d{4}\.xlsx$/i


// ============================================================
// EXPORT
// ============================================================

module.exports = {
    SOURCE_GROUP_ID,
    TARGET_USER_IDS,

    BOT_ACTIVE_START,
    BOT_ACTIVE_END,

    FORWARD_START,
    FORWARD_END,

    DUPLICATE_WAIT,
    QUEUE_DELAY,

    OCR_ENABLED,
    OCR_TIMEOUT,

    BOT_TIMEZONE,

    EXCEL_REPORT_PATTERN
}
