export type Kind = 'read' | 'send' | 'copy' | 'files' | 'account'

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
}

export interface Settings {
    toasts: boolean
    watch: Record<Kind, boolean>
    trusted: string[]
    log: Hit[]
}

export const DEFAULTS: Settings = {
    toasts: true,
    watch: { read: true, send: true, copy: true, files: true, account: true },
    trusted: [],
    log: [],
}

const MAX_LOG = 200

let storage: any
export function bind(s: any) {
    storage = s
}

export function settings(): Settings {
    const c = storage?.cache ?? {}
    return { ...DEFAULTS, ...c, watch: { ...DEFAULTS.watch, ...(c.watch ?? {}) } }
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
export function record(p: string, k: Kind, d?: string) {
    const s = settings()
    const now = Date.now()
    const log = s.log.slice()
    const i = log.findIndex(h => h.p === p && h.k === k && h.d === d)
    if (i >= 0) {
        const h = { ...log[i], at: now, n: log[i].n + 1 }
        log.splice(i, 1)
        log.unshift(h)
    } else log.unshift({ p, k, first: now, at: now, n: 1, d })
    if (storage?.cache) storage.cache.log = log.slice(0, MAX_LOG)
    clearTimeout(timer)
    timer = setTimeout(() => update({ log: settings().log }), 1500)
}
