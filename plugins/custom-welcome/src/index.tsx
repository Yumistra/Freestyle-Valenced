import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { bindSticker } from './grid'
import { bindPicker } from './picker'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings } from './store'

/**
 * Custom Welcome: "Wave to say hi!" 버튼이 보내는 것을 바꾼다.
 * 디스코드는 이 버튼에서 sendGreetMessage(채널, [스티커], { messageReference }) 를 부른다.
 * 이것을 가로채서 같은 메시지에 답장으로, 정한 메시지(GIF 링크 포함)와 스티커를 보낸다.
 */

let actions: any
/** 우리가 보내는 중 (마지막 스티커 기억에서 뺀다) */
let sending = false

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]

/** 인자들 속에서 채널 ID 와 답장할 메시지 정보를 찾는다 (디스코드 버전마다 모양이 조금 다르다) */
function contextOf(args: any[]) {
    const channelId = args.find(a => typeof a === 'string' && /^\d{17,20}$/.test(a))
    let ref: any
    for (const a of args) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) continue
        ref = a.messageReference ?? a.message_reference ?? (a.message_id ? a : undefined)
        if (ref) break
    }
    return { channelId: channelId as string | undefined, ref }
}

/** {mention}, {name}, {server}, {channel} 바꾸기 */
function fill(text: string, channelId: string, ref: any) {
    const S: any = Stores
    let user: any
    try {
        const m = ref?.message_id ? S.MessageStore?.getMessage?.(ref.channel_id ?? channelId, ref.message_id) : undefined
        user = m?.author
    } catch {}
    let server = ''
    let channel = ''
    try {
        const ch = S.ChannelStore?.getChannel?.(channelId)
        channel = ch?.name ? `#${ch.name}` : ''
        server = (ch?.guild_id && S.GuildStore?.getGuild?.(ch.guild_id)?.name) || ''
        // DM 의 손 흔들기처럼 답장할 메시지가 없으면 DM 상대를 부른다
        if (!user && ch && !ch.guild_id) {
            const me = S.UserStore?.getCurrentUser?.()?.id
            const id = ch.getRecipientId?.() ?? (ch.recipients ?? ch.recipient_ids ?? []).map((r: any) => (typeof r === 'string' ? r : r?.id)).find((r: string) => r && r !== me)
            if (id) user = S.UserStore?.getUser?.(id) ?? { id }
        }
    } catch {}
    const name = user?.globalName ?? user?.global_name ?? user?.username ?? 'there'
    return text
        .replace(/\{mention\}/gi, user?.id ? `<@${user.id}>` : name)
        .replace(/\{name\}/gi, name)
        .replace(/\{server\}/gi, server)
        .replace(/\{channel\}/gi, channel)
}

/** 디스코드의 "손 흔들기" 웨이브 스티커 (DM 첫 화면 버튼이 보내는 것) */
export const WAVE_STICKER = '749054660769218631'
function isWave(ids: any, options: any) {
    if (!Array.isArray(ids) || ids.length !== 1) return false
    return String(ids[0]) === WAVE_STICKER || /wave/i.test(String(options?.location ?? ''))
}

let sendability: any
let stickerStore: any
function stickers(): any {
    const S: any = Stores
    if (S.StickersStore?.getStickerById) return S.StickersStore
    try {
        stickerStore ??= (lookupModule(withProps('getStickerById', 'getStickerPack') as any) as any)?.[0]
    } catch {}
    return stickerStore
}
function hasNitro() {
    try {
        const u = (Stores as any).UserStore?.getCurrentUser?.()
        return !!u && u.premiumType != null && u.premiumType !== 0
    } catch {
        return false
    }
}
/**
 * 이 채널에서 이 스티커를 보낼 수 있는지.
 *  - 디스코드의 isSendableSticker 가 "못 보낸다"고 하면 못 보낸다
 *  - 그와 별도로, 니트로가 없으면 다른 서버 스티커는 못 보낸다 (DM 에서는 서버 스티커 전부)
 *  - 니트로가 없는데 스티커 정보를 못 찾으면 못 보낸다고 본다 (보냈다가 실패하는 것보다 낫다)
 */
function canSend(id: string, channelId: string): boolean {
    if (id === WAVE_STICKER) return true
    const S: any = Stores
    const sticker = stickers()?.getStickerById?.(id)
    const channel = S.ChannelStore?.getChannel?.(channelId)
    const user = S.UserStore?.getCurrentUser?.()
    try {
        sendability ??= (lookupModule(withProps('isSendableSticker') as any) as any)?.[0]
        if (sticker && channel && user && typeof sendability?.isSendableSticker === 'function' && !sendability.isSendableSticker(sticker, user, channel)) return false
    } catch {}
    if (hasNitro()) return true
    if (!sticker) return false
    const g = sticker.guild_id ?? sticker.guildId
    if (g == null) return true
    return channel?.guild_id != null && String(channel.guild_id) === String(g)
}
/**
 * 못 보내는 스티커를 이미지 링크로 (FakeNitro 처럼).
 * [𝅙](주소) 로 쓰면 (𝅙 는 거의 안 보이는 글자) 주소도 이름도 안 보이고 이미지만 뜬다.
 * 로티(움직이는 기본 스티커)는 이미지 주소가 없어서 못 바꾼다.
 */
function stickerLink(id: string): string | undefined {
    try {
        const st = stickers()?.getStickerById?.(id)
        const format = st?.format_type ?? st?.formatType
        if (format === 3) return
        const ext = format === 4 ? 'gif' : 'png'
        const name = String(st?.name ?? 'sticker').replace(/[\[\]()\\]/g, '') || 'sticker'
        return `[\u{1D159}](https://media.discordapp.net/stickers/${id}.${ext}?size=160&name=${encodeURIComponent(name)})`
    } catch {}
}

function send(channelId: string, ref: any): boolean {
    const s = settings()
    // DM (서버가 없는 채널): 디스코드 그대로 두거나, DM 용 것을 보낸다
    let isDM = false
    try {
        const ch = (Stores as any).ChannelStore?.getChannel?.(channelId)
        isDM = !!ch && !ch.guild_id
    } catch {}
    if (isDM && s.dm === 'wave') return false
    const own = isDM && s.dm === 'own'
    const messages = own ? s.dmMessages : s.messages
    const stickerList = own ? s.dmStickers : s.stickers
    const content = messages.length ? fill(pick(messages), channelId, ref) : ''
    const sticker = stickerList.length ? pick(stickerList) : undefined
    if (!content.trim() && !sticker) return false
    if (typeof actions?.sendMessage !== 'function') return false
    const options: any = {}
    if (ref?.message_id)
        options.messageReference = {
            channel_id: ref.channel_id ?? channelId,
            message_id: ref.message_id,
            ...(ref.guild_id ? { guild_id: ref.guild_id } : {}),
        }
    if (!s.ping) options.allowedMentions = { parse: ['users', 'roles', 'everyone'], replied_user: false }
    const msg = (text: string) => ({ content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] })
    sending = true
    try {
        // 하나만 (separate): 그때그때 글만, 또는 스티커만 무작위로
        const one = s.mode === 'separate' && content.trim() && sticker ? (Math.random() < 0.5 ? 'text' : 'sticker') : undefined
        let text = one === 'sticker' ? '' : content
        if (sticker && one !== 'text') {
            const link = s.stickerLinks && !canSend(sticker, channelId) ? stickerLink(sticker) : undefined
            if (link) text = text.trim() ? `${text}\n${link}` : link
            else options.stickerIds = [sticker]
        }
        actions.sendMessage(channelId, msg(text), undefined, options)
    } finally {
        sending = false
    }
    return true
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        bindPicker(cleanup)
        bindSticker(cleanup)
        const greet = function (this: unknown, args: any[], orig: (...a: any[]) => any) {
            try {
                if (settings().enabled) {
                    const { channelId, ref } = contextOf(args)
                    if (channelId && send(channelId, ref)) return Promise.resolve()
                }
            } catch {}
            return orig.apply(this, args)
        }
        const done = new WeakSet<object>()
        const waved = new WeakSet<object>()
        cleanup(
            getModules(withProps('sendGreetMessage') as any, (mod: any) => {
                if (typeof mod?.sendGreetMessage !== 'function' || done.has(mod)) return
                done.add(mod)
                cleanup(instead(mod, 'sendGreetMessage', greet))
            }) as any,
            // DM 첫 화면의 "손 흔들기" 버튼은 sendGreetMessage 가 아니라 웨이브 스티커를 sendStickers 로 보낸다
            getModules(withProps('sendStickers', 'sendMessage') as any, (mod: any) => {
                if (typeof mod?.sendStickers !== 'function' || waved.has(mod)) return
                waved.add(mod)
                if (typeof mod.sendMessage === 'function' && !actions) actions = mod
                cleanup(
                    instead(mod, 'sendStickers', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            const [channelId, ids, , options] = args
                            if (settings().enabled && typeof channelId === 'string' && isWave(ids, options) && send(channelId, undefined)) return Promise.resolve()
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
            // 보내는 함수는 찾아 두기만 한다 (보낼 때마다 끼어들지 않는다)
            getModules(withProps('sendMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.sendMessage === 'function' && !actions) actions = mod
            }, { max: 1 } as any) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
