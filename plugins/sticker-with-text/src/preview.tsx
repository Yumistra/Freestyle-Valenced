import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useEffect, useRef, useState } from 'react'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Animated, Image, LayoutAnimation, Pressable, View } from 'react-native'

/**
 * 고른 스티커를 바로 보내지 않고 입력창 위에 사진처럼 올려 둔다.
 * 사진 칸(ChatInputImageCarousel) 앞에 우리 칸을 그린다.
 */

export interface Pending {
    ids: string[]
    /** 디스코드가 sendStickers 에 넘긴 옵션 (답장 등) */
    options?: any
}

const pending = new Map<string, Pending>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(f => f())

export const getPending = (channelId: string) => pending.get(channelId)
export function addPending(channelId: string, ids: string[], options?: any) {
    const p = pending.get(channelId)
    // 한 메시지에 스티커는 3개까지
    const all = [...(p?.ids ?? []), ...ids.map(String)].filter((x, i, a) => a.indexOf(x) === i).slice(-3)
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    pending.set(channelId, { ids: all, options: options ?? p?.options })
    emit()
}
export function removePending(channelId: string, id?: string) {
    const p = pending.get(channelId)
    if (!p) return
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const ids = id ? p.ids.filter(x => x !== id) : []
    if (ids.length) pending.set(channelId, { ...p, ids })
    else pending.delete(channelId)
    emit()
}
/** 보낼 때 꺼내 간다 */
export function takePending(channelId: string): Pending | undefined {
    const p = pending.get(channelId)
    if (!p) return
    pending.delete(channelId)
    emit()
    return p
}
export function clearAllPending() {
    pending.clear()
    emit()
}

// ── 색 (지금 테마) ───────────────────────────────────────────────────────
function tokenColor(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}

// ── 스티커 그리기 (디스코드 부품이 있으면 Lottie 도 그대로) ─────────────────
let stickerMod: any
export const setStickerModule = (m: any) => (stickerMod ??= m)

function StickerArt({ id, size }: { id: string; size: number }) {
    let s: any
    try {
        s = (Stores as any).StickersStore?.getStickerById?.(id)
    } catch {}
    const C = stickerMod?.default
    if (C && s?.format_type != null) return <C sticker={s} size={size} animated />
    let uri = `https://media.discordapp.net/stickers/${id}.${s?.format_type === 4 ? 'gif' : 'png'}?size=160`
    try {
        if (s && typeof stickerMod?.getStickerAssetUrl === 'function') uri = stickerMod.getStickerAssetUrl(s, { size: 160 }) ?? uri
    } catch {}
    return <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="contain" />
}

/** 나타날 때 톡 튀어나오는 칸 */
function Pop({ children }: { children: any; key?: string }) {
    const v = useRef(new Animated.Value(0.6)).current
    useEffect(() => {
        Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 10 }).start()
    }, [])
    return <Animated.View style={{ transform: [{ scale: v }], opacity: v.interpolate({ inputRange: [0.6, 1], outputRange: [0, 1] }) }}>{children}</Animated.View>
}

export function PendingStickers({ channelId, onSend }: { channelId: string; onSend(): void }) {
    const [, tick] = useState(0)
    useEffect(() => {
        const f = () => tick(n => n + 1)
        listeners.add(f)
        return () => {
            listeners.delete(f)
        }
    }, [])
    const p = pending.get(channelId)
    if (!p?.ids.length) return null
    const { Text } = Design as any
    const surface = tokenColor(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_FLOATING', 'BACKGROUND_SECONDARY'], '#2b2d31')
    const muted = tokenColor(['TEXT_MUTED'], '#949ba4')
    const brand = tokenColor(['BACKGROUND_BRAND', 'BRAND_500'], '#5865f2')
    const SIZE = 80
    const SendIcon: any = lookupGeneratedIconComponent('SendMessageIcon' as any)
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
            {p.ids.map(id => (
                <Pop key={id}>
                    <View style={{ width: SIZE + 12, height: SIZE + 12, marginRight: 8, borderRadius: 12, backgroundColor: surface, alignItems: 'center', justifyContent: 'center' }}>
                        <StickerArt id={id} size={SIZE} />
                        {/* 사진 칸처럼 오른쪽 위 X */}
                        <Pressable
                            onPress={() => removePending(channelId, id)}
                            hitSlop={8}
                            style={{ position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12, backgroundColor: surface, borderWidth: 2, borderColor: muted, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Text variant="text-sm/bold" style={{ color: muted, lineHeight: 18 }}>
                                ×
                            </Text>
                        </Pressable>
                    </View>
                </Pop>
            ))}
            <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 2 }}>
                <Text variant="text-xs/medium" style={{ color: muted }} numberOfLines={2}>
                    Sends with your message
                </Text>
            </View>
            {/* 글도 파일도 없을 때 스티커만 보내는 버튼 */}
            <Pressable onPress={onSend} hitSlop={6} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: brand, alignItems: 'center', justifyContent: 'center', marginLeft: 8 }}>
                {SendIcon ? <SendIcon size="sm" color="#ffffff" /> : <Text variant="text-md/bold" style={{ color: '#ffffff' }}>➤</Text>}
            </Pressable>
        </View>
    )
}
