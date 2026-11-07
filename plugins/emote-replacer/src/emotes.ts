import { settings } from './store'

/**
 * 이름으로 쓰는 그림 이모트: 설정에서 내가 추가한 것만 (서버 이모지는 send.ts 의 discordEmojis).
 * 원래 플러그인의 Yentis 이모트 목록은 쓰지 않는다.
 */

const listeners = new Set<() => void>()
export const onEmotesChange = (fn: () => void) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
}
export const loadEmotes = (_force = false) => Promise.resolve()
export const emoteStatus = () => ({ count: Object.keys(settings().customEmotes).length, failed: false })

/** 이름 → 주소 */
export function allEmotes(): Record<string, string> {
    return { ...settings().customEmotes }
}

export function search(query: string, limit = 60): Array<[string, string]> {
    const q = query.trim().toLowerCase().replace(/^[^\w]+/, '')
    const all = Object.entries(allEmotes())
    if (!q) return all.slice(0, limit)
    return [...all.filter(([n]) => n.toLowerCase().startsWith(q)), ...all.filter(([n]) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))].slice(0, limit)
}
