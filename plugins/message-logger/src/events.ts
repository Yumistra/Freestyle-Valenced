import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { allowed, guildOf, isFriend } from './filters'
import { events, EVENTS_MAX, keepMs, profiles, save, seen, settings, type Event, type UserSnap } from './store'

/**
 * 메시지 말고 다른 기록:
 *  - 반응 빼기 (누가 어떤 반응을 달았다가 뺐는지)
 *  - 채널, 스레드 삭제 (이름과 마지막 메시지들)
 *  - 친구, DM 상대의 프로필 변경 (사용자 이름, 표시 이름, 아바타, 상태 메시지)
 * 그리고 내 DM, 나를 멘션한 메시지가 지워졌을 때의 휴대폰 알림.
 */

const S = () => Stores as any
const NOTIFY = 'yumistra.message-logger.notify'

const myId = (): string | undefined => {
    try {
        return S().AuthenticationStore?.getId?.()
    } catch {}
}

let seq = 0
const eid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

function push(e: Event) {
    const all = events()
    all.push(e)
    if (all.length > EVENTS_MAX) all.splice(0, all.length - EVENTS_MAX)
    save()
}

/** 보관 기간이 지난 기록 지우기 */
export function pruneEvents() {
    const all = events()
    const limit = Date.now() - keepMs()
    const keep = all.filter(e => e.at >= limit)
    if (keep.length !== all.length) {
        all.splice(0, all.length, ...keep)
        save()
    }
}

export function removeEvent(id: string) {
    const all = events()
    const i = all.findIndex(e => e.id === id)
    if (i >= 0) {
        all.splice(i, 1)
        save(true)
    }
}

// ── 반응 ────────────────────────────────────────────────────────────────
/** 이 메시지에서 빠진 반응들 (채팅 아래 표시용) */
export function removedReactions(messageId: string) {
    return events().filter((e): e is Extract<Event, { k: 'r' }> => e.k === 'r' && e.m === messageId)
}

function onReactionRemove(p: any) {
    if (!settings().logReactions || p?.optimistic) return
    const u = p.userId ? String(p.userId) : ''
    if (!p.messageId || !p.channelId || (u && u === myId())) return
    if (settings().ignoreBots && u && S().UserStore?.getUser?.(u)?.bot) return
    if (!allowed({ channel_id: p.channelId, guild_id: p.guildId, author: { id: u } })) return
    const em = p.emoji ?? {}
    const un = u ? snapOf(u) : undefined
    push({ k: 'r', id: eid(), c: String(p.channelId), g: p.guildId ?? guildOf({ channel_id: p.channelId }), m: String(p.messageId), u, em: { id: em.id ?? undefined, name: String(em.name ?? '?'), animated: !!em.animated }, at: Date.now(), ...(un ? { un } : {}) })
}

/** 지금 디스코드가 아는 사용자 모습 (나중에 몰라도 이름이 보이게 같이 남긴다) */
export function snapOf(id: string): UserSnap | undefined {
    try {
        const x = S().UserStore?.getUser?.(id)
        if (!x) return
        return { id, username: x.username, global_name: x.globalName ?? x.global_name ?? null, avatar: x.avatar ?? null }
    } catch {}
}

// ── 채널, 스레드 ────────────────────────────────────────────────────────
const DM_TYPES = new Set([1, 3])

function lastMessages(channelId: string): any[] {
    let list: any[] = []
    try {
        const ms = S().MessageStore?.getMessages?.(channelId)
        const arr: any[] = ms?.toArray?.() ?? ms?._array ?? []
        list = arr.map(r => ({ id: r.id, content: r.content ?? '', author: { id: r.author?.id, username: r.author?.username, global_name: r.author?.globalName ?? r.author?.global_name, avatar: r.author?.avatar }, attachments: (r.attachments ?? []).length }))
    } catch {}
    if (!list.length) {
        list = Object.values(seen())
            .map(x => x.m)
            .filter(m => String(m?.channel_id) === channelId)
            .map(m => ({ id: m.id, content: m.content ?? '', author: m.author, attachments: (m.attachments ?? []).length }))
    }
    return list.slice(-30)
}

function onChannelDelete(p: any) {
    const ch = p?.channel
    if (!settings().logChannels || !ch?.id || DM_TYPES.has(ch.type)) return
    if (!allowed({ channel_id: ch.id, guild_id: ch.guild_id ?? ch.guildId })) return
    push({ k: 'c', id: eid(), c: String(ch.id), g: ch.guild_id ?? ch.guildId ?? undefined, name: String(ch.name ?? ''), type: Number(ch.type ?? 0), parent: ch.parent_id ?? ch.parentId ?? undefined, msgs: lastMessages(String(ch.id)), at: Date.now() })
}

// ── 프로필 ──────────────────────────────────────────────────────────────
function watched(id: string): boolean {
    if (!id || id === myId()) return false
    if (isFriend(id)) return true
    try {
        return !!S().ChannelStore?.getDMFromUserId?.(id)
    } catch {
        return false
    }
}

function customStatus(activities: any[] | undefined): string | undefined {
    if (!Array.isArray(activities)) return
    const a = activities.find(x => x?.type === 4)
    if (!a) return ''
    return [a.emoji?.name, a.state].filter(Boolean).join(' ')
}

/** 바뀐 칸만 기록. 처음 보는 사람은 지금 모습만 기억한다 */
export function checkUser(u: any, activities?: any[]) {
    const id = u?.id ? String(u.id) : ''
    if (!settings().logProfiles || !watched(id)) return
    const now: Record<string, string | undefined> = {}
    if ('username' in (u ?? {}) && u.username != null) now.username = String(u.username)
    if ('global_name' in (u ?? {}) || 'globalName' in (u ?? {})) now.name = String(u.global_name ?? u.globalName ?? '')
    if ('avatar' in (u ?? {})) now.avatar = String(u.avatar ?? '')
    const st = customStatus(activities)
    if (st !== undefined) now.status = st
    const all = profiles()
    const before = all[id]
    if (!before) {
        all[id] = now
        save()
        return
    }
    let any = false
    for (const field of ['username', 'name', 'avatar', 'status'] as const) {
        const v = now[field]
        if (v === undefined) continue
        const old = (before as any)[field]
        if (old !== undefined && old !== v) {
            push({ k: 'p', id: eid(), u: id, field, from: old, to: v, at: Date.now() })
            any = true
        }
        ;(before as any)[field] = v
    }
    if (!any) save()
}

// ── 지운 메시지 알림 ────────────────────────────────────────────────────
function mentionsMe(m: any, me: string): boolean {
    const ms: any[] = m?.mentions ?? []
    if (ms.some(x => String(x?.id ?? x) === me)) return true
    return typeof m?.content === 'string' && (m.content.includes(`<@${me}>`) || m.content.includes(`<@!${me}>`))
}

const nameOf = (a: any) => a?.globalName ?? a?.global_name ?? a?.username ?? 'Someone'

/** 지운 메시지가 내 DM 이거나 나를 멘션했으면 휴대폰 알림 */
export function notifyDeleted(m: any, guildId?: string) {
    try {
        const me = myId()
        if (!settings().notifyDeletes || !me || !m?.id || String(m.author?.id) === me) return
        const g = guildId ?? guildOf(m)
        if (g && !mentionsMe(m, me)) return
        const ch = S().ChannelStore?.getChannel?.(m.channel_id)
        const where = g ? ` in #${ch?.name ?? 'channel'}` : ''
        const files = (m.attachments ?? []).length
        const text = String(m.content ?? '').trim() || (files ? `[${files} attachment${files > 1 ? 's' : ''}]` : '[no text]')
        const url = `https://discord.com/channels/${g ?? '@me'}/${m.channel_id}/${m.id}`
        Promise.resolve((callNativeMethod as any)(NOTIFY, [`${nameOf(m.author)} deleted a message${where}`, text.slice(0, 500), url])).catch(() => {})
    } catch {}
}

export function interceptEvents() {
    const safe = (f: (p: any) => void) => (p: any) => {
        try {
            f(p)
        } catch {}
        return p
    }
    return [
        onFluxEventDispatched('MESSAGE_REACTION_REMOVE', safe(onReactionRemove)),
        onFluxEventDispatched(
            'MESSAGE_REACTION_REMOVE_EMOJI',
            safe(p => onReactionRemove({ ...p, userId: '' })),
        ),
        onFluxEventDispatched('CHANNEL_DELETE', safe(onChannelDelete)),
        onFluxEventDispatched('THREAD_DELETE', safe(onChannelDelete)),
        onFluxEventDispatched(
            'PRESENCE_UPDATES',
            safe(p => {
                for (const u of p?.updates ?? []) checkUser(u.user, u.activities)
            }),
        ),
        onFluxEventDispatched(
            'USER_UPDATE',
            safe(p => checkUser(p?.user)),
        ),
        onFluxEventDispatched(
            'RELATIONSHIP_ADD',
            safe(p => checkUser(p?.relationship?.user)),
        ),
    ]
}
