import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules, lookupModule, lookupModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import { renderLottie } from './lottie'
import { encodePng } from './png'
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

/** 고르기 칸 아래 줄의 한 칸: 서버, 또는 디스코드 기본 묶음 */
interface Group {
    key: string
    label: string
    /** 아이콘 그림 주소, 없으면 글자 */
    icon?: string
    iconText?: string
    /** 아이콘으로 그릴 스티커 (그림 주소가 없는 Lottie 묶음) */
    sticker?: any
    items: any[]
}

function guildLabel(id: string) {
    return { label: guildName(id), icon: guildIcon(id), iconText: guildName(id).slice(0, 2) }
}

// ── 디스코드 스티커 그림 (Lottie, APNG 도 디스코드가 그리는 그대로) ─────────────
let StickerC: any
/** modules/stickers/native/Sticker.tsx: { default: Sticker, getStickerAssetUrl } */
const isStickerModule = (m: any) => typeof m?.default === 'function' && typeof m?.getStickerAssetUrl === 'function'
export function bindSticker(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(withProps('getStickerAssetUrl') as any, (m: any) => {
            if (!StickerC && isStickerModule(m)) StickerC = m.default
        }) as any,
    )
}
function stickerComponent() {
    if (StickerC) return StickerC
    try {
        const found: any = lookupModuleWithImportedPath('modules/stickers/native/Sticker.tsx')
        let m: any = found?.[0]
        // 디스코드가 아직 스티커 부품을 안 불렀으면 (스티커 고르기를 한 번도 안 연 경우) 직접 부른다.
        // 이게 없으면 움직이는 스티커가 이름 글자로만 보인다
        if (!m && found?.[1] != null && typeof (globalThis as any).__r === 'function') m = (globalThis as any).__r(found[1])
        if (isStickerModule(m)) StickerC = m.default
    } catch {}
    try {
        if (!StickerC)
            for (const m of (lookupModules(withProps('getStickerAssetUrl') as any) as any) ?? [])
                if (isStickerModule(Array.isArray(m) ? m[0] : m)) {
                    StickerC = (Array.isArray(m) ? m[0] : m).default
                    break
                }
    } catch {}
    return StickerC
}

/** 스티커 하나 그리기. 디스코드 부품이 있으면 그걸로, 없으면 그림 주소로 */
export function StickerView({ sticker, size }: { sticker: any; size: number }) {
    // 디스코드 부품은 온전한 스티커 정보(형식 포함)가 있을 때만 쓴다
    const C = sticker?.format_type != null && sticker?.name ? stickerComponent() : undefined
    if (C) return <C sticker={sticker} size={size} animated={false} />
    if (sticker?.format_type === 3) return <LottieStill sticker={sticker} size={size} />
    return <Image source={{ uri: stickerImage(sticker) }} style={{ width: size, height: size }} resizeMode="contain" />
}

// ── 움직이는(Lottie) 스티커: 디스코드 부품이 아직 없으면 플러그인이 한 장면을 직접 그린다 ──
const stills = new Map<string, string | null>()
const waitingFor = new Map<string, Set<() => void>>()
/** 받기는 여러 개 같이, 그리기는 화면이 안 멈추게 하나씩 */
const jsons = new Map<string, Promise<any>>()
const drawQueue: string[] = []
let drawing = false
function fetchJson(id: string): Promise<any> {
    let p = jsons.get(id)
    if (!p) {
        p = (async () => {
            for (const u of [`https://discord.com/stickers/${id}.json`, `https://media.discordapp.net/stickers/${id}.json`, `https://cdn.discordapp.com/stickers/${id}.json`]) {
                try {
                    const res = await fetch(u)
                    if (!res.ok) continue
                    const j = await res.json()
                    if (j && Array.isArray(j.layers)) return j
                } catch {}
            }
        })()
        jsons.set(id, p)
    }
    return p
}
function finish(id: string, uri: string | null) {
    stills.set(id, uri)
    const fs = waitingFor.get(id)
    waitingFor.delete(id)
    for (const f of fs ?? [])
        try {
            f()
        } catch {}
}
function pump() {
    if (drawing) return
    const id = drawQueue.shift()
    if (!id) return
    drawing = true
    fetchJson(id)
        .then(json => {
            let uri: string | null = null
            if (json)
                for (const at of [0.4, 0.6, 0.25, 0.8, 0])
                    try {
                        const rgba = renderLottie(json, 96, at)
                        if (rgba) {
                            uri = `data:image/png;base64,${encodePng(rgba, 96)}`
                            break
                        }
                    } catch {}
            finish(id, uri)
        })
        .finally(() => {
            drawing = false
            setTimeout(pump, 0)
        })
}
function drawStill(id: string, done: () => void) {
    if (stills.has(id)) return done()
    let fs = waitingFor.get(id)
    if (!fs) {
        waitingFor.set(id, (fs = new Set()))
        fetchJson(id)
        drawQueue.push(id)
    }
    fs.add(done)
    pump()
}
function LottieStill({ sticker, size }: { sticker: any; size: number }) {
    const id = String(sticker.id)
    const [, tick] = useState(0)
    const fade = useRef(new Animated.Value(stills.get(id) ? 1 : 0)).current
    useEffect(() => {
        let alive = true
        if (!stills.has(id))
            drawStill(id, () => {
                if (!alive) return
                tick(n => n + 1)
                Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start()
            })
        return () => {
            alive = false
        }
    }, [id])
    const uri = stills.get(id)
    if (uri) return <Animated.Image source={{ uri }} style={{ width: size, height: size, opacity: fade }} resizeMode="contain" />
    const P = palette()
    if (uri === null) {
        // 못 그린 스티커만 이름으로
        const { Text } = Design as any
        return (
            <View style={{ width: size, height: size, borderRadius: 12, backgroundColor: P.chip, alignItems: 'center', justifyContent: 'center', padding: 2 }}>
                <Text variant="text-xs/semibold" numberOfLines={2} adjustsFontSizeToFit style={{ color: P.text, textAlign: 'center' }}>
                    {sticker.name}
                </Text>
            </View>
        )
    }
    // 그리는 중: 글자 없이 옅은 자리만
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: P.chip, opacity: 0.5, transform: [{ scale: 0.6 }] }} />
}

// ── 디스코드 기본 스티커 묶음 (Wumpus 같은 것) ──────────────────────────────
let apiPacks: any[] | undefined
let loading = false
/** 디스코드 기본 스티커 묶음 목록 (로그인 없이 받는 공개 주소, 토큰은 쓰지 않는다) */
const waiting = new Set<() => void>()
function loadPacks(done: () => void) {
    if (apiPacks) return
    waiting.add(done)
    if (loading) return
    loading = true
    fetch('https://discord.com/api/v9/sticker-packs')
        .then(r => r.json())
        .then(j => {
            apiPacks = Array.isArray(j?.sticker_packs) ? j.sticker_packs : []
        })
        .catch(() => {
            apiPacks = []
        })
        .finally(() => {
            loading = false
            const all = [...waiting]
            waiting.clear()
            for (const f of all)
                try {
                    f()
                } catch {}
        })
}

/** 고른 스티커 목록이 디스코드 기본 묶음을 받은 뒤 다시 그려지게 한다 (안 그러면 "Sticker 123..." 으로 남는다) */
export function usePacks() {
    const [, tick] = useState(0)
    useEffect(() => {
        let alive = true
        loadPacks(() => alive && tick(n => n + 1))
        return () => {
            alive = false
        }
    }, [])
}

function storePacks(): any[] {
    const S: any = Stores
    for (const store of [S.StickersStore, S.StickersPackStore]) {
        try {
            const p = store?.getPremiumPacks?.()
            if (Array.isArray(p) && p.length) return p
        } catch {}
    }
    return []
}

function systemStickerGroups(): Group[] {
    const packs = storePacks().length ? storePacks() : apiPacks ?? []
    const out: Group[] = []
    for (const p of packs) {
        const items = (p?.stickers ?? []).filter((x: any) => x?.id)
        if (!items.length) continue
        const preview = items.find((x: any) => x.format_type !== 3)
        out.push({ key: `pack:${p.id}`, label: String(p.name ?? 'Discord'), icon: preview ? stickerImage(preview) : undefined, iconText: '✨', sticker: items[0], items })
    }
    return out
}

function guildStickerGroups(): Group[] {
    const out: Group[] = []
    try {
        const all = (Stores as any).StickersStore?.getAllGuildStickers?.()
        const add = (g: string, list: any) => Array.isArray(list) && list.length && out.push({ key: `g:${g}`, ...guildLabel(g), items: list })
        if (all instanceof Map) {
            for (const [g, list] of all) add(String(g), list)
        } else if (all && typeof all === 'object') {
            for (const g of Object.keys(all)) add(g, all[g])
        }
    } catch {}
    return out
}

// ── 디스코드 기본 이모지 (유니코드, 분류별) ──────────────────────────────────
const CATEGORY: Record<string, [string, string]> = {
    people: ['People', '😀'],
    nature: ['Nature', '🐻'],
    food: ['Food', '🍔'],
    activity: ['Activities', '⚽'],
    travel: ['Travel', '🚗'],
    objects: ['Objects', '💡'],
    symbols: ['Symbols', '❤️'],
    flags: ['Flags', '🏳️'],
}
let unicode: any
function systemEmojiGroups(): Group[] {
    try {
        unicode ??= (lookupModule(withProps('getByCategory', 'getCategories') as any) as any)?.[0]
        const cats: string[] = unicode?.getCategories?.() ?? []
        const out: Group[] = []
        for (const c of cats) {
            const list = (unicode.getByCategory?.(c) ?? [])
                .map((e: any) => {
                    const surrogates = e?.surrogates ?? e?.optionallyDiverseSequence
                    return surrogates ? { id: `u:${e.uniqueName ?? e.name ?? surrogates}`, name: String(e.uniqueName ?? e.name ?? (e.names ?? [])[0] ?? ''), surrogates, unicode: true } : undefined
                })
                .filter(Boolean)
            if (!list.length) continue
            const [label, iconText] = CATEGORY[c] ?? [c.charAt(0).toUpperCase() + c.slice(1), list[0].surrogates]
            out.push({ key: `u:${c}`, label, iconText, items: list })
        }
        return out
    } catch {
        return []
    }
}

function guildEmojiGroups(): Group[] {
    const S: any = Stores
    const out: Group[] = []
    try {
        const guilds = S.GuildStore?.getGuilds?.() ?? {}
        for (const id of Object.keys(guilds)) {
            const list = S.EmojiStore?.getGuildEmoji?.(id) ?? S.EmojiStore?.getGuildEmojis?.(id)
            if (Array.isArray(list) && list.length) out.push({ key: `g:${id}`, ...guildLabel(id), items: list })
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
    const groups: Group[] = kind === 'sticker' ? [...systemStickerGroups(), ...guildStickerGroups()] : [...systemEmojiGroups(), ...guildEmojiGroups()]
    const [sel, setSel] = useState<string | undefined>(groups[0]?.key)
    // 기본 스티커 묶음을 막 받아 오기 시작했으면 조금 뒤 다시 그린다
    const [, tick] = useState(0)
    const noPacks = kind === 'sticker' && !groups.some(g => g.key.startsWith('pack:'))
    useEffect(() => {
        if (noPacks) loadPacks(() => tick(n => n + 1))
    }, [noPacks])
    const [q, setQ] = useState('')
    const size = kind === 'sticker' ? 64 : 36
    const ql = q.trim().toLowerCase()

    if (!groups.length)
        return (
            <Text variant="text-sm/medium" style={{ color: P.muted }}>
                {kind === 'sticker' ? 'No stickers found.' : 'No emojis found.'}
            </Text>
        )

    const current = groups.find(g => g.key === sel) ?? groups[0]
    // 검색하면 모든 묶음에서 찾는다
    const results: any[] = ql ? groups.flatMap(g => g.items.filter(x => String(x.name ?? '').toLowerCase().includes(ql))).slice(0, 150) : current.items

    const cell = (x: any) => {
        const on = chosen?.includes(String(x.id))
        return (
            <Cell key={x.id} size={size} on={on} onPress={() => onPick(x)}>
                {x.unicode ? (
                    <Text style={{ fontSize: size * 0.8, lineHeight: size, textAlign: 'center', color: P.text }}>{x.surrogates}</Text>
                ) : kind === 'sticker' ? (
                    <StickerView sticker={x} size={size} />
                ) : (
                    <Image source={{ uri: emojiImage(x) }} style={{ width: size, height: size }} resizeMode="contain" />
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
                {(ql ? `Results (${results.length})` : current.label).toUpperCase()}
            </Text>
            <ScrollView nestedScrollEnabled style={{ height: kind === 'sticker' ? 300 : 260 }} contentContainerStyle={{ padding: 6 }}>
                <FadeIn k={ql ? `q:${ql}` : current.key}>
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
                {groups.map(g => {
                    const on = !ql && g.key === current.key
                    return (
                        <Pressable
                            key={g.key}
                            onPress={() => {
                                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                                setQ('')
                                setSel(g.key)
                            }}
                            style={{ width: 44, height: 44, marginRight: 6, borderRadius: on ? 14 : 22, borderWidth: 2, borderColor: on ? P.brand : 'transparent', alignItems: 'center', justifyContent: 'center', backgroundColor: P.chip, overflow: 'hidden' }}
                        >
                            {g.sticker && !g.icon ? (
                                <StickerView sticker={g.sticker} size={36} />
                            ) : g.icon ? (
                                <Image source={{ uri: g.icon }} style={{ width: 40, height: 40 }} resizeMode="contain" />
                            ) : (
                                <Text style={{ color: P.text, fontSize: g.key.startsWith('u:') ? 22 : 12, fontWeight: '700' }} numberOfLines={1}>
                                    {g.iconText ?? g.label.slice(0, 2)}
                                </Text>
                            )}
                        </Pressable>
                    )
                })}
            </ScrollView>
        </View>
    )
}

/** ID 로 스티커 찾기 (서버 스티커, 디스코드 기본 묶음) */
export function stickerById(id: string): any {
    try {
        const s = (Stores as any).StickersStore?.getStickerById?.(id)
        if (s) return s
    } catch {}
    for (const p of [...storePacks(), ...(apiPacks ?? [])]) for (const x of p?.stickers ?? []) if (String(x?.id) === id) return x
    return undefined
}
