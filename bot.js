// ============================================================
// BOT FORWARD WHATSAPP - PROSES UTAMA
//
// Fungsi file ini:
// - Menghubungkan ke WhatsApp lewat Baileys (sesi di folder auth/)
// - Memantau pesan masuk dari grup sumber (sourceGroups)
// - Meneruskan pesan yang memenuhi trigger ke semua target:
//     1. Teks yang cocok dengan daftar TEXT_TRIGGERS
//     2. File Excel report sesuai EXCEL_REPORT_PATTERN
//     3. Gambar dengan caption trigger, atau yang lolos OCR
//        (mengandung "laporan harian" dan "lombok")
// - Membalas otomatis pesan terima kasih dari target (chat pribadi)
// - Menulis status koneksi/QR ke data/state.json untuk dashboard
// - Menyimpan daftar grup ke data/groups.json
//
// Alur singkat: messages.upsert -> cek auto-reply -> filter source
// group -> filter trigger -> masuk queue -> proses -> kirim ke target.
//
// Pengaturan yang sedang aktif (dibaca dari data/runtime-config.json):
// - Grup sumber          : GRUP REPORT (120363422141040169@g.us)
// - Penerima             : MIF (271558048247882@lid)
// - Jam aktif & forward  : 01:00 - 08:00 (Asia/Makassar)
// Nilai di config.js hanya dipakai sebagai cadangan/default.
// ============================================================

'use strict'

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys')

const P = require('pino')
const QRCode = require('qrcode')

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const {
    SOURCE_GROUP_ID,
    TARGET_USER_IDS,
    BOT_ACTIVE_START,
    BOT_ACTIVE_END,
    FORWARD_START,
    FORWARD_END,
    OCR_ENABLED,
    OCR_TIMEOUT,
    BOT_TIMEZONE,
    EXCEL_REPORT_PATTERN
} = require('./config')


// ============================================================
// CONFIG
// ============================================================

const AUTH_DIR = path.join(__dirname, 'auth')

const DATA_DIR = path.join(__dirname, 'data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.json')
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')

const LOGGER = P({
    level: 'silent'
})


// ============================================================
// RUNTIME CONFIG (dapat diubah dari dashboard)
// ============================================================

function defaultSchedule() {

    return {
        botActive: {
            start: BOT_ACTIVE_START,
            end: BOT_ACTIVE_END
        },

        forward: {
            start: FORWARD_START,
            end: FORWARD_END
        }
    }
}


function normalizeScheduleRange(raw, fallback) {

    const timePattern =
        /^([01]\d|2[0-3]):[0-5]\d$/


    const start =
        String(raw?.start || '').trim()

    const end =
        String(raw?.end || '').trim()


    if (
        !timePattern.test(start) ||
        !timePattern.test(end)
    ) {

        return fallback
    }


    return {
        start,
        end
    }
}


function defaultRuntimeConfig() {

    return {
        sourceGroups: SOURCE_GROUP_ID
            ? [{ id: SOURCE_GROUP_ID, name: 'Grup default' }]
            : [],

        targets: TARGET_USER_IDS.map(id => ({
            id,
            name: ''
        })),

        schedule: defaultSchedule()
    }
}


function writeJsonAtomic(file, value) {

    const tmp = `${file}.${process.pid}.tmp`

    fs.writeFileSync(
        tmp,
        JSON.stringify(value, null, 2)
    )

    fs.renameSync(tmp, file)
}


function ensureDataFiles() {

    fs.mkdirSync(
        DATA_DIR,
        {
            recursive: true
        }
    )


    if (
        !fs.existsSync(RUNTIME_CONFIG_FILE)
    ) {

        writeJsonAtomic(
            RUNTIME_CONFIG_FILE,
            defaultRuntimeConfig()
        )
    }
}


function readRuntimeConfig() {

    try {

        const parsed =
            JSON.parse(
                fs.readFileSync(
                    RUNTIME_CONFIG_FILE,
                    'utf8'
                )
            )


        const sourceGroups =
            Array.isArray(parsed.sourceGroups)
                ? parsed.sourceGroups
                    .filter(group => {

                        return (
                            group &&
                            typeof group.id === 'string' &&
                            group.id.includes('@')
                        )
                    })
                    .map(group => ({
                        id: group.id,

                        name: String(
                            group.name || ''
                        )
                    }))
                : []


        const targets =
            Array.isArray(parsed.targets)
                ? parsed.targets
                    .filter(target => {

                        return (
                            target &&
                            typeof target.id === 'string' &&
                            target.id.includes('@')
                        )
                    })
                    .map(target => ({
                        id: target.id,

                        name: String(
                            target.name || ''
                        )
                    }))
                : []


        const fallbackSchedule =
            defaultSchedule()


        const schedule = {
            botActive:
                normalizeScheduleRange(
                    parsed.schedule?.botActive,
                    fallbackSchedule.botActive
                ),

            forward:
                normalizeScheduleRange(
                    parsed.schedule?.forward,
                    fallbackSchedule.forward
                )
        }


        return {
            sourceGroups,
            targets,
            schedule
        }

    } catch (error) {

        console.error(
            '❌ Gagal membaca runtime config, memakai default:',
            error.message
        )

        return defaultRuntimeConfig()
    }
}


ensureDataFiles()

let runtimeConfig =
    readRuntimeConfig()


function isSourceGroup(remoteJid) {

    return runtimeConfig.sourceGroups.some(
        group => group.id === remoteJid
    )
}


function refreshRuntimeConfig() {

    runtimeConfig =
        readRuntimeConfig()


    console.log(
        `🔄 Config dimuat ulang | Source: ${runtimeConfig.sourceGroups.length} grup | Target: ${runtimeConfig.targets.length}`
    )
}


fs.watchFile(
    RUNTIME_CONFIG_FILE,
    {
        interval: 1000
    },
    refreshRuntimeConfig
)


// ============================================================
// STATE (dibaca dashboard)
// ============================================================

let botState = {
    status: 'starting',
    qr: null,
    me: null,
    connectedAt: null,
    lastError: null
}


function writeState(patch) {

    botState = {
        ...botState,
        ...patch,

        updatedAt:
            new Date().toISOString()
    }


    try {

        ensureDataFiles()

        writeJsonAtomic(
            STATE_FILE,
            botState
        )

    } catch (error) {

        console.error(
            '❌ Gagal menulis state:',
            error.message
        )
    }
}


async function writeGroupsFile() {

    if (!sock) {
        return
    }


    try {

        const groups =
            await sock.groupFetchAllParticipating()


        const list =
            Object.values(groups)
                .map(group => ({
                    id: group.id,

                    subject:
                        group.subject || '',

                    size:
                        Array.isArray(group.participants)
                            ? group.participants.length
                            : 0
                }))
                .sort((a, b) => {

                    return a.subject.localeCompare(
                        b.subject
                    )
                })


        writeJsonAtomic(
            GROUPS_FILE,
            list
        )


        console.log(
            `👥 Daftar grup diperbarui (${list.length} grup)`
        )

    } catch (error) {

        console.error(
            '⚠️ Gagal mengambil daftar grup:',
            error.message
        )
    }
}


writeState({
    status: 'starting'
})


// ============================================================
// TEXT TRIGGERS
// ============================================================

const TEXT_TRIGGERS = [
    'Report Pencapaian Sales Lombok vs BE MTD',
    'Report Daily Sales Lombok Periode',
    'Report Sales AM/AC vs TARGET MTD & E-Voucher Periode',
    'Report Growth SPD Toko Lombok AM/AC vs Last Year Periode',
    'Kontribusi Sales',
    'Report Daily Sales Voucher Lombok Periode',
    'Building Block Act vs BE Branch Lombok MTD Periode',
    'ACV DAILY VS BE'
]


// ============================================================
// AUTO REPLY
// ============================================================

const THANK_YOU_KEYWORDS = [
    'terimakasih',
    'terima kasih',
    'makasih',
    'mksh',
    'thanks',
    'thank you',
    'thx',
    'tks'
]

const AUTO_REPLY_TEXT =
    'Nggih Pak, sama-sama 🙏'

// Jeda sebelum membalas agar terlihat natural
const AUTO_REPLY_DELAY = 10000


// ============================================================
// RUNTIME STATE
// ============================================================

let sock = null
let botRunning = false
let reconnectTimer = null

const processedMessages = new Map()
const processedContent = new Map()
const processedExcelHashes = new Map()
const lidToPn = new Map()

const messageQueue = []
let processingQueue = false


// ============================================================
// TIME
// ============================================================

function getNowInTimezone() {

    return new Date(
        new Date().toLocaleString('en-US', {
            timeZone: BOT_TIMEZONE
        })
    )
}


function timeToMinutes(time) {

    const [hour, minute] =
        time.split(':').map(Number)

    return (hour * 60) + minute
}


function isTimeInRange(
    currentMinutes,
    startTime,
    endTime
) {

    const start =
        timeToMinutes(startTime)

    const end =
        timeToMinutes(endTime)


    // Normal range
    if (start <= end) {

        return (
            currentMinutes >= start &&
            currentMinutes <= end
        )
    }


    // Range melewati tengah malam
    return (
        currentMinutes >= start ||
        currentMinutes <= end
    )
}


function isBotActiveTime() {

    const now =
        getNowInTimezone()

    const currentMinutes =
        now.getHours() * 60 +
        now.getMinutes()

    return isTimeInRange(
        currentMinutes,
        runtimeConfig.schedule.botActive.start,
        runtimeConfig.schedule.botActive.end
    )
}


function isForwardTime() {

    const now =
        getNowInTimezone()

    const currentMinutes =
        now.getHours() * 60 +
        now.getMinutes()

    return isTimeInRange(
        currentMinutes,
        runtimeConfig.schedule.forward.start,
        runtimeConfig.schedule.forward.end
    )
}


function currentTimeString() {

    const now =
        getNowInTimezone()

    return now.toLocaleTimeString(
        'id-ID',
        {
            hour12: false
        }
    )
}


// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(text) {

    if (!text) {
        return ''
    }

    return String(text)
        .replace(/\r/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
}


function getMessageContainer(message) {

    if (
        !message ||
        !message.message
    ) {
        return null
    }

    let content =
        message.message


    // --------------------------------------------------------
    // Unwrap common Baileys wrappers
    // --------------------------------------------------------

    const WRAPPER_KEYS = [
        'deviceSentMessage',
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'documentWithCaptionMessage'
    ]


    for (
        let depth = 0;
        depth < 5;
        depth++
    ) {

        let next = null


        for (const key of WRAPPER_KEYS) {

            if (content[key]?.message) {

                next = content[key].message

                break
            }
        }


        if (!next) {
            break
        }


        content = next
    }


    return content
}


function getMessageText(message) {

    const content =
        getMessageContainer(message)

    if (!content) {
        return ''
    }


    if (
        typeof content.conversation === 'string'
    ) {

        return content.conversation
    }


    if (
        content.extendedTextMessage?.text
    ) {

        return content.extendedTextMessage.text
    }


    if (
        content.imageMessage?.caption
    ) {

        return content.imageMessage.caption
    }


    if (
        content.documentMessage?.caption
    ) {

        return content.documentMessage.caption
    }


    return ''
}


function isTextTrigger(text) {

    const normalized =
        normalizeText(text)

    if (!normalized) {
        return false
    }


    return TEXT_TRIGGERS.some(
        trigger => {

            return normalized.includes(
                normalizeText(trigger)
            )
        }
    )
}


// ============================================================
// SENDER / PARTICIPANT
// ============================================================

function getSenderJid(message) {

    if (!message) {
        return ''
    }


    // Untuk pesan group, pengirim biasanya ada di participant.
    // Untuk chat pribadi, remoteJid adalah pengirim.
    return (
        message.key?.participant ||
        message.key?.remoteJid ||
        ''
    )
}


function getSenderDisplay(message) {

    const senderJid =
        getSenderJid(message)

    if (!senderJid) {
        return '-'
    }


    return senderJid
}


// ============================================================
// AUTO REPLY HELPERS
// ============================================================

function canonicalJid(jid) {

    return String(jid || '')
        .replace(/:\d+@/, '@')
}


function rememberIdentity(message) {

    const key =
        message?.key || {}


    const pairs = [
        [key.senderLid, key.senderPn],
        [key.participantLid, key.participantPn]
    ]


    for (const [lid, pn] of pairs) {

        if (lid && pn) {

            lidToPn.set(lid, pn)
        }
    }
}


function getMessageIdentityJids(message) {

    const key =
        message?.key || {}


    const jids = [
        key.remoteJid,
        key.senderPn,
        key.senderLid,
        key.participantPn,
        key.participantLid,
        key.participant
    ].filter(Boolean)


    const mapped = []


    for (const jid of jids) {

        const pn =
            lidToPn.get(jid)

        if (pn) {
            mapped.push(pn)
        }
    }


    return [
        ...new Set([
            ...jids,
            ...mapped
        ])
    ]
}


function isTargetMessage(message) {

    const candidates =
        new Set(
            getMessageIdentityJids(message)
                .map(canonicalJid)
        )


    return runtimeConfig.targets.some(
        target => candidates.has(
            canonicalJid(target.id)
        )
    )
}


function getThankYouKeyword(text) {

    const normalized =
        normalizeText(text)

    if (!normalized) {
        return ''
    }


    return (
        THANK_YOU_KEYWORDS.find(
            keyword => normalized.includes(keyword)
        ) || ''
    )
}


function isThankYouMessage(text) {

    return !!getThankYouKeyword(text)
}


async function processTargetAutoReply(message) {

    if (!message || !sock) {
        return false
    }


    const remoteJid =
        message.key?.remoteJid || ''


    const messageId =
        message.key?.id || '-'


    rememberIdentity(message)


    // ========================================================
    // HANYA untuk mencegah bot membalas dirinya sendiri
    //
    // CATATAN:
    // Ini TIDAK berhubungan dengan forwarding group.
    // Forwarding TETAP menerima fromMe.
    // ========================================================

    if (message.key?.fromMe) {

        return false
    }


    // ========================================================
    // Hanya chat pribadi
    // ========================================================

    if (
        !remoteJid ||
        remoteJid === 'status@broadcast' ||
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@broadcast')
    ) {

        return false
    }


    const text =
        getMessageText(message)


    const keyword =
        getThankYouKeyword(text)


    if (!keyword) {

        return false
    }


    console.log(
        `🔎 [AUTO-REPLY] Terima kasih terdeteksi | ID ${messageId} | Dari ${remoteJid} | PN ${message.key?.senderPn || '-'} | Keyword "${keyword}"`
    )


    // ========================================================
    // Cocokkan target lewat remoteJid, LID, atau nomor PN
    // ========================================================

    if (!isTargetMessage(message)) {

        console.log(
            `⏭️ [AUTO-REPLY] Dilewati: pengirim bukan target | ID ${messageId} | ${remoteJid} | PN ${message.key?.senderPn || '-'}`
        )

        return false
    }


    // ========================================================
    // Ikut jam bot aktif
    // ========================================================

    if (!isBotActiveTime()) {

        console.log(
            `⏸️ [AUTO-REPLY] Standby: di luar jam aktif ${runtimeConfig.schedule.botActive.start}-${runtimeConfig.schedule.botActive.end} | ID ${messageId} | ${remoteJid}`
        )

        return false
    }


    console.log('')
    console.log(
        '=========================================='
    )

    console.log(
        '🤖 [AUTO-REPLY] TERIMA KASIH'
    )

    console.log(
        `🆔 Message ID : ${messageId}`
    )

    console.log(
        `👤 Remote JID : ${remoteJid}`
    )

    console.log(
        `👥 PN / LID   : ${message.key?.senderPn || '-'} / ${message.key?.senderLid || '-'}`
    )

    console.log(
        `🔑 Keyword    : ${keyword}`
    )

    console.log(
        `📝 Pesan      : ${text}`
    )

    console.log(
        `💬 Balasan    : ${AUTO_REPLY_TEXT}`
    )

    console.log(
        `⏳ Jeda       : ${AUTO_REPLY_DELAY / 1000} detik`
    )

    console.log(
        '=========================================='
    )


    const socket = sock
    const waitStartedAt = Date.now()


    console.log(
        `⏳ [AUTO-REPLY] Menunggu ${AUTO_REPLY_DELAY / 1000} detik sebelum membalas | ID ${messageId}`
    )


    await new Promise(resolve => {

        setTimeout(resolve, AUTO_REPLY_DELAY)
    })


    try {

        console.log(
            `📤 [AUTO-REPLY] Mengirim balasan ke ${remoteJid} | ID ${messageId}`
        )


        await socket.sendMessage(
            remoteJid,
            {
                text: AUTO_REPLY_TEXT
            }
        )


        const elapsed =
            ((Date.now() - waitStartedAt) / 1000).toFixed(1)


        console.log(
            `✅ [AUTO-REPLY] Terkirim dalam ${elapsed}s | ID ${messageId} | Ke ${remoteJid}`
        )

        return true

    } catch (error) {

        console.error(
            `❌ [AUTO-REPLY] Gagal mengirim | ID ${messageId} | Ke ${remoteJid}:`,
            error.message
        )

        return false
    }
}


// ============================================================
// MESSAGE TYPE
// ============================================================

function getImageMessage(message) {

    const content =
        getMessageContainer(message)

    if (!content) {
        return null
    }

    return content.imageMessage || null
}


function getDocumentMessage(message) {

    const content =
        getMessageContainer(message)

    if (!content) {
        return null
    }

    return content.documentMessage || null
}


function hasImage(message) {

    return !!getImageMessage(message)
}


function hasDocument(message) {

    return !!getDocumentMessage(message)
}


function isExcelReport(message) {

    const documentMessage =
        getDocumentMessage(message)

    if (!documentMessage) {
        return false
    }


    const fileName =
        documentMessage.fileName || ''


    return EXCEL_REPORT_PATTERN.test(
        fileName
    )
}


// ============================================================
// HASH / DUPLICATE
// ============================================================

function createFingerprint(buffer) {

    return crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex')
}


function createTextFingerprint(text) {

    return crypto
        .createHash('sha256')
        .update(normalizeText(text))
        .digest('hex')
}


function cleanupMap(
    map,
    maxAge
) {

    const now =
        Date.now()


    for (
        const [
            key,
            timestamp
        ] of map.entries()
    ) {

        if (
            (now - timestamp) >
            maxAge
        ) {

            map.delete(key)
        }
    }
}


function isDuplicateTextOrImage(
    fingerprint
) {

    cleanupMap(
        processedContent,
        60 * 1000
    )


    if (
        processedContent.has(
            fingerprint
        )
    ) {

        return true
    }


    processedContent.set(
        fingerprint,
        Date.now()
    )


    return false
}


function isDuplicateExcel(hash) {

    cleanupMap(
        processedExcelHashes,
        60 * 60 * 1000
    )


    if (
        processedExcelHashes.has(hash)
    ) {

        return true
    }


    processedExcelHashes.set(
        hash,
        Date.now()
    )


    return false
}


function isDuplicateMessage(
    messageId
) {

    cleanupMap(
        processedMessages,
        10 * 60 * 1000
    )


    if (
        processedMessages.has(
            messageId
        )
    ) {

        return true
    }


    processedMessages.set(
        messageId,
        Date.now()
    )


    return false
}


// ============================================================
// MEDIA DOWNLOAD
// ============================================================

async function downloadMedia(message) {

    if (!sock) {

        throw new Error(
            'Socket WhatsApp belum tersedia'
        )
    }


    return await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
            logger: LOGGER,
            reuploadRequest:
                sock.updateMediaMessage
        }
    )
}


// ============================================================
// OCR
// ============================================================

let systemTesseractMissing = false
let tesseractJsWorker = null


async function runOCRTesseractJs(buffer) {

    if (!tesseractJsWorker) {

        const { createWorker } =
            require('tesseract.js')


        console.log(
            'ℹ️ Menyiapkan tesseract.js (fallback OCR)...'
        )


        tesseractJsWorker =
            await createWorker('eng')
    }


    const { data } =
        await tesseractJsWorker.recognize(
            buffer
        )


    return data.text || ''
}


async function runOCR(
    buffer,
    extension = '.jpg'
) {

    const tempDir =
        fs.mkdtempSync(
            path.join(
                os.tmpdir(),
                'bot-forward-'
            )
        )


    const imagePath =
        path.join(
            tempDir,
            `image${extension}`
        )


    try {

        fs.writeFileSync(
            imagePath,
            buffer
        )


        if (!systemTesseractMissing) {

            console.log(
                '🔎 Menjalankan OCR (tesseract)...'
            )


            try {

                const result =
                    await execFileAsync(
                        'tesseract',
                        [
                            imagePath,
                            'stdout',
                            '--psm',
                            '6',
                            '-l',
                            'eng'
                        ],
                        {
                            timeout:
                                OCR_TIMEOUT,

                            maxBuffer:
                                10 * 1024 * 1024
                        }
                    )


                return result.stdout || ''

            } catch (error) {

                if (
                    error.code !== 'ENOENT'
                ) {

                    throw error
                }


                systemTesseractMissing = true


                console.log(
                    'ℹ️ Tesseract sistem tidak ada, beralih ke tesseract.js'
                )
            }
        }


        return await runOCRTesseractJs(
            buffer
        )

    } finally {

        try {

            fs.rmSync(
                tempDir,
                {
                    recursive: true,
                    force: true
                }
            )

        } catch (err) {

            // abaikan
        }
    }
}


function isOCRMatch(text) {

    const normalized =
        normalizeText(text)


    const hasLaporanHarian =
        normalized.includes(
            'laporan harian'
        )


    const hasLombok =
        normalized.includes(
            'lombok'
        )


    return (
        hasLaporanHarian &&
        hasLombok
    )
}


// ============================================================
// SEND TO TARGETS
// ============================================================

async function sendToAllTargets(
    payload
) {

    if (!sock) {

        throw new Error(
            'Socket belum tersedia'
        )
    }


    for (
        const target
        of runtimeConfig.targets
    ) {

        try {

            console.log(
                `📤 Mengirim ke target: ${target.id}${target.name ? ` (${target.name})` : ''}`
            )


            await sock.sendMessage(
                target.id,
                payload
            )


            console.log(
                `✅ Berhasil dikirim ke ${target.id}`
            )

        } catch (error) {

            console.error(
                `❌ Gagal kirim ke ${target.id}:`,
                error.message
            )
        }
    }
}


// ============================================================
// PROCESS TEXT
// ============================================================

async function processText(
    message,
    text
) {

    const fingerprint =
        createTextFingerprint(text)


    if (
        isDuplicateTextOrImage(
            fingerprint
        )
    ) {

        console.log(
            '⏭️ TEXT DUPLIKAT - dilewati'
        )

        return
    }


    console.log(
        '🎯 TEXT MATCH'
    )


    console.log(
        `📝 ${text}`
    )


    await sendToAllTargets({
        text: text
    })


    console.log(
        '✅ Text selesai diproses'
    )
}


// ============================================================
// PROCESS EXCEL
// ============================================================

async function processExcel(
    message
) {

    const documentMessage =
        getDocumentMessage(message)


    if (!documentMessage) {
        return
    }


    const fileName =
        documentMessage.fileName ||
        'report.xlsx'


    console.log(
        `📊 Excel ditemukan: ${fileName}`
    )


    let buffer


    try {

        buffer =
            await downloadMedia(
                message
            )

    } catch (error) {

        console.error(
            '❌ Gagal download Excel:',
            error
        )

        return
    }


    const hash =
        createFingerprint(buffer)


    console.log(
        `🔐 SHA-256: ${hash}`
    )


    if (
        isDuplicateExcel(hash)
    ) {

        console.log(
            '⏭️ EXCEL DUPLIKAT - dilewati'
        )

        return
    }


    console.log(
        '🎯 EXCEL MATCH'
    )


    await sendToAllTargets({

        document: buffer,

        mimetype:
            documentMessage.mimetype ||
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

        fileName: fileName
    })


    console.log(
        '✅ Excel selesai diproses'
    )
}


// ============================================================
// PROCESS IMAGE
// ============================================================

async function processImage(
    message
) {

    const imageMessage =
        getImageMessage(message)


    if (!imageMessage) {

        console.log(
            '⚠️ ImageMessage tidak ditemukan'
        )

        return
    }


    let buffer


    try {

        console.log(
            '📥 Download image...'
        )


        buffer =
            await downloadMedia(
                message
            )


        console.log(
            `📦 Image downloaded: ${buffer.length} bytes`
        )

    } catch (error) {

        console.error(
            '❌ Gagal download image:',
            error
        )

        return
    }


    // ========================================================
    // DUPLICATE IMAGE
    // ========================================================

    const fingerprint =
        createFingerprint(buffer)


    if (
        isDuplicateTextOrImage(
            fingerprint
        )
    ) {

        console.log(
            '⏭️ IMAGE DUPLIKAT - dilewati'
        )

        return
    }


    // ========================================================
    // CAPTION
    // ========================================================

    const caption =
        imageMessage.caption || ''


    // ========================================================
    // IMAGE + CAPTION
    // ========================================================

    if (
        isTextTrigger(caption)
    ) {

        console.log(
            '🎯 IMAGE CAPTION MATCH'
        )


        await sendToAllTargets({

            image: buffer,

            mimetype:
                imageMessage.mimetype ||
                'image/jpeg',

            caption: caption
        })


        console.log(
            '✅ Image + caption selesai diproses'
        )


        return
    }


    // ========================================================
    // OCR
    // ========================================================

    if (!OCR_ENABLED) {

        console.log(
            'ℹ️ OCR disabled'
        )

        return
    }


    console.log(
        '🔎 OCR image...'
    )


    let ocrText = ''


    try {

        ocrText =
            await runOCR(
                buffer,
                '.jpg'
            )

    } catch (error) {

        console.error(
            '❌ OCR gagal:',
            error.message
        )

        return
    }


    console.log(
        '📄 HASIL OCR:'
    )


    console.log(
        ocrText
    )


    // ========================================================
    // OCR TRIGGER
    //
    // HARUS ADA:
    // LAPORAN HARIAN
    // DAN
    // LOMBOK
    // ========================================================

    if (
        !isOCRMatch(ocrText)
    ) {

        console.log(
            '⏭️ OCR tidak memenuhi trigger'
        )

        return
    }


    console.log(
        '🎯 IMAGE MATCH dari OCR'
    )


    const payload = {

        image: buffer,

        mimetype:
            imageMessage.mimetype ||
            'image/jpeg'
    }


    if (caption) {

        payload.caption =
            caption
    }


    await sendToAllTargets(
        payload
    )


    console.log(
        '✅ Image OCR selesai diproses'
    )
}


// ============================================================
// QUEUE
// ============================================================

function addToQueue(task) {

    messageQueue.push(task)


    console.log(
        `📥 Masuk queue. Panjang queue: ${messageQueue.length}`
    )


    processQueue()
}


async function processQueue() {

    if (processingQueue) {
        return
    }


    processingQueue = true


    try {

        while (
            messageQueue.length > 0
        ) {

            const task =
                messageQueue.shift()


            console.log(
                `⚙️ Processing queue. Sisa: ${messageQueue.length}`
            )


            try {

                await processIncomingMessage(
                    task.message
                )

            } catch (error) {

                console.error(
                    '❌ Error processing queue:',
                    error
                )
            }
        }

    } finally {

        processingQueue = false
    }
}


// ============================================================
// PROCESS INCOMING MESSAGE
// ============================================================

async function processIncomingMessage(
    message
) {

    if (!message) {
        return
    }


    const remoteJid =
        message.key?.remoteJid || ''


    const senderJid =
        getSenderJid(message)


    const messageId =
        message.key?.id || ''


    console.log('')
    console.log(
        '=========================================='
    )


    console.log(
        `🕐 ${currentTimeString()}`
    )


    console.log(
        `📍 Remote JID : ${remoteJid}`
    )


    console.log(
        `👤 Sender JID : ${senderJid || '-'}`
    )


    console.log(
        `🤖 From Me    : ${message.key?.fromMe}`
    )


    console.log(
        `🆔 Message ID : ${messageId}`
    )


    console.log(
        `📝 Push Name  : ${message.pushName || '-'}`
    )


    console.log(
        '=========================================='
    )


    // ========================================================
    // SOURCE GROUP
    //
    // HANYA group ini yang boleh diteruskan.
    // ========================================================

    if (
        !isSourceGroup(remoteJid)
    ) {

        console.log(
            '⏭️ Bukan source group'
        )

        return
    }


    // ========================================================
    // PENTING:
    //
    // TIDAK ADA FILTER FROM ME DI SINI.
    //
    // Artinya:
    //
    // 1. Orang lain kirim pesan  -> DIPROSES
    // 2. Saya kirim pesan        -> DIPROSES
    // 3. Bot kirim pesan         -> DIPROSES
    //
    // Selama:
    // - berasal dari SOURCE_GROUP_ID
    // - memenuhi trigger
    // - masuk jam forwarding
    //
    // maka akan diteruskan.
    // ========================================================


    // ========================================================
    // MESSAGE ID DUPLICATE
    // ========================================================

    if (messageId) {

        if (
            isDuplicateMessage(
                messageId
            )
        ) {

            console.log(
                '⏭️ Message ID duplikat'
            )

            return
        }
    }


    // ========================================================
    // BOT ACTIVE TIME
    // ========================================================

    if (
        !isBotActiveTime()
    ) {

        console.log(
            `⏸️ Bot standby. Active: ${runtimeConfig.schedule.botActive.start}-${runtimeConfig.schedule.botActive.end}`
        )

        return
    }


    // ========================================================
    // FORWARD TIME
    // ========================================================

    if (
        !isForwardTime()
    ) {

        console.log(
            `⏸️ Di luar jam forwarding. Forward: ${runtimeConfig.schedule.forward.start}-${runtimeConfig.schedule.forward.end}`
        )

        return
    }


    // ========================================================
    // TEXT
    // ========================================================

    const text =
        getMessageText(message)


    // ========================================================
    // EXCEL
    // ========================================================

    if (
        hasDocument(message)
    ) {

        if (
            isExcelReport(message)
        ) {

            console.log(
                '📊 Excel masuk queue'
            )


            await processExcel(
                message
            )


            return
        }


        console.log(
            '⏭️ Document bukan Excel Report'
        )


        return
    }


    // ========================================================
    // IMAGE
    // ========================================================

    if (
        hasImage(message)
    ) {

        console.log(
            '🖼️ Image masuk queue'
        )


        await processImage(
            message
        )


        return
    }


    // ========================================================
    // TEXT
    // ========================================================

    if (
        isTextTrigger(text)
    ) {

        console.log(
            '📝 Text trigger masuk queue'
        )


        await processText(
            message,
            text
        )


        return
    }


    console.log(
        '⏭️ Tidak ada trigger'
    )
}


// ============================================================
// CONNECTION
// ============================================================

async function startBot() {

    if (botRunning) {
        return
    }


    botRunning = true


    writeState({
        status: 'connecting',
        lastError: null
    })


    console.log('')


    console.log(
        '=========================================='
    )


    console.log(
        '🚀 STARTING WHATSAPP BOT'
    )


    console.log(
        '=========================================='
    )


    console.log(
        `📌 Source Groups : ${runtimeConfig.sourceGroups.length}`
    )


    runtimeConfig.sourceGroups.forEach(
        (group, index) => {

            console.log(
                `   ${index + 1}. ${group.id}${group.name ? ` (${group.name})` : ''}`
            )
        }
    )


    console.log(
        `📌 Target Count : ${runtimeConfig.targets.length}`
    )


    runtimeConfig.targets.forEach(
        (target, index) => {

            console.log(
                `   ${index + 1}. ${target.id}${target.name ? ` (${target.name})` : ''}`
            )
        }
    )


    console.log(
        `⏰ Bot Active   : ${runtimeConfig.schedule.botActive.start} - ${runtimeConfig.schedule.botActive.end}`
    )


    console.log(
        `📤 Forward      : ${runtimeConfig.schedule.forward.start} - ${runtimeConfig.schedule.forward.end}`
    )


    console.log(
        `🌏 Timezone     : ${BOT_TIMEZONE}`
    )


    console.log(
        `🔎 OCR          : ${OCR_ENABLED ? 'ON' : 'OFF'}`
    )


    console.log(
        '⚡ Mode         : INSTANT + SEQUENTIAL QUEUE'
    )


    console.log(
        '🔁 From Me      : ACCEPTED FORWARDING'
    )


    console.log(
        '🤖 Auto Reply   : ENABLED'
    )


    console.log(
        `💬 Auto Reply   : "${AUTO_REPLY_TEXT}"`
    )


    console.log(
        '=========================================='
    )


    // ========================================================
    // AUTH
    // ========================================================

    if (
        !fs.existsSync(AUTH_DIR)
    ) {

        fs.mkdirSync(
            AUTH_DIR,
            {
                recursive: true
            }
        )
    }


    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            AUTH_DIR
        )


    // ========================================================
    // SOCKET
    // ========================================================

    sock =
        makeWASocket({

            auth: state,

            logger: LOGGER,

            printQRInTerminal: false,

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false
        })


    // ========================================================
    // SAVE AUTH
    // ========================================================

    sock.ev.on(
        'creds.update',
        saveCreds
    )


    // Cache nama kontak apabila Baileys menyediakan data kontak.
    // Kontak tidak disimpan ke database


    // ========================================================
    // CONNECTION UPDATE
    // ========================================================

    sock.ev.on(
        'connection.update',
        async update => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update


            // ------------------------------------------------
            // QR
            // ------------------------------------------------

            if (qr) {

                console.log('')


                console.log(
                    '📱 QR baru tersedia — scan di dashboard'
                )


                try {

                    const qrDataUrl =
                        await QRCode.toDataURL(
                            qr,
                            {
                                margin: 1,
                                width: 512
                            }
                        )


                    writeState({
                        status: 'qr',
                        qr: qrDataUrl,
                        me: null,
                        connectedAt: null,
                        lastError: null
                    })

                } catch (error) {

                    console.error(
                        '❌ Gagal membuat QR untuk dashboard:',
                        error.message
                    )
                }
            }


            // ------------------------------------------------
            // CONNECTED
            // ------------------------------------------------

            if (
                connection === 'open'
            ) {

                console.log('')


                console.log(
                    '=========================================='
                )


                console.log(
                    '✅ WHATSAPP CONNECTED'
                )


                console.log(
                    `🕐 ${currentTimeString()} ${BOT_TIMEZONE}`
                )


                console.log(
                    '=========================================='
                )


                botRunning = true


                writeState({
                    status: 'connected',
                    qr: null,

                    me: sock?.user
                        ? {
                            id: sock.user.id,

                            name:
                                sock.user.name ||
                                sock.user.verifiedName ||
                                ''
                        }
                        : null,

                    connectedAt:
                        new Date().toISOString(),

                    lastError: null
                })


                writeGroupsFile()


                return
            }


            // ------------------------------------------------
            // CLOSED
            // ------------------------------------------------

            if (
                connection === 'close'
            ) {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode


                const loggedOut =
                    statusCode ===
                    DisconnectReason.loggedOut


                console.log('')


                console.log(
                    '=========================================='
                )


                console.log(
                    '❌ WHATSAPP CONNECTION CLOSED'
                )


                console.log(
                    `Status: ${statusCode || 'unknown'}`
                )


                console.log(
                    `Logged out: ${loggedOut}`
                )


                console.log(
                    '=========================================='
                )


                botRunning = false

                sock = null


                writeState({
                    status: loggedOut
                        ? 'logged_out'
                        : 'disconnected',

                    qr: null,
                    me: null,

                    lastError:
                        lastDisconnect
                            ?.error
                            ?.message ||
                        `closed (${statusCode || 'unknown'})`
                })


                // ------------------------------------------------
                // LOGOUT
                // ------------------------------------------------

                if (loggedOut) {

                    console.log(
                        '⚠️ WhatsApp logout.'
                    )


                    console.log(
                        'ℹ️ Jangan hapus auth otomatis.'
                    )


                    console.log(
                        'ℹ️ Jika perlu pairing ulang, lakukan manual.'
                    )


                    return
                }


                // ------------------------------------------------
                // RECONNECT
                // ------------------------------------------------

                if (reconnectTimer) {
                    return
                }


                console.log(
                    '🔄 Reconnect dalam 5 detik...'
                )


                reconnectTimer =
                    setTimeout(
                        async () => {

                            reconnectTimer =
                                null


                            try {

                                await startBot()

                            } catch (error) {

                                console.error(
                                    '❌ Reconnect error:',
                                    error
                                )
                            }

                        },
                        5000
                    )
            }
        }
    )


    // ========================================================
    // INCOMING MESSAGES
    // ========================================================

    sock.ev.on(
        'messages.upsert',
        async ({
            messages,
            type
        }) => {

            if (
                !messages ||
                !messages.length
            ) {

                return
            }


            console.log('')


            console.log(
                `📨 messages.upsert | type=${type} | count=${messages.length}`
            )


            for (
                const message
                of messages
            ) {

                try {

                    const remoteJid =
                        message.key?.remoteJid ||
                        ''


                    const senderJid =
                        getSenderJid(message)


                    console.log(
                        `📩 Incoming Group/Chat : ${remoteJid}`
                    )


                    console.log(
                        `👤 Sender              : ${senderJid || '-'}`
                    )


                    console.log(
                        `🤖 From Me             : ${message.key?.fromMe}`
                    )


                    if (
                        !message.key?.fromMe &&
                        String(remoteJid).endsWith('@lid')
                    ) {

                        console.log(
                            `🧭 Identitas LID       : PN ${message.key?.senderPn || '-'} | LID ${message.key?.senderLid || '-'}`
                        )
                    }


                    // =================================================
                    // AUTO REPLY
                    //
                    // Hanya untuk private message dari target.
                    //
                    // fromMe dicek DI SINI SAJA agar bot tidak
                    // membalas dirinya sendiri.
                    // =================================================

                    const autoReplied =
                        await processTargetAutoReply(
                            message
                        )


                    if (autoReplied) {

                        console.log(
                            '↩️ Pesan selesai sebagai auto-reply'
                        )


                        continue
                    }


                    // =================================================
                    // HANYA SOURCE GROUP UNTUK FORWARDING
                    // =================================================

                    if (
                        !isSourceGroup(remoteJid)
                    ) {

                        console.log(
                            '⏭️ Bukan source group'
                        )


                        continue
                    }


                    // =================================================
                    // PENTING:
                    //
                    // JANGAN PERNAH melakukan:
                    //
                    // if (message.key?.fromMe) return
                    //
                    // karena user memang ingin pesan dari dirinya
                    // sendiri juga diteruskan.
                    // =================================================


                    // =================================================
                    // CHECK MESSAGE TYPE
                    // =================================================

                    const text =
                        getMessageText(
                            message
                        )


                    const content =
                        getMessageContainer(message)


                    console.log(
                        `🧩 Content            : ${
                            content
                                ? Object.keys(content).join(', ')
                                : 'kosong'
                        }`
                    )


                    if (text) {

                        console.log(
                            `📝 Text preview       : ${
                                normalizeText(text).slice(0, 180)
                            }`
                        )
                    }


                    const hasImg =
                        hasImage(
                            message
                        )


                    const hasDoc =
                        hasDocument(
                            message
                        )


                    const isExcel =
                        hasDoc &&
                        isExcelReport(
                            message
                        )


                    const textMatch =
                        isTextTrigger(
                            text
                        )


                    if (text && !textMatch) {

                        console.log(
                            '⏭️ Teks ada tapi tidak cocok dengan daftar trigger'
                        )
                    }


                    // =================================================
                    // HANYA MASUK QUEUE JIKA ADA TRIGGER
                    // =================================================

                    if (
                        !hasImg &&
                        !isExcel &&
                        !textMatch
                    ) {

                        console.log(
                            '⏭️ Source group tapi tidak ada trigger'
                        )


                        continue
                    }


                    // =================================================
                    // QUEUE
                    // =================================================

                    addToQueue({
                        message
                    })

                } catch (error) {

                    console.error(
                        '❌ Error messages.upsert:',
                        error
                    )
                }
            }
        }
    )


}


// ============================================================
// PERIODIC MONITOR
// ============================================================

setInterval(
    () => {

        if (!botRunning) {
            return
        }


        const active =
            isBotActiveTime()


        const forwarding =
            isForwardTime()


        console.log(
            `🕐 ${currentTimeString()} | Active=${active} | Forward=${forwarding} | Queue=${messageQueue.length}`
        )

    },
    5 * 60 * 1000
)


setInterval(
    () => {

        if (sock) {
            writeGroupsFile()
        }

    },
    15 * 60 * 1000
)


// ============================================================
// START
// ============================================================

startBot()
    .catch(error => {

        console.error(
            '❌ Fatal bot error:',
            error
        )


        process.exit(1)
    })


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
    signal
) {

    console.log('')


    console.log(
        `🛑 Received ${signal}`
    )


    try {

        if (sock) {

            try {

                sock.end(
                    new Error(
                        'Bot shutdown'
                    )
                )

            } catch (error) {

                // abaikan
            }
        }

    } catch (error) {

        console.error(
            'Shutdown error:',
            error
        )

    } finally {

        try {

            if (tesseractJsWorker) {

                await tesseractJsWorker.terminate()

                tesseractJsWorker = null
            }

        } catch (error) {

            // abaikan
        }


        process.exit(0)
    }
}


process.on(
    'SIGINT',
    () => shutdown('SIGINT')
)


process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
)