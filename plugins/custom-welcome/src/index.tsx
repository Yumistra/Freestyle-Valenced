import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { bindPicker } from './picker'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings, update } from './store'

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
    } catch {}
    const name = user?.globalName ?? user?.global_name ?? user?.username ?? 'there'
    return text
        .replace(/\{mention\}/gi, user?.id ? `<@${user.id}>` : name)
        .replace(/\{name\}/gi, name)
        .replace(/\{server\}/gi, server)
        .replace(/\{channel\}/gi, channel)
}

function send(channelId: string, ref: any): boolean {
    const s = settings()
    const content = s.messages.length ? fill(pick(s.messages), channelId, ref) : ''
    const sticker = s.stickers.length ? pick(s.stickers) : undefined
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
    if (sticker) options.stickerIds = [sticker]
    sending = true
    try {
        actions.sendMessage(channelId, { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, options)
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
        cleanup(
            getModules(withProps('sendGreetMessage') as any, (mod: any) => {
                if (typeof mod?.sendGreetMessage !== 'function' || done.has(mod)) return
                done.add(mod)
                cleanup(instead(mod, 'sendGreetMessage', greet))
            }) as any,
            getModules(withProps('sendMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.sendMessage !== 'function' || actions) return
                actions = mod
                // 마지막으로 보낸 스티커를 기억해 둔다 (설정에서 한 번에 추가)
                cleanup(
                    after(mod, 'sendMessage', (args: any[]) => {
                        try {
                            if (sending) return
                            const id = args?.[3]?.stickerIds?.[0]
                            if (id && String(id) !== settings().lastSticker) update({ lastSticker: String(id) })
                        } catch {}
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
