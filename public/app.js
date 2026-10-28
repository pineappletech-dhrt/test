// ============================================================
// SCRIPT DASHBOARD (SISI BROWSER)
//
// Fungsi file ini:
// - Memuat status bot, jadwal, dan konfigurasi dari API server
// - Menampilkan QR login, status koneksi, jam server, dan log bot
// - Mengelola form grup sumber dan penerima (tambah/hapus/simpan)
// - Mengunci pengaturan dengan password tanggal (tombol Unlock)
// - Menerima pembaruan real-time lewat WebSocket /ws
// ============================================================

'use strict'

const $ = id => document.getElementById(id)

const MAX_LOG_LINES = 3000

const STATUS_TEXT = {
    connected: 'Terhubung',
    qr: 'Menunggu scan QR',
    connecting: 'Menghubungkan',
    starting: 'Memulai',
    disconnected: 'Terputus',
    logged_out: 'Logout — perlu scan ulang',
    unknown: 'Tidak diketahui'
}

const STATUS_TAG = {
    connected: 'ONLINE',
    qr: 'BUTUH QR',
    connecting: 'PROSES',
    starting: 'PROSES',
    disconnected: 'OFFLINE',
    logged_out: 'LOGOUT',
    unknown: 'UNKNOWN'
}

const app = {
    state: null,
    schedule: null,
    config: {
        sourceGroups: [],
        targets: []
    },
    groups: [],
    dirty: false,
    locked: true,
    unlockCode: null,
    logs: [],
    logPartial: '',
    toastTimer: null,
    ws: null,
    wsRetry: 1000
}


// ============================================================
// HELPERS
// ============================================================

async function fetchJson(url, options) {

    const response =
        await fetch(url, {
            cache: 'no-store',
            ...options
        })


    if (!response.ok) {

        let message =
            `HTTP ${response.status}`

        try {

            const body =
                await response.json()

            if (body.error) {
                message = body.error
            }

        } catch (error) {
            // bukan JSON
        }


        const failure =
            new Error(message)

        failure.status = response.status

        throw failure
    }


    return response.json()
}


function showToast(message, isError) {

    const toast = $('toast')

    toast.textContent = message

    toast.classList.toggle('error', !!isError)

    toast.classList.add('show')


    clearTimeout(app.toastTimer)


    app.toastTimer = setTimeout(() => {

        toast.classList.remove('show')

    }, 3200)
}


function formatDateTime(iso) {

    if (!iso) {
        return '-'
    }


    const date = new Date(iso)


    if (Number.isNaN(date.getTime())) {
        return '-'
    }


    const timeZone =
        app.schedule?.timezone || 'Asia/Makassar'


    return date.toLocaleString(
        'id-ID',
        {
            dateStyle: 'medium',
            timeStyle: 'medium',
            timeZone
        }
    )
}


function cleanJid(jid) {

    if (!jid) {
        return ''
    }

    return String(jid)
        .split('@')[0]
        .split(':')[0]
}


function normalizeTargetInput(value) {

    const raw = String(value || '').trim()


    if (
        !raw.includes('@') &&
        /^[+]?[0-9\s().-]{5,25}$/.test(raw)
    ) {

        let digits =
            raw.replace(/\D/g, '')


        if (digits.startsWith('0')) {

            digits = `62${digits.slice(1)}`
        }


        return `${digits}@s.whatsapp.net`
    }


    return raw
}


function isValidTarget(id) {

    return /^[0-9]+@(s\.whatsapp\.net|lid|g\.us)$/.test(id)
}


function isValidGroup(id) {

    return /^[0-9]+@g\.us$/.test(id)
}


function setWsState(online) {

    const el = $('wsState')

    el.classList.toggle('offline', !online)

    el.lastChild.textContent =
        online ? ' live' : ' terputus'
}


// ============================================================
// SETTINGS LOCK
// ============================================================

const LOCKED_CONTROLS = [
    'activeStart',
    'activeEnd',
    'forwardStart',
    'forwardEnd',
    'groupSelect',
    'sourceName',
    'addSourceBtn',
    'sourceId',
    'sourceManualName',
    'addSourceManualBtn',
    'targetId',
    'targetName',
    'addTargetBtn'
]


function setLocked(locked) {

    app.locked = locked


    if (locked) {
        app.unlockCode = null
    }


    document.body.classList.toggle(
        'locked',
        locked
    )


    $('lockBtnText').textContent =
        locked ? 'Unlock' : 'Kunci'


    $('lockBtn').classList.toggle(
        'unlocked',
        !locked
    )


    for (const id of LOCKED_CONTROLS) {

        $(id).disabled = locked
    }


    for (
        const button
        of document.querySelectorAll('.remove-btn')
    ) {

        button.disabled = locked
    }


    setDirty(app.dirty)
}


// ============================================================
// STATE / SCHEDULE
// ============================================================

function applyState(state) {

    if (!state) {
        return
    }


    const previousStatus =
        app.state?.status || null


    app.state = state


    const status =
        STATUS_TEXT[state.status] ||
        state.status ||
        'Tidak diketahui'


    const pill = $('statusPill')

    pill.dataset.status =
        STATUS_TEXT[state.status]
            ? state.status
            : 'unknown'


    $('statusText').textContent = status

    $('connTag').textContent =
        STATUS_TAG[state.status] || 'UNKNOWN'


    $('resetSessionBtn').classList.toggle(
        'hidden',
        !['logged_out', 'disconnected', 'unknown'].includes(
            state.status
        )
    )


    if (state.me?.id) {

        const name =
            state.me.name
                ? ` (${state.me.name})`
                : ''

        $('connMe').textContent =
            `${cleanJid(state.me.id)}${name}`

    } else {

        $('connMe').textContent = '-'
    }


    $('connSince').textContent =
        formatDateTime(state.connectedAt)

    $('connUpdated').textContent =
        formatDateTime(state.updatedAt)


    const hasQr = !!state.qr

    $('qrWrap').classList.toggle('hidden', !hasQr)

    $('qrIdle').classList.toggle(
        'hidden',
        hasQr || state.status === 'connected'
    )


    if (hasQr) {

        const img = $('qrImg')

        if (img.getAttribute('src') !== state.qr) {

            img.src = state.qr
        }
    }


    const shouldShowError =
        state.lastError &&
        (
            state.status === 'disconnected' ||
            state.status === 'logged_out' ||
            state.status === 'unknown'
        )


    const errorEl = $('connError')

    errorEl.classList.toggle(
        'hidden',
        !shouldShowError
    )


    if (shouldShowError) {

        errorEl.textContent =
            state.status === 'logged_out'
                ? `Sesi WhatsApp logout. ${state.lastError}`
                : state.lastError
    }


    if (
        state.status === 'connected' &&
        previousStatus !== 'connected'
    ) {

        loadGroups(false)
    }
}


function applySchedule(schedule) {

    if (!schedule) {
        return
    }


    app.schedule = schedule


    $('timezoneTag').textContent =
        schedule.timezone


    const activeBadge = $('activeBadge')

    activeBadge.textContent =
        schedule.botActive.active
            ? 'Aktif'
            : 'Standby'

    activeBadge.classList.toggle(
        'on',
        schedule.botActive.active
    )

    activeBadge.classList.toggle(
        'off',
        !schedule.botActive.active
    )


    const forwardBadge = $('forwardBadge')

    forwardBadge.textContent =
        schedule.forward.active
            ? 'Berjalan'
            : 'Di luar jam'

    forwardBadge.classList.toggle(
        'on',
        schedule.forward.active
    )

    forwardBadge.classList.toggle(
        'off',
        !schedule.forward.active
    )
}


function tickClock() {

    const timeZone =
        app.schedule?.timezone || 'Asia/Makassar'


    $('serverClock').textContent =
        new Intl.DateTimeFormat(
            'id-ID',
            {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }
        ).format(new Date())
}


// ============================================================
// CONFIG
// ============================================================

function createItem(kind, item) {

    const li = document.createElement('li')

    li.className = 'item'


    const icon = document.createElement('span')

    icon.className = 'item-icon'

    icon.textContent =
        kind === 'source' ? '#' : '@'

    li.append(icon)


    const main = document.createElement('div')

    main.className = 'item-main'


    const name = document.createElement('span')

    name.className = 'item-name'

    name.textContent =
        item.name ||
        (kind === 'source'
            ? 'Grup tanpa label'
            : 'Penerima tanpa label')


    const id = document.createElement('span')

    id.className = 'item-id'

    id.textContent = item.id


    main.append(name, id)

    li.append(main)


    const remove = document.createElement('button')

    remove.type = 'button'

    remove.className = 'remove-btn'

    remove.textContent = '×'

    remove.setAttribute(
        'aria-label',
        `Hapus ${item.id}`
    )

    remove.dataset.kind = kind

    remove.dataset.id = item.id

    remove.disabled = app.locked

    li.append(remove)


    return li
}


function renderList(kind) {

    const list =
        kind === 'source'
            ? $('sourceList')
            : $('targetList')


    const items =
        kind === 'source'
            ? app.config.sourceGroups
            : app.config.targets


    list.textContent = ''


    if (items.length === 0) {

        const empty = document.createElement('li')

        empty.className = 'empty'

        empty.textContent =
            kind === 'source'
                ? 'Belum ada grup sumber.'
                : 'Belum ada penerima forward.'

        list.append(empty)

    } else {

        for (const item of items) {

            list.append(createItem(kind, item))
        }
    }


    $('sourceCount').textContent =
        `${app.config.sourceGroups.length} grup`

    $('targetCount').textContent =
        `${app.config.targets.length} penerima`
}


function renderConfig() {

    renderList('source')

    renderList('target')
}


const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/


function setScheduleInputs(schedule) {

    if (!schedule?.botActive || !schedule?.forward) {
        return
    }


    $('activeStart').value =
        schedule.botActive.start

    $('activeEnd').value =
        schedule.botActive.end

    $('forwardStart').value =
        schedule.forward.start

    $('forwardEnd').value =
        schedule.forward.end
}


function readScheduleInputs() {

    return {
        botActive: {
            start: $('activeStart').value,
            end: $('activeEnd').value
        },

        forward: {
            start: $('forwardStart').value,
            end: $('forwardEnd').value
        }
    }
}


function isScheduleValid(schedule) {

    for (const range of [schedule.botActive, schedule.forward]) {

        if (
            !TIME_PATTERN.test(range.start) ||
            !TIME_PATTERN.test(range.end)
        ) {

            return false
        }
    }


    return true
}


function applyConfig(config) {

    if (!config) {
        return
    }


    app.config = config

    renderConfig()

    setScheduleInputs(config.schedule)
}


function setDirty(dirty) {

    app.dirty = dirty


    $('saveBtn').disabled =
        app.locked || !dirty


    const saveState = $('saveState')

    saveState.classList.toggle(
        'dirty',
        dirty && !app.locked
    )


    if (app.locked) {

        saveState.textContent =
            'Terkunci — klik Unlock untuk mengubah'

    } else {

        saveState.textContent =
            dirty
                ? 'Ada perubahan belum disimpan'
                : 'Pengaturan terbuka — ubah lalu simpan'
    }
}


function addSource(id, name) {

    if (app.locked) {

        showToast(
            'Pengaturan terkunci. Klik Unlock dulu.',
            true
        )

        return false
    }


    if (!isValidGroup(id)) {

        showToast(
            'ID grup tidak valid. Contoh: 120363181349825721@g.us',
            true
        )

        return false
    }


    if (
        app.config.sourceGroups.some(
            group => group.id === id
        )
    ) {

        showToast('Grup tersebut sudah ada.', true)

        return false
    }


    app.config.sourceGroups.push({
        id,
        name: String(name || '').trim()
    })


    setDirty(true)

    renderConfig()

    return true
}


function addTarget(id, name) {

    if (app.locked) {

        showToast(
            'Pengaturan terkunci. Klik Unlock dulu.',
            true
        )

        return false
    }


    const normalized =
        normalizeTargetInput(id)


    if (!isValidTarget(normalized)) {

        showToast(
            'Penerima tidak valid. Gunakan nomor WA atau JID (@lid / @g.us).',
            true
        )

        return false
    }


    if (
        app.config.targets.some(
            target => target.id === normalized
        )
    ) {

        showToast('Penerima tersebut sudah ada.', true)

        return false
    }


    app.config.targets.push({
        id: normalized,
        name: String(name || '').trim()
    })


    setDirty(true)

    renderConfig()

    return true
}


function removeItem(kind, id) {

    if (app.locked) {

        showToast(
            'Pengaturan terkunci. Klik Unlock dulu.',
            true
        )

        return
    }


    if (kind === 'source') {

        app.config.sourceGroups =
            app.config.sourceGroups.filter(
                group => group.id !== id
            )

    } else {

        app.config.targets =
            app.config.targets.filter(
                target => target.id !== id
            )
    }


    setDirty(true)

    renderConfig()
}


async function saveConfig() {

    if (app.locked || !app.unlockCode) {

        showToast(
            'Pengaturan terkunci. Klik Unlock dulu.',
            true
        )

        return
    }


    const schedule =
        readScheduleInputs()


    if (!isScheduleValid(schedule)) {

        showToast(
            'Format jam tidak valid. Gunakan format HH:MM.',
            true
        )

        return
    }


    const button = $('saveBtn')

    button.disabled = true

    button.textContent = 'Menyimpan…'


    try {

        const result =
            await fetchJson(
                '/api/config',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json'
                    },

                    body: JSON.stringify({
                        unlockCode:
                            app.unlockCode,

                        sourceGroups:
                            app.config.sourceGroups,

                        targets:
                            app.config.targets,

                        schedule
                    })
                }
            )


        applyConfig(
            result.config || app.config
        )


        if (result.schedule) {

            applySchedule(result.schedule)
        }


        setDirty(false)

        setLocked(true)

        showToast('Konfigurasi tersimpan. Pengaturan dikunci kembali.')

    } catch (error) {

        if (error.status === 403) {

            setLocked(true)

            showToast(
                'Sesi kunci berakhir. Buka lagi dengan password hari ini.',
                true
            )

        } else {

            showToast(
                `Gagal menyimpan: ${error.message}`,
                true
            )

            setDirty(true)
        }

    } finally {

        button.textContent = 'Simpan perubahan'
    }
}


async function reloadConfig() {

    try {

        const config =
            await fetchJson('/api/config')


        applyConfig(config)

        setDirty(false)

    } catch (error) {

        showToast(
            `Gagal memuat konfigurasi: ${error.message}`,
            true
        )
    }
}


async function lockSettings() {

    if (app.dirty) {

        const discard =
            window.confirm(
                'Ada perubahan belum disimpan. Buang perubahan dan kunci pengaturan?'
            )


        if (!discard) {
            return
        }


        await reloadConfig()
    }


    setLocked(true)

    showToast('Pengaturan dikunci.')
}


function promptUnlock() {

    const value =
        window.prompt(
            'Masukkan password hari ini (contoh 28 Oktober = 2180):'
        )


    if (value === null) {
        return
    }


    attemptUnlock(value)
        .catch(error => {

            showToast(error.message, true)
        })
}


function openUnlockDialog() {

    if (!app.locked) {

        lockSettings()

        return
    }


    const dialog =
        $('unlockDialog')

    const input =
        $('unlockInput')


    if (
        !dialog ||
        !input ||
        typeof dialog.showModal !== 'function'
    ) {

        promptUnlock()

        return
    }


    input.value = ''

    $('unlockError').classList.add('hidden')

    $('unlockError').textContent = ''


    try {

        dialog.showModal()

    } catch (error) {

        promptUnlock()

        return
    }


    input.focus()
}


async function attemptUnlock(rawCode) {

    const code =
        String(rawCode || '')
            .replace(/\D/g, '')
            .slice(0, 4)


    if (code.length !== 4) {

        throw new Error('Password harus 4 digit.')
    }


    await fetchJson(
        '/api/unlock',
        {
            method: 'POST',

            headers: {
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({ code })
        }
    )


    app.unlockCode = code


    const dialog =
        $('unlockDialog')


    if (
        dialog &&
        typeof dialog.close === 'function'
    ) {

        dialog.close()
    }


    setLocked(false)

    showToast('Pengaturan terbuka. Ubah lalu simpan.')
}


async function submitUnlock(event) {

    event.preventDefault()


    const code =
        $('unlockInput').value
            .replace(/\D/g, '')
            .slice(0, 4)


    const errorEl =
        $('unlockError')

    const button =
        $('unlockSubmitBtn')


    if (code.length !== 4) {

        errorEl.textContent =
            'Password harus 4 digit.'

        errorEl.classList.remove('hidden')

        return
    }


    button.disabled = true

    button.textContent = 'Membuka…'

    errorEl.classList.add('hidden')


    try {

        await attemptUnlock(code)

    } catch (error) {

        errorEl.textContent =
            error.message

        errorEl.classList.remove('hidden')

        $('unlockInput').select()

    } finally {

        button.disabled = false

        button.textContent = 'Buka'
    }
}


function renderGroupOptions() {

    const select = $('groupSelect')


    select.textContent = ''


    const placeholder =
        document.createElement('option')

    placeholder.value = ''

    placeholder.textContent =
        app.groups.length
            ? 'Pilih grup terdeteksi…'
            : 'Belum ada grup terdeteksi'


    select.append(placeholder)


    for (const group of app.groups) {

        const option =
            document.createElement('option')

        option.value = group.id

        option.textContent =
            `${group.subject || '(tanpa nama)'} — ${group.id}`


        option.dataset.subject =
            group.subject || ''


        select.append(option)
    }
}


// ============================================================
// LOGS
// ============================================================

let logRenderQueued = false


function scheduleLogRender() {

    if (logRenderQueued) {
        return
    }


    logRenderQueued = true


    requestAnimationFrame(() => {

        logRenderQueued = false

        renderLogs()
    })
}


function renderLogs() {

    const filter =
        $('logFilter').value
            .trim()
            .toLowerCase()


    const visible =
        filter
            ? app.logs.filter(line => {

                return line
                    .toLowerCase()
                    .includes(filter)
            })
            : app.logs


    const view = $('logView')

    const text =
        visible.join('\n') +
        (app.logPartial ? `\n${app.logPartial}` : '')


    view.textContent = text


    $('logCount').textContent =
        `${visible.length} baris${filter ? ' (difilter)' : ''}`


    if ($('autoScroll').checked) {

        view.scrollTop = view.scrollHeight
    }
}


function appendLog(chunk) {

    if (!chunk) {
        return
    }


    const combined =
        app.logPartial +
        String(chunk).replace(/\r/g, '')


    const lines =
        combined.split('\n')


    app.logPartial =
        lines.pop() || ''


    for (const line of lines) {

        // lewati sisa QR art lama yang tercetak di terminal
        if (
            /^[\s▀▄█]+$/.test(line) &&
            /[▀▄█]/.test(line)
        ) {

            continue
        }


        app.logs.push(line)
    }


    if (app.logs.length > MAX_LOG_LINES) {

        app.logs.splice(
            0,
            app.logs.length - MAX_LOG_LINES
        )
    }


    scheduleLogRender()
}


// ============================================================
// WEBSOCKET
// ============================================================

function connectWebSocket() {

    const protocol =
        location.protocol === 'https:'
            ? 'wss:'
            : 'ws:'


    let socket


    try {

        socket =
            new WebSocket(
                `${protocol}//${location.host}/ws`
            )

    } catch (error) {

        setTimeout(connectWebSocket, app.wsRetry)

        return
    }


    app.ws = socket


    socket.onopen = () => {

        app.wsRetry = 1000

        setWsState(true)
    }


    socket.onmessage = event => {

        let message


        try {

            message = JSON.parse(event.data)

        } catch (error) {

            return
        }


        if (message.type === 'log') {

            appendLog(message.data)

        } else if (message.type === 'state') {

            applyState(message.data)

        } else if (message.type === 'schedule') {

            applySchedule(message.data)

        } else if (message.type === 'config') {

            if (!app.dirty) {

                applyConfig(message.data)
            }
        }
    }


    socket.onclose = () => {

        setWsState(false)


        if (app.ws === socket) {

            app.ws = null
        }


        setTimeout(connectWebSocket, app.wsRetry)


        app.wsRetry = Math.min(
            Math.round(app.wsRetry * 1.6),
            15000
        )
    }


    socket.onerror = () => {

        try {
            socket.close()
        } catch (error) {
            // abaikan
        }
    }
}


// ============================================================
// BOOT
// ============================================================

async function loadInitial() {

    try {

        const status =
            await fetchJson('/api/status')


        applyState(status.state)

        applySchedule(status.schedule)


        if (!app.dirty && status.config) {

            applyConfig(status.config)
        }

    } catch (error) {

        showToast(
            `Gagal memuat status: ${error.message}`,
            true
        )
    }


    await loadGroups(false)


    try {

        const response =
            await fetch('/api/logs?lines=250', {
                cache: 'no-store'
            })


        if (response.ok) {

            appendLog(await response.text())
        }

    } catch (error) {
        // log opsional
    }
}


async function loadGroups(announce) {

    try {

        const result =
            await fetchJson('/api/groups')


        app.groups =
            Array.isArray(result.groups)
                ? result.groups
                : []


        renderGroupOptions()


        if (announce !== false) {

            showToast(
                result.updatedAt
                    ? `${app.groups.length} grup dimuat.`
                    : 'Daftar grup belum tersedia. Pastikan bot sudah login.'
            )
        }

    } catch (error) {

        if (announce !== false) {

            showToast(
                `Gagal memuat grup: ${error.message}`,
                true
            )
        }
    }
}


function refreshGroups() {

    return loadGroups(true)
}


$('addSourceBtn').addEventListener('click', () => {

    const select = $('groupSelect')

    if (!select.value) {

        showToast('Pilih grup terlebih dahulu.', true)

        return
    }


    const name =
        $('sourceName').value.trim() ||
        select.selectedOptions[0]?.dataset.subject ||
        ''


    if (addSource(select.value, name)) {

        select.value = ''

        $('sourceName').value = ''

        showToast('Grup sumber ditambahkan.')
    }
})


$('addSourceManualBtn').addEventListener('click', () => {

    const id = $('sourceId').value.trim()

    const name = $('sourceManualName').value.trim()


    if (addSource(id, name)) {

        $('sourceId').value = ''

        $('sourceManualName').value = ''

        showToast('Grup sumber ditambahkan.')
    }
})


$('addTargetBtn').addEventListener('click', () => {

    const id = $('targetId').value

    const name = $('targetName').value.trim()


    if (addTarget(id, name)) {

        $('targetId').value = ''

        $('targetName').value = ''

        showToast('Penerima ditambahkan.')
    }
})


$('groupSelect').addEventListener('change', event => {

    const subject =
        event.target.selectedOptions[0]?.dataset.subject || ''


    if (subject && !$('sourceName').value.trim()) {

        $('sourceName').value = subject
    }
})


for (const list of [$('sourceList'), $('targetList')]) {

    list.addEventListener('click', event => {

        const button =
            event.target.closest('.remove-btn')


        if (!button) {
            return
        }


        removeItem(
            button.dataset.kind,
            button.dataset.id
        )
    })
}


$('saveBtn').addEventListener('click', saveConfig)

$('lockBtn').addEventListener('click', openUnlockDialog)

$('unlockForm').addEventListener('submit', submitUnlock)

$('unlockCancelBtn').addEventListener('click', () => {

    $('unlockDialog').close()
})

$('unlockDialog').addEventListener('click', event => {

    if (event.target === $('unlockDialog')) {

        $('unlockDialog').close()
    }
})

$('unlockInput').addEventListener('input', () => {

    $('unlockError').classList.add('hidden')
})

$('refreshGroupsBtn').addEventListener('click', refreshGroups)


for (const id of ['activeStart', 'activeEnd', 'forwardStart', 'forwardEnd']) {

    $(id).addEventListener('input', () => {

        setDirty(true)
    })
}


$('resetSessionBtn').addEventListener('click', async () => {

    const confirmed =
        window.confirm(
            'Reset sesi WhatsApp? Sesi lama dipindahkan ke folder backup dan bot akan restart, lalu QR baru muncul untuk scan ulang.'
        )


    if (!confirmed) {
        return
    }


    try {

        await fetchJson(
            '/api/session/reset',
            {
                method: 'POST'
            }
        )


        showToast(
            'Sesi direset. Tunggu beberapa detik sampai QR muncul.'
        )

    } catch (error) {

        showToast(
            `Gagal reset sesi: ${error.message}`,
            true
        )
    }
})


$('logFilter').addEventListener('input', renderLogs)


$('clearLogs').addEventListener('click', () => {

    app.logs = []
    app.logPartial = ''

    renderLogs()
})


window.addEventListener('beforeunload', event => {

    if (!app.dirty) {
        return
    }


    event.preventDefault()

    event.returnValue = ''
})


async function pollStatus() {

    try {

        const status =
            await fetchJson('/api/status')


        applyState(status.state)

        applySchedule(status.schedule)


        if (!app.dirty && status.config) {

            applyConfig(status.config)
        }

    } catch (error) {

        // biarkan WS yang melaporkan
    }
}


tickClock()

setInterval(tickClock, 1000)

setInterval(pollStatus, 20000)


setLocked(true)

loadInitial()

connectWebSocket()
