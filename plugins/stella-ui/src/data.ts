import { ToastActionCreators } from '@valenced/discord/actions'
import { Dispatcher } from '@valenced/discord/common/flux'
import { Stores } from '@valenced/discord/flux'
import { RootNavigationRef } from '@valenced/discord/modules/main_tabs_v2'
import { lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'

/**
 * 디스코드에서 읽고 쓰는 것들. 화면은 이 파일의 함수만 쓴다.
 * 디스코드가 바뀌어 무언가 없어도 오류 대신 빈 값을 준다.
 */

export const S = () => Stores as any

// ── 모듈 찾기 (한 번 찾으면 기억) ───────────────────────────────────────
const found = new Map<string, any>()
export function find(...props: string[]): any {
    const key = props.join(',')
    if (found.has(key)) return found.get(key)
    let mod: any
    try {
        mod = (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
    if (mod) found.set(key, mod)
    return mod
}
export const forgetModules = () => found.clear()

// ── 스토어 구독 ─────────────────────────────────────────────────────────
/**
 * 스토어가 바뀌면 read 를 다시 부르고, 결과가 달라졌을 때만 다시 그린다.
 * same 으로 같음을 판단한다 (기본은 ===).
 */
export function useStores<T>(names: string[], read: () => T, deps: unknown[] = [], same: (a: T, b: T) => boolean = Object.is): T {
    const [value, setValue] = useState(read)
    const last = useRef(value)
    last.current = value
    useEffect(() => {
        const update = () => {
            let next: T
            try {
                next = read()
            } catch {
                return
            }
            if (!same(last.current, next)) {
                last.current = next
                setValue(() => next)
            }
        }
        const stores = names.map(n => S()[n]).filter(Boolean)
        stores.forEach(s => s.addChangeListener?.(update))
        update()
        return () => stores.forEach(s => s.removeChangeListener?.(update))
    }, deps)
    return value
}

/** 배열을 칸마다 비교한다 */
export const sameList = <L extends readonly unknown[]>(a: L, b: L) => a === b || (a.length === b.length && a.every((v, i) => Object.is(v, b[i])))

// ── 사람, 서버, 채널 ────────────────────────────────────────────────────
export const me = () => S().UserStore?.getCurrentUser?.()
export const user = (id: string | undefined) => (id ? S().UserStore?.getUser?.(id) : undefined)
export const channel = (id: string | undefined) => (id ? S().ChannelStore?.getChannel?.(id) : undefined)
export const guild = (id: string | undefined) => (id ? S().GuildStore?.getGuild?.(id) : undefined)

const CDN = 'https://cdn.discordapp.com'

export function avatarUrl(u: any, size = 128, guildId?: string): string | undefined {
    if (!u) return
    try {
        const url = u.getAvatarURL?.(guildId, size, false)
        if (typeof url === 'string') return url
    } catch {}
    if (u.avatar) return `${CDN}/avatars/${u.id}/${u.avatar}.png?size=${size}`
    const n = (() => {
        try {
            return Number((BigInt(u.id) >> BigInt(22)) % BigInt(6))
        } catch {
            return 0
        }
    })()
    return `${CDN}/embed/avatars/${n}.png`
}

export function guildIconUrl(g: any, size = 128): string | undefined {
    if (!g?.icon) return
    try {
        const url = g.getIconURL?.(size, false)
        if (typeof url === 'string') return url
    } catch {}
    return `${CDN}/icons/${g.id}/${g.icon}.png?size=${size}`
}

export function guildBannerUrl(g: any, size = 512): string | undefined {
    const hash = g?.banner ?? g?.splash ?? g?.discoverySplash
    if (!hash) return
    const kind = g?.banner ? 'banners' : g?.splash ? 'splashes' : 'discovery-splashes'
    return `${CDN}/${kind}/${g.id}/${hash}.png?size=${size}`
}

export function emojiUrl(id: string, animated: boolean, size = 48) {
    return `${CDN}/emojis/${id}.${animated ? 'gif' : 'webp'}?size=${size}`
}

/** 이름 (서버 별명, 표시 이름, 아이디 순) */
export function displayName(u: any, guildId?: string): string {
    if (!u) return '?'
    const nick = guildId ? S().GuildMemberStore?.getNick?.(guildId, u.id) : undefined
    return nick || u.globalName || u.global_name || u.username || '?'
}

export function roleColor(guildId: string | undefined, userId: string | undefined): string | undefined {
    if (!guildId || !userId) return
    const c = S().GuildMemberStore?.getMember?.(guildId, userId)?.colorString
    return typeof c === 'string' && c ? c : undefined
}

/** DM 이름 */
export function dmName(ch: any): string {
    if (!ch) return '?'
    if (ch.name) return ch.name
    const ids: string[] = ch.recipients ?? ch.rawRecipients?.map((r: any) => r.id) ?? []
    const names = ids.map(id => displayName(user(id))).filter(n => n !== '?')
    return names.join(', ') || '?'
}

export function dmAvatar(ch: any): string | undefined {
    if (!ch) return
    if (ch.icon) return `${CDN}/channel-icons/${ch.id}/${ch.icon}.png?size=128`
    const id = ch.recipients?.[0] ?? ch.rawRecipients?.[0]?.id
    return avatarUrl(user(id))
}

// ── 안 읽음 ─────────────────────────────────────────────────────────────
export function unread(channelId: string): { unread: boolean; mentions: number } {
    const rs = S().ReadStateStore
    let mentions = 0
    let has = false
    try {
        mentions = Number(rs?.getMentionCount?.(channelId) ?? 0) || 0
        has = !!rs?.hasUnread?.(channelId)
    } catch {}
    return { unread: has || mentions > 0, mentions }
}

export function guildUnread(guildId: string): { unread: boolean; mentions: number } {
    try {
        const gs = S().GuildReadStateStore
        const mentions = Number(gs?.getMentionCount?.(guildId) ?? 0) || 0
        const has = !!gs?.hasUnread?.(guildId)
        return { unread: has || mentions > 0, mentions }
    } catch {
        return { unread: false, mentions: 0 }
    }
}

/** 표시용 숫자 (100 이상은 99+) */
export const count = (n: number) => (n > 99 ? '99+' : String(n))

// ── 목록 ────────────────────────────────────────────────────────────────
/** 최근 대화 순 DM 채널 ID */
export function dmIds(): string[] {
    const s = S()
    try {
        const ids = s.PrivateChannelSortStore?.getPrivateChannelIds?.()
        if (Array.isArray(ids)) return ids
    } catch {}
    try {
        const list = s.ChannelStore?.getSortedPrivateChannels?.()
        if (Array.isArray(list)) return list.map((c: any) => c.id)
    } catch {}
    return []
}

/** 서버 목록에 보이는 순서대로 서버 ID */
export function guildIds(): string[] {
    const s = S()
    try {
        const ids = s.SortedGuildStore?.getFlattenedGuildIds?.()
        if (Array.isArray(ids) && ids.length) return ids
    } catch {}
    try {
        const folders = s.SortedGuildStore?.getGuildFolders?.()
        if (Array.isArray(folders) && folders.length) return folders.flatMap((f: any) => f.guildIds ?? [])
    } catch {}
    try {
        return Object.keys(s.GuildStore?.getGuilds?.() ?? {})
    } catch {
        return []
    }
}

export const VOICELIKE = new Set([2, 13])

export interface Section {
    id: string
    name: string
    channels: any[]
}

/** 서버의 채널을 카테고리별로 (볼 수 있는 것만, 디스코드 순서대로) */
export function guildSections(guildId: string): Section[] {
    const s = S()
    let all: any[] = []
    try {
        const g = s.GuildChannelStore?.getChannels?.(guildId) ?? {}
        all = [...(g.SELECTABLE ?? []), ...(g.VOCAL ?? [])].map((e: any) => e?.channel ?? e).filter(Boolean)
    } catch {}
    const byParent = new Map<string, any[]>()
    for (const ch of all) {
        const key = ch.parent_id ?? ''
        if (!byParent.has(key)) byParent.set(key, [])
        byParent.get(key)!.push(ch)
    }
    const pos = (c: any) => (VOICELIKE.has(c.type) ? 10000 : 0) + (c.position ?? 0)
    const sections: Section[] = []
    for (const [parent, list] of byParent) {
        list.sort((a, b) => pos(a) - pos(b))
        const cat = parent ? channel(parent) : undefined
        sections.push({ id: parent || 'none', name: cat?.name ?? '', channels: list })
    }
    sections.sort((a, b) => (a.id === 'none' ? -1 : b.id === 'none' ? 1 : (channel(a.id)?.position ?? 0) - (channel(b.id)?.position ?? 0)))
    return sections
}

/** 음성 채널에 있는 사람 수 */
export function voiceCount(channelId: string): number {
    try {
        const states = S().VoiceStateStore?.getVoiceStatesForChannel?.(channelId)
        return states ? Object.keys(states).length : 0
    } catch {
        return 0
    }
}

export function relationships(): { incoming: string[]; friends: string[] } {
    const incoming: string[] = []
    const friends: string[] = []
    try {
        const map = S().RelationshipStore?.getRelationships?.() ?? {}
        for (const [id, type] of Object.entries<any>(map)) {
            const t = typeof type === 'object' ? type?.type : type
            if (t === 3) incoming.push(id)
            else if (t === 1) friends.push(id)
        }
    } catch {}
    return { incoming, friends }
}

export function onlineFriends(): number {
    const ps = S().PresenceStore
    return relationships().friends.filter(id => {
        const st = ps?.getStatus?.(id)
        return st && st !== 'offline' && st !== 'invisible'
    }).length
}

// ── 메시지 ──────────────────────────────────────────────────────────────
/** 채널의 메시지 묶음 (디스코드가 바뀔 때마다 새 객체를 준다) */
export const messagesOf = (channelId: string) => S().MessageStore?.getMessages?.(channelId)

export function messageArray(list: any): any[] {
    if (!list) return []
    if (Array.isArray(list._array)) return list._array
    try {
        const a = list.toArray?.()
        if (Array.isArray(a)) return a
    } catch {}
    return []
}

export function lastMessage(channelId: string): any {
    const a = messageArray(messagesOf(channelId))
    return a[a.length - 1]
}

const loading = new Set<string>()
/** 메시지를 받아 온다 (이미 받았으면 안 한다) */
export function loadMessages(channelId: string, before?: string) {
    const key = `${channelId}|${before ?? ''}`
    if (loading.has(key)) return
    const list = messagesOf(channelId)
    if (!before && list && (list.ready || list.loadingMore || list.hasFetched) && messageArray(list).length) return
    const actions = find('fetchMessages', 'sendMessage') ?? find('fetchMessages')
    if (typeof actions?.fetchMessages !== 'function') return
    loading.add(key)
    try {
        Promise.resolve(actions.fetchMessages({ channelId, limit: 50, ...(before ? { before } : {}) }))
            .catch(() => {})
            .then(() => loading.delete(key))
    } catch {
        loading.delete(key)
    }
}

export function sendMessage(channelId: string, text: string): boolean {
    const content = text.trim()
    if (!content) return false
    const actions = find('sendMessage', 'receiveMessage') ?? find('sendMessage', 'deleteMessage')
    if (typeof actions?.sendMessage !== 'function') return false
    try {
        actions.sendMessage(channelId, { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, {})
        return true
    } catch {
        return false
    }
}

/** 읽음으로 표시 */
export function ack(channelId: string) {
    try {
        const rs = S().ReadStateStore
        if (!rs?.hasUnread?.(channelId) && !rs?.getMentionCount?.(channelId)) return
        const last = rs?.lastMessageId?.(channelId) ?? channel(channelId)?.lastMessageId ?? channel(channelId)?.last_message_id
        if (last) (Dispatcher as any).dispatch({ type: 'BULK_ACK', context: 'APP', channels: [{ channelId, messageId: last, readStateType: 0 }] })
    } catch {}
}

/** 메시지 한 개를 한 줄 미리보기로 */
export function previewText(m: any, guildId?: string): string {
    if (!m) return ''
    const text = plainText(m.content ?? '', guildId)
    if (text) return text
    if (m.attachments?.length) return '[파일]'
    if (m.stickerItems?.length || m.sticker_items?.length) return '[스티커]'
    if (m.embeds?.length) return m.embeds[0]?.rawTitle ?? m.embeds[0]?.title ?? '[임베드]'
    return ''
}

// ── 메시지 글 ───────────────────────────────────────────────────────────
export type Piece = { t: 'text'; v: string } | { t: 'mention'; v: string } | { t: 'emoji'; id: string; name: string; animated: boolean } | { t: 'link'; v: string }

const TOKEN = /<(@!?|@&|#)(\d+)>|<(a?):(\w+):(\d+)>|(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g

/** 메시지 글을 조각으로 나눈다 (멘션, 커스텀 이모지, 링크) */
export function parseContent(content: string, guildId?: string): Piece[] {
    const out: Piece[] = []
    let last = 0
    TOKEN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TOKEN.exec(content))) {
        const i = m.index
        if (i > last) out.push({ t: 'text', v: content.slice(last, i) })
        if (m[1]) {
            const id = m[2]
            const kind = m[1]
            if (kind === '#') out.push({ t: 'mention', v: `#${channel(id)?.name ?? '채널'}` })
            else if (kind === '@&') out.push({ t: 'mention', v: `@${(guildId && S().GuildRoleStore?.getRole?.(guildId, id)?.name) || S().GuildStore?.getRole?.(guildId, id)?.name || '역할'}` })
            else out.push({ t: 'mention', v: `@${displayName(user(id), guildId)}` })
        } else if (m[5]) out.push({ t: 'emoji', id: m[5], name: m[4], animated: m[3] === 'a' })
        else if (m[6]) out.push({ t: 'link', v: m[6] })
        last = i + m[0].length
    }
    if (last < content.length) out.push({ t: 'text', v: content.slice(last) })
    return out
}

/** 꾸밈 없이 글만 */
export function plainText(content: string, guildId?: string): string {
    return parseContent(content, guildId)
        .map(p => (p.t === 'emoji' ? `:${p.name}:` : p.v))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
}

// ── 디스코드 화면으로 가기 ──────────────────────────────────────────────
function rootNav(): any {
    try {
        const ref = (RootNavigationRef as any)?.getRootNavigationRef?.()
        return ref?.isReady?.() === false ? undefined : ref
    } catch {}
}

/** 디스코드 원래 화면 열기. 성공하면 true */
export function openNative(where: 'notifications' | 'friends' | 'shop' | 'quests' | 'settings'): boolean {
    try {
        switch (where) {
            case 'shop': {
                const m = find('openCollectiblesShopMobile')
                if (typeof m?.openCollectiblesShopMobile === 'function') return m.openCollectiblesShopMobile({ analyticsSource: { page: 'Stella UI' } }), true
                break
            }
            case 'quests': {
                const m = find('openQuestHome')
                if (typeof m?.openQuestHome === 'function') return m.openQuestHome({}), true
                break
            }
            case 'settings': {
                const m = find('openUserSettings')
                if (typeof m?.openUserSettings === 'function') return m.openUserSettings(), true
                break
            }
        }
        const nav = rootNav()
        if (typeof nav?.navigate !== 'function') return false
        nav.navigate(where === 'settings' ? 'settings' : where)
        return where === 'notifications' || where === 'friends' || where === 'settings'
    } catch {
        return false
    }
}

/** 디스코드에서 채널 열기 (포럼, 스레드 등 이 화면에서 못 보여 주는 것) */
export function openChannelNative(ch: any): boolean {
    try {
        const r = find('transitionToGuild')
        if (typeof r?.transitionToGuild === 'function') {
            r.transitionToGuild(ch.guild_id, ch.id)
            return true
        }
    } catch {}
    return false
}

export function joinVoice(channelId: string): boolean {
    try {
        const m = find('selectVoiceChannel')
        if (typeof m?.selectVoiceChannel !== 'function') return false
        m.selectVoiceChannel(channelId)
        return true
    } catch {
        return false
    }
}

export function acceptRequest(userId: string): boolean {
    try {
        const m = find('acceptFriendRequest', 'addRelationship')
        if (typeof m?.acceptFriendRequest !== 'function') return false
        m.acceptFriendRequest({ userId, context: { location: 'Stella UI' } })
        return true
    } catch {
        return false
    }
}

export function declineRequest(userId: string): boolean {
    try {
        const m = find('cancelFriendRequest', 'addRelationship') ?? find('removeRelationship', 'addRelationship')
        const f = m?.cancelFriendRequest ?? m?.removeRelationship
        if (typeof f !== 'function') return false
        f.call(m, userId, { location: 'Stella UI' })
        return true
    } catch {
        return false
    }
}

/** 친구와의 DM 채널 ID (없으면 만든다) */
export async function dmWith(userId: string): Promise<string | undefined> {
    try {
        const id = S().ChannelStore?.getDMFromUserId?.(userId)
        if (id) return id
        const m = find('getOrEnsurePrivateChannel') ?? find('ensurePrivateChannel')
        const f = m?.getOrEnsurePrivateChannel ?? m?.ensurePrivateChannel
        if (typeof f !== 'function') return
        const out = await f.call(m, userId)
        return typeof out === 'string' ? out : out?.id
    } catch {}
}

// ── 마이크, 헤드셋 ──────────────────────────────────────────────────────
export function voiceSelf() {
    const me = S().MediaEngineStore
    return { mute: !!me?.isSelfMute?.(), deaf: !!me?.isSelfDeaf?.() }
}
export function toggleVoice(kind: 'mute' | 'deaf') {
    try {
        const m = find('toggleSelfMute', 'toggleSelfDeaf')
        if (kind === 'mute') m?.toggleSelfMute?.()
        else m?.toggleSelfDeaf?.()
    } catch {}
}

// ── 알림 ────────────────────────────────────────────────────────────────
let toastSeq = 0
export function toast(text: string) {
    try {
        ;(ToastActionCreators as any).open(`stella-ui-${Date.now()}-${toastSeq++}`, { text })
    } catch {}
}

// ── 그림 고르기 (디스코드의 사진 고르기 창) ─────────────────────────────
/** 고른 그림 주소. 취소하거나 못 열면 undefined */
export async function pickImage(): Promise<string | undefined> {
    try {
        const mod: any = lookupModuleWithImportedPath('modules/image/native/ImagePicker.tsx')
        const picker = mod?.default ?? mod
        if (typeof picker?.launchImageLibraryAsync !== 'function') return
        const res: any = await picker.launchImageLibraryAsync({ mediaType: 'photo', selectionLimit: 1 })
        if (!res || res.didCancel || res.cancelled || res.canceled) return
        const uri = res.assets?.[0]?.uri ?? res.uri ?? res.path ?? (Array.isArray(res) ? res[0]?.uri : undefined)
        return typeof uri === 'string' && uri ? uri : undefined
    } catch {}
}
