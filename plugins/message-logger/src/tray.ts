import { callNativeMethod } from '@valenced/modules/native'
import { cmp, markChanged } from './logger'
import { keepMs, logs, save, settings, type Entry } from './store'

/**
 * 알림 창에 남아 있는 디스코드 알림에서 메시지를 읽어 둔다 (앱이 꺼져 있을 때 온 것도).
 * 알림 속 메시지에는 ID 가 없고 글·보낸 사람·시각만 있다. 시각은 메시지 ID 의 시각과 같으므로
 * 채널을 불러올 때 같은 시각의 메시지를 찾아 맞춘다:
 *  - 같은 시각 메시지가 있고 글이 다르다 → 그사이 고쳐짐 (그 메시지에 기록)
 *  - 불러온 범위 안인데 그 시각 메시지가 없다 → 그사이 지워짐 (그 시각으로 ID 를 만들어 제자리에 넣는다)
 */

const NS = 'yumistra.message-logger'
const EPOCH = 1420070400000
const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)

export interface Note {
    c: string
    t: number
    text: string
    sender: string
    senderId?: string
    s: number
}

let notesRef: () => Record<string, Note> = () => ({})
export const bindNotes = (fn: () => Record<string, Note>) => {
    notesRef = fn
}

export const trayStatus = { notifications: 0, messages: 0, lastRead: 0, native: '' }

/** 스노플레이크 → 밀리초 (정밀도는 1ms 안쪽) */
export function msOf(id: string) {
    try {
        if (typeof BigInt === 'function') return Number(BigInt(id) >> BigInt(22)) + EPOCH
    } catch {}
    return Math.floor(Number(id) / 4194304) + EPOCH
}

/** 밀리초 → 그 시각의 스노플레이크 (그 ms 안의 가운데 값) */
export function idAt(ms: number) {
    const base = Math.max(0, Math.floor(ms - EPOCH))
    try {
        if (typeof BigInt === 'function') return ((BigInt(base) << BigInt(22)) + BigInt(2097151)).toString()
    } catch {}
    // 십진 문자열로 곱하기
    let digits = String(base).split('').map(Number)
    let carry = 0
    const out: number[] = []
    for (let i = digits.length - 1; i >= 0; i--) {
        const v = digits[i] * 4194304 + carry
        out.unshift(v % 10)
        carry = Math.floor(v / 10)
    }
    while (carry > 0) {
        out.unshift(carry % 10)
        carry = Math.floor(carry / 10)
    }
    digits = out
    let add = 2097151
    for (let i = digits.length - 1; i >= 0 && add > 0; i--) {
        const v = digits[i] + (add % 10)
        add = Math.floor(add / 10)
        digits[i] = v % 10
        add += Math.floor(v / 10)
    }
    if (add > 0) digits.unshift(...String(add).split('').map(Number))
    return digits.join('').replace(/^0+(?=\d)/, '')
}

// 디스코드는 알림 바로가기(shortcut) ID 를 채널 ID 로 만든다
const channelOf = (n: any): string | undefined => {
    for (const s of [n?.shortcut, n?.tag, n?.group, n?.key]) {
        const m = typeof s === 'string' ? s.match(/\d{17,20}/) : null
        if (m) return m[0]
    }
}

export async function readTray() {
    if (!settings().rememberPushes) return 0
    let list: any[] = []
    try {
        const r: any = await (callNativeMethod as any)(`${NS}.tray`, [])
        list = JSON.parse(String(unwrap(r) ?? '[]'))
    } catch {
        return 0
    }
    const notes = notesRef()
    const now = Date.now()
    let n = 0
    for (const no of Array.isArray(list) ? list : []) {
        const c = channelOf(no)
        if (!c || !Array.isArray(no.messages)) continue
        trayStatus.notifications++
        for (const m of no.messages) {
            const t = Number(m?.time)
            const text = typeof m?.text === 'string' ? m.text : ''
            // 내가 알림에서 답장한 것 등은 보낸 사람이 없다
            if (!t || !text || !m.sender) continue
            const key = `${c}:${t}`
            if (notes[key]) continue
            notes[key] = { c, t, text, sender: String(m.sender), ...(m.senderKey && /^\d{5,}$/.test(m.senderKey) ? { senderId: m.senderKey } : {}), s: now }
            n++
        }
    }
    trayStatus.messages += n
    trayStatus.lastRead = now
    if (n) save()
    return n
}

export async function nativeStatus() {
    try {
        const r: any = await (callNativeMethod as any)(`${NS}.status`, [])
        trayStatus.native = String(unwrap(r) ?? '')
    } catch (e: any) {
        trayStatus.native = `error: ${e?.message ?? e}`
    }
    return trayStatus.native
}

export function trimNotes() {
    const notes = notesRef()
    const limit = keepMs()
    const now = Date.now()
    for (const [k, v] of Object.entries(notes)) if (now - v.s > limit) delete notes[k]
}

/** 채널을 불러왔을 때 알림 메모와 맞춘다 (away.compare 다음에) */
export function compareNotes(payload: any) {
    const channelId = payload?.channelId
    const messages: any[] = payload?.messages
    if (!channelId || !Array.isArray(messages) || !messages.length) return
    const s = settings()
    if (!s.detectAway) return
    const notes = notesRef()
    const mine = Object.entries(notes).filter(([, v]) => v.c === channelId)
    const synthetic = Object.values(logs()).some(e => e.c === channelId && e.n)
    if (!mine.length && !synthetic) return
    const times = messages.map(m => ({ m, t: msOf(String(m.id)) }))
    const ids = messages.map(m => String(m.id)).sort(cmp)
    const minT = msOf(ids[0])
    const maxT = msOf(ids[ids.length - 1])
    const newest = !payload.isBefore && !payload.isAfter && !payload.jump && payload.hasMoreAfter === false
    const oldest = !payload.isAfter && !payload.jump && payload.hasMoreBefore === false && messages.length < (payload.limit ?? 50)
    const all = logs()
    const now = Date.now()
    let any = false
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
    // 알림으로 만들어 둔 "지워진 메시지"인데 같은 시각 메시지가 서버에 있으면 잘못 잡은 것 → 없앤다
    for (const [id, e] of Object.entries(all)) {
        if (e.c !== channelId || !e.d || !e.n) continue
        const text = typeof e.m?.content === 'string' ? norm(e.m.content) : ''
        if (times.some(x => Math.abs(x.t - msOf(id)) <= 2 || (Math.abs(x.t - msOf(id)) <= 10 * 60_000 && typeof x.m.content === 'string' && norm(x.m.content) === text))) {
            delete all[id]
            markChanged(id)
            any = true
        }
    }
    for (const [key, note] of mine) {
        const inRange = (note.t >= minT - 2 || oldest) && (note.t <= maxT + 2 || newest)
        if (!inRange) continue
        // 같은 시각(메시지 ID 시각) 메시지, 없으면 같은 글이 근처 시각에 있는지 (알림 시각이 받은 시각인 경우)
        const hit = times.find(x => Math.abs(x.t - note.t) <= 2) ?? times.find(x => Math.abs(x.t - note.t) <= 10 * 60_000 && typeof x.m.content === 'string' && norm(x.m.content) === norm(note.text))
        delete notes[key]
        any = true
        if (hit) {
            const server = typeof hit.m.content === 'string' ? hit.m.content : ''
            // 알림 글은 멘션·이모지가 바뀌어 오므로 그런 표기가 없을 때만 비교
            if (s.logEdits && server && server !== note.text && !server.includes('<') && !note.text.endsWith('…')) {
                const id = String(hit.m.id)
                const e: Entry = (all[id] ??= { c: channelId, at: now })
                const edits = (e.e ??= [])
                if (!edits.some(h => h.t === note.text)) edits.push({ t: note.text, at: Date.parse(hit.m.edited_timestamp) || now })
                e.at = now
                markChanged(id)
            }
            continue
        }
        if (!s.logDeletes) continue
        // 글이 같은 메시지가 범위 안 어디든 있으면 지워진 게 아니다
        if (times.some(x => typeof x.m.content === 'string' && norm(x.m.content) === norm(note.text))) continue
        // 이미 다른 방법(본 메시지·푸시)으로 같은 시각 메시지를 지운 걸로 기록했으면 건너뛴다
        const already = Object.entries(all).some(([id, e]) => e.c === channelId && e.d && Math.abs(msOf(id) - note.t) <= 2)
        if (already) continue
        const id = idAt(note.t)
        all[id] = {
            c: channelId,
            at: now,
            d: now,
            away: 1,
            n: 1,
            m: {
                id,
                channel_id: channelId,
                type: 0,
                flags: 0,
                content: note.text,
                timestamp: new Date(note.t).toISOString(),
                edited_timestamp: null,
                author: { id: note.senderId ?? '1', username: note.sender, global_name: note.sender, avatar: null, discriminator: '0', bot: false, public_flags: 0 },
                attachments: [],
                embeds: [],
                mentions: [],
                mention_roles: [],
                mention_everyone: false,
                pinned: false,
                tts: false,
            },
        }
        markChanged(id)
    }
    if (any) save()
}
