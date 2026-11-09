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
}

export const DEFAULTS: Settings = { rememberPushes: true, detectAway: true, logDeletes: true, logEdits: true, ignoreSelf: false, ignoreBots: true, keepHours: 72, saveAttachments: true, allow: [], block: [], allowOnly: false, friendsOnly: false }

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

export function settings(): Settings {
    const c = storage?.cache ?? {}
    return { ...DEFAULTS, ...(c.settings ?? {}) }
}

export function setSettings(patch: Partial<Settings>) {
    if (!storage) return
    storage.cache = { ...(storage.cache ?? {}), settings: { ...settings(), ...patch } }
    save(true)
}

export function logs(): Record<string, Entry> {
    const c = storage?.cache
    if (!c) return {}
    if (!c.logs || typeof c.logs !== 'object') c.logs = {}
    return c.logs
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

export const onChange = (fn: () => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

let timer: any
/** 잠깐 모았다가 한 번에 쓴다 */
export function save(now = false) {
    for (const fn of [...listeners]) {
        try {
            fn()
        } catch {}
    }
    if (!storage) return
    clearTimeout(timer)
    const write = () => {
        try {
            storage.set({ ...(storage.cache ?? {}), logs: logs(), seen: seen(), notes: notes(), settings: settings() }, true)
        } catch {}
    }
    if (now) write()
    else timer = setTimeout(write, 3000)
}

export const keepMs = () => Math.max(1, settings().keepHours) * 3600_000
