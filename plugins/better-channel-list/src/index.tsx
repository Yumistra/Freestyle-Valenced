import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { bind, DEFAULTS, settings, update, useSettings } from './store'

/**
 * Better Channel List (BetterDiscord BetterChannelList 를 옮긴 것).
 * 서버 채널 목록의 채널 이름 아래에 마지막 메시지를 보여 준다.
 *  - 서버를 열면 게이트웨이에 채널마다 마지막 메시지를 달라고 한다 (requestLastMessages, 디스코드도 쓰는 것)
 *  - 받은 메시지(MESSAGE_PREVIEWS_LOADED)를 메시지 저장소에 넣는다 (원래 플러그인과 같은 방법)
 *  - 채널 줄(guild_sidebar/native/ChannelItem)의 subtitle 칸에 그린다
 * 원래 플러그인의 "새 모바일 디자인"은 폰 디스코드에 이미 있어서 뺐다.
 */

const S = () => Stores as any
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

// ── 마지막 메시지 받아 오기 ────────────────────────────────────────────────
function socket(): any {
    return S().GatewayConnectionStore?.getSocket?.() ?? find('getSocket')?.getSocket?.()
}

function selectable(guildId: string): string[] {
    try {
        const ids = S().GuildChannelStore?.getSelectableChannelIds?.(guildId) ?? find('getSelectableChannelIds')?.getSelectableChannelIds?.(guildId)
        return Array.isArray(ids) ? ids : []
    } catch {
        return []
    }
}

const asked = new Map<string, number>()
function request(guildId: string | null | undefined, channelIds?: string[], force = false) {
    if (!guildId || !settings().lastMessage) return
    // 같은 서버를 짧은 사이에 여러 번 묻지 않는다
    const last = asked.get(guildId) ?? 0
    if (!force && !channelIds && Date.now() - last < 60_000) return
    const ids = channelIds ?? selectable(guildId)
    if (!ids.length) return
    try {
        socket()?.requestLastMessages?.(guildId, ids)
        if (!channelIds) asked.set(guildId, Date.now())
    } catch {}
}

function onPreviews({ messages }: any) {
    if (!Array.isArray(messages)) return
    for (const m of messages) {
        try {
            if (!m?.channel_id || S().MessageStore?.getMessage?.(m.channel_id, m.id)) continue
            Dispatcher.dispatch({ type: 'LOAD_MESSAGES_SUCCESS', channelId: m.channel_id, hasMoreAfter: false, hasMoreBefore: true, isAfter: true, isBefore: false, isStale: true, limit: 1, messages: [m] } as any)
        } catch {}
    }
}

// ── 미리보기 글 만들기 ─────────────────────────────────────────────────────
function nameOf(userId: string, guildId?: string, fallback?: any) {
    try {
        const nick = guildId ? S().GuildMemberStore?.getNick?.(guildId, userId) : undefined
        const u = S().UserStore?.getUser?.(userId) ?? fallback
        return nick ?? u?.globalName ?? u?.global_name ?? u?.username ?? 'Someone'
    } catch {
        return 'Someone'
    }
}

function colorOf(userId: string, guildId?: string): string | undefined {
    try {
        return (guildId && S().GuildMemberStore?.getMember?.(guildId, userId)?.colorString) || undefined
    } catch {}
}

function plain(m: any, guildId?: string): string {
    let text = String(m?.content ?? '')
    text = text
        .replace(/<@!?(\d+)>/g, (_, id) => `@${nameOf(id, guildId)}`)
        .replace(/<@&(\d+)>/g, (_, id) => {
            try {
                const r = S().GuildRoleStore?.getRole?.(guildId, id) ?? S().GuildStore?.getGuild?.(guildId)?.roles?.[id]
                return `@${r?.name ?? 'role'}`
            } catch {
                return '@role'
            }
        })
        .replace(/<#(\d+)>/g, (_, id) => `#${S().ChannelStore?.getChannel?.(id)?.name ?? 'channel'}`)
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
        .replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toLocaleString())
        .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒')
        .replace(/[*_~`>#]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (text) return text
    const files = m?.attachments ?? []
    if (files.length) {
        const first = files[0]
        const kind = String(first?.content_type ?? first?.contentType ?? '')
        if (kind.startsWith('image/')) return files.length > 1 ? `${files.length} images` : 'Image'
        if (kind.startsWith('video/')) return 'Video'
        return first?.filename ?? 'Attachment'
    }
    const stickers = m?.stickerItems ?? m?.sticker_items ?? m?.stickers ?? []
    if (stickers.length) return `Sticker, ${stickers[0]?.name ?? ''}`.replace(/, $/, '')
    if ((m?.embeds ?? []).length) return m.embeds[0]?.title ?? m.embeds[0]?.rawTitle ?? 'Embed'
    if (m?.poll) return 'Poll'
    return ''
}

const SYSTEM: Record<number, string> = { 6: 'pinned a message', 7: 'joined the server', 8: 'boosted the server', 18: 'started a thread' }

function useLastMessage(channelId: string) {
    const read = () => {
        try {
            const list = S().MessageStore?.getMessages?.(channelId)
            return list?.last?.() ?? list?._array?.[list._array.length - 1]
        } catch {}
    }
    const [m, setM] = useState(read)
    useEffect(() => {
        const store = S().MessageStore
        const on = () => {
            const next = read()
            setM((prev: any) => (prev?.id === next?.id && prev?.content === next?.content ? prev : next))
        }
        store?.addChangeListener?.(on)
        on()
        return () => store?.removeChangeListener?.(on)
    }, [channelId])
    return m
}

function LastMessage({ channel }: { channel: any }) {
    const { Text } = Design as any
    const s = useSettings()
    const m = useLastMessage(channel.id)
    if (!m || !s.lastMessage) return null
    const guildId = channel.guild_id
    const authorId = m.author?.id
    let blocked = false
    try {
        blocked = !!authorId && !!S().RelationshipStore?.isBlocked?.(authorId)
    } catch {}
    if (blocked)
        return (
            <Text variant="text-sm/medium" color="text-muted" numberOfLines={1}>
                Blocked message
            </Text>
        )
    const system = SYSTEM[m.type]
    const body = system ?? plain(m, guildId)
    const name = authorId ? nameOf(authorId, guildId, m.author) : ''
    const color = s.roleColor && authorId ? colorOf(authorId, guildId) : undefined
    return (
        <Text variant="text-sm/medium" color="text-muted" numberOfLines={1}>
            {s.showAuthor && name ? (
                <Text variant="text-sm/semibold" color={color ? undefined : 'text-default'} style={color ? { color } : undefined}>
                    {system ? `${name} ` : `${name}: `}
                </Text>
            ) : null}
            {body}
        </Text>
    )
}

// ── 채널 줄 ───────────────────────────────────────────────────────────────
/** 글을 쓰는 채널 (텍스트, 공지, 스레드) */
const TEXTUAL = new Set([0, 5, 10, 11, 12])

function withLastMessage(props: any) {
    const ch = props?.channel
    if (!ch?.id || props?.subtitle || !settings().lastMessage || !TEXTUAL.has(ch.type)) return props
    return { ...props, subtitle: <LastMessage channel={ch} /> }
}

function SettingsPage() {
    const { Stack, TableRowGroup, TableSwitchRow } = Design as any
    const s = useSettings()
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Channel list">
                    <TableSwitchRow label="Last message" subLabel="Shows the most recent message under each channel" value={s.lastMessage} onValueChange={(lastMessage: boolean) => update({ lastMessage })} />
                    <TableSwitchRow label="Show author" subLabel="Shows who sent it before the message" value={s.showAuthor} onValueChange={(showAuthor: boolean) => update({ showAuthor })} />
                    <TableSwitchRow label="Role color" subLabel="Paints the author's name in their role color" value={s.roleColor} onValueChange={(roleColor: boolean) => update({ roleColor })} />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        const subs: Array<[string, (e: any) => void]> = [
            ['MESSAGE_PREVIEWS_LOADED', onPreviews],
            ['CHANNEL_SELECT', (e: any) => request(e?.guildId)],
            ['CHANNEL_UPDATES', (e: any) => e?.channels?.some?.((c: any) => c?.guild_id === S().SelectedGuildStore?.getGuildId?.()) && request(S().SelectedGuildStore?.getGuildId?.(), undefined, true)],
            ['GUILD_MEMBER_UPDATE', (e: any) => e?.user?.id === S().UserStore?.getCurrentUser?.()?.id && request(e?.guildId, undefined, true)],
            [
                'MESSAGE_DELETE',
                (e: any) => {
                    const g = S().ChannelStore?.getChannel?.(e?.channelId)?.guild_id
                    if (g && g === S().SelectedGuildStore?.getGuildId?.()) request(g, [e.channelId])
                },
            ],
        ]
        for (const [type, fn] of subs) {
            (Dispatcher as any).subscribe(type, fn)
            cleanup(() => (Dispatcher as any).unsubscribe(type, fn))
        }
        // 서버를 바꾸면 그 서버 채널들의 마지막 메시지를 받아 온다
        const guildStore = S().SelectedGuildStore
        const onGuild = () => request(guildStore?.getGuildId?.())
        guildStore?.addChangeListener?.(onGuild)
        cleanup(() => guildStore?.removeChangeListener?.(onGuild))
        onGuild()

        cleanup(
            getModuleWithImportedPath('modules/guild_sidebar/native/ChannelItem.tsx', (mod: any) => {
                const item = mod?.default
                if (!item) return
                const key = typeof item === 'function' ? 'default' : typeof item?.type === 'function' ? 'type' : undefined
                if (!key) return
                cleanup(
                    instead(key === 'default' ? mod : item, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            args = [withLastMessage(args[0]), ...args.slice(1)]
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
