import { Dispatcher } from '@valenced/discord/common/flux'
import { channel, displayName, find, guild, guildIds, http, launchLibrary, S, toast, user } from './data'

/**
 * 입력창이 쓰는 것들: 파일 붙이기, 입력 중 알리기, 이모지·스티커·GIF 목록, 자동완성.
 */

// ── 파일 ────────────────────────────────────────────────────────────────
export interface Picked {
    uri: string
    name: string
    type: string
    width?: number
    height?: number
}

/** 사진, 영상 고르기 (여러 개). 실패하면 이유를 알려 준다 */
export async function pickFiles(): Promise<Picked[]> {
    try {
        const res: any = await launchLibrary({ mediaType: 'mixed', selectionLimit: 10, skipProcessing: true })
        if (!res || res.didCancel || res.cancelled || res.canceled) return []
        if (res.errorCode || res.errorMessage) {
            toast(`파일을 고르지 못했어요: ${res.errorMessage ?? res.errorCode}`)
            return []
        }
        const list: any[] = res.assets ?? (Array.isArray(res) ? res : res.uri ? [res] : [])
        return list
            .filter(a => a?.uri)
            .map((a, i) => ({ uri: a.uri, name: a.fileName || String(a.uri).split('/').pop() || `file_${Date.now()}_${i}`, type: a.mimeType ?? a.fileType ?? a.type ?? 'application/octet-stream', width: a.width, height: a.height }))
    } catch (e: any) {
        toast(`파일을 고르지 못했어요: ${e?.message ?? e}`)
        return []
    }
}

// ── 채널별 쓰던 글과 붙인 파일 (사진 고르는 동안 화면이 다시 그려져도 남게) ──
const drafts = new Map<string, { text: string; files: Picked[] }>()
const draftListeners = new Set<() => void>()
export const draftOf = (channelId: string) => drafts.get(channelId) ?? { text: '', files: [] }
export function setDraft(channelId: string, d: Partial<{ text: string; files: Picked[] }>) {
    drafts.set(channelId, { ...draftOf(channelId), ...d })
    draftListeners.forEach(f => f())
}
export function onDraft(f: () => void) {
    draftListeners.add(f)
    return () => draftListeners.delete(f)
}
export const forgetDrafts = () => drafts.clear()

const CHANNEL_MESSAGE = 0
function uploadsOf(channelId: string): any[] {
    try {
        const u = S().UploadAttachmentStore?.getUploads?.(channelId, CHANNEL_MESSAGE)
        return Array.isArray(u) ? u : []
    } catch {
        return []
    }
}

/** 고른 파일을 디스코드 업로드로 (사진 고르기와 같은 방법) */
function makeUpload(channelId: string, f: Picked): any {
    const platform = find('UploadPlatform')?.UploadPlatform?.REACT_NATIVE ?? 0
    const origin = find('UploadOrigin')?.UploadOrigin?.IMAGE_PICKER
    const item: any = { id: f.uri, uri: f.uri, originalUri: f.uri, mimeType: f.type, width: f.width, height: f.height, filename: f.name, platform }
    if (origin != null) item.origin = origin
    const before = new Set(uploadsOf(channelId))
    try {
        ;(Dispatcher as any).dispatch({ type: 'UPLOAD_ATTACHMENT_ADD_FILES', channelId, files: [item], draftType: CHANNEL_MESSAGE, allowOptimization: false })
    } catch {
        return
    }
    return uploadsOf(channelId).find(u => !before.has(u))
}

function removeUpload(channelId: string, u: any) {
    const id = u?.id ?? u?.item?.id
    if (id == null) return
    try {
        ;(Dispatcher as any).dispatch({ type: 'UPLOAD_ATTACHMENT_REMOVE_FILE', channelId, id, draftType: CHANNEL_MESSAGE })
    } catch {}
}

/** 글과 파일, 스티커를 보낸다. 성공하면 true */
export function sendWith(channelId: string, text: string, opts: { reply?: any; files?: Picked[]; stickerIds?: string[] }): boolean {
    const actions = find('sendMessage', 'receiveMessage') ?? find('sendMessage', 'deleteMessage')
    if (typeof actions?.sendMessage !== 'function') return false
    const content = text.trim()
    const options: any = {}
    if (opts.reply?.id) {
        const guildId = channel(channelId)?.guild_id
        options.messageReference = { channel_id: channelId, message_id: opts.reply.id, ...(guildId ? { guild_id: guildId } : {}) }
    }
    if (opts.stickerIds?.length) options.stickerIds = opts.stickerIds
    const uploads = (opts.files ?? []).map(f => makeUpload(channelId, f)).filter(Boolean)
    if (opts.files?.length && uploads.length !== opts.files.length) {
        uploads.forEach(u => removeUpload(channelId, u))
        return false
    }
    if (uploads.length) options.attachmentsToUpload = uploads
    if (!content && !uploads.length && !opts.stickerIds?.length) return false
    try {
        actions.sendMessage(channelId, { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, options)
    } catch {
        uploads.forEach(u => removeUpload(channelId, u))
        return false
    }
    // 디스코드 입력창에 남지 않게
    if (uploads.length) setTimeout(() => uploads.forEach(u => removeUpload(channelId, u)), 0)
    return true
}

// ── 입력 중 ─────────────────────────────────────────────────────────────
let lastTyping = 0
export function typing(channelId: string) {
    const now = Date.now()
    if (now - lastTyping < 8000) return
    lastTyping = now
    try {
        find('startTyping', 'stopTyping')?.startTyping?.(channelId)
    } catch {}
}
export function stopTyping(channelId: string) {
    lastTyping = 0
    try {
        find('startTyping', 'stopTyping')?.stopTyping?.(channelId)
    } catch {}
}

/** 지금 입력 중인 사람 이름 (나 빼고) */
export function typingNames(channelId: string): string[] {
    try {
        const map = S().TypingStore?.getTypingUsers?.(channelId) ?? {}
        const me = S().UserStore?.getCurrentUser?.()?.id
        const g = channel(channelId)?.guild_id
        return Object.keys(map)
            .filter(id => id !== me)
            .map(id => displayName(user(id), g))
    } catch {
        return []
    }
}

export function typingText(names: string[]): string {
    if (!names.length) return ''
    if (names.length === 1) return `${names[0]} 님이 입력 중…`
    if (names.length <= 3) return `${names.join(', ')} 님이 입력 중…`
    return '여러 명이 입력 중…'
}

// ── 이모지 ──────────────────────────────────────────────────────────────
export interface Emoji {
    id?: string
    name: string
    /** 유니코드 이모지 글자 */
    surrogates?: string
    animated?: boolean
    guildId?: string
}

export const UNICODE_CATEGORIES = ['people', 'nature', 'food', 'activity', 'travel', 'objects', 'symbols', 'flags'] as const
export const CATEGORY_LABEL: Record<string, string> = { people: '사람', nature: '자연', food: '음식', activity: '활동', travel: '여행', objects: '물건', symbols: '기호', flags: '깃발' }

/** 디스코드에 들어 있는 유니코드 이모지 */
export function unicodeEmojis(category: string): Emoji[] {
    try {
        const m = find('getByCategory', 'getCategories')
        const list: any[] = m?.getByCategory?.(category) ?? []
        return list.map(e => ({ name: e.uniqueName ?? e.names?.[0] ?? '', surrogates: e.surrogates })).filter(e => e.surrogates)
    } catch {
        return []
    }
}

/** 서버별 커스텀 이모지 (쓸 수 있는 것만) */
export function guildEmojis(): { guildId: string; name: string; emojis: Emoji[] }[] {
    const out: { guildId: string; name: string; emojis: Emoji[] }[] = []
    for (const id of guildIds()) {
        try {
            const list: any[] = S().EmojiStore?.getGuildEmoji?.(id) ?? []
            const emojis = list.filter(e => e && e.available !== false).map(e => ({ id: e.id, name: e.name, animated: !!e.animated, guildId: id }))
            if (emojis.length) out.push({ guildId: id, name: guild(id)?.name ?? '', emojis })
        } catch {}
    }
    return out
}

/** 보낼 때 쓰는 글 */
export const emojiText = (e: Emoji) => (e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : (e.surrogates ?? ''))

// ── 스티커 ──────────────────────────────────────────────────────────────
export function guildStickers(): { guildId: string; name: string; stickers: any[] }[] {
    const out: { guildId: string; name: string; stickers: any[] }[] = []
    for (const id of guildIds()) {
        try {
            const list: any[] = S().StickersStore?.getStickersByGuildId?.(id) ?? []
            const stickers = list.filter(s => s && s.available !== false)
            if (stickers.length) out.push({ guildId: id, name: guild(id)?.name ?? '', stickers })
        } catch {}
    }
    return out
}

// ── GIF ─────────────────────────────────────────────────────────────────
export interface Gif {
    url: string
    src: string
    width: number
    height: number
}

export async function gifs(query: string): Promise<Gif[]> {
    try {
        const q = query.trim()
        const res = await http()?.get?.({ url: q ? '/gifs/search' : '/gifs/trending-gifs', query: { ...(q ? { q } : {}), media_format: 'webp', provider: 'tenor', locale: 'ko' } })
        const list: any[] = Array.isArray(res?.body) ? res.body : (res?.body?.gifs ?? [])
        return list.filter(g => g?.src && g?.url).map(g => ({ url: g.url, src: g.src, width: Number(g.width) || 200, height: Number(g.height) || 200 }))
    } catch {
        return []
    }
}

// ── 자동완성 ────────────────────────────────────────────────────────────
export interface Suggestion {
    key: string
    label: string
    sub?: string
    /** 넣을 글 (보낼 때 그대로) */
    insert: string
    avatar?: string
    emoji?: Emoji
}

/** 입력 끝에 @, #, : 로 시작하는 낱말이 있으면 그것 */
export function trigger(text: string): { kind: '@' | '#' | ':'; query: string; start: number } | undefined {
    const m = /(^|\s)([@#:])([^\s@#:]*)$/.exec(text)
    if (!m) return
    const kind = m[2] as '@' | '#' | ':'
    if (kind === ':' && m[3].length < 2) return
    return { kind, query: m[3].toLowerCase(), start: m.index + m[1].length }
}

export function suggestions(channelId: string, text: string): Suggestion[] {
    const t = trigger(text)
    if (!t) return []
    const ch = channel(channelId)
    const guildId = ch?.guild_id
    const q = t.query
    const hit = (s: string | undefined) => !!s && s.toLowerCase().includes(q)
    if (t.kind === '@') {
        const ids = new Set<string>()
        if (guildId) {
            try {
                for (const m of S().GuildMemberStore?.getMembers?.(guildId) ?? []) ids.add(m.userId ?? m.user?.id)
            } catch {}
        } else for (const id of ch?.recipients ?? []) ids.add(id)
        const out: Suggestion[] = []
        for (const id of ids) {
            const u = user(id)
            if (!u) continue
            const name = displayName(u, guildId)
            if (!q || hit(name) || hit(u.username)) out.push({ key: id, label: name, sub: u.username, insert: `<@${id}>`, avatar: u.getAvatarURL?.(guildId, 48) })
            if (out.length >= 8) break
        }
        return out
    }
    if (t.kind === '#') {
        if (!guildId) return []
        const out: Suggestion[] = []
        try {
            const g = S().GuildChannelStore?.getChannels?.(guildId) ?? {}
            for (const e of [...(g.SELECTABLE ?? []), ...(g.VOCAL ?? [])]) {
                const c = e?.channel ?? e
                if (c && (!q || hit(c.name))) out.push({ key: c.id, label: `#${c.name}`, insert: `<#${c.id}>` })
                if (out.length >= 8) break
            }
        } catch {}
        return out
    }
    const out: Suggestion[] = []
    for (const g of guildEmojis())
        for (const e of g.emojis) {
            if (hit(e.name)) out.push({ key: e.id!, label: `:${e.name}:`, sub: g.name, insert: emojiText(e), emoji: e })
            if (out.length >= 8) return out
        }
    for (const cat of UNICODE_CATEGORIES)
        for (const e of unicodeEmojis(cat)) {
            if (hit(e.name)) out.push({ key: e.name, label: `:${e.name}:`, insert: e.surrogates!, emoji: e })
            if (out.length >= 8) return out
        }
    return out
}

/** 자동완성 하나를 고르면 입력 끝 낱말을 바꾼다 */
export function applySuggestion(text: string, s: Suggestion): string {
    const t = trigger(text)
    if (!t) return text
    return `${text.slice(0, t.start)}${s.insert} `
}
