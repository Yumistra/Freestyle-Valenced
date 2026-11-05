export type Kind = 'read' | 'send' | 'copy' | 'files' | 'account'

/** off: 아무것도 안 함, alert: 알리기만, block: 막고 알리기 */
export type Mode = 'off' | 'alert' | 'block'

export interface Hit {
    /** 플러그인 id ('' 면 누군지 모름) */
    p: string
    k: Kind
    /** 처음, 마지막 시각 */
    first: number
    at: number
    n: number
    /** 보낸 곳, 파일 경로 같은 자세한 내용 */
    d?: string
    /** 막았는지 */
    b?: boolean
}

export interface Settings {
    toasts: boolean
    watch: Record<Kind, Mode>
    trusted: string[]
    log: Hit[]
}

export const DEFAULTS: Settings = {
    toasts: true,
    watch: { read: 'alert', send: 'block', copy: 'alert', files: 'alert', account: 'block' },
    trusted: [],
    log: [],
}

const MAX_LOG = 200

let storage: any
let pending = false
export function bind(s: any) {
    if (storage === s) return
    storage = s
    // 저장소가 붙기 전에 쌓인 기록을 옮긴다
    if (pending && s?.cache && Array.isArray(early?.log)) {
        pending = false
        s.cache.log = early.log
        update({ log: early.log })
    }
}

/** 저장소가 붙기 전 (preInit) 에 파일에서 바로 읽어 둔 설정 */
let early: any
export function setEarly(v: any) {
    early = v
}

export function settings(): Settings {
    const c = storage?.cache ?? early ?? {}
    const watch: any = { ...DEFAULTS.watch }
    // 1.0.0 은 켜기, 끄기(true, false) 였다
    for (const [k, v] of Object.entries(c.watch ?? {})) watch[k] = v === true ? DEFAULTS.watch[k as Kind] : v === false ? 'off' : v
    return { ...DEFAULTS, ...c, watch }
}

export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}

export function update(patch: Partial<Settings>) {
    return storage?.set({ ...settings(), ...patch }, true)
}

// 로그는 자주 바뀌니 모아서 저장한다
let timer: any
export function record(p: string, k: Kind, d: string | undefined, b: boolean) {
    const s = settings()
    const now = Date.now()
    const log = s.log.slice()
    const i = log.findIndex(h => h.p === p && h.k === k && h.d === d && !!h.b === b)
    if (i >= 0) {
        const h = { ...log[i], at: now, n: log[i].n + 1 }
        log.splice(i, 1)
        log.unshift(h)
    } else log.unshift({ p, k, first: now, at: now, n: 1, d, b: b || undefined })
    if (storage?.cache) storage.cache.log = log.slice(0, MAX_LOG)
    else {
        early = { ...(early ?? {}), log: log.slice(0, MAX_LOG) }
        pending = true
        return
    }
    clearTimeout(timer)
    timer = setTimeout(() => update({ log: settings().log }), 1500)
}
