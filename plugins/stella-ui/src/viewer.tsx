import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Image, Linking, PanResponder, Pressable, View } from 'react-native'
import { Icon } from './parts'
import { setState, useUi } from './state'
import { C } from './theme'

/**
 * 그림: 움직이는 그림(WebP, GIF)은 움직이게, 누르면 크게 보기(두 손가락으로 확대, 두 번 눌러 확대, 끌어서 이동).
 */

/** 디스코드 미디어 주소에 붙여 쓸 값 */
function withQuery(url: string, extra: Record<string, string>): string {
    const [base, q = ''] = url.split('?')
    const params = q.split('&').filter(Boolean).filter(p => !(p.split('=')[0] in extra))
    for (const [k, v] of Object.entries(extra)) params.push(`${k}=${v}`)
    return `${base}?${params.join('&')}`
}

const isAnimatedType = (type: string | undefined, url: string) => /image\/(gif|webp)/.test(type ?? '') || /\.(gif|webp)(\?|$)/i.test(url)

/**
 * 보여 줄 주소 후보 (앞에서부터 시도).
 * 디스코드 미디어 서버는 animated=true 를 붙여야 움직이는 그림을 그대로 준다.
 * GIF 는 안드로이드에서 프레임이 겹쳐 남아서 움직이는 WebP 로 바꿔 받는다.
 */
export function imageSources(m: { url?: string; proxy_url?: string; proxyURL?: string; proxyUrl?: string; content_type?: string; contentType?: string }): string[] {
    const original = m.url
    const proxy = m.proxy_url ?? m.proxyURL ?? m.proxyUrl ?? original
    if (!proxy) return []
    const type = m.content_type ?? m.contentType
    const out: string[] = []
    const onMedia = /media\.discordapp\.net/.test(proxy)
    if (isAnimatedType(type, proxy) && onMedia) {
        const gif = /gif/.test(type ?? '') || /\.gif(\?|$)/i.test(proxy)
        out.push(withQuery(proxy, gif ? { format: 'webp', animated: 'true' } : { animated: 'true' }))
    }
    out.push(proxy)
    if (original && original !== proxy) out.push(original)
    return [...new Set(out)]
}

/** 후보 주소를 차례로 시도하는 그림 */
export function SmartImage({ sources, style, resizeMode = 'cover' }: { sources: string[]; style: any; resizeMode?: 'cover' | 'contain' }) {
    const [i, setI] = useState(0)
    useEffect(() => setI(0), [sources.join('|')])
    const uri = sources[i]
    if (!uri) return <View style={style} />
    return <Image source={{ uri }} style={style} resizeMode={resizeMode} onError={() => setI(n => n + 1)} />
}

export function openViewer(sources: string[], width?: number, height?: number, link?: string) {
    if (sources.length) setState({ viewer: { sources, width, height, link } })
}

// ── 크게 보기 ───────────────────────────────────────────────────────────
const dist = (t: any[]) => Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY)

export function ImageViewer({ width, height }: { width: number; height: number }) {
    const v = useUi(s => s.viewer)
    if (!v) return null
    return <ViewerBody key={v.sources[0]} v={v} width={width} height={height} />
}

function ViewerBody({ v, width, height }: { v: { sources: string[]; width?: number; height?: number; link?: string }; width: number; height: number }) {
    const scale = useRef(new Animated.Value(1)).current
    const tx = useRef(new Animated.Value(0)).current
    const ty = useRef(new Animated.Value(0)).current
    const g = useRef({ scale: 1, x: 0, y: 0, startScale: 1, startDist: 0, startX: 0, startY: 0, lastTap: 0 }).current
    const close = () => setState({ viewer: undefined })

    // 화면에 맞춘 그림 크기
    const fit = useMemo(() => {
        const w0 = v.width || width
        const h0 = v.height || height
        const k = Math.min(width / w0, (height - 80) / h0)
        return { w: Math.round(w0 * k), h: Math.round(h0 * k) }
    }, [v.width, v.height, width, height])

    const apply = () => {
        // 확대하지 않았으면 가운데로, 확대했으면 그림 밖으로 너무 나가지 않게
        const maxX = Math.max(0, (fit.w * g.scale - width) / 2)
        const maxY = Math.max(0, (fit.h * g.scale - height) / 2)
        g.x = Math.max(-maxX, Math.min(maxX, g.x))
        g.y = Math.max(-maxY, Math.min(maxY, g.y))
        scale.setValue(g.scale)
        tx.setValue(g.x)
        ty.setValue(g.y)
    }

    const responder = useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => true,
                onMoveShouldSetPanResponder: () => true,
                onPanResponderGrant: e => {
                    const t = e.nativeEvent.touches
                    g.startScale = g.scale
                    g.startX = g.x
                    g.startY = g.y
                    g.startDist = t.length >= 2 ? dist(t) : 0
                    // 두 번 누르면 확대, 한 번 더 두 번 누르면 원래대로
                    const now = Date.now()
                    if (t.length === 1 && now - g.lastTap < 280) {
                        g.scale = g.scale > 1 ? 1 : 2.5
                        if (g.scale === 1) g.x = g.y = 0
                        apply()
                        g.lastTap = 0
                    } else g.lastTap = now
                },
                onPanResponderMove: (e, s) => {
                    const t = e.nativeEvent.touches
                    if (t.length >= 2) {
                        if (!g.startDist) {
                            g.startDist = dist(t)
                            g.startScale = g.scale
                        }
                        g.scale = Math.max(1, Math.min(6, (g.startScale * dist(t)) / g.startDist))
                    } else if (g.scale > 1) {
                        g.x = g.startX + s.dx
                        g.y = g.startY + s.dy
                    }
                    apply()
                },
                onPanResponderRelease: (_e, s) => {
                    // 확대하지 않은 채로 아래로 끌면 닫는다
                    if (g.scale === 1 && s.dy > 120) close()
                    g.startDist = 0
                },
            }),
        [fit],
    )

    return (
        <View style={{ position: 'absolute', top: 0, left: 0, width, height, backgroundColor: 'rgba(12,18,44,0.94)' }}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} {...responder.panHandlers}>
                <Animated.View style={{ width: fit.w, height: fit.h, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
                    <SmartImage sources={v.sources} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                </Animated.View>
            </View>
            <View style={{ position: 'absolute', top: 16, right: 16, flexDirection: 'row', gap: 12 }}>
                {v.link ? (
                    <Pressable onPress={() => Linking.openURL(v.link!).catch(() => {})} accessibilityRole="button" accessibilityLabel="Open in browser" hitSlop={8}>
                        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                            <Icon names={['WindowLaunchIcon', 'LinkExternalSmallIcon', 'LinkIcon']} color={C.white} size={22} />
                        </View>
                    </Pressable>
                ) : null}
                <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close viewer" hitSlop={8}>
                    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={['XLargeIcon', 'CloseIcon']} color={C.white} size={22} />
                    </View>
                </Pressable>
            </View>
        </View>
    )
}
