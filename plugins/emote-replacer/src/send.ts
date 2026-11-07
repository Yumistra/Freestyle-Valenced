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

function replaceNamed(text: string): { text: string; count: number } {
    const s = settings()
    const emotes = allEmotes()
    const lower: Record<string, string> = {}
    for (const k of Object.keys(emotes)) lower[k.toLowerCase()] ??= k
    const find = (name: string) => emotes[name] ?? emotes[lower[name.toLowerCase()] ?? '']
    let count = 0
    const prefix = s.prefix || ''
    const re = s.requirePrefix && prefix ? new RegExp(`(^|[^\\w/:])${esc(prefix)}([\\w-]{2,})`, 'g') : /(^|[^\w/:<])([\w-]{2,})(?![\w:>])/g
    const out = outsideCode(text, part =>
        part.replace(re, (all, before: string, name: string) => {
            const url = find(name)
            if (!url) return all
            count++
            return before + link(url)
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

    const named = replaceNamed(text)
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
