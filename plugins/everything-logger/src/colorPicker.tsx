import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useRef, useState } from 'react'
import { NativeModules, PanResponder, Pressable, TextInput as RNTextInput, View } from 'react-native'
import { iconComponent } from './icons'
import { palette } from './logs'
import { setSettings, settings } from './store'

/**
 * 색 고르기: 디스코드 색 고르기 창 (프로필 테마 색과 같은 것).
 *  1. 디스코드 창 모듈이 이미 불러와져 있으면 그것
 *  2. 전에 찾아 둔 모듈 번호로 불러오기 (같은 디스코드 버전일 때)
 *  3. 그래도 없으면 같은 모양으로 만든 창 (헥스 칸, 추천 색, 채도/명도 판, 색상 막대)
 * 어느 쪽이든 항상 열린다.
 */
const PATH = 'modules/color_picker/native/showCustomColorPickerActionSheet.tsx'
export const SUGGESTED = [0xf23f43, 0xff7a45, 0xf0b232, 0x23a55a, 0x00a8fc, 0x5865f2, 0xb45cf6, 0xeb459e, 0x949ba4]

export const toHex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`
export const toInt = (hex: string) => (/^#?[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.replace('#', ''), 16) : undefined)

function discordPicker(): any {
    let mod: any
    try {
        const un = getModuleWithImportedPath(PATH, (m: any) => (mod = m)) as any
        if (typeof un === 'function') un()
    } catch {}
    const ok = (m: any) => (typeof m?.default === 'function' && 'CUSTOM_COLOR_PICKER_KEY' in m ? m : undefined)
    if (ok(mod)) {
        remember()
        return mod
    }
    // 전에 찾아 둔 번호 (디스코드 버전이 같을 때만)
    const saved = settings().pickerModule
    const req = (globalThis as any).__r
    if (saved && saved.build && saved.build === build() && typeof req === 'function') {
        try {
            const m = ok(req(saved.id))
            if (m) return m
        } catch {}
    }
    // 불러오지 않은 모듈까지 찾아 주는 경우
    try {
        const r: any = (lookupModule as any)(withProps('CUSTOM_COLOR_PICKER_KEY') as any, { uninitialized: true, initialize: true })
        const m = ok(r?.[0])
        if (m) {
            if (typeof r?.[1] === 'number' && build()) setSettings({ pickerModule: { id: r[1], build: build() } })
            return m
        }
    } catch {}
}

/** 디스코드 창 모듈의 번호를 남겨 둔다 (다음에 디스코드를 켰을 때 바로 불러오려고) */
function remember() {
    try {
        const r: any = lookupModule(withProps('CUSTOM_COLOR_PICKER_KEY') as any)
        if (typeof r?.[1] === 'number' && build() && settings().pickerModule?.id !== r[1]) setSettings({ pickerModule: { id: r[1], build: build() } })
    } catch {}
}

/** 디스코드 빌드 번호 (모듈 번호는 빌드마다 바뀐다) */
function build(): string {
    try {
        const c: any = (NativeModules as any)?.ClientInfoManager ?? (NativeModules as any)?.InfoDictionaryManager
        const k = c?.getConstants?.() ?? c
        return String(k?.Build ?? k?.build ?? k?.Version ?? '')
    } catch {
        return ''
    }
}

export function openColorPicker(color: number, onPick: (hex: string) => void) {
    const m = discordPicker()
    if (m) {
        try {
            m.default({ color, suggestedColors: SUGGESTED, onSelect: (c: number) => onPick(toHex(c)) })
            return
        } catch {}
    }
    try {
        ;(ActionSheetActionCreators as any).openLazy(Promise.resolve({ default: PickerSheet }), 'everything-logger-color', { color, onPick })
    } catch {}
}

// ── 같은 모양으로 만든 창 ─────────────────────────────────────────────────
function hsv2rgb(h: number, s: number, v: number) {
    const f = (n: number) => {
        const k = (n + h / 60) % 6
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    }
    return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255)
}
function rgb2hsv(n: number) {
    const r = ((n >> 16) & 255) / 255,
        g = ((n >> 8) & 255) / 255,
        b = (n & 255) / 255
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b),
        d = max - min
    let h = 0
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max }
}

let gradientMod: any
function Gradient(props: any) {
    gradientMod ??= (lookupModule(withProps('LinearGradient') as any) as any)?.[0]
    const G = gradientMod?.LinearGradient ?? gradientMod?.default
    if (G) return <G {...props} />
    // 그라데이션 부품이 없으면 띠로
    const steps = 24
    const { colors, start, end, style } = props
    const horizontal = (end?.x ?? 0) !== (start?.x ?? 0)
    return (
        <View style={[style, { flexDirection: horizontal ? 'row' : 'column', overflow: 'hidden' }]}>
            {Array.from({ length: steps }, (_, i) => (
                <View key={i} style={{ flex: 1, backgroundColor: colors[Math.min(colors.length - 1, Math.floor((i / steps) * colors.length))] }} />
            ))}
        </View>
    )
}

const HUES = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000']

function PickerSheet({ color, onPick }: { color: number; onPick: (hex: string) => void }) {
    const { ActionSheet, Text, Button } = Design as any
    const P = palette()
    const start = rgb2hsv(color)
    const [hsv, setHsv] = useState(start)
    const [hex, setHex] = useState(toHex(color))
    const cur = hsv2rgb(hsv.h, hsv.s, hsv.v)
    const set = (next: { h: number; s: number; v: number }) => {
        setHsv(next)
        setHex(toHex(hsv2rgb(next.h, next.s, next.v)))
    }
    const box = useRef({ w: 1, h: 1, hueW: 1 })
    const svPan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (e: any) => moveSv(e.nativeEvent.locationX, e.nativeEvent.locationY),
            onPanResponderMove: (e: any) => moveSv(e.nativeEvent.locationX, e.nativeEvent.locationY),
        }),
    ).current
    const huePan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (e: any) => moveHue(e.nativeEvent.locationX),
            onPanResponderMove: (e: any) => moveHue(e.nativeEvent.locationX),
        }),
    ).current
    const latest = useRef(hsv)
    latest.current = hsv
    function moveSv(x: number, y: number) {
        const s = Math.max(0, Math.min(1, x / box.current.w))
        const v = 1 - Math.max(0, Math.min(1, y / box.current.h))
        set({ ...latest.current, s, v })
    }
    function moveHue(x: number) {
        const h = Math.max(0, Math.min(359.9, (x / box.current.hueW) * 360))
        set({ ...latest.current, h })
    }
    const Check = iconComponent('CheckmarkLargeIcon')
    const done = () => {
        onPick(toHex(cur))
        try {
            ActionSheetActionCreators.hideActionSheet()
        } catch {}
    }
    const body = (
        <View style={{ paddingHorizontal: 16, paddingBottom: 24, gap: 16, alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', minHeight: 44 }}>
                <View style={{ flex: 1 }} />
                <Text variant="heading-lg/bold" style={{ color: P.header }}>
                    Pick a color
                </Text>
                <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Button text="Select" variant="secondary" size="sm" onPress={done} />
                </View>
            </View>
            <RNTextInput
                value={hex}
                onChangeText={(t: string) => {
                    setHex(t)
                    const n = toInt(t)
                    if (n !== undefined) setHsv(rgb2hsv(n))
                }}
                maxLength={7}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ alignSelf: 'stretch', height: 48, borderRadius: 24, borderWidth: 1, borderColor: P.border, paddingHorizontal: 18, fontSize: 17, color: P.text }}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 }}>
                {SUGGESTED.map(n => (
                    <Pressable key={n} accessibilityLabel={toHex(n)} onPress={() => set(rgb2hsv(n))} style={{ width: 34, height: 34, borderRadius: 6, backgroundColor: toHex(n), alignItems: 'center', justifyContent: 'center' }}>
                        {cur === n && Check ? <Check size="sm" color="#ffffff" /> : null}
                    </Pressable>
                ))}
            </View>
            <View
                {...svPan.panHandlers}
                onLayout={(e: any) => {
                    box.current.w = e.nativeEvent.layout.width
                    box.current.h = e.nativeEvent.layout.height
                }}
                style={{ width: '82%', aspectRatio: 1, borderRadius: 6, overflow: 'hidden', backgroundColor: toHex(hsv2rgb(hsv.h, 1, 1)) }}
            >
                <Gradient colors={['#ffffff', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
                <Gradient colors={['rgba(0,0,0,0)', '#000000']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} />
                <View pointerEvents="none" style={{ position: 'absolute', left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, width: 24, height: 24, marginLeft: -12, marginTop: -12, borderRadius: 12, borderWidth: 2, borderColor: '#ffffff' }} />
            </View>
            <View
                {...huePan.panHandlers}
                onLayout={(e: any) => {
                    box.current.hueW = e.nativeEvent.layout.width
                }}
                style={{ width: '82%', height: 28, justifyContent: 'center' }}
            >
                <Gradient colors={HUES} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height: 22, borderRadius: 4 }} />
                <View pointerEvents="none" style={{ position: 'absolute', left: `${(hsv.h / 360) * 100}%`, width: 18, height: 30, marginLeft: -9, borderRadius: 6, borderWidth: 2, borderColor: '#ffffff', backgroundColor: toHex(hsv2rgb(hsv.h, 1, 1)) }} />
            </View>
        </View>
    )
    return ActionSheet ? <ActionSheet>{body}</ActionSheet> : body
}

export { PickerSheet as _PickerSheet, hsv2rgb as _hsv2rgb, rgb2hsv as _rgb2hsv }
