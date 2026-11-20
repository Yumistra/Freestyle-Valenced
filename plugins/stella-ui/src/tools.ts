import { channel, find, http, S, toast, user } from './data'

/**
 * 채널 도구: 고정 메시지, 검색, 멤버, 알림 설정, 초대. 대부분 디스코드 API 로 바로 한다
 * (디스코드 쪽 모듈은 원래 화면에서 한 번 써야 불러와지는 것이 많다).
 */

const errText = (e: any) => e?.body?.message ?? e?.message ?? String(e ?? '')

// ── 고정 메시지 ─────────────────────────────────────────────────────────
export async function fetchPins(channelId: string): Promise<any[]> {
    const h = http()
    if (!h) throw new Error('no http')
    try {
        const r = await h.get({ url: `/channels/${channelId}/messages/pins`, query: { limit: 50 } })
        const items = r?.body?.items
        if (Array.isArray(items)) return items.map((i: any) => ({ ...i.message, pinned_at: i.pinned_at }))
    } catch {}
    const r = await h.get({ url: `/channels/${channelId}/pins` })
    return Array.isArray(r?.body) ? r.body : []
}

export async function setPinned(channelId: string, messageId: string, pin: boolean): Promise<boolean> {
    const h = http()
    const f = pin ? h?.put : (h?.del ?? h?.delete)
    if (typeof f !== 'function') return false
    try {
        await f.call(h, { url: `/channels/${channelId}/messages/pins/${messageId}` })
        return true
    } catch {
        try {
            await f.call(h, { url: `/channels/${channelId}/pins/${messageId}` })
            return true
        } catch (e) {
            toast(`${pin ? '고정' : '고정 해제'}하지 못했어요: ${errText(e)}`)
            return false
        }
    }
}

// ── 검색 ────────────────────────────────────────────────────────────────
export interface SearchResult {
    messages: any[]
    total: number
    /** 디스코드가 아직 색인 중 */
    indexing?: boolean
}

export async function searchMessages(o: { guildId?: string; channelId: string; query: string; everywhere?: boolean; offset?: number }): Promise<SearchResult> {
    const h = http()
    if (!h) throw new Error('no http')
    const url = o.guildId ? `/guilds/${o.guildId}/messages/search` : `/channels/${o.channelId}/messages/search`
    const query: any = { content: o.query, offset: o.offset ?? 0 }
    if (o.guildId && !o.everywhere) query.channel_id = o.channelId
    const r = await h.get({ url, query })
    if (r?.status === 202 || r?.body?.code === 110000) return { messages: [], total: 0, indexing: true }
    const groups: any[] = r?.body?.messages ?? []
    return { messages: groups.map(g => (Array.isArray(g) ? g[0] : g)).filter(Boolean), total: Number(r?.body?.total_results) || 0 }
}

// ── 멤버 ────────────────────────────────────────────────────────────────
export interface Member {
    id: string
    name: string
    username: string
    status: string
    color?: string
    /** 표시되는 가장 높은 역할 */
    role?: string
}

const STATUS_ORDER: Record<string, number> = { online: 0, idle: 1, dnd: 2, streaming: 0, offline: 3, invisible: 3 }

export function memberList(guildId: string | undefined, channelId: string): Member[] {
    const ids = new Set<string>()
    if (guildId) {
        try {
            for (const m of S().GuildMemberStore?.getMembers?.(guildId) ?? []) {
                const id = m?.userId ?? m?.user?.id
                if (id) ids.add(id)
            }
        } catch {}
    } else {
        const ch = channel(channelId)
        for (const id of ch?.recipients ?? []) ids.add(id)
        const me = S().UserStore?.getCurrentUser?.()?.id
        if (me) ids.add(me)
    }
    const out: Member[] = []
    for (const id of ids) {
        const u = user(id)
        if (!u) continue
        let role: string | undefined
        let color: string | undefined
        if (guildId) {
            try {
                const m = S().GuildMemberStore?.getMember?.(guildId, id)
                color = m?.colorString ?? undefined
                const roles = (m?.roles ?? []).map((r: string) => S().GuildRoleStore?.getRole?.(guildId, r)).filter((r: any) => r?.hoist)
                roles.sort((a: any, b: any) => (b.position ?? 0) - (a.position ?? 0))
                role = roles[0]?.name
            } catch {}
        }
        const nick = guildId ? S().GuildMemberStore?.getNick?.(guildId, id) : undefined
        out.push({ id, name: nick || u.globalName || u.global_name || u.username, username: u.username, status: S().PresenceStore?.getStatus?.(id) ?? 'offline', color, role })
    }
    out.sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || a.name.localeCompare(b.name))
    return out
}

export function memberCount(guildId: string | undefined, channelId: string): number | undefined {
    if (!guildId) return (channel(channelId)?.recipients?.length ?? 0) + 1
    try {
        return S().GuildMemberCountStore?.getMemberCount?.(guildId) ?? undefined
    } catch {
        return undefined
    }
}

/** 이름으로 멤버를 디스코드에 더 불러온다 (게이트웨이 요청) */
export function requestMembers(guildId: string, query: string) {
    try {
        const m = find('requestMembers')
        m?.requestMembers?.(guildId, query, 25)
    } catch {}
}

// ── 알림 ────────────────────────────────────────────────────────────────
/** 0 모든 메시지, 1 멘션만, 2 없음, 3 서버 설정 따름 (채널) */
export type Level = 0 | 1 | 2 | 3

export interface NotifyState {
    guildLevel: Level
    guildMuted: boolean
    suppressEveryone: boolean
    suppressRoles: boolean
    channelLevel: Level
    channelMuted: boolean
}

export function notifyState(guildId: string | undefined, channelId: string): NotifyState {
    const st = S().UserGuildSettingsStore
    const g = guildId ?? null
    const safe = <T>(f: () => T, d: T): T => {
        try {
            const v = f()
            return v == null ? d : v
        } catch {
            return d
        }
    }
    return {
        guildLevel: safe(() => st?.getMessageNotifications?.(g), 1),
        guildMuted: !!safe(() => st?.isMuted?.(g), false),
        suppressEveryone: !!safe(() => st?.isSuppressEveryoneEnabled?.(g), false),
        suppressRoles: !!safe(() => st?.isSuppressRolesEnabled?.(g), false),
        channelLevel: safe(() => st?.getChannelMessageNotifications?.(g, channelId), 3),
        channelMuted: !!safe(() => st?.isChannelMuted?.(g, channelId), false),
    }
}

/** 음소거 기간 (초, -1 은 다시 켤 때까지) */
const muteConfig = (seconds: number) => ({ selected_time_window: seconds, end_time: seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null })

async function patchGuildSettings(guildId: string | undefined, body: any): Promise<boolean> {
    const h = http()
    if (!h?.patch) return false
    try {
        await h.patch({ url: `/users/@me/guilds/${guildId ?? '@me'}/settings`, body })
        return true
    } catch (e) {
        toast(`알림 설정을 바꾸지 못했어요: ${errText(e)}`)
        return false
    }
}

export const setGuildLevel = (guildId: string, level: Level) => patchGuildSettings(guildId, { message_notifications: level })
export const setGuildMuted = (guildId: string, muted: boolean, seconds = -1) => patchGuildSettings(guildId, { muted, mute_config: muted ? muteConfig(seconds) : null })
export const setSuppress = (guildId: string, key: 'suppress_everyone' | 'suppress_roles', on: boolean) => patchGuildSettings(guildId, { [key]: on })
export const setChannelLevel = (guildId: string | undefined, channelId: string, level: Level) => patchGuildSettings(guildId, { channel_overrides: { [channelId]: { message_notifications: level } } })
export const setChannelMuted = (guildId: string | undefined, channelId: string, muted: boolean, seconds = -1) =>
    patchGuildSettings(guildId, { channel_overrides: { [channelId]: { muted, mute_config: muted ? muteConfig(seconds) : null } } })

// ── 초대 ────────────────────────────────────────────────────────────────
export async function createInvite(channelId: string, maxAge: number, maxUses: number): Promise<string | undefined> {
    const h = http()
    if (!h?.post) return
    try {
        const r = await h.post({ url: `/channels/${channelId}/invites`, body: { max_age: maxAge, max_uses: maxUses, temporary: false, unique: false } })
        const code = r?.body?.code
        return code ? `https://discord.gg/${code}` : undefined
    } catch (e) {
        toast(`초대 링크를 만들지 못했어요: ${errText(e)}`)
    }
}
