import { settings } from './store'

/**
 * Yentis 이모트 목록 (원래 플러그인과 같은 곳).
 * emotes.json 은 { 번호: "이름.확장자" } 이고 이미지는 images/번호.확장자 에 있다.
 */
const BASE = 'https://raw.githubusercontent.com/Yentis/yentis.github.io/master/emotes'

let standard: Record<string, string> = {}
let loading: Promise<void> | undefined
let failed = false
const listeners = new Set<() => void>()

export const onEmotesChange = (fn: () => void) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
}
const emit = () => listeners.forEach(f => f())

export function loadEmotes(force = false): Promise<void> {
    if (loading && !force) return loading
    loading = (async () => {
        try {
            const res = await fetch(`${BASE}/emotes.json`, { cache: 'no-cache' } as any)
            if (!res.ok) throw new Error(String(res.status))
            const data = (await res.json()) as Record<string, string>
            const out: Record<string, string> = {}
            for (const [key, file] of Object.entries(data)) {
                const at = String(file).lastIndexOf('.')
                if (at <= 0) continue
                out[String(file).slice(0, at)] = `${BASE}/images/${key}.${String(file).slice(at + 1)}`
            }
            standard = out
            failed = false
        } catch {
            failed = true
        }
        emit()
    })()
    return loading
}

export const emoteStatus = () => ({ count: Object.keys(standard).length, failed })

/** 이름 → 주소. 내 이모트가 같은 이름의 목록 이모트보다 우선 */
export function allEmotes(): Record<string, string> {
    const s = settings()
    return { ...(s.showStandardEmotes ? standard : {}), ...s.customEmotes }
}

export function search(query: string, limit = 60): Array<[string, string]> {
    const q = query.trim().toLowerCase().replace(/^[^\w]+/, '')
    const all = Object.entries(allEmotes())
    if (!q) return all.slice(0, limit)
    const starts: Array<[string, string]> = []
    const contains: Array<[string, string]> = []
    for (const e of all) {
        const n = e[0].toLowerCase()
        if (n.startsWith(q)) starts.push(e)
        else if (n.includes(q)) contains.push(e)
        if (starts.length >= limit) break
    }
    return [...starts, ...contains].slice(0, limit)
}
