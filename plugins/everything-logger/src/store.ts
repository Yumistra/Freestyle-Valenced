/** 저장되는 로그 (디스코드를 다시 켜도 남는다) */
export interface Entry {
    /** 채널 */
    c: string
    /** 서버 (없으면 DM) */
    g?: string
    /** 지운 시각 (ms). 없으면 지워지지 않음 */
    d?: number
    /** 예전 내용들, 오래된 것부터 */
    e?: Array<{ t: string; at: number }>
    /** 지운 메시지의 원본 (다시 켰을 때 채팅에 다시 넣으려고) */
    m?: any
    /** 마지막으로 기록한 시각 (보관 기간은 여기부터) */
    at: number
    /** 자리를 비운 사이 지워진 걸 나중에 알아낸 것 */
    away?: 1
    /** 채팅에서는 숨김 (로그 보기에는 남는다) */
    h?: 1
    /** 알림으로만 알던 메시지 (ID 를 시각으로 만들었다) */
    n?: 1
    /** 기기에 저장한 첨부파일 경로들 (지울 때 같이 지운다) */
    f?: string[]
}

/** 기록할 때 알던 사용자 모습 (나중에 디스코드가 그 사용자를 모를 때 쓴다) */
export interface UserSnap {
    id?: string
    username?: string
    global_name?: string | null
    avatar?: string | null
}

/** 본 메시지 (자리를 비운 사이 지워졌는지·고쳐졌는지 비교하려고) */
export interface Seen {
    /** API 형태 메시지 */
    m: any
    /** 저장한 시각 */
    s: number
    /** 알림으로만 받은 것 (내용이 알림용으로 바뀌어 있을 수 있어 수정 비교는 안 한다) */
    p?: 1
}

export interface Settings {
    /** 알림으로 온 메시지도 기억 (앱이 꺼져 있어도) */
    rememberPushes: boolean
    /** 앱을 다시 열었을 때 그사이 지워지거나 고쳐진 것 찾기 */
    detectAway: boolean
    logDeletes: boolean
    logEdits: boolean
    ignoreSelf: boolean
    ignoreBots: boolean
    /** 보관 시간 (시간) */
    keepHours: number
    /** 지운 메시지의 첨부파일을 기기에 저장 */
    saveAttachments: boolean
    /** 화이트리스트: 사용자, 채널, 서버 ID. 블랙리스트보다 우선 */
    allow: string[]
    /** 블랙리스트: 사용자, 채널, 서버 ID */
    block: string[]
    /** 화이트리스트에 있는 것만 기록 */
    allowOnly: boolean
    /** 친구가 보낸 메시지만 기록 (화이트리스트는 그대로 기록) */
    friendsOnly: boolean
    /** DM, 그룹 DM 도 기록 */
    logDms: boolean
    /** 고른 서버만 기록 (DM 은 상관없음) */
    onlyServersOn: boolean
    onlyServers: string[]
    /** 채팅에 예전 버전 보이기 */
    showHistoryInChat: boolean
    /** 지운 메시지에 지운 시각 */
    showDeleteTime: boolean
    /** 예전 버전 옆에 수정 시각 */
    showEditTime: boolean
    /** 시각에 초까지 */
    seconds: boolean
    /** 12시간제 */
    clock12: boolean
    /** 지운 메시지 색 (#rrggbb, 비우면 테마 빨강) */
    deletedColor: string
    /** 수정 기록 색 (비우면 테마 회색) */
    editedColor: string
    /** 지운 메시지 보낸 사람 이름도 그 색으로 */
    colorDeletedNames: boolean
    /** 반응을 뺀 것 기록 */
    logReactions: boolean
    /** 채널, 스레드 삭제 기록 */
    logChannels: boolean
    /** 친구, DM 상대의 프로필 변경 기록 */
    logProfiles: boolean
    /** 내 DM, 나를 멘션한 메시지가 지워지면 휴대폰 알림 */
    notifyDeletes: boolean
    /** 저장한 검색 */
    searches: SavedSearch[]
    /** 디스코드 색 고르기 창 모듈 번호 (같은 빌드일 때 바로 불러오려고) */
    pickerModule?: { id: number; build: string }
    /** Discord Watch 경고를 보고 켜기로 했다 */
    watchUnlocked?: boolean
}

export interface SavedSearch {
    name: string
    q: string
    f: { kinds: string[]; places: string[]; channels: string[]; users: string[]; from?: string; to?: string }
}

/** 메시지 말고 다른 기록 (반응, 채널, 프로필) */
export type Event =
    | { k: 'r'; id: string; c: string; g?: string; m: string; u: string; em: { id?: string; name: string; animated?: boolean }; at: number; un?: UserSnap; back?: number }
    | { k: 'c'; id: string; c: string; g?: string; name: string; type: number; parent?: string; msgs: any[]; at: number; /** 지워진 게 아니라 내가 볼 수 없게 된 것 */ lost?: boolean; /** 서버에 물어봐서 확인함 */ checked?: boolean }
    | { k: 'p'; id: string; u: string; field: 'username' | 'name' | 'avatar' | 'status'; from: string; to: string; at: number }

export const DEFAULTS: Settings = { rememberPushes: true, detectAway: true, logDeletes: true, logEdits: true, ignoreSelf: false, ignoreBots: true, keepHours: 72, saveAttachments: true, allow: [], block: [], allowOnly: false, friendsOnly: false, logDms: true, onlyServersOn: false, onlyServers: [], showHistoryInChat: true, showDeleteTime: true, showEditTime: true, seconds: false, clock12: false, deletedColor: '', editedColor: '', colorDeletedNames: false, logReactions: true, logChannels: true, logProfiles: true, notifyDeletes: true, searches: [] }

/** 첨부파일 하나 저장 크기 상한 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export const KEEP_OPTIONS: Array<[number, string]> = [
    [12, '12 hours'],
    [24, '1 day'],
    [72, '3 days'],
    [168, '7 days'],
    [720, '30 days'],
]

let storage: any
const listeners = new Set<() => void>()

export function bind(s: any) {
    storage = s
}

/** 설정 화면이 넘겨준 저장소: 이미 읽은 저장소가 있으면 그대로 둔다 */
export function bindIfNone(s: any) {
    if (!storage?.cache && s) storage = s
}

/**
 * 저장된 내용을 아직 못 읽었거나 플러그인이 꺼진 뒤에는 쓰지 않는다.
 * (읽기 전의 빈 내용으로 쓰면 저장된 로그와 설정이 전부 지워진다)
 */
function ready(): boolean {
    const c = storage?.cache
    return !!c && typeof c === 'object'
}

/** 기다리던 저장을 지금 한다 (디스코드가 뒤로 갈 때: 그 뒤에 꺼지면 3초 기다리던 게 사라진다) */
export function flush() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
    if (ready()) writeNow()
}

/** 플러그인이 꺼질 때: 기다리던 저장을 지금 하고, 그 뒤로는 아무것도 쓰지 않는다 */
export function unbind() {
    if (timer) {
        clearTimeout(timer)
        timer = undefined
        if (ready()) writeNow()
    }
    storage = undefined
}

export function settings(): Settings {
    const c = storage?.cache ?? {}
    return { ...DEFAULTS, ...(c.settings ?? {}) }
}

export function setSettings(patch: Partial<Settings>) {
    if (!storage || !ready()) return
    storage.cache = { ...(storage.cache ?? {}), settings: { ...settings(), ...patch } }
    save(true)
}

export function logs(): Record<string, Entry> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.logs || typeof c.logs !== 'object') c.logs = {}
    return c.logs
}

/**
 * 사용자가 지운 로그의 표시 (메시지 ID → 지운 시각).
 * 알림 앱은 같은 기록을 3일 동안 다시 보내고, 다른 곳에서도 같은 기록이 다시 들어올 수 있다.
 * 지운 시각 전에 생긴 기록은 다시 넣지 않는다 (그 뒤에 새로 생긴 일, 예: 나중에 진짜로 지워짐은 넣는다).
 */
export function gone(): Record<string, number> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.gone || typeof c.gone !== 'object') c.gone = {}
    return c.gone
}
export function bury(id: string) {
    gone()[id] = Date.now()
}
/** 사용자가 지운 로그인지 (at: 그 기록이 생긴 시각, 지운 시각보다 앞이면 다시 넣지 않는다) */
export function buried(id: string, at: number) {
    const t = gone()[id]
    return typeof t === 'number' && at <= t
}
/** 알림 앱이 다시 보내는 기간(3일)이나 보관 기간 중 긴 것보다 오래된 표시는 치운다 */
export function pruneGone() {
    const all = gone()
    const limit = Date.now() - Math.max(keepMs(), 4 * 86400_000)
    let any = false
    for (const [id, t] of Object.entries(all))
        if (t < limit) {
            delete all[id]
            any = true
        }
    return any
}

/** 기억해 둘 본 메시지 수 상한 */
export const SEEN_MAX = 3000

export function seen(): Record<string, Seen> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.seen || typeof c.seen !== 'object') c.seen = {}
    return c.seen
}

export function notes(): Record<string, any> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.notes || typeof c.notes !== 'object') c.notes = {}
    return c.notes
}

/** 반응, 채널, 프로필 기록 (새것이 뒤) */
export const EVENTS_MAX = 3000
export function events(): Event[] {
    const c = storage?.cache
    if (!c) return []
    if (!Array.isArray(c.events)) c.events = []
    return c.events
}

/** 친구, DM 상대의 마지막으로 본 프로필 (바뀐 걸 알아내려고) */
export function profiles(): Record<string, { username?: string; name?: string; avatar?: string; status?: string }> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.profiles || typeof c.profiles !== 'object') c.profiles = {}
    return c.profiles
}

export const onChange = (fn: () => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

let timer: any
let due = 0
/**
 * 잠깐 모았다가 한 번에 쓴다. 메시지가 계속 들어와도 늦어도 delay 안에는 쓴다
 * (예전처럼 부를 때마다 기다림을 다시 시작하면 바쁜 채널에서는 한참 안 써진다).
 * 기억해 둔 메시지(seen)만 바뀐 건 조금 더 모아서 (delay 5초) 쓴다: 저장할 때 전체를 다시 쓰기 때문.
 */
/** 바뀔 때마다 1씩 (화면이 다시 계산할지 정하는 데 쓴다) */
let ver = 0
export const version = () => ver
let notifyTimer: any
export function save(now = false, delay = 1000) {
    ver++
    // 보고 있는 화면에 알리는 건 0.4초에 한 번만 (반응, 프로필 기록이 몰려 올 때 화면이 계속 다시 그려져 멈추지 않게)
    const notify = () => {
        clearTimeout(notifyTimer)
        notifyTimer = undefined
        for (const fn of [...listeners]) {
            try {
                fn()
            } catch {}
        }
    }
    // 사용자가 직접 바꾼 것 (설정, 지우기: now) 은 바로
    if (now) notify()
    else if (!notifyTimer && listeners.size) notifyTimer = setTimeout(notify, 400)
    if (!storage) return
    if (now) {
        clearTimeout(timer)
        timer = undefined
        writeNow()
        return
    }
    const at = Date.now() + delay
    if (timer && due <= at) return
    clearTimeout(timer)
    due = at
    timer = setTimeout(() => {
        timer = undefined
        writeNow()
    }, delay)
}

function writeNow() {
    if (!ready()) return
    const s = storage
    try {
        s.set({ ...s.cache, logs: logs(), gone: gone(), seen: seen(), notes: notes(), events: events(), profiles: profiles(), settings: settings() }, true)
    } catch {}
}

export const keepMs = () => Math.max(1, settings().keepHours) * 3600_000

// ── 수정 기록 넣기 (모든 곳이 이걸 거친다) ─────────────────────────────
/** 멘션 표기 차이(<@!id> 와 <@id>)는 같은 글로 본다 */
const sameText = (a: string, b: string) => a.replace(/<@!(\d+)>/g, '<@$1>').trim() === b.replace(/<@!(\d+)>/g, '<@$1>').trim()

/**
 * 예전 내용 하나를 넣는다. 넣었으면 true.
 *  - 지운 뒤의 수정은 있을 수 없으니 넣지 않는다
 *  - 지금 내용과 같은 글은 수정이 아니다
 *  - 같은 글이 1분 안에 또 오면 (플러그인이 두 겹으로 걸렸을 때 등) 한 번만
 */
export function addEdit(e: Entry, t: string, at: number, current?: string): boolean {
    if (typeof t !== 'string') return false
    if (e.d && at > e.d) return false
    if (typeof current === 'string' && sameText(t, current)) return false
    const edits = (e.e ??= [])
    if (edits.some(h => h.at === at || (sameText(h.t, t) && Math.abs(h.at - at) < 60_000))) return false
    edits.push({ t, at })
    edits.sort((a, b) => a.at - b.at)
    return true
}

/** 이미 들어간 잘못된 수정 기록을 치운다 (지운 뒤 시각, 지운 원본과 같은 글, 겹친 것). 바꿨으면 true */
export function cleanEdits(): boolean {
    let any = false
    for (const [id, e] of Object.entries(logs())) {
        if (!e.e?.length) continue
        const before = e.e.length
        const kept: Array<{ t: string; at: number }> = []
        for (const h of e.e) {
            if (e.d && h.at > e.d) continue
            if (e.d && typeof e.m?.content === 'string' && sameText(h.t, e.m.content)) continue
            if (kept.some(k => k.at === h.at || (sameText(k.t, h.t) && Math.abs(k.at - h.at) < 60_000))) continue
            kept.push(h)
        }
        if (kept.length === before) continue
        any = true
        if (kept.length) e.e = kept
        else {
            delete e.e
            if (!e.d) delete logs()[id]
        }
    }
    return any
}
