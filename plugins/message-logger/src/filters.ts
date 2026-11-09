import { Stores } from '@valenced/discord/flux'
import { setSettings, settings } from './store'

/**
 * 블랙리스트, 화이트리스트.
 * 목록에는 사용자, 채널, 서버 ID 를 섞어 넣는다. 메시지의 보낸 사람, 채널(스레드면 부모 채널도), 서버 중 하나라도 걸리면 해당.
 * 화이트리스트가 블랙리스트보다 우선이다 (서버를 막아도 그 안의 한 채널은 기록하기 등).
 */

const S = () => Stores as any

export type Kind = 'user' | 'channel' | 'server' | 'unknown'

function channelOf(id?: string) {
    try {
        return id ? S().ChannelStore?.getChannel?.(id) : undefined
    } catch {}
}

/** 메시지와 관련된 ID 들 (보낸 사람, 채널, 부모 채널, 서버) */
function idsOf(m: any): string[] {
    const out: string[] = []
    const author = m?.author?.id
    const cid = m?.channel_id ?? m?.channelId
    if (author) out.push(String(author))
    if (cid) out.push(String(cid))
    const ch = channelOf(cid ? String(cid) : undefined)
    if (ch?.parent_id) out.push(String(ch.parent_id))
    const gid = m?.guild_id ?? m?.guildId ?? ch?.guild_id
    if (gid) out.push(String(gid))
    return out
}

/** 이 메시지를 기록해도 되는지 */
export function allowed(m: any): boolean {
    const s = settings()
    const allow = s.allow ?? []
    const block = s.block ?? []
    if (!allow.length && !block.length && !s.allowOnly && !s.friendsOnly) return true
    const ids = idsOf(m)
    if (ids.some(id => allow.includes(id))) return true
    if (s.allowOnly) return false
    if (s.friendsOnly && !isFriend(m?.author?.id)) return false
    return !ids.some(id => block.includes(id))
}

/** 친구인지 (RelationshipStore) */
export function isFriend(id?: string): boolean {
    if (!id) return false
    try {
        const R = S().RelationshipStore
        if (typeof R?.isFriend === 'function') return !!R.isFriend(String(id))
        return R?.getRelationshipType?.(String(id)) === 1
    } catch {}
    return false
}

export function kindOf(id: string): Kind {
    try {
        if (S().UserStore?.getUser?.(id)) return 'user'
        if (channelOf(id)) return 'channel'
        if (S().GuildStore?.getGuild?.(id)) return 'server'
    } catch {}
    return 'unknown'
}

export function nameOf(id: string): string {
    try {
        const u = S().UserStore?.getUser?.(id)
        if (u) return u.globalName ?? u.global_name ?? u.username ?? id
        const c = channelOf(id)
        if (c) {
            if (c.name) return `#${c.name}`
            const r = c.recipients?.[0]
            const ru = r ? S().UserStore?.getUser?.(r) : undefined
            return ru ? `DM, ${ru.globalName ?? ru.username}` : 'DM'
        }
        const g = S().GuildStore?.getGuild?.(id)
        if (g) return g.name ?? id
    } catch {}
    return id
}

export const KIND_LABEL: Record<Kind, string> = { user: 'User', channel: 'Channel', server: 'Server', unknown: 'ID' }

export function inList(list: 'allow' | 'block', id: string) {
    return (settings()[list] ?? []).includes(id)
}

export function addTo(list: 'allow' | 'block', id: string) {
    id = id.trim()
    if (!/^\d{5,25}$/.test(id)) return false
    const other = list === 'allow' ? 'block' : 'allow'
    const s = settings()
    const next = [...new Set([...(s[list] ?? []), id])]
    // 같은 ID 가 두 목록에 같이 있지 않게
    setSettings({ [list]: next, [other]: (s[other] ?? []).filter(x => x !== id) } as any)
    return true
}

export function removeFrom(list: 'allow' | 'block', id: string) {
    setSettings({ [list]: (settings()[list] ?? []).filter(x => x !== id) } as any)
}
