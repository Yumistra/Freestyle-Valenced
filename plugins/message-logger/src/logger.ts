import { Dispatcher } from '@valenced/discord/common/flux'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { compare, forget, importPushes, remember, updateSeen } from './away'
import { compareNotes } from './tray'
import { keepMs, logs, save, seen, settings, type Entry } from './store'

const EPHEMERAL = 1 << 6
const S = () => Stores as any

/** 로그가 바뀌어서 네이티브가 다시 그려야 하는 메시지 */
const changed = new Set<string>()
/** 우리가 진짜로 지우거나 되돌리려고 보내는 액션 (다시 잡지 않는다) */
const bypassed = new Set<string>()

/** 알림으로만 받은 메시지: 알림 글이 그대로 비교 가능할 때만 (멘션·이모지 표기가 없을 때) */
function pushedComparable(u: any) {
    if (!settings().rememberPushes) return
    const x = seen()[u?.id]
    if (!x?.p || typeof u.content !== 'string' || u.content.includes('<')) return
    const t = x.m.content
    if (!t || t.endsWith('…') || t.endsWith('...')) return
    return x.m
}

export const takeChanged = (id: string) => changed.delete(id)
export const markChanged = (id: string) => changed.add(id)

export { importPushes }

const myId = () => {
    try {
        return S().AuthenticationStore?.getId?.()
    } catch {}
}

function shouldLog(record: any) {
    const s = settings()
    if (s.ignoreBots && record?.author?.bot) return false
    if (s.ignoreSelf && record?.author?.id && record.author.id === myId()) return false
    return true
}

const getMessage = (channelId: string, id: string) => {
    try {
        return S().MessageStore?.getMessage?.(channelId, id)
    } catch {}
}

const iso = (t: any) => {
    if (!t) return undefined
    if (typeof t === 'string') return t
    try {
        return t.toISOString?.() ?? new Date(t.valueOf()).toISOString()
    } catch {
        return undefined
    }
}

/** MessageRecord → API 형태 메시지 (다시 켰을 때 LOAD_MESSAGES_SUCCESS 에 끼워 넣을 것) */
function rawOf(r: any, guildId?: string) {
    const a = r.author ?? {}
    const ref = r.messageReference
    return {
        id: r.id,
        channel_id: r.channel_id,
        ...(guildId ? { guild_id: guildId } : {}),
        type: r.type ?? 0,
        flags: (r.flags ?? 0) & ~EPHEMERAL,
        content: r.content ?? '',
        timestamp: iso(r.timestamp) ?? new Date().toISOString(),
        edited_timestamp: iso(r.editedTimestamp) ?? null,
        author: {
            id: a.id,
            username: a.username,
            global_name: a.globalName ?? a.global_name ?? null,
            avatar: a.avatar ?? null,
            discriminator: a.discriminator ?? '0',
            bot: !!a.bot,
            public_flags: a.publicFlags ?? a.public_flags ?? 0,
        },
        attachments: Array.isArray(r.attachments) ? r.attachments : [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        pinned: false,
        tts: false,
        ...(ref ? { message_reference: { message_id: ref.message_id, channel_id: ref.channel_id, guild_id: ref.guild_id } } : {}),
        ...(Array.isArray(r.stickerItems) && r.stickerItems.length ? { sticker_items: r.stickerItems } : {}),
    }
}

function entryOf(record: any, guildId?: string): Entry {
    const all = logs()
    let e = all[record.id]
    if (!e) {
        e = { c: record.channel_id, at: Date.now() }
        if (guildId) e.g = guildId
        all[record.id] = e
    }
    return e
}

/**
 * 지운 메시지를 남긴다. 화면에 있는 메시지면 'store', 화면엔 없지만 기억해 둔 메시지면 'seen' (예: 다른 채널을 보고 있을 때), 아니면 false
 */
function keepDeleted(channelId: string, id: string, guildId?: string): 'store' | 'seen' | false {
    if (bypassed.has(id)) return false
    const record = getMessage(channelId, id)
    const sx = record ? undefined : seen()[id]
    // 알림으로만 알던 메시지는 "알림 기억하기"를 켰을 때만
    const remembered = sx && (!sx.p || settings().rememberPushes) ? sx.m : undefined
    if (!record && !remembered) return false
    // 내가 지운 건 게이트웨이가 확인하면서 한 번 더 온다
    if (logs()[id]?.d) return logs()[id].h ? false : record ? 'store' : 'seen'
    const r = record ?? remembered
    // 안 보내진 메시지·나만 보이는 메시지는 지워진 게 아니라 치워진 것
    if ((record?.state && record.state !== 'SENT') || (r.flags ?? 0) & EPHEMERAL) return false
    if (!shouldLog(r)) return false
    const e = entryOf({ id, channel_id: channelId }, guildId ?? remembered?.guild_id)
    e.d = Date.now()
    e.at = e.d
    e.m = record ? rawOf(record, guildId) : remembered
    changed.add(id)
    forget(id)
    save()
    return record ? 'store' : 'seen'
}

/** 줄만 다시 만들게 하는 가짜 수정 (네이티브는 changed 표시가 있어야 다시 그린다) */
const rerender = (channelId: string, id: string, guildId?: string) => ({ type: 'MESSAGE_UPDATE', guildId, message: { id, channel_id: channelId } })

function rerenderLater(channelId: string, id: string, guildId?: string) {
    changed.add(id)
    Promise.resolve().then(() => {
        try {
            Dispatcher.dispatch(rerender(channelId, id, guildId) as any)
        } catch {}
    })
}

// ── 스노플레이크 비교 (문자열 길이 → 사전 순) ───────────────────────
export const cmp = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0)

/** 채널 메시지를 불러올 때 남겨 둔 지운 메시지를 제자리에 다시 넣는다 (다시 켰을 때) */
function withDeleted(payload: any) {
    const channelId = payload?.channelId
    const messages: any[] = payload?.messages
    if (!channelId || !Array.isArray(messages)) return payload
    const have = new Set(messages.map(m => m?.id))
    const ids = messages.map(m => String(m.id)).sort(cmp)
    const min = ids[0]
    const max = ids[ids.length - 1]
    const newest = !payload.isBefore && !payload.isAfter && !payload.jump && payload.hasMoreAfter === false
    const oldest = !payload.isAfter && !payload.jump && payload.hasMoreBefore === false && messages.length < (payload.limit ?? 50)
    const extra: any[] = []
    for (const [id, e] of Object.entries(logs())) {
        if (!e.d || !e.m || e.h || e.c !== channelId || have.has(id)) continue
        const inRange = !ids.length || ((cmp(id, min) >= 0 || oldest) && (cmp(id, max) <= 0 || newest))
        if (inRange) extra.push(e.m)
    }
    if (!extra.length) return payload
    // 새것부터
    const all = [...messages, ...extra].sort((a, b) => cmp(String(b.id), String(a.id)))
    return { ...payload, messages: all }
}

/** 보관 기간이 지난 로그를 지운다. 지금 보이는 지운 메시지는 진짜로 지운다 */
export function expire() {
    const now = Date.now()
    const limit = keepMs()
    const all = logs()
    let any = false
    for (const [id, e] of Object.entries(all)) {
        if (now - (e.at ?? 0) <= limit) continue
        delete all[id]
        any = true
        reallyRemove(id, e)
    }
    if (any) save()
}

/** 로그를 없애고 화면도 원래대로 (지운 메시지면 진짜로 지움) */
function reallyRemove(id: string, e: Entry) {
    changed.add(id)
    if (!getMessage(e.c, id)) return
    bypassed.add(id)
    try {
        if (e.d) Dispatcher.dispatch({ type: 'MESSAGE_DELETE', id, channelId: e.c, guildId: e.g } as any)
        else Dispatcher.dispatch(rerender(e.c, id, e.g) as any)
    } catch {
    } finally {
        bypassed.delete(id)
    }
}

/** 채팅에서만 지운다 (로그 보기에는 남는다): 지운 메시지는 채팅에서 빠지고, 수정 기록은 기록 줄이 사라진다 */
export function hideInChat(id: string) {
    const e = logs()[id]
    if (!e || e.h) return
    e.h = 1
    reallyRemove(id, e)
    save(true)
}

/** 로그 하나만 지운다 (지운 메시지면 채팅에서도 사라지고, 수정 기록이면 기록 줄만 없어진다) */
export function removeOne(id: string) {
    const all = logs()
    const e = all[id]
    if (!e) return
    delete all[id]
    reallyRemove(id, e)
    save(true)
}

export function clearAll() {
    const all = logs()
    for (const [id, e] of Object.entries(all)) {
        delete all[id]
        reallyRemove(id, e)
    }
    save(true)
}

export function intercept() {
    return [
        onFluxEventDispatched('MESSAGE_DELETE', (p: any) => {
            const kept = settings().logDeletes ? keepDeleted(p.channelId, p.id, p.guildId) : false
            // 화면에 있으면 지우지 않고 다시 그리게, 화면에 없으면 그대로 (채널을 열 때 제자리에 넣는다)
            return kept === 'store' ? (rerender(p.channelId, p.id, p.guildId) as any) : p
        }),
        onFluxEventDispatched('MESSAGE_DELETE_BULK', (p: any) => {
            if (!settings().logDeletes || !Array.isArray(p.ids)) return p
            const kept = new Set<string>(p.ids.filter((id: string) => keepDeleted(p.channelId, id, p.guildId) === 'store'))
            if (!kept.size) return p
            // 디스패치 도중엔 또 디스패치할 수 없다
            for (const id of kept) rerenderLater(p.channelId, id, p.guildId)
            const rest = p.ids.filter((id: string) => !kept.has(id))
            return rest.length ? { ...p, ids: rest } : undefined
        }),
        onFluxEventDispatched('MESSAGE_UPDATE', (p: any) => {
            const u = p?.message
            if (u?.id && !bypassed.has(u.id)) Promise.resolve().then(() => updateSeen(u))
            if (!u?.id || bypassed.has(u.id) || !settings().logEdits) return p
            // 화면에 없는 채널의 메시지는 기억해 둔 것과 비교한다
            const record = getMessage(u.channel_id, u.id) ?? (seen()[u.id] && !seen()[u.id].p ? seen()[u.id].m : undefined) ?? pushedComparable(u)
            if (!record || typeof u.content !== 'string' || !record.content || u.content === record.content || !shouldLog(record)) return p
            const e = entryOf(record, p.guildId ?? u.guild_id)
            ;(e.e ??= []).push({ t: record.content, at: Date.now() })
            e.at = Date.now()
            changed.add(u.id)
            save()
            return p
        }),
        onFluxEventDispatched('MESSAGE_CREATE', (p: any) => {
            try {
                if (!p?.optimistic && p?.message && !p.isPushNotification) remember([{ ...p.message, guild_id: p.message.guild_id ?? p.guildId }], myId())
            } catch {}
            return p
        }),
        onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', (p: any) => {
            try {
                // 자리 비운 사이 바뀐 것부터 찾고, 지워진 걸 제자리에 넣는다
                compare(p, myId())
                compareNotes(p)
                return settings().logDeletes ? withDeleted(p) : p
            } catch {
                return p
            }
        }),
    ]
}
