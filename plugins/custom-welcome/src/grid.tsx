import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useState } from 'react'
import { Image, LayoutAnimation, Pressable, View } from 'react-native'

/**
 * 내가 들어가 있는 서버들의 스티커, 이모지를 서버별로 보여 주는 고르기 칸.
 * 디스코드 고르기 창(채팅 입력창)은 버전에 따라 밖에서 열 수 없을 때가 있어서 직접 그린다.
 * 서버 이름을 누르면 그 서버 것만 펼친다 (한꺼번에 그리면 무겁다).
 */

export interface Sticker {
    id: string
    name: string
    format_type?: number
}
export interface Emoji {
    id: string
    name: string
    animated?: boolean
}

export const stickerImage = (s: { id: string; format_type?: number }) =>
    // 1 PNG, 2 APNG, 3 Lottie(그림 주소 없음), 4 GIF
    s.format_type === 4 ? `https://media.discordapp.net/stickers/${s.id}.gif?size=160` : `https://media.discordapp.net/stickers/${s.id}.png?size=160`
export const emojiImage = (e: Emoji) => `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=64`

function guildName(id: string) {
    try {
        return String((Stores as any).GuildStore?.getGuild?.(id)?.name ?? '') || 'Server'
    } catch {
        return 'Server'
    }
}
function guildIcon(id: string) {
    try {
        const g = (Stores as any).GuildStore?.getGuild?.(id)
        return g?.icon ? `https://cdn.discordapp.com/icons/${id}/${g.icon}.png?size=64` : undefined
    } catch {}
}

/** 서버 ID → 스티커들 */
function stickerGroups(): Array<[string, Sticker[]]> {
    try {
        const all = (Stores as any).StickersStore?.getAllGuildStickers?.()
        const out: Array<[string, Sticker[]]> = []
        if (all instanceof Map) {
            for (const [g, list] of all) if (Array.isArray(list) && list.length) out.push([String(g), list])
        } else if (all && typeof all === 'object') {
            for (const g of Object.keys(all)) if (all[g]?.length) out.push([g, all[g]])
        }
        return out
    } catch {
        return []
    }
}

/** 서버 ID → 이모지들 */
function emojiGroups(): Array<[string, Emoji[]]> {
    const S: any = Stores
    const out: Array<[string, Emoji[]]> = []
    try {
        const guilds = S.GuildStore?.getGuilds?.() ?? {}
        for (const id of Object.keys(guilds)) {
            const list = S.EmojiStore?.getGuildEmoji?.(id) ?? S.EmojiStore?.getGuildEmojis?.(id)
            if (Array.isArray(list) && list.length) out.push([id, list])
        }
    } catch {}
    return out
}

export function ExpressionGrid({ kind, onPick, chosen }: { kind: 'sticker' | 'emoji'; onPick(x: any): void; chosen?: string[] }) {
    const { Text, TextInput } = Design as any
    const [open, setOpen] = useState<string | undefined>()
    const [q, setQ] = useState('')
    const groups: Array<[string, any[]]> = kind === 'sticker' ? stickerGroups() : emojiGroups()
    const size = kind === 'sticker' ? 72 : 40
    const ql = q.trim().toLowerCase()
    const shown = ql ? groups.map(([g, list]) => [g, list.filter(x => String(x.name ?? '').toLowerCase().includes(ql))] as [string, any[]]).filter(([, l]) => l.length) : groups

    if (!groups.length)
        return (
            <Text variant="text-sm/medium" color="text-muted">
                {kind === 'sticker' ? 'No server stickers found.' : 'No server emojis found. Your keyboard emojis work too.'}
            </Text>
        )

    const cell = (x: any) => {
        const on = chosen?.includes(String(x.id))
        const lottie = kind === 'sticker' && x.format_type === 3
        return (
            <Pressable key={x.id} onPress={() => onPick(x)} style={{ width: size + 12, height: size + 12, padding: 6, borderRadius: 10, opacity: on ? 0.4 : 1, alignItems: 'center', justifyContent: 'center' }}>
                {lottie ? (
                    <Text variant="text-xs/medium" color="text-normal" numberOfLines={2} style={{ textAlign: 'center' }}>
                        {x.name}
                    </Text>
                ) : (
                    <Image source={{ uri: kind === 'sticker' ? stickerImage(x) : emojiImage(x) }} style={{ width: size, height: size }} resizeMode="contain" />
                )}
            </Pressable>
        )
    }

    return (
        <View>
            <TextInput value={q} placeholder={kind === 'sticker' ? 'Find a sticker' : 'Find an emoji'} onChange={setQ} isClearable onClear={() => setQ('')} />
            {shown.map(([g, list]) => {
                const expanded = !!ql || open === g
                const icon = guildIcon(g)
                return (
                    <View key={g} style={{ marginTop: 8 }}>
                        <Pressable
                            onPress={() => {
                                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                                setOpen(o => (o === g ? undefined : g))
                            }}
                            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}
                        >
                            {icon ? <Image source={{ uri: icon }} style={{ width: 24, height: 24, borderRadius: 12, marginRight: 8 }} /> : null}
                            <Text variant="text-md/semibold" color="text-normal" style={{ flex: 1 }} numberOfLines={1}>
                                {guildName(g)}
                            </Text>
                            <Text variant="text-sm/medium" color="text-muted">
                                {`${list.length} ${expanded ? '▲' : '▼'}`}
                            </Text>
                        </Pressable>
                        {expanded ? <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{list.map(cell)}</View> : null}
                    </View>
                )
            })}
        </View>
    )
}
