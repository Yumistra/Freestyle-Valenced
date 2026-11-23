import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { allowed, guildOf, isFriend } from './filters'
import { buried, bury, events, EVENTS_MAX, keepMs, profiles, save, seen, settings, type Event, type UserSnap } from './store'

/**
 * 메시지 말고 다른 기록:
 *  - 반응 빼기 (누가 어떤 반응을 달았다가 뺐는지)
 *  - 채널, 스레드 삭제 (이름과 마지막 메시지들)
 *  - 친구, DM 상대의 프로필 변경 (사용자 이름, 표시 이름, 아바타, 상태 메시지)
 * 그리고 내 DM, 나를 멘션한 메시지가 지워졌을 때의 휴대폰 알림.
 */

const S = () => Stores as any
const NOTIFY = 'yumistra.everything-logger.notify'

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
    // 예전에 남은 숨겨진 채널 기록도 치운다
    const keep = all.filter(e => e.at >= limit && !(e.k === 'c' && hiddenName((e as any).name)))
    if (keep.length !== all.length) {
        all.splice(0, all.length, ...keep)
        save()
    }
}

/** 지운 반응 기록을 가리키는 이름 (사용자가 지운 기록을 Discord Watch 가 다시 보내도 넣지 않으려고) */
export const reactionKey = (e: { m: string; u: string; em: { id?: string; name: string } }) => `r:${e.m}:${e.u}:${e.em.id || e.em.name}`

export function removeEvent(id: string) {
    const all = events()
    const i = all.findIndex(e => e.id === id)
    if (i >= 0) {
        const e = all[i]
        if (e.k === 'r') bury(reactionKey(e))
        all.splice(i, 1)
        save(true)
    }
}

// ── 반응 ────────────────────────────────────────────────────────────────
type ReactionEvent = Extract<Event, { k: 'r' }>
const NONE: ReactionEvent[] = []
/**
 * 메시지별 빠진 반응 색인. 채팅 줄을 그릴 때마다 불리므로 기록 전체를 매번 훑지 않는다.
 * 기록 목록이 바뀌면(다른 배열, 길이, 처음, 마지막) 다시 만든다.
 */
let index: { ref: Event[]; len: number; first?: Event; last?: Event; by: Map<string, ReactionEvent[]> } | undefined
/** 이 메시지에서 빠진 반응들 (채팅 아래 표시용, 오래된 것부터) */
export function removedReactions(messageId: string): ReactionEvent[] {
    const all = events()
    if (!index || index.ref !== all || index.len !== all.length || index.first !== all[0] || index.last !== all[all.length - 1]) {
        const by = new Map<string, ReactionEvent[]>()
        for (const e of all) {
            if (e.k !== 'r') continue
            const list = by.get(e.m)
            if (list) list.push(e)
            else by.set(e.m, [e])
        }
        index = { ref: all, len: all.length, first: all[0], last: all[all.length - 1], by }
    }
    return index.by.get(messageId) ?? NONE
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

/** 지운 뒤 같은 이모지로 다시 반응하면 그 기록에 다시 반응한 시각을 적는다 (지운 사람으로 안 세게) */
export function onReactionAdd(p: any) {
    if (p?.optimistic || !p?.messageId || !p?.userId) return
    const u = String(p.userId)
    const m = String(p.messageId)
    const em = p.emoji ?? {}
    let changed = false
    for (const e of events()) {
        if (e.k !== 'r' || e.m !== m || e.u !== u || e.back) continue
        const same = em.id ? String(e.em.id ?? '') === String(em.id) : !e.em.id && e.em.name === String(em.name ?? '')
        if (!same) continue
        e.back = Date.now()
        changed = true
    }
    if (changed) save()
}

const sameEmoji = (a: { id?: string; name: string }, b: { id?: string; name?: string }) =>
    a.id || b.id ? String(a.id ?? '') === String(b.id ?? '') : a.name === String(b.name ?? '')

/**
 * Discord Watch 가 디스코드가 꺼진 동안 본 반응 빼기/다시 달기.
 *  {"t":"react-","at":ms,"c":채널,"g":서버,"m":메시지,"u":사용자,"em":{id,name,animated},"un":{사용자 모습}}
 *  {"t":"react+", ...같은 칸} (뺐던 반응을 다시 단 것)
 * 바뀐 기록이 있으면 true. 디스코드가 켜져 있을 때 직접 잡은 것과 겹치면 (2분 안, 같은 사람, 같은 이모지) 넣지 않는다.
 */
export function companionReaction(x: any): boolean {
    const s = settings()
    if (!s.logReactions || !x?.m || !x.c || !x.u || !x.em) return false
    const u = String(x.u)
    const m = String(x.m)
    const at = Number(x.at) || Date.now()
    const em = { ...(x.em.id ? { id: String(x.em.id) } : {}), name: String(x.em.name ?? '?'), animated: !!x.em.animated }
    const all = events()
    if (x.t === 'react+') {
        let any = false
        for (const e of all) {
            if (e.k !== 'r' || e.m !== m || e.u !== u || e.back || e.at > at + 120_000 || !sameEmoji(e.em, em)) continue
            e.back = at
            any = true
        }
        return any
    }
    if (x.t !== 'react-' || u === myId()) return false
    if (buried(reactionKey({ m, u, em }), at)) return false
    const un: UserSnap | undefined = snapOf(u) ?? (x.un?.username ? { id: u, username: String(x.un.username), global_name: x.un.global_name ?? null, avatar: x.un.avatar ?? null } : undefined)
    if (s.ignoreBots && (S().UserStore?.getUser?.(u)?.bot || x.un?.bot)) return false
    const g = x.g ? String(x.g) : guildOf({ channel_id: x.c })
    if (!allowed({ channel_id: String(x.c), guild_id: g, author: { id: u } })) return false
    if (all.some(e => e.k === 'r' && e.m === m && e.u === u && Math.abs(e.at - at) < 120_000 && sameEmoji(e.em, em))) return false
    const e: Event = { k: 'r', id: eid(), c: String(x.c), ...(g ? { g } : {}), m, u, em, at, ...(un ? { un } : {}) }
    // 시간 순서대로 (앱이 늦게 보내도)
    let i = all.length
    while (i > 0 && all[i - 1].at > at) i--
    all.splice(i, 0, e)
    if (all.length > EVENTS_MAX) all.splice(0, all.length - EVENTS_MAX)
    return true
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

/** 내가 볼 수 없는 (숨겨진) 채널: 이름이 가려져 있거나, 이름이 없거나, 보기 권한이 없다 */
export function hiddenName(raw: any): boolean {
    const name = String(raw ?? '').trim()
    return !name || name === '___hidden___' || /^\d{15,}$/.test(name)
}

export function hiddenChannel(ch: any): boolean {
    if (hiddenName(ch?.name)) return true
    try {
        const can = S().PermissionStore?.can
        // 1 << 10 = 채널 보기
        if (typeof can === 'function' && can.call(S().PermissionStore, BigInt(1024), ch) === false) return true
    } catch {}
    return false
}

function onChannelDelete(p: any) {
    const ch = p?.channel
    if (!settings().logChannels || !ch?.id || DM_TYPES.has(ch.type)) return
    if (hiddenChannel(ch)) return
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
/** 같은 사람의 같은 항목이 이 시간 안에 또 바뀌면 한 기록으로 합친다 */
export const MERGE_MS = 10 * 60_000

/**
 * 프로필 변경 기록. 상태를 자주 바꾸는 사람(몇십 초마다 도는 상태 등)이 목록을 덮지 않게
 * 10분 안의 같은 항목 변경은 앞 기록의 "바뀐 뒤" 값만 고친다. 원래대로 돌아왔으면 기록을 지운다.
 */
export function mergeProfile(id: string, field: string, from: string, to: string, at = Date.now()) {
    const all = events()
    for (let i = all.length - 1, n = 0; i >= 0 && n < 300; i--, n++) {
        const e: any = all[i]
        if (e.k !== 'p' || e.u !== id || e.field !== field) continue
        if (at - e.at > MERGE_MS) break
        if (e.from === to) all.splice(i, 1)
        else {
            e.to = to
            e.at = at
            // 맨 뒤로 (가장 최근 기록)
            all.splice(i, 1)
            all.push(e)
        }
        save()
        return
    }
    push({ k: 'p', id: eid(), u: id, field: field as any, from, to, at })
}

export function checkUser(u: any, activities?: any[]) {
    const id = u?.id ? String(u.id) : ''
    if (!settings().logProfiles || !watched(id)) return
    // 블랙리스트에 넣은 사람은 프로필도 기록하지 않는다
    if ((settings().block ?? []).includes(id)) return
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
            mergeProfile(id, field, old, v)
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
        onFluxEventDispatched('MESSAGE_REACTION_ADD', safe(onReactionAdd)),
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
