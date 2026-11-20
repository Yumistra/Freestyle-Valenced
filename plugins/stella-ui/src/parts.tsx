import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Component, memo, useEffect, useRef, useState } from 'react'
import { Animated, Image, Pressable, Text, View } from 'react-native'
import { useUi } from './state'
import { C, fixFont, R, shadow } from './theme'

/**
 * 여러 화면이 같이 쓰는 조각들.
 */

// ── 오류가 나면 대신 그릴 것 ───────────────────────────────────────────
export class Boundary extends Component<{ fallback: any; children?: any }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    render() {
        return this.state.failed ? this.props.fallback : this.props.children
    }
}

// ── 아이콘 ──────────────────────────────────────────────────────────────
const icons = new Map<string, any>()
function iconOf(names: string[]): any {
    const key = names.join('|')
    if (icons.has(key)) return icons.get(key)
    let found: any
    for (const n of names) {
        try {
            found = lookupGeneratedIconComponent(n as any)
        } catch {}
        if (found) break
    }
    if (found) icons.set(key, found)
    return found
}

export function Icon({ names, color = C.ink, size = 20 }: { names: string[]; color?: string; size?: number }) {
    const Comp = iconOf(names)
    if (!Comp) return <View style={{ width: size, height: size }} />
    return <Comp size={size >= 24 ? 'md' : 'sm'} color={color} style={{ width: size, height: size }} />
}

// ── 글 ──────────────────────────────────────────────────────────────────
export function T({ children, size = 14, color = C.ink, weight = '600', lines, style }: { children: any; size?: number; color?: string; weight?: '400' | '500' | '600' | '700' | '800'; lines?: number; style?: any }) {
    return (
        <Text numberOfLines={lines} textBreakStrategy="simple" style={fixFont([{ fontSize: size, color, fontWeight: weight, includeFontPadding: false }, style])}>
            {children}
        </Text>
    )
}

// ── 프로필 그림 ─────────────────────────────────────────────────────────
export const Avatar = memo(function Avatar({ uri, size = 44, ring = C.white }: { uri?: string; size?: number; ring?: string }) {
    return (
        <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: ring, backgroundColor: C.blueSoft, overflow: 'hidden' }}>
            {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} /> : null}
        </View>
    )
})

// ── 배지 ────────────────────────────────────────────────────────────────
/** 게임처럼: 멘션이 있으면 빨간 느낌표, 안 읽음만 있으면 주황 점 세 개 */
export function Badge({ unread, mentions, style }: { unread: boolean; mentions: number; style?: any }) {
    if (!unread && !mentions) return null
    const bg = mentions ? C.red : C.orange
    return (
        <View style={[{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, backgroundColor: bg, borderWidth: 2, borderColor: C.white, alignItems: 'center', justifyContent: 'center' }, style]}>
            <Text textBreakStrategy="simple" style={fixFont({ fontSize: 12, lineHeight: 15, color: C.white, fontWeight: 'bold', textAlign: 'center', includeFontPadding: false, textAlignVertical: 'center' })}>
                {mentions ? (mentions > 9 ? '9+' : '!') : '···'}
            </Text>
        </View>
    )
}

/** 빨간 점 (새 것이 있을 때) */
export const Dot = ({ style }: { style?: any }) => <View style={[{ width: 12, height: 12, borderRadius: 6, backgroundColor: C.red, borderWidth: 2, borderColor: C.white }, style]} />

// ── 왼쪽 위 ↩, 🏠 버튼 ───────────────────────────────────────────────────
function SlantButton({ names, onPress, label }: { names: string[]; onPress: () => void; label: string }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={({ pressed }) => [{ transform: [{ skewX: '-10deg' }, { scale: pressed ? 0.94 : 1 }] }]}>
            <View style={[{ width: 62, height: 44, borderRadius: 6, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                <View style={{ transform: [{ skewX: '10deg' }] }}>
                    <Icon names={names} color={C.navy} size={24} />
                </View>
            </View>
        </Pressable>
    )
}

export function NavButtons({ onBack, onHome }: { onBack: () => void; onHome?: () => void }) {
    return (
        <View style={{ flexDirection: 'row', gap: 10 }}>
            <SlantButton names={['ArrowLargeLeftIcon', 'ArrowLeftIcon', 'ChevronLargeLeftIcon']} onPress={onBack} label="Back" />
            {onHome ? <SlantButton names={['HomeIcon', 'ServerIcon']} onPress={onHome} label="Lobby" /> : null}
        </View>
    )
}

/** 📍 위치 칩 (지금 있는 곳) */
export function PlaceChip({ text }: { text: string }) {
    return (
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: R.pill, backgroundColor: C.navy }, shadow(2)]}>
            <Icon names={['LocationIcon', 'PinIcon', 'MapPinIcon']} color={C.white} size={16} />
            <T size={14} color={C.white} weight="700" lines={1} style={{ maxWidth: 260 }}>
                {text}
            </T>
        </View>
    )
}

// ── 버튼 ────────────────────────────────────────────────────────────────
export function PillButton({ label, onPress, kind = 'teal', small }: { label: string; onPress: () => void; kind?: 'teal' | 'white'; small?: boolean }) {
    const teal = kind === 'teal'
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
            <View
                style={[
                    { height: small ? 32 : 40, paddingHorizontal: small ? 14 : 22, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: teal ? C.teal : C.white, borderWidth: teal ? 0 : 1.5, borderColor: C.line },
                    shadow(2),
                ]}
            >
                <T size={small ? 13 : 15} color={teal ? C.white : C.ink} weight="700">
                    {label}
                </T>
            </View>
        </Pressable>
    )
}

/** 로비의 동그란 아이콘 버튼 (아래 이름표) */
export function RoundButton({ names, label, onPress, dot, size = 64 }: { names: string[]; label: string; onPress: () => void; dot?: boolean; size?: number }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ alignItems: 'center', transform: [{ scale: pressed ? 0.93 : 1 }] }]}>
            <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: 'rgba(255,255,255,0.9)', borderWidth: 2, borderColor: C.white, alignItems: 'center', justifyContent: 'center' }, shadow(4)]}>
                <Icon names={names} color={C.navy} size={Math.round(size * 0.46)} />
            </View>
            {dot ? <Dot style={{ position: 'absolute', top: 2, right: 2 }} /> : null}
            <View style={{ marginTop: -8, paddingHorizontal: 9, paddingVertical: 2, minHeight: 22, borderRadius: R.pill, backgroundColor: C.white, justifyContent: 'center', borderWidth: 1, borderColor: C.line }}>
                <T size={12} color={C.ink} weight="700">
                    {label}
                </T>
            </View>
        </Pressable>
    )
}

// ── 배경 ────────────────────────────────────────────────────────────────
/** 위에서 아래로 두 색 사이를 나눈 띠 (그라데이션 대신) */
function mix(a: string, b: string, t: number) {
    const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
    const c = [0, 1, 2].map(i => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t))
    return `rgb(${c[0]},${c[1]},${c[2]})`
}
const BANDS = 14
const SKY = Array.from({ length: BANDS }, (_, i) => {
    const t = i / (BANDS - 1)
    return t < 0.55 ? mix(C.skyTop, C.skyMid, t / 0.55) : mix(C.skyMid, C.skyLow, (t - 0.55) / 0.45)
})
const CLOUDS = [
    { l: '6%', t: '16%', w: 220, h: 54, o: 0.75 },
    { l: '58%', t: '10%', w: 300, h: 70, o: 0.6 },
    { l: '30%', t: '34%', w: 180, h: 44, o: 0.5 },
    { l: '74%', t: '40%', w: 240, h: 58, o: 0.55 },
]

/** 기본 풍경: 하늘, 구름, 먼 언덕 (직접 그린 것) */
export const Scenery = memo(function Scenery() {
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
            {SKY.map((c, i) => (
                <View key={i} style={{ flex: 1, backgroundColor: c }} />
            ))}
            <View style={{ position: 'absolute', right: '12%', top: '8%', width: 160, height: 160, borderRadius: 80, backgroundColor: 'rgba(255,250,225,0.55)' }} />
            {CLOUDS.map((c, i) => (
                <View key={i} style={{ position: 'absolute', left: c.l as any, top: c.t as any, width: c.w, height: c.h, borderRadius: c.h / 2, backgroundColor: `rgba(255,255,255,${c.o})` }} />
            ))}
            <View style={{ position: 'absolute', left: '-10%', right: '35%', bottom: '-30%', height: '55%', borderRadius: 600, backgroundColor: '#8fc7a8' }} />
            <View style={{ position: 'absolute', left: '30%', right: '-15%', bottom: '-34%', height: '58%', borderRadius: 700, backgroundColor: '#7dbb9b' }} />
        </View>
    )
})

/** 배경: 고른 그림이 있으면 그것, 없으면 기본 풍경. blur 로 흐리게 */
export function Backdrop({ uri, blur = 0, dim = 0 }: { uri?: string; blur?: number; dim?: number }) {
    const [failed, setFailed] = useState(false)
    useEffect(() => setFailed(false), [uri])
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.skyMid }} pointerEvents="none">
            {uri && !failed ? <Image source={{ uri }} resizeMode="cover" blurRadius={blur} onError={() => setFailed(true)} style={{ width: '100%', height: '100%' }} /> : <Scenery />}
            {dim ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: `rgba(20,32,74,${dim})` }} /> : null}
        </View>
    )
}

// ── 휴대폰 틀 ───────────────────────────────────────────────────────────
function useClock() {
    const fmt = () => {
        const d = new Date()
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const [now, setNow] = useState(fmt)
    useEffect(() => {
        // 분이 바뀔 때만 다시 그린다
        let t: any
        const tick = () => {
            setNow(fmt())
            t = setTimeout(tick, 60000 - (Date.now() % 60000) + 50)
        }
        t = setTimeout(tick, 60000 - (Date.now() % 60000) + 50)
        return () => clearTimeout(t)
    }, [])
    return now
}

function Signal() {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 }}>
            {[4, 7, 10, 12].map((h, i) => (
                <View key={i} style={{ width: 3, height: h, borderRadius: 1, backgroundColor: i < 3 ? C.ink : C.line }} />
            ))}
        </View>
    )
}

/** 게임 속 휴대폰 (남색 테두리, 위 상태 줄) */
export function Phone({ children, title, footer, style }: { children: any; title?: string; footer?: any; style?: any }) {
    const now = useClock()
    return (
        <View style={[{ borderRadius: 38, borderWidth: 9, borderColor: C.navy, backgroundColor: C.panel, overflow: 'hidden' }, shadow(10), style]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 12, height: 40 }}>
                <T size={14} weight="700">
                    {now}
                </T>
                <View style={{ width: 72, height: 18, borderRadius: 9, backgroundColor: '#cfd6e6' }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Signal />
                    <View style={{ width: 22, height: 11, borderRadius: 3, backgroundColor: C.ink }} />
                </View>
            </View>
            {title ? (
                <T size={20} weight="800" style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8 }}>
                    {title}
                </T>
            ) : null}
            <View style={{ flex: 1 }}>{children}</View>
            {footer}
        </View>
    )
}

/** 휴대폰 아래 탭 줄 */
export function PhoneTabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: string; icon: string[]; dot?: boolean }[]; value: K; onChange: (k: K) => void }) {
    return (
        <View style={[{ flexDirection: 'row', margin: 10, padding: 5, borderRadius: R.pill, backgroundColor: C.white }, shadow(4)]}>
            {tabs.map(t => {
                const on = t.key === value
                return (
                    <Pressable key={t.key} onPress={() => onChange(t.key)} accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: on }} style={{ flex: 1 }}>
                        <View style={{ height: 40, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: on ? C.blue : 'transparent' }}>
                            <Icon names={t.icon} color={on ? C.white : C.ink} size={18} />
                            <T size={14} color={on ? C.white : C.ink} weight="700">
                                {t.label}
                            </T>
                            {t.dot ? <Dot style={{ position: 'absolute', top: 0, right: 8 }} /> : null}
                        </View>
                    </Pressable>
                )
            })}
        </View>
    )
}

// ── 빈 화면 (말풍선 아이콘과 한 줄) ──────────────────────────────────────
export function Empty({ text }: { text: string }) {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <View style={{ width: 150, height: 120, borderRadius: 60, borderWidth: 10, borderColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 22 }}>
                <View style={{ width: 14, height: 34, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.28)' }} />
                <View style={{ width: 14, height: 34, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.28)' }} />
            </View>
            <T size={16} color="rgba(255,255,255,0.75)" weight="700" style={{ marginTop: 24, textAlign: 'center' }}>
                {text}
            </T>
        </View>
    )
}

// ── 화면 전환: 청록 사선이 지나간다 ──────────────────────────────────────
export function Wipe({ width }: { width: number }) {
    const turn = useUi(s => s.turn)
    const x = useRef(new Animated.Value(1)).current
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        x.setValue(0)
        const a = Animated.timing(x, { toValue: 1, duration: 420, useNativeDriver: true })
        a.start()
        return () => a.stop()
    }, [turn])
    const w = width * 1.6
    const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-w, width + w * 0.2] })
    return (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: -200, bottom: -200, width: w, left: 0, transform: [{ translateX }, { skewX: '-18deg' }] }}>
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View style={{ flex: 1, backgroundColor: 'rgba(25,195,203,0.55)' }} />
                <View style={{ flex: 3, backgroundColor: C.teal }} />
                <View style={{ flex: 1, backgroundColor: 'rgba(25,195,203,0.55)' }} />
            </View>
        </Animated.View>
    )
}
