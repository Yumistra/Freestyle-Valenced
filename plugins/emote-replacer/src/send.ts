import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { allEmotes } from './emotes'
import { settings } from './store'

/**
 * 보낼 때 바꾸기.
 *  - ;이름 → 이모트 이미지
 *  - 니트로 없이 못 쓰는 디스코드 이모지 <:이름:ID> → 이모지 이미지
 *  - 니트로 없이 못 보내는 스티커 → 스티커 이미지
 * 이미지는 [𝅙](주소) 로 보낸다. 𝅙 는 거의 안 보이는 글자라 주소도 글자도 안 보이고 이미지만 뜬다.
 */

const S = () => Stores as any
const HIDDEN = '\u{1D159}'
const link = (url: string) => `[${HIDDEN}](${url})`
const esc = (s: string) => s.replace(/[-\\/^$*+?.()|[\]{}]/g, '\\$&')

export function hasNitro() {
    try {
        const u = S().UserStore?.getCurrentUser?.()
        return !!u && u.premiumType != null && u.premiumType !== 0
    } catch {
        return false
    }
}

function guildOf(channelId: string): string | undefined {
    try {
        const g = S().ChannelStore?.getChannel?.(channelId)?.guild_id
        return g == null ? undefined : String(g)
    } catch {}
}

/** 코드 블록, 인라인 코드 밖에서만 바꾼다 */
function outsideCode(text: string, fn: (part: string) => string) {
    return text
        .split(/(```[\s\S]*?```|`[^`\n]*`)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join('')
}

/** 내가 들어가 있는 모든 서버의 커스텀 이모지 (이름 → 이모지 목록) */
export function discordEmojis(channelId?: string): Map<string, any[]> {
    const out = new Map<string, any[]>()
    const push = (e: any) => {
        if (!e?.id || !e?.name) return
        const list = out.get(e.name) ?? []
        if (!list.some(x => x.id === e.id)) list.push(e)
        out.set(e.name, list)
    }
    const eat = (v: any) => {
        if (!v) return
        const vals = v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : Object.values(v)
        for (const x of vals) {
            if (Array.isArray(x)) x.forEach(push)
            else if (x && Array.isArray(x.emojis)) x.emojis.forEach(push)
            else if (x && typeof x.getEmojis === 'function') x.getEmojis().forEach?.(push)
            else push(x)
        }
    }
    try {
        const store = S().EmojiStore
        const ctx = store?.getDisambiguatedEmojiContext?.(channelId ? guildOf(channelId) : undefined)
        eat(ctx?.getGroupedCustomEmoji?.())
        if (!out.size) eat(store?.getGuilds?.())
    } catch {}
    return out
}

/** 이 채널에서 니트로 없이 쓸 수 있는 이모지인지 */
function usable(e: any, here: string | undefined) {
    if (e?.available === false) return false
    if (hasNitro()) return true
    const g = e?.guildId ?? e?.guild_id
    return !e?.animated && g != null && String(g) === here
}

const emojiUrl = (e: any) =>
    `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'webp'}?size=${settings().emoteSize}&quality=lossless&name=${encodeURIComponent(e.name)}`

/** 디스코드 이모지를 이 채널에 맞게: 쓸 수 있으면 진짜 이모지, 아니면 이미지 */
function emojiOut(list: any[], here: string | undefined): string {
    const ok = list.find(e => usable(e, here))
    if (ok) return `<${ok.animated ? 'a' : ''}:${ok.name}:${ok.id}>`
    return link(emojiUrl(list[0]))
}

function replaceNamed(text: string, channelId: string): { text: string; count: number } {
    const s = settings()
    const emotes = allEmotes()
    const lower: Record<string, string> = {}
    for (const k of Object.keys(emotes)) lower[k.toLowerCase()] ??= k
    const here = guildOf(channelId)
    let discord: Map<string, any[]> | undefined
    const discordLower = new Map<string, string>()
    const discordFind = (name: string) => {
        if (!discord) {
            discord = discordEmojis(channelId)
            for (const k of discord.keys()) if (!discordLower.has(k.toLowerCase())) discordLower.set(k.toLowerCase(), k)
        }
        return discord.get(name) ?? discord.get(discordLower.get(name.toLowerCase()) ?? '')
    }
    // 순서: 내 이모트, 같은 이름의 디스코드 이모지, Yentis 이모트 (대소문자까지 같은 것 먼저)
    const resolve = (name: string): string | undefined => {
        if (s.customEmotes[name]) return link(s.customEmotes[name])
        const exact = discordFind(name)
        if (exact?.length && exact[0].name === name) return emojiOut(exact, here)
        if (emotes[name]) return link(emotes[name])
        if (exact?.length) return emojiOut(exact, here)
        const k = lower[name.toLowerCase()]
        return k ? link(emotes[k]) : undefined
    }
    let count = 0
    const prefix = s.prefix || ''
    const re = s.requirePrefix && prefix ? new RegExp(`(^|[^\\w/:])${esc(prefix)}([\\w~-]{2,})`, 'g') : /(^|[^\w/:<])([\w~-]{2,})(?![\w:>])/g
    let out = outsideCode(text, part =>
        part.replace(re, (all, before: string, name: string) => {
            const r = resolve(name)
            if (!r) return all
            count++
            return before + r
        }),
    )
    // :이름: 으로 쓴 것 중 디스코드가 못 바꾼 (니트로가 없어 잠긴) 이모지
    if (s.lockedEmojis)
        out = outsideCode(out, part =>
            part.replace(/(^|[^\w<])(:([\w~-]{2,}):)(?!\d)/g, (all, before: string, _w: string, name: string) => {
                const list = discordFind(name)
                if (!list?.length) return all
                count++
                return before + emojiOut(list, here)
            }),
        )
    return { text: out, count }
}

function emojiGuild(id: string): string | undefined {
    try {
        const e = S().EmojiStore?.getCustomEmojiById?.(id)
        const g = e?.guildId ?? e?.guild_id
        return g == null ? undefined : String(g)
    } catch {}
}

function replaceLockedEmojis(text: string, channelId: string): { text: string; count: number } {
    if (!settings().lockedEmojis || hasNitro()) return { text, count: 0 }
    const here = guildOf(channelId)
    const size = settings().emoteSize
    let count = 0
    const out = outsideCode(text, part =>
        part.replace(/<(a?):(\w+):(\d+)>/g, (all, animated: string, name: string, id: string) => {
            const g = emojiGuild(id)
            const usable = !animated && g != null && g === here
            if (usable) return all
            count++
            return link(`https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=${size}&quality=lossless&name=${encodeURIComponent(name)}`)
        }),
    )
    return { text: out, count }
}

let sendability: any
function stickerStore(): any {
    if (S().StickersStore?.getStickerById) return S().StickersStore
    try {
        return (lookupModule(withProps('getStickerById', 'getStickerPack') as any) as any)?.[0]
    } catch {}
}
function stickerLocked(id: string, channelId: string): any {
    const sticker = stickerStore()?.getStickerById?.(id)
    const channel = S().ChannelStore?.getChannel?.(channelId)
    const user = S().UserStore?.getCurrentUser?.()
    try {
        sendability ??= (lookupModule(withProps('isSendableSticker') as any) as any)?.[0]
        if (sticker && channel && user && typeof sendability?.isSendableSticker === 'function' && !sendability.isSendableSticker(sticker, user, channel)) return sticker
    } catch {}
    if (hasNitro() || !sticker) return
    const g = sticker.guild_id ?? sticker.guildId
    if (g != null && String(g) !== guildOf(channelId)) return sticker
}
function stickerUrl(st: any): string | undefined {
    const format = st?.format_type ?? st?.formatType
    // 로티(움직이는 기본 스티커)는 이미지 주소가 없다
    if (format === 3) return
    const size = Math.max(160, settings().emoteSize)
    return `https://media.discordapp.net/stickers/${st.id}.${format === 4 ? 'gif' : 'png'}?size=${size}&name=${encodeURIComponent(String(st.name ?? 'sticker'))}`
}

/** sendMessage(channelId, message, _, options) 의 인자를 바꿔서 돌려준다 */
export function rewrite(args: any[]): any[] {
    const [channelId, message, third, options] = args
    if (typeof channelId !== 'string' || !message || typeof message.content !== 'string') return args
    let text = message.content
    let changed = false

    const named = replaceNamed(text, channelId)
    const locked = replaceLockedEmojis(named.text, channelId)
    if (named.count || locked.count) {
        text = locked.text
        changed = true
    }

    let opts = options
    const ids: string[] = Array.isArray(options?.stickerIds) ? options.stickerIds : []
    if (settings().lockedStickers && ids.length) {
        const keep: string[] = []
        const links: string[] = []
        for (const id of ids) {
            const st = stickerLocked(String(id), channelId)
            const url = st ? stickerUrl(st) : undefined
            if (url) links.push(link(url))
            else keep.push(id)
        }
        if (links.length) {
            text = [text.trim(), ...links].filter(Boolean).join('\n')
            opts = { ...options, stickerIds: keep.length ? keep : undefined }
            changed = true
        }
    }

    if (!changed) return args
    const next = { ...message, content: text, invalidEmojis: [] }
    return [channelId, next, third, opts, ...args.slice(4)]
}
