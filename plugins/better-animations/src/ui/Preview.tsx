import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, View } from 'react-native'
import { applyMove, caskStyleOf, DEFAULT_PREVIEW, easingFrom, effectOf, exitEffectOf, exitPoseOf, springFor, type EasingKey, type ModuleKey, type Normalized } from '../effects'
import { makeCardInterpolator, partsFor } from '../interpolate'
import { caskRun, caskVisual, randomColor } from '../patches/lists'
import type { ModuleSettings } from '../settings'
import { palette } from './colors'

/**
 * 설정 화면 미리보기. 실제 패치와 같은 효과 정의로 react-native Animated 를 돌린다.
 * 0 → 1 (나타남) → 잠깐 멈춤 → 0 (사라짐, 나갈 때 효과) 을 반복한다.
 */

const HEIGHT = 170
const fill = { position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: 0 }

function anim(p: any, to: number, duration: number, easing: EasingKey, instant: boolean, native = true) {
    if (instant) return Animated.timing(p, { toValue: to, duration: 0, useNativeDriver: native })
    if (easing === 'spring') return Animated.spring(p, { toValue: to, ...springFor(duration, 0.55), useNativeDriver: native } as any)
    return Animated.timing(p, { toValue: to, duration, easing: easingFrom(Easing, easing), useNativeDriver: native })
}

/** p: 0 → 1 → 0, closing: 사라지는 동안 1 */
function useLoop(duration: number, easing: EasingKey, instant: boolean, native = true) {
    const p = useRef(new Animated.Value(0)).current
    const closing = useRef(new Animated.Value(0)).current
    useEffect(() => {
        const set = (v: any, to: number) => Animated.timing(v, { toValue: to, duration: 0, useNativeDriver: native })
        p.setValue(0)
        const loop = Animated.loop(
            Animated.sequence([set(closing, 0), Animated.delay(450), anim(p, 1, duration, easing, instant, native), Animated.delay(1200), set(closing, 1), anim(p, 0, duration, easing, instant, native), Animated.delay(350)]),
        )
        loop.start()
        return () => loop.stop()
    }, [duration, easing, instant, native])
    return { p, closing }
}

const lerp = (p: any, from: any, to: any) => p.interpolate({ inputRange: [0, 1], outputRange: [from, to] })

/** 메뉴 모서리 기준·가장자리 밖 같은 미리보기 전용 보정을 이동값으로 바꾼다 */
function adjust(h: Normalized, extra?: { anchorX?: number; anchorY?: number; halfW?: number; halfH?: number; edge?: number }): Normalized {
    const ax = h.anchor ? (extra?.anchorX ?? 0) * (extra?.halfW ?? 0) * (1 - h.s) : 0
    const ay = h.anchor ? (extra?.anchorY ?? 0) * (extra?.halfH ?? 0) * (1 - h.s * h.sy) : 0
    return { ...h, tx: h.tx + ax, ty: h.ty + ay + (h.edge ? (extra?.edge ?? 0) : 0) }
}

/** 나타날 때 h, 사라질 때 hx 로 움직이는 스타일 */
function moving(p: any, closing: any, h: Normalized, hx: Normalized, W: number, H: number) {
    const parts = partsFor(p, h, W, H, undefined, hx, closing)
    const style: any = { transform: [{ perspective: 800 }, ...parts.transform] }
    if (parts.opacity) style.opacity = parts.opacity
    return style
}

function Bars({ color, widths, gap = 7 }: { color: string; widths: string[]; gap?: number }) {
    return (
        <View style={{ gap }}>
            {widths.map((w, i) => (
                <View key={i} style={{ height: 7, width: w as any, borderRadius: 4, backgroundColor: color }} />
            ))}
        </View>
    )
}

function FakeScreen({ title, c, tone }: { title: string; c: ReturnType<typeof palette>; tone: string }) {
    return (
        <View style={{ flex: 1, backgroundColor: tone, padding: 12, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: c.brand }} />
                <View style={{ height: 8, width: title as any, borderRadius: 4, backgroundColor: c.text }} />
            </View>
            <Bars color={c.muted} widths={['85%', '60%', '72%', '40%']} />
        </View>
    )
}

function ChatRow({ c, i }: { c: ReturnType<typeof palette>; i: number }) {
    return (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', height: 30 }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: i % 2 ? c.brand : c.raised }} />
            <View style={{ gap: 5, flex: 1 }}>
                <View style={{ width: 64, height: 7, borderRadius: 4, backgroundColor: c.text }} />
                <View style={{ width: `${50 + ((i * 17) % 40)}%` as any, height: 7, borderRadius: 4, backgroundColor: c.muted }} />
            </View>
        </View>
    )
}

/** 메시지: 차례로 나타난 뒤, 가운데 메시지 하나가 지워지고 위 메시지들이 밀려 내려온다 */
function MessagesPreview({ s, W }: { s: ModuleSettings; W: number }) {
    const c = useMemo(palette, [])
    const ROWS = 4
    const ROW_H = 30
    const GAP = 10
    const DELETED = 2
    const rows = useRef([...Array(ROWS)].map(() => new Animated.Value(0))).current
    const gone = useRef(new Animated.Value(0)).current
    const shift = useRef(new Animated.Value(0)).current
    const off = s.effect === 'default' || s.effect === 'none'
    const exitOff = off && (!s.exit || s.exit === 'same')
    const effect = effectOf('messages', off ? 'fade' : s.effect)
    const exit = exitEffectOf('messages', off ? 'fade' : s.effect, s.exit)
    const stagger = Math.max(s.stagger ?? 30, s.effect === 'wave' ? 45 : 0)
    useEffect(() => {
        const set = (v: any, to: number) => Animated.timing(v, { toValue: to, duration: 0, useNativeDriver: true })
        const loop = Animated.loop(
            Animated.sequence([
                Animated.parallel([...rows.map(v => set(v, 0)), set(gone, 0), set(shift, 0)]),
                Animated.delay(400),
                Animated.stagger(
                    stagger,
                    rows.map(v => anim(v, 1, s.duration, s.easing, off)),
                ),
                Animated.delay(900),
                Animated.parallel([
                    anim(gone, 1, s.duration, s.easing, exitOff),
                    s.shift === false ? set(shift, 1) : Animated.timing(shift, { toValue: 1, duration: s.shiftDuration ?? 200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
                ]),
                Animated.delay(900),
            ]),
        )
        loop.start()
        return () => loop.stop()
    }, [s.effect, s.exit, s.duration, s.easing, s.stagger, s.shift, s.shiftDuration, s.direction, s.position])

    const move = { direction: s.direction, position: s.position }
    const h = applyMove(effect.hidden, move, W - 28, ROW_H)
    const hx = applyMove(exit.hidden, move, W - 28, ROW_H)
    return (
        <View style={{ ...fill, padding: 14, justifyContent: 'flex-end' }}>
            {rows.map((v, i) => {
                const enter = off ? {} : moving(v, undefined, h, h, W, HEIGHT)
                const down = i < DELETED ? { transform: [{ translateY: lerp(shift, 0, ROW_H + GAP) }] } : undefined
                const leaving =
                    i === DELETED
                        ? exitOff
                            ? { opacity: lerp(gone, 1, 0) }
                            : moving(Animated.subtract(1, gone), undefined, hx, hx, W, HEIGHT)
                        : undefined
                return (
                    <Animated.View key={i} style={[{ marginTop: i ? GAP : 0 }, down]}>
                        <Animated.View style={enter}>
                            <Animated.View style={leaving}>
                                <ChatRow c={c} i={i} />
                            </Animated.View>
                        </Animated.View>
                    </Animated.View>
                )
            })}
        </View>
    )
}

/** 목록 스크롤 (Cask): 줄들이 차례로 들어온다 */
function CaskPreview({ s, W }: { s: ModuleSettings; W: number }) {
    const c = useMemo(palette, [])
    const style = caskStyleOf(s.effect)
    const ROWS = 5
    const values = useRef([...Array(ROWS)].map(() => new Animated.Value(1))).current
    const colors = useMemo(() => values.map(() => randomColor()), [s.effect])
    useEffect(() => {
        if (!style) return
        let stopped = false
        let current: any
        const cycle = () => {
            if (stopped) return
            for (const v of values) v.setValue(0)
            current = Animated.sequence([
                Animated.stagger(Math.max(60, s.duration * 0.25), values.map(v => (style === 'permanentColor' ? Animated.timing(v, { toValue: 1, duration: s.duration, useNativeDriver: true }) : caskRun(style, v, s.duration)))),
                Animated.delay(1100),
            ])
            current.start(({ finished }: any) => finished && cycle())
        }
        cycle()
        return () => {
            stopped = true
            current?.stop()
        }
    }, [s.effect, s.duration])
    return (
        <View style={{ ...fill, padding: 12, gap: 8 }}>
            {values.map((v, i) => {
                const vis = style ? caskVisual(style, v, W) : {}
                return (
                    <Animated.View key={i} style={[{ height: 22, borderRadius: 8, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8, overflow: 'hidden' }, vis.style]}>
                        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.brand }} />
                        <View style={{ height: 6, width: `${40 + ((i * 23) % 45)}%` as any, borderRadius: 3, backgroundColor: c.text }} />
                        {vis.overlay && <Animated.View style={[fill, { backgroundColor: colors[i], opacity: vis.overlay }]} />}
                    </Animated.View>
                )
            })}
        </View>
    )
}

/** 채널 목록 접기·펼치기 / 서버 바꾸기 (LayoutAnimation 흉내, 높이는 JS 로) */
function ListPreview({ module, s }: { module: 'channelList' | 'servers'; s: ModuleSettings }) {
    const c = useMemo(palette, [])
    const instant = s.effect === 'default' || s.effect === 'none'
    const { p } = useLoop(s.duration, s.easing, instant, false)
    if (module === 'servers') {
        const a = p.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })
        const move = { direction: s.direction, position: s.position }
        const h = applyMove(effectOf('servers', instant ? 'fade' : s.effect).hidden, move, 220, HEIGHT)
        const enter = instant ? { opacity: p.interpolate({ inputRange: [0, 0.5, 0.51, 1], outputRange: [0, 0, 1, 1] }) } : moving(p, undefined, h, h, 220, HEIGHT)
        // 옛 목록: 원래 모습 → 나가는 모습
        const hx = exitPoseOf('servers', instant ? 'fade' : s.effect, s.exit, move, 220, HEIGHT)
        const leave = instant ? { opacity: a.interpolate({ inputRange: [0, 0.99, 1], outputRange: [0, 0, 1] }) } : moving(a, undefined, hx, hx, 220, HEIGHT)
        return (
            <View style={{ ...fill, flexDirection: 'row', padding: 12, gap: 12 }}>
                <View style={{ width: 40, gap: 8 }}>
                    <Animated.View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: lerp(p, 0, 1).interpolate({ inputRange: [0, 1], outputRange: [c.brand, c.raised] }) }} />
                    <Animated.View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: lerp(p, 0, 1).interpolate({ inputRange: [0, 1], outputRange: [c.raised, c.brand] }) }} />
                </View>
                <View style={{ flex: 1 }}>
                    <Animated.View style={[fill, leave]}>
                        <Bars color={c.muted} widths={['50%', '80%', '65%', '72%', '40%']} gap={12} />
                    </Animated.View>
                    <Animated.View style={[fill, enter]}>
                        <Bars color={c.text} widths={['40%', '70%', '85%', '55%']} gap={12} />
                    </Animated.View>
                </View>
            </View>
        )
    }
    const ROW = 19
    const rh = applyMove(effectOf('channelList', instant ? 'smooth' : s.effect).hidden, undefined, 200, 20)
    const rowStyle = moving(p, undefined, rh, rh, 200, 20)
    return (
        <View style={{ ...fill, padding: 14, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Animated.View style={{ width: 10, height: 10, borderRightWidth: 2, borderBottomWidth: 2, borderColor: c.muted, transform: [{ rotate: lerp(p, '-45deg', '45deg') }] }} />
                <View style={{ height: 8, width: 90, borderRadius: 4, backgroundColor: c.muted }} />
            </View>
            <Animated.View style={{ height: lerp(p, 0, ROW * 3), overflow: 'hidden' }}>
                <Animated.View style={[{ gap: 12, paddingLeft: 18 }, rowStyle]}>
                    <Bars color={c.text} widths={['60%', '45%', '70%']} gap={12} />
                </Animated.View>
            </Animated.View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 10, height: 10, borderRightWidth: 2, borderBottomWidth: 2, borderColor: c.muted, transform: [{ rotate: '45deg' }] }} />
                <View style={{ height: 8, width: 70, borderRadius: 4, backgroundColor: c.muted }} />
            </View>
            <View style={{ paddingLeft: 18 }}>
                <Bars color={c.text} widths={['55%', '62%']} gap={12} />
            </View>
        </View>
    )
}

export default function Preview({ module, settings }: { module: ModuleKey; settings: ModuleSettings }) {
    const c = useMemo(palette, [])
    const [W, setW] = useState(320)
    const isDefault = settings.effect === 'default'
    const shown = isDefault ? { ...settings, ...DEFAULT_PREVIEW[module] } : settings
    const instant = shown.effect === 'none'
    // 네이티브 화면은 속도를 못 바꾼다
    const duration = module === 'push' || module === 'modal' ? 320 : shown.duration
    const easing: EasingKey = module === 'push' || module === 'modal' ? 'out' : shown.easing
    const { p, closing } = useLoop(duration, easing, instant)
    const one = useRef(new Animated.Value(1)).current
    const effect = effectOf(module, shown.effect)
    const exit = isDefault ? effect : exitEffectOf(module, shown.effect, shown.exit)
    const move = isDefault ? undefined : { direction: shown.direction, position: shown.position }

    let body: any
    const isScreen = module === 'stack' || module === 'push' || module === 'modal' || module === 'panel'
    const hFor = (w: number, h: number, extra?: Parameters<typeof adjust>[1]) => [adjust(applyMove(effect.hidden, move, w, h), extra), adjust(applyMove(exit.hidden, move, w, h), extra)] as const

    if (module === 'lists' || (module === 'messages' && caskStyleOf(settings.effect))) {
        body = <CaskPreview s={settings} W={W} />
    } else if (module === 'messages') {
        body = <MessagesPreview s={settings} W={W} />
    } else if (module === 'channelList' || module === 'servers') {
        body = <ListPreview module={module} s={shown} />
    } else if (isScreen) {
        const layouts = { screen: { width: W, height: HEIGHT } }
        const interp = makeCardInterpolator(instant ? { id: 'none', label: '' } : effect, { exit, move })
        const top = interp({ current: { progress: p }, inverted: one, layouts, closing })
        const under = interp({ current: { progress: one }, next: { progress: p }, inverted: one, layouts })
        const topStyle = instant ? { opacity: p.interpolate({ inputRange: [0, 0.5, 0.51, 1], outputRange: [0, 0, 1, 1] }) } : top.cardStyle
        body = (
            <>
                <Animated.View style={[fill, under.cardStyle]}>
                    <FakeScreen title="40%" c={c} tone={c.surface} />
                </Animated.View>
                {top.overlayStyle && <Animated.View style={[fill, { backgroundColor: '#000' }, top.overlayStyle]} />}
                <Animated.View style={[fill, topStyle]}>
                    <FakeScreen title="55%" c={c} tone={c.raised} />
                </Animated.View>
            </>
        )
    } else if (module === 'folder') {
        // 서버 목록: 폴더 아이콘 아래로 서버 아이콘 셋이 나타난다
        const size = 30
        const [h, hx] = hFor(size, size, { edge: -(size + 8) })
        body = (
            <View style={{ position: 'absolute', top: 10, bottom: 10, left: 14, width: 52, borderRadius: 26, backgroundColor: c.surface, alignItems: 'center', paddingTop: 10, gap: 8 }}>
                <View style={{ width: size + 6, height: size + 6, borderRadius: 12, backgroundColor: c.brandSoft }} />
                {[0, 1, 2].map(i => (
                    <Animated.View key={i} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: i === 1 ? c.brand : c.raised }, moving(p, closing, h, hx, W, HEIGHT)]} />
                ))}
            </View>
        )
    } else if (module === 'press') {
        // 버튼: 눌린 모습 ↔ 원래 모습
        const [h] = hFor(140, 40)
        const style = moving(p, closing, h, h, W, HEIGHT)
        body = (
            <View style={{ ...fill, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 16 }}>
                <Animated.View style={[{ width: 140, height: 40, borderRadius: 12, backgroundColor: c.brand }, style]} />
                <Animated.View style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.raised }, style]} />
            </View>
        )
    } else if (module === 'subtle') {
        // 체크박스·라디오·스위치
        const [h] = hFor(30, 30)
        const style = moving(p, closing, h, h, W, HEIGHT)
        body = (
            <View style={{ ...fill, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 28 }}>
                <View style={{ width: 30, height: 30, borderRadius: 8, borderWidth: 2, borderColor: c.muted, alignItems: 'center', justifyContent: 'center' }}>
                    <Animated.View style={[{ width: 30, height: 30, borderRadius: 8, backgroundColor: c.brand }, style]} />
                </View>
                <View style={{ width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: c.muted, alignItems: 'center', justifyContent: 'center' }}>
                    <Animated.View style={[{ width: 16, height: 16, borderRadius: 8, backgroundColor: c.brand }, style]} />
                </View>
                <View style={{ width: 52, height: 30, borderRadius: 15, backgroundColor: c.raised, justifyContent: 'center', paddingHorizontal: 3 }}>
                    <Animated.View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.brand, transform: [{ translateX: lerp(p, 0, 22) }] }} />
                </View>
            </View>
        )
    } else if (module === 'sheet') {
        body = (
            <>
                <Animated.View style={[fill, { backgroundColor: '#000', opacity: lerp(p, 0, 0.45) }]} />
                <Animated.View
                    style={[
                        { position: 'absolute', left: 8, right: 8, bottom: 0, height: 104, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: c.raised, padding: 14, gap: 10 },
                        { transform: [{ translateY: lerp(p, 120, 0) }] },
                    ]}
                >
                    <View style={{ alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: c.muted }} />
                    <Bars color={c.muted} widths={['70%', '55%', '62%']} />
                </Animated.View>
            </>
        )
    } else if (module === 'menu') {
        const halfW = 60
        const halfH = 50
        const [h, hx] = hFor(halfW * 2, halfH * 2, { anchorX: 1, anchorY: -1, halfW, halfH })
        body = (
            <>
                <View style={{ position: 'absolute', top: 12, right: 14, width: 26, height: 26, borderRadius: 13, backgroundColor: c.brandSoft }} />
                <Animated.View
                    style={[
                        { position: 'absolute', top: 44, right: 14, width: halfW * 2, height: halfH * 2, borderRadius: 12, backgroundColor: c.raised, padding: 12, gap: 12, borderWidth: 1, borderColor: c.border },
                        moving(p, closing, h, hx, W, HEIGHT),
                    ]}
                >
                    <Bars color={c.muted} widths={['80%', '60%', '70%']} gap={12} />
                </Animated.View>
            </>
        )
    } else if (module === 'media') {
        // 채팅의 사진 → 전체 화면 보기
        const thumb = { left: 46, top: 40, width: 70, height: 52 }
        const full = { left: 10, top: 14, width: W - 20, height: HEIGHT - 28 }
        const zoom = shown.effect === 'zoom' || shown.effect === 'grow' || instant
        const [h] = hFor(full.width, full.height)
        const card = zoom
            ? {
                  left: lerp(p, thumb.left, full.left),
                  top: lerp(p, thumb.top, full.top),
                  width: lerp(p, thumb.width, full.width),
                  height: lerp(p, thumb.height, full.height),
                  borderRadius: lerp(p, 10, 4),
              }
            : [full, { borderRadius: 4 }, moving(p, undefined, h, h, W, HEIGHT)]
        body = (
            <>
                <View style={{ position: 'absolute', left: 14, top: 14, flexDirection: 'row', gap: 8 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.raised }} />
                    <View style={{ height: 8, width: 80, marginTop: 6, borderRadius: 4, backgroundColor: c.muted }} />
                </View>
                <View style={{ position: 'absolute', ...thumb, borderRadius: 10, backgroundColor: c.brandSoft }} />
                <Animated.View style={[fill, { backgroundColor: '#000', opacity: lerp(p, 0, 0.9) }]} />
                <Animated.View style={[{ position: 'absolute', backgroundColor: c.brand, overflow: 'hidden' }, card]} />
            </>
        )
    } else if (module === 'alert' || module === 'backdrop') {
        // 배경 미리보기는 확인창 기본 모습 + 배경 진하기
        const dim = module === 'backdrop' ? (shown.effect === 'none' ? 0 : shown.effect === 'solid' ? (shown.amount ?? 0.6) * 0.5 : 0.5) : 0.5
        const cardW = Math.min(220, W - 60)
        const [h, hx] = module === 'backdrop' ? [adjust(applyMove({ o: 0, s: 0.7, ty: 50 }, undefined, 0, 0)), adjust(applyMove({ o: 0, s: 0.7, ty: 50 }, undefined, 0, 0))] : hFor(cardW, 120)
        body = (
            <>
                <Animated.View style={[fill, { backgroundColor: '#000', opacity: lerp(p, 0, dim) }]} />
                <View style={{ ...fill, alignItems: 'center', justifyContent: 'center' }}>
                    <Animated.View style={[{ width: cardW, borderRadius: 16, backgroundColor: c.raised, padding: 14, gap: 12 }, moving(p, closing, h, hx, W, HEIGHT)]}>
                        <View style={{ height: 9, width: '50%', borderRadius: 4, backgroundColor: c.text }} />
                        <Bars color={c.muted} widths={['90%', '70%']} />
                        <View style={{ height: 22, borderRadius: 11, backgroundColor: c.brand }} />
                    </Animated.View>
                </View>
            </>
        )
    } else {
        const [h, hx] = hFor(160, 34, { edge: -50 })
        body = (
            <View style={{ position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' }}>
                <Animated.View
                    style={[
                        { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: c.raised, borderWidth: 1, borderColor: c.border },
                        moving(p, closing, h, hx, W, HEIGHT),
                    ]}
                >
                    <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c.brand }} />
                    <View style={{ height: 7, width: 90, borderRadius: 4, backgroundColor: c.text }} />
                </Animated.View>
            </View>
        )
    }

    const behind = module === 'sheet' || module === 'alert' || module === 'backdrop' || module === 'toast' || module === 'menu'
    return (
        <View onLayout={e => setW(Math.round(e.nativeEvent.layout.width))} style={{ height: HEIGHT, borderRadius: 14, overflow: 'hidden', backgroundColor: isScreen ? c.surface : c.base }}>
            {behind && (
                <View style={{ ...fill, padding: 14 }}>
                    <Bars color={c.border} widths={['70%', '50%', '80%', '45%', '65%', '55%']} gap={12} />
                </View>
            )}
            {body}
        </View>
    )
}
