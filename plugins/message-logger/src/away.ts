import { callNativeMethod } from '@valenced/modules/native'
import { cmp, markChanged } from './logger'
import { keepMs, logs, save, seen, SEEN_MAX, settings, type Entry } from './store'

/**
 * 자리를 비운 사이 (앱이 꺼져 있거나 연결이 끊긴 동안) 지워지거나 고쳐진 메시지 찾기.
 *
 * 디스코드는 삭제·수정을 알림으로 보내지 않는다. 대신
 *  1. 앱이 켜져 있는 동안 본 메시지와
 *  2. 앱이 꺼져 있어도 알림으로 온 메시지(네이티브 Pushes.kt 가 파일에 적어 둔다)를 기억해 두고,
 * 나중에 그 채널을 불러올 때 서버가 보내 준 목록과 비교한다:
 *  - 불러온 범위 안인데 서버 목록에 없다 → 그사이 지워짐 (빨간색)
 *  - 내용이 다르다 → 그사이 고쳐짐 (회색 + 예전 내용, 시간은 서버가 준 수정 시각)
 */

const EPHEMERAL = 1 << 6
const NATIVE = 'yumistra.message-logger.takePushed'

/** 설정 화면의 상태 표시용 */
export const status = { native: 'unknown' as 'unknown' | 'ok' | 'missing', imported: 0, lastPush: 0, lastError: '' }

const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)

/** 알림 글은 멘션·이모지가 @이름·:이름: 으로 바뀌어 오고 길면 잘린다. 그런 게 없을 때만 비교한다 */
function pushComparable(pushed: string, server: string) {
    return !server.includes('<') && !pushed.endsWith('…') && !pushed.endsWith('...')
}

/** 메시지에서 비교·다시 보여주기에 필요한 것만 */
export function slim(m: any) {
    if (!m?.id || !m.channel_id) return
    const a = m.author ?? {}
    return {
        id: String(m.id),
        channel_id: String(m.channel_id),
        ...(m.guild_id ? { guild_id: String(m.guild_id) } : {}),
        type: m.type ?? 0,
        flags: (m.flags ?? 0) & ~EPHEMERAL,
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: m.timestamp,
        edited_timestamp: m.edited_timestamp ?? null,
        author: { id: a.id, username: a.username, global_name: a.global_name ?? null, avatar: a.avatar ?? null, discriminator: a.discriminator ?? '0', bot: !!a.bot, public_flags: a.public_flags ?? 0 },
        attachments: Array.isArray(m.attachments)
            ? m.attachments.map((x: any) => ({ id: x.id, filename: x.filename, size: x.size, url: x.url, proxy_url: x.proxy_url, content_type: x.content_type, width: x.width, height: x.height }))
            : [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
        pinned: false,
        tts: false,
        ...(m.message_reference ? { message_reference: m.message_reference } : {}),
        ...(Array.isArray(m.sticker_items) && m.sticker_items.length ? { sticker_items: m.sticker_items } : {}),
    }
}

function wanted(m: any, me?: string) {
    if (!m?.id || (m.flags ?? 0) & EPHEMERAL) return false
    const s = settings()
    if (s.ignoreBots && m.author?.bot) return false
    if (s.ignoreSelf && me && m.author?.id === me) return false
    return true
}

/** 본 메시지로 기억 (이미 지워진 걸로 기록된 건 빼고) */
export function remember(messages: any[], me?: string, push = false) {
    const all = seen()
    const kept = logs()
    const now = Date.now()
    let any = false
    for (const m of messages) {
        if (!wanted(m, me) || kept[m.id]?.d) continue
        // 알림으로 받은 것보다 서버에서 받은 게 정확하다 (거꾸로는 덮지 않는다)
        if (push && all[m.id] && !all[m.id].p) continue
        const x = slim(m)
        if (!x) continue
        all[x.id] = push ? { m: x, s: now, p: 1 } : { m: x, s: now }
        any = true
    }
    if (any) {
        trim()
        save()
    }
}

export function forget(id: string) {
    if (seen()[id]) {
        delete seen()[id]
        save()
    }
}

/** 메시지가 바뀌었을 때 기억도 같이 (수정 기록은 logger 가 따로 남긴다) */
export function updateSeen(u: any) {
    const x = seen()[u?.id]
    if (!x) return
    if (typeof u.content === 'string') x.m.content = u.content
    if (u.edited_timestamp) x.m.edited_timestamp = u.edited_timestamp
    if (Array.isArray(u.attachments)) x.m.attachments = slim({ ...x.m, attachments: u.attachments })!.attachments
    delete x.p
    save()
}

/** 오래된 것·넘치는 것 정리 */
export function trim() {
    const all = seen()
    const limit = keepMs()
    const now = Date.now()
    for (const [id, x] of Object.entries(all)) if (now - x.s > limit) delete all[id]
    const ids = Object.keys(all)
    if (ids.length <= SEEN_MAX) return
    ids.sort((a, b) => all[a].s - all[b].s)
    for (const id of ids.slice(0, ids.length - SEEN_MAX)) delete all[id]
}

/** 알림 데이터 → API 형태 메시지 */
function fromPush(o: any) {
    const at = Number(o.sent_at_ms) || Number(o.received_at) || Date.now()
    return {
        id: String(o.id),
        channel_id: String(o.channel_id),
        ...(o.guild_id ? { guild_id: String(o.guild_id) } : {}),
        type: Number(o.message_type_) || 0,
        flags: Number(o.message_flags) || 0,
        content: typeof o.message_content === 'string' ? o.message_content : '',
        timestamp: new Date(at).toISOString(),
        author: { id: o.user_id, username: o.user_username, global_name: o.user_global_name ?? null, avatar: o.user_avatar ?? null, discriminator: o.user_discriminator ?? '0' },
        attachments: [],
    }
}

/** 네이티브가 적어 둔 알림 메시지를 가져온다 */
export async function importPushes(me?: string) {
    if (!settings().rememberPushes) {
        // 꺼져 있으면 그동안 쌓인 알림은 버린다 (나중에 켜도 꺼져 있던 동안의 것은 안 들어오게)
        try {
            await (callNativeMethod as any)(NATIVE, [])
        } catch {}
        return 0
    }
    let text = ''
    try {
        const r: any = await (callNativeMethod as any)(NATIVE, [])
        if (r && typeof r === 'object' && 'error' in r && !('result' in r)) throw new Error(String(r.error?.message ?? r.error))
        text = String(unwrap(r) ?? '')
        status.native = 'ok'
    } catch (e: any) {
        status.native = 'missing'
        status.lastError = String(e?.message ?? e)
        return 0
    }
    const messages: any[] = []
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
            const o = JSON.parse(line)
            if (o?.id && o.channel_id && o.is_from_current_user !== 'true') {
                messages.push(fromPush(o))
                status.lastPush = Math.max(status.lastPush, Number(o.received_at) || 0)
            }
        } catch {}
    }
    if (messages.length) remember(messages, me, true)
    status.imported += messages.length
    return messages.length
}

/**
 * 채널을 불러왔을 때: 기억해 둔 것과 비교해서 그사이 지워진 것·고쳐진 것을 로그로 남긴다.
 * 그다음 불러온 메시지를 새로 기억한다.
 */
export function compare(payload: any, me?: string) {
    const channelId = payload?.channelId
    const messages: any[] = payload?.messages
    if (!channelId || !Array.isArray(messages)) return
    const s = settings()
    if (s.detectAway && messages.length) {
        const byId = new Map<string, any>(messages.map(m => [String(m.id), m]))
        const ids = [...byId.keys()].sort(cmp)
        const min = ids[0]
        const max = ids[ids.length - 1]
        // 목록 바깥은 서버가 "여기가 정말 끝"이라고 분명히 말할 때만 본다 (아니면 아직 안 불러온 것일 수 있다)
        const newest = !payload.isBefore && !payload.isAfter && !payload.jump && payload.hasMoreAfter === false
        const oldest = !payload.isAfter && !payload.jump && payload.hasMoreBefore === false && messages.length < (payload.limit ?? 50)
        const all = logs()
        const now = Date.now()
        let any = false
        // 지워졌다고 기록했는데 서버가 그대로 보내 줬으면 잘못 잡은 것 → 되돌린다
        for (const id of byId.keys()) {
            const e = all[id]
            if (!e?.d) continue
            delete e.d
            delete e.m
            delete e.away
            if (!e.e?.length) delete all[id]
            markChanged(id)
            any = true
        }
        for (const [id, x] of Object.entries(seen())) {
            if (x.m.channel_id !== channelId || all[id]?.d) continue
            const inRange = (cmp(id, min) >= 0 || oldest) && (cmp(id, max) <= 0 || newest)
            if (!inRange) continue
            const now_ = byId.get(id)
            if (!now_) {
                if (!s.logDeletes) continue
                // 그사이 지워짐
                const e: Entry = (all[id] ??= { c: channelId, at: now })
                if (x.m.guild_id) e.g = x.m.guild_id
                e.d = now
                e.at = now
                e.m = x.m
                e.away = 1
                markChanged(id)
                delete seen()[id]
                any = true
            } else if (s.logEdits && x.m.content && typeof now_.content === 'string' && now_.content !== x.m.content && (!x.p || pushComparable(x.m.content, now_.content))) {
                // 그사이 고쳐짐 (수정 시각은 서버가 알려 준다)
                const at = Date.parse(now_.edited_timestamp) || now
                const e: Entry = (all[id] ??= { c: channelId, at: now })
                if (x.m.guild_id) e.g = x.m.guild_id
                const edits = (e.e ??= [])
                if (!edits.some(h => h.t === x.m.content)) edits.push({ t: x.m.content, at })
                e.at = now
                markChanged(id)
                any = true
            }
        }
        if (any) save()
    }
    remember(messages, me)
}
