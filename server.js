// ============================================================
// SERVER DASHBOARD BOT FORWARD
//
// Fungsi file ini:
// - Menjalankan web dashboard (Express) di port 3210
// - Menyajikan halaman dashboard dari folder public/
// - Menyediakan API: status bot, baca/simpan konfigurasi,
//   daftar grup WhatsApp, dan log service
// - Login Basic Auth, plus kode unlock tanggal untuk mengubah setelan
// - WebSocket /ws untuk siaran langsung status, jadwal, dan log
// - Reset sesi WhatsApp (pindahkan folder auth/ lalu restart service)
//
// Pengaturan yang sedang aktif (dibaca dari data/runtime-config.json):
// - Grup sumber          : GRUP REPORT (120363422141040169@g.us)
// - Penerima             : MIF (271558048247882@lid)
// - Jam aktif & forward  : 01:00 - 08:00 (Asia/Makassar)
// Nilai default/cadangan diambil dari config.js.
// ============================================================

'use strict'

const express = require('express')
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.PORT || 3210)
const HOST = process.env.HOST || '127.0.0.1'
const BOT_UNIT = 'bot-forward.service'

const ROOT = __dirname
const DATA_DIR = path.join(ROOT, 'data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.json')
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')
const AUTH_FILE = path.join(DATA_DIR, 'dashboard-auth.json')

const MAX_LOG_LINES = 3000


// ============================================================
// HELPERS
// ============================================================

function writeFileAtomic(file, content, mode) {

    const tmp = `${file}.${process.pid}.tmp`

    fs.writeFileSync(tmp, content, {
        mode: mode || 0o644
    })

    fs.renameSync(tmp, file)
}


function readJson(file, fallback) {

    try {

        return JSON.parse(
            fs.readFileSync(file, 'utf8')
        )

    } catch (error) {

        return fallback
    }
}


function loadCredentials() {

    if (
        process.env.DASH_USER &&
        process.env.DASH_PASSWORD
    ) {

        return {
            username: process.env.DASH_USER,
            password: process.env.DASH_PASSWORD
        }
    }


    fs.mkdirSync(DATA_DIR, {
        recursive: true
    })


    const saved =
        readJson(AUTH_FILE, null)


    if (
        saved &&
        typeof saved.username === 'string' &&
        typeof saved.password === 'string'
    ) {

        return saved
    }


    const credentials = {
        username: 'admin',
        password:
            crypto.randomBytes(18).toString('base64url')
    }


    writeFileAtomic(
        AUTH_FILE,
        JSON.stringify(credentials, null, 2),
        0o600
    )


    console.log(
        '🔐 Kredensial dashboard dibuat di data/dashboard-auth.json'
    )


    return credentials
}


function safeEqual(a, b) {

    const left =
        Buffer.from(String(a))

    const right =
        Buffer.from(String(b))


    if (left.length !== right.length) {
        return false
    }


    return crypto.timingSafeEqual(left, right)
}


function parseBasicAuth(header) {

    if (
        !header ||
        !header.startsWith('Basic ')
    ) {

        return false
    }


    let decoded = ''


    try {

        decoded =
            Buffer
                .from(header.slice(6), 'base64')
                .toString('utf8')

    } catch (error) {

        return false
    }


    const separator =
        decoded.indexOf(':')


    if (separator === -1) {
        return false
    }


    const username =
        decoded.slice(0, separator)

    const password =
        decoded.slice(separator + 1)


    return (
        safeEqual(
            username,
            CREDENTIALS.username
        ) &&
        safeEqual(
            password,
            CREDENTIALS.password
        )
    )
}


const CREDENTIALS =
    loadCredentials()


// ============================================================
// SCHEDULE
// ============================================================

// Cadangan jika config.js gagal dibaca; nilainya disamakan dengan config.js.
let baseConfig = {
    BOT_ACTIVE_START: '01:00',
    BOT_ACTIVE_END: '08:00',
    FORWARD_START: '01:00',
    FORWARD_END: '08:00',
    BOT_TIMEZONE: 'Asia/Makassar'
}


try {

    baseConfig = {
        ...baseConfig,
        ...require('./config')
    }

} catch (error) {

    console.error(
        '⚠️ config.js tidak terbaca:',
        error.message
    )
}


function defaultSchedule() {

    return {
        botActive: {
            start: baseConfig.BOT_ACTIVE_START,
            end: baseConfig.BOT_ACTIVE_END
        },

        forward: {
            start: baseConfig.FORWARD_START,
            end: baseConfig.FORWARD_END
        }
    }
}


function parseScheduleRange(raw) {

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

        return null
    }


    return {
        start,
        end
    }
}


function normalizeScheduleRange(raw, fallback) {

    return parseScheduleRange(raw) || fallback
}


function normalizeScheduleInput(raw) {

    const botActive =
        parseScheduleRange(raw?.botActive)

    const forward =
        parseScheduleRange(raw?.forward)


    if (!botActive || !forward) {
        return null
    }


    return {
        botActive,
        forward
    }
}


function getEffectiveSchedule(raw) {

    const fallback =
        defaultSchedule()


    return {
        botActive:
            normalizeScheduleRange(
                raw?.botActive,
                fallback.botActive
            ),

        forward:
            normalizeScheduleRange(
                raw?.forward,
                fallback.forward
            )
    }
}


function getEffectiveConfig() {

    const saved =
        readJson(CONFIG_FILE, {})


    return {
        sourceGroups:
            Array.isArray(saved.sourceGroups)
                ? saved.sourceGroups
                : [],

        targets:
            Array.isArray(saved.targets)
                ? saved.targets
                : [],

        schedule:
            getEffectiveSchedule(saved.schedule)
    }
}


function timeToMinutes(time) {

    const [hour, minute] =
        String(time).split(':').map(Number)


    return (hour * 60) + minute
}


function inRange(current, start, end) {

    const from =
        timeToMinutes(start)

    const to =
        timeToMinutes(end)


    if (from <= to) {

        return current >= from && current <= to
    }


    return current >= from || current <= to
}


function nowInTimezone(timeZone) {

    const parts =
        new Intl.DateTimeFormat(
            'en-GB',
            {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23'
            }
        ).formatToParts(new Date())


    const get = type => {

        return Number(
            parts.find(part => part.type === type)?.value || 0
        )
    }


    return {
        hour: get('hour'),
        minute: get('minute'),
        second: get('second')
    }
}


function getSchedule() {

    const timeZone =
        baseConfig.BOT_TIMEZONE

    const now =
        nowInTimezone(timeZone)

    const current =
        (now.hour * 60) + now.minute

    const pad = value => {

        return String(value).padStart(2, '0')
    }


    const schedule =
        getEffectiveSchedule(
            readJson(CONFIG_FILE, {}).schedule
        )


    return {
        timezone: timeZone,

        now:
            `${pad(now.hour)}:${pad(now.minute)}:${pad(now.second)}`,

        botActive: {
            start: schedule.botActive.start,
            end: schedule.botActive.end,

            active: inRange(
                current,
                schedule.botActive.start,
                schedule.botActive.end
            )
        },

        forward: {
            start: schedule.forward.start,
            end: schedule.forward.end,

            active: inRange(
                current,
                schedule.forward.start,
                schedule.forward.end
            )
        }
    }
}


// ============================================================
// SETTINGS LOCK
//
// Password = d1m1d2m2 dari tanggal hari ini (Asia/Makassar).
// Contoh 28 Oktober: d=28, m=10 -> 2 1 8 0 = 2180
// ============================================================

function getUnlockCode() {

    const parts =
        new Intl.DateTimeFormat(
            'en-GB',
            {
                timeZone: baseConfig.BOT_TIMEZONE,
                day: '2-digit',
                month: '2-digit'
            }
        ).formatToParts(new Date())


    const get = type => {

        return parts.find(
            part => part.type === type
        )?.value || ''
    }


    const day =
        get('day').padStart(2, '0')

    const month =
        get('month').padStart(2, '0')


    return `${day[0]}${month[0]}${day[1]}${month[1]}`
}


function isUnlocked(body) {

    return safeEqual(
        String(body?.unlockCode || '').trim(),
        getUnlockCode()
    )
}


// ============================================================
// CONFIG NORMALIZATION
// ============================================================

function normalizeGroup(raw) {

    const id =
        String(raw?.id || '').trim()

    if (!/^[0-9]+@g\.us$/.test(id)) {
        return null
    }

    return {
        id,

        name:
            String(raw?.name || '')
                .trim()
                .slice(0, 120)
    }
}


function normalizeTarget(raw) {

    let id =
        String(raw?.id || '').trim()


    if (
        !id.includes('@') &&
        /^[+]?[0-9\s().-]{5,25}$/.test(id)
    ) {

        let digits =
            id.replace(/\D/g, '')


        if (digits.startsWith('0')) {

            digits = `62${digits.slice(1)}`
        }


        id = `${digits}@s.whatsapp.net`
    }


    if (!/^[0-9]+@(s\.whatsapp\.net|lid|g\.us)$/.test(id)) {
        return null
    }

    return {
        id,

        name:
            String(raw?.name || '')
                .trim()
                .slice(0, 120)
    }
}


function dedupe(list) {

    const seen =
        new Set()


    return list.filter(item => {

        if (seen.has(item.id)) {
            return false
        }

        seen.add(item.id)

        return true
    })
}


// ============================================================
// HTTP
// ============================================================

const app = express()

app.disable('x-powered-by')

app.use((req, res, next) => {

    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')

    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'"
    )

    if (req.path.startsWith('/api/')) {

        res.setHeader(
            'Cache-Control',
            'no-store'
        )
    }

    next()
})

app.get('/healthz', (req, res) => {

    res.type('text/plain').send('ok')
})

app.use((req, res, next) => {

    if (parseBasicAuth(req.headers.authorization)) {

        return next()
    }


    res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Bot Forward", charset="UTF-8"'
    )

    res.status(401).type('text/plain').send(
        'Unauthorized'
    )
})

app.use(express.json({
    limit: '128kb'
}))

app.use(
    express.static(
        path.join(ROOT, 'public'),
        {
            index: 'index.html',
            etag: true,
            maxAge: 0,
            setHeaders: res => {

                res.setHeader(
                    'Cache-Control',
                    'no-store'
                )
            }
        }
    )
)


app.get('/api/status', (req, res) => {

    const state =
        readJson(
            STATE_FILE,
            {
                status: 'unknown',
                qr: null,
                me: null,
                connectedAt: null,
                lastError: null
            }
        )


    res.json({
        state,
        schedule: getSchedule(),

        config: getEffectiveConfig(),

        updatedAt:
            new Date().toISOString()
    })
})


app.get('/api/config', (req, res) => {

    res.json(
        getEffectiveConfig()
    )
})


app.post('/api/unlock', (req, res) => {

    const code =
        String(req.body?.code || '').trim()


    if (!isUnlocked({ unlockCode: code })) {

        return res.status(401).json({
            error: 'Password salah. Gunakan kode tanggal hari ini.'
        })
    }


    res.json({
        ok: true
    })
})


app.post('/api/config', (req, res) => {

    const body =
        req.body || {}


    if (!isUnlocked(body)) {

        return res.status(403).json({
            error:
                'Pengaturan terkunci. Buka dengan password hari ini lewat tombol Unlock.'
        })
    }


    if (
        !Array.isArray(body.sourceGroups) ||
        !Array.isArray(body.targets)
    ) {

        return res.status(400).json({
            error:
                'sourceGroups dan targets harus berupa array'
        })
    }


    const sourceGroups =
        dedupe(
            body.sourceGroups
                .map(normalizeGroup)
                .filter(Boolean)
        )

    const targets =
        dedupe(
            body.targets
                .map(normalizeTarget)
                .filter(Boolean)
        )


    if (
        body.sourceGroups.length !== sourceGroups.length ||
        body.targets.length !== targets.length
    ) {

        return res.status(400).json({
            error:
                'Ada ID yang tidak valid. Grup harus berakhiran @g.us, penerima berupa nomor atau JID.'
        })
    }


    if (sourceGroups.length > 50 || targets.length > 50) {

        return res.status(400).json({
            error: 'Maksimal 50 grup sumber dan 50 penerima.'
        })
    }


    let schedule


    if (body.schedule === undefined) {

        schedule =
            getEffectiveSchedule(
                readJson(CONFIG_FILE, {}).schedule
            )

    } else {

        schedule =
            normalizeScheduleInput(
                body.schedule
            )


        if (!schedule) {

            return res.status(400).json({
                error:
                    'Format jadwal tidak valid. Gunakan HH:MM (contoh 00:00 dan 23:59).'
            })
        }
    }


    const next = {
        sourceGroups,
        targets,
        schedule,

        updatedAt:
            new Date().toISOString()
    }


    try {

        writeFileAtomic(
            CONFIG_FILE,
            JSON.stringify(next, null, 2)
        )

    } catch (error) {

        return res.status(500).json({
            error: 'Gagal menyimpan konfigurasi.'
        })
    }


    broadcast({
        type: 'config',
        data: next
    })


    broadcast({
        type: 'schedule',
        data: getSchedule()
    })


    res.json({
        config: next,
        schedule: getSchedule()
    })
})


app.post('/api/session/reset', (req, res) => {

    const authDir =
        path.join(ROOT, 'auth')


    try {

        if (fs.existsSync(authDir)) {

            const backup =
                path.join(
                    ROOT,
                    `auth.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
                )

            fs.renameSync(authDir, backup)
        }

    } catch (error) {

        return res.status(500).json({
            error:
                `Gagal memindahkan sesi lama: ${error.message}`
        })
    }


    try {

        const child =
            spawn(
                'systemctl',
                [
                    '--user',
                    'restart',
                    'bot-forward.service'
                ],
                {
                    detached: true,
                    stdio: 'ignore'
                }
            )

        child.unref()

    } catch (error) {

        return res.status(500).json({
            error:
                `Gagal restart bot: ${error.message}`
        })
    }


    res.json({
        ok: true
    })
})


app.get('/api/groups', (req, res) => {

    const groups =
        readJson(GROUPS_FILE, [])


    let updatedAt = null


    try {

        updatedAt =
            fs.statSync(GROUPS_FILE).mtime.toISOString()

    } catch (error) {

        // belum ada
    }


    res.json({
        groups: Array.isArray(groups) ? groups : [],
        updatedAt
    })
})


app.get('/api/logs', (req, res) => {

    const lines =
        Math.min(
            2000,
            Math.max(
                1,
                Number(req.query.lines) || 300
            )
        )


    const result =
        spawnSync(
            'journalctl',
            [
                `--user-unit=${BOT_UNIT}`,
                '-n', String(lines),
                '-o', 'cat',
                '--no-pager'
            ],
            {
                encoding: 'utf8',
                maxBuffer: 8 * 1024 * 1024
            }
        )


    res.type('text/plain').send(
        result.stdout || ''
    )
})


// ============================================================
// WEBSOCKET
// ============================================================

const server =
    http.createServer(app)

const wss =
    new WebSocketServer({
        noServer: true
    })


function broadcast(message) {

    const raw =
        JSON.stringify(message)


    for (const client of wss.clients) {

        if (client.readyState === 1) {

            client.send(raw)
        }
    }
}


server.on('upgrade', (req, socket, head) => {

    if (req.url !== '/ws') {

        socket.destroy()

        return
    }


    if (!parseBasicAuth(req.headers.authorization)) {

        socket.end(
            'HTTP/1.1 401 Unauthorized\r\n' +
            'WWW-Authenticate: Basic realm="Bot Forward"\r\n' +
            'Content-Length: 0\r\n' +
            'Connection: close\r\n\r\n'
        )

        return
    }


    wss.handleUpgrade(req, socket, head, ws => {

        wss.emit('connection', ws, req)
    })
})


let tailProcess = null
let tailRestartTimer = null


function startLogTail() {

    if (tailProcess) {
        return
    }


    tailProcess =
        spawn(
            'journalctl',
            [
                `--user-unit=${BOT_UNIT}`,
                '-f',
                '-n', '0',
                '-o', 'cat'
            ],
            {
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )


    tailProcess.stdout.setEncoding('utf8')

    tailProcess.stdout.on('data', chunk => {

        broadcast({
            type: 'log',
            data: chunk
        })
    })


    tailProcess.stderr.on('data', chunk => {

        process.stderr.write(
            `journalctl: ${chunk}`
        )
    })


    tailProcess.on('error', error => {

        process.stderr.write(
            `journalctl error: ${error.message}\n`
        )
    })


    tailProcess.on('exit', () => {

        tailProcess = null


        if (
            wss.clients.size > 0 &&
            !tailRestartTimer
        ) {

            tailRestartTimer =
                setTimeout(() => {

                    tailRestartTimer = null

                    startLogTail()

                }, 2000)
        }
    })
}


function stopLogTailIfIdle() {

    if (
        wss.clients.size === 0 &&
        tailProcess
    ) {

        tailProcess.kill('SIGTERM')

        tailProcess = null
    }
}


wss.on('connection', ws => {

    startLogTail()


    ws.send(
        JSON.stringify({
            type: 'state',

            data:
                readJson(
                    STATE_FILE,
                    {
                        status: 'unknown',
                        qr: null,
                        me: null,
                        connectedAt: null,
                        lastError: null
                    }
                )
        })
    )


    ws.send(
        JSON.stringify({
            type: 'schedule',
            data: getSchedule()
        })
    )


    ws.on('close', () => {

        setTimeout(stopLogTailIfIdle, 1000)
    })
})


let lastStateMtime = 0


setInterval(() => {

    if (wss.clients.size === 0) {
        return
    }


    try {

        const stat =
            fs.statSync(STATE_FILE)


        if (stat.mtimeMs !== lastStateMtime) {

            lastStateMtime = stat.mtimeMs


            broadcast({
                type: 'state',

                data:
                    readJson(
                        STATE_FILE,
                        {
                            status: 'unknown',
                            qr: null,
                            me: null,
                            connectedAt: null,
                            lastError: null
                        }
                    )
            })
        }

    } catch (error) {

        // file state belum ada
    }
}, 1000)


setInterval(() => {

    if (wss.clients.size > 0) {

        broadcast({
            type: 'schedule',
            data: getSchedule()
        })
    }
}, 5000)


// ============================================================
// START
// ============================================================

server.listen(
    PORT,
    HOST,
    () => {

        console.log(
            `🌐 Dashboard berjalan di http://${HOST}:${PORT}`
        )

        console.log(
            `🔐 Login dashboard: user "${CREDENTIALS.username}" (password di data/dashboard-auth.json)`
        )
    }
)


function shutdown(signal) {

    console.log(`🛑 Dashboard ${signal}`)


    try {

        if (tailProcess) {
            tailProcess.kill('SIGTERM')
        }

    } catch (error) {

        // abaikan
    }


    server.close(() => {

        process.exit(0)
    })


    setTimeout(() => process.exit(0), 3000)
}


process.on('SIGINT', () => shutdown('SIGINT'))

process.on('SIGTERM', () => shutdown('SIGTERM'))
