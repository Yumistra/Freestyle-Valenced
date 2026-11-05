import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useEffect, useRef, useState } from 'react'
import { Animated, Image, LayoutAnimation, Pressable, ScrollView, TextInput as RNTextInput, View } from 'react-native'
import { palette } from './colors'

/**
 * 디스코드 고르기 창처럼: 위에 검색, 가운데 고른 서버의 스티커(또는 이모지) 칸,
 * 아래에 서버 아이콘 줄. 서버 아이콘을 누르면 그 서버 것으로 바뀐다.
 * (채팅 입력창의 고르기 창은 버전에 따라 밖에서 열 수 없어서 직접 그린다)
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

function guild(id: string): any {
    try {
        return (Stores as any).GuildStore?.getGuild?.(id)
    } catch {}
}
const guildName = (id: string) => String(guild(id)?.name ?? '') || 'Server'
function guildIcon(id: string) {
    const g = guild(id)
    return g?.icon ? `https://cdn.discordapp.com/icons/${id}/${g.icon}.png?size=64` : undefined
}

function stickerGroups(): Array<[string, Sticker[]]> {
    const out: Array<[string, Sticker[]]> = []
    try {
        const all = (Stores as any).StickersStore?.getAllGuildStickers?.()
        if (all instanceof Map) {
            for (const [g, list] of all) if (Array.isArray(list) && list.length) out.push([String(g), list])
        } else if (all && typeof all === 'object') {
            for (const g of Object.keys(all)) if (all[g]?.length) out.push([g, all[g]])
        }
    } catch {}
    return out
}

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

/** 누르면 살짝 줄었다가 튀어 돌아오는 칸 */
function Cell({ onPress, children, size, on }: { onPress(): void; children: any; size: number; on?: boolean; key?: string }) {
    const scale = useRef(new Animated.Value(1)).current
    const spring = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: to === 1 ? 12 : 0 }).start()
    const P = palette()
    return (
        <Pressable onPressIn={() => spring(0.85)} onPressOut={() => spring(1)} onPress={onPress} style={{ width: size + 12, height: size + 12, padding: 4 }}>
            <Animated.View
                style={{
                    flex: 1,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: on ? P.brandSoft : 'transparent',
                    transform: [{ scale }],
                }}
            >
                {children}
            </Animated.View>
        </Pressable>
    )
}

/** 처음 나타날 때 살짝 떠오른다 */
function FadeIn({ children, k }: { children: any; k: string }) {
    const v = useRef(new Animated.Value(0)).current
    useEffect(() => {
        v.setValue(0)
        Animated.timing(v, { toValue: 1, duration: 180, useNativeDriver: true }).start()
    }, [k])
    return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>{children}</Animated.View>
}

export function ExpressionGrid({ kind, onPick, chosen }: { kind: 'sticker' | 'emoji'; onPick(x: any): void; chosen?: string[] }) {
    const { Text } = Design as any
    const P = palette()
    const groups: Array<[string, any[]]> = kind === 'sticker' ? stickerGroups() : emojiGroups()
    const [sel, setSel] = useState<string | undefined>(groups[0]?.[0])
    const [q, setQ] = useState('')
    const size = kind === 'sticker' ? 64 : 36
    const ql = q.trim().toLowerCase()

    if (!groups.length)
        return (
            <Text variant="text-sm/medium" style={{ color: P.muted }}>
                {kind === 'sticker' ? 'No server stickers found.' : 'No server emojis found. Keyboard emojis work too.'}
            </Text>
        )

    const current = groups.find(([g]) => g === sel) ?? groups[0]
    // 검색하면 모든 서버에서 찾는다
    const results = ql
        ? groups
              .flatMap(([g, list]) => list.filter(x => String(x.name ?? '').toLowerCase().includes(ql)).map(x => [g, x] as [string, any]))
              .slice(0, 150)
        : current[1].map(x => [current[0], x] as [string, any])

    const cell = ([, x]: [string, any]) => {
        const on = chosen?.includes(String(x.id))
        const lottie = kind === 'sticker' && x.format_type === 3
        return (
            <Cell key={x.id} size={size} on={on} onPress={() => onPick(x)}>
                {lottie ? (
                    <Text variant="text-xs/medium" numberOfLines={2} style={{ color: P.text, textAlign: 'center' }}>
                        {x.name}
                    </Text>
                ) : (
                    <Image source={{ uri: kind === 'sticker' ? stickerImage(x) : emojiImage(x) }} style={{ width: size, height: size }} resizeMode="contain" />
                )}
            </Cell>
        )
    }

    return (
        <View style={{ borderRadius: 16, backgroundColor: P.surface, overflow: 'hidden' }}>
            <View style={{ padding: 10, paddingBottom: 6 }}>
                <RNTextInput
                    value={q}
                    onChangeText={v => (LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut), setQ(v))}
                    placeholder={kind === 'sticker' ? 'Find a sticker' : 'Find an emoji'}
                    placeholderTextColor={P.muted}
                    autoCorrect={false}
                    autoCapitalize="none"
                    style={{ height: 40, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: P.text, backgroundColor: P.input }}
                />
            </View>
            <Text variant="text-xs/bold" style={{ color: P.muted, paddingHorizontal: 14, paddingTop: 4, letterSpacing: 0.4 }} numberOfLines={1}>
                {(ql ? `Results (${results.length})` : guildName(current[0])).toUpperCase()}
            </Text>
            <ScrollView nestedScrollEnabled style={{ height: kind === 'sticker' ? 300 : 260 }} contentContainerStyle={{ padding: 6 }}>
                <FadeIn k={ql ? `q:${ql}` : current[0]}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{results.map(cell)}</View>
                    {!results.length ? (
                        <Text variant="text-sm/medium" style={{ color: P.muted, padding: 8 }}>
                            Nothing matches.
                        </Text>
                    ) : null}
                </FadeIn>
            </ScrollView>
            {/* 서버 아이콘 줄 */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderTopWidth: 1, borderTopColor: P.chip }} contentContainerStyle={{ padding: 8 }}>
                {groups.map(([g]) => {
                    const icon = guildIcon(g)
                    const on = !ql && g === current[0]
                    return (
                        <Pressable
                            key={g}
                            onPress={() => {
                                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                                setQ('')
                                setSel(g)
                            }}
                            style={{ width: 44, height: 44, marginRight: 6, borderRadius: on ? 14 : 22, borderWidth: 2, borderColor: on ? P.brand : 'transparent', alignItems: 'center', justifyContent: 'center', backgroundColor: P.chip, overflow: 'hidden' }}
                        >
                            {icon ? (
                                <Image source={{ uri: icon }} style={{ width: 40, height: 40 }} />
                            ) : (
                                <Text variant="text-xs/bold" style={{ color: P.text }} numberOfLines={1}>
                                    {guildName(g).slice(0, 2)}
                                </Text>
                            )}
                        </Pressable>
                    )
                })}
            </ScrollView>
        </View>
    )
}
