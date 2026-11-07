import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Animated, Dimensions, Pressable, View } from 'react-native'
import { T, useColor } from './colors'

/**
 * 디스코드 툴팁(design Tooltip.native.tsx)을 그대로 따라 만든 것.
 * 디스코드 것은 화면에 LayerScope 가 있어야 떠서, 같은 값으로 플러그인 화면 맨 위 층에 직접 그린다.
 *  - 상자: paddingHorizontal space.PX_8, paddingVertical space.PX_4, radii.sm, maxWidth 150
 *  - 색: CONTROL_PRIMARY_BACKGROUND_DEFAULT, 누르면 _ACTIVE 로 (ON_PRESS_SPRING)
 *  - 글: text-xs/bold, text-overlay-light, 가운데
 *  - 꼬리: 6px 삼각형 (테두리 트릭), 대상 가운데를 가리킨다
 *  - 자리: 대상에서 4px, 화면 끝에서 12px 안쪽으로 밀고 꼬리는 그만큼 반대로
 *  - 나타나기: TOOLTIP_SPRING 으로 투명도 0→1, 8px 미끄러져 들어온다 (위쪽이면 아래에서 위로)
 */

export type Position = 'top' | 'bottom' | 'left' | 'right'
interface Rect {
    x: number
    y: number
    width: number
    height: number
}
interface Req {
    id: number
    text: string
    target: Rect
    position: Position
}

const TOOLTIP_SPRING = { stiffness: 450, damping: 35, mass: 0.5, overshootClamping: true, restDisplacementThreshold: 0.001 }
const ON_PRESS_SPRING = { stiffness: 300, damping: 27, mass: 1, overshootClamping: true }
const GAP = 4
const EDGE = 12
const ARROW = 6
const SHOW_MS = 2500

const num = (v: any, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const reducedMotion = () => {
    try {
        return !!(Stores as any).AccessibilityStore?.useReducedMotion
    } catch {
        return false
    }
}

const Ctx = createContext<{ show: (r: Omit<Req, 'id'>) => void; hide: () => void } | null>(null)

/** 툴팁이 그려질 맨 위 층. 플러그인 설정 화면 전체를 감싼다 */
export function TooltipHost({ children }: { children: any }) {
    const [req, setReq] = useState<Req | null>(null)
    const host = useRef<any>(null)
    const seq = useRef(0)
    const api = useRef({
        show: (r: Omit<Req, 'id'>) => setReq({ ...r, id: ++seq.current }),
        hide: () => setReq(null),
    }).current
    return (
        <Ctx.Provider value={api}>
            <View ref={host} style={{ flex: 1 }} collapsable={false}>
                {children}
                {req ? <Bubble key={req.id} req={req} host={host} onGone={() => setReq(r => (r?.id === req.id ? null : r))} /> : null}
            </View>
        </Ctx.Provider>
    )
}

export const useTooltipHide = () => useContext(Ctx)?.hide ?? (() => {})

function Bubble({ req, host, onGone }: { req: Req; host: any; onGone: () => void }) {
    const { Text } = Design as any
    const [origin, setOrigin] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
    const [size, setSize] = useState<{ width: number; height: number } | null>(null)
    const shown = useRef(new Animated.Value(0)).current
    const pressed = useRef(new Animated.Value(0)).current
    const leaving = useRef(false)
    const horizontal = req.position === 'left' || req.position === 'right'
    // 디스코드: top 8, bottom -8, left 8, right -8 에서 0 으로
    const from = req.position === 'top' || req.position === 'left' ? 8 : -8

    useEffect(() => {
        host.current?.measureInWindow?.((x: number, y: number, w: number, h: number) => setOrigin({ x, y, w, h }))
    }, [])
    const animate = (to: number, done?: () => void) => {
        if (reducedMotion()) {
            shown.setValue(to)
            done?.()
            return
        }
        Animated.spring(shown, { toValue: to, ...TOOLTIP_SPRING, useNativeDriver: true }).start(() => done?.())
    }
    const leave = () => {
        if (leaving.current) return
        leaving.current = true
        animate(0, onGone)
    }
    useEffect(() => {
        if (!size || !origin) return
        animate(1)
        const t = setTimeout(leave, SHOW_MS)
        return () => clearTimeout(t)
    }, [size, origin])

    // 위치 (useTooltipPosition 과 같은 계산)
    let left = -9999
    let top = -9999
    let adjust = 0
    if (size && origin) {
        const tx = req.target.x - origin.x
        const ty = req.target.y - origin.y
        const W = origin.w || Dimensions.get('window').width
        const H = origin.h || Dimensions.get('window').height
        const center = (start: number, length: number, own: number, total: number) => {
            const p = start + length / 2 - own / 2
            let a = 0
            if (p < EDGE) a = EDGE - p
            else if (p + own > total - EDGE) a = total - p - own - EDGE
            return { p: p + a, a }
        }
        if (horizontal) {
            const c = center(ty, req.target.height, size.height, H)
            top = c.p
            adjust = c.a
            left = req.position === 'left' ? tx - size.width - GAP : tx + req.target.width + GAP
        } else {
            const c = center(tx, req.target.width, size.width, W)
            left = c.p
            adjust = c.a
            top = req.position === 'top' ? ty - size.height - GAP : ty + req.target.height + GAP
        }
    }

    const bg = useColor(['CONTROL_PRIMARY_BACKGROUND_DEFAULT', 'BACKGROUND_BRAND'], '#5865f2')
    const bgPressed = useColor(['CONTROL_PRIMARY_BACKGROUND_ACTIVE', 'CONTROL_PRIMARY_BACKGROUND_DEFAULT'], '#4752c4')
    const fill = pressed.interpolate({ inputRange: [0, 1], outputRange: [bg, bgPressed] })
    const t = T()
    const box = {
        paddingHorizontal: num(t?.space?.PX_8, 8),
        paddingVertical: num(t?.space?.PX_4, 4),
        borderRadius: num(t?.radii?.sm, 4),
        maxWidth: 150,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    }
    const tri = (dir: 'up' | 'down' | 'left' | 'right') => {
        const base: any = { width: 0, height: 0, borderStyle: 'solid', borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: 'transparent', borderBottomColor: 'transparent' }
        if (dir === 'down') Object.assign(base, { borderLeftWidth: ARROW, borderRightWidth: ARROW, borderTopWidth: ARROW, borderTopColor: fill, left: -adjust })
        if (dir === 'up') Object.assign(base, { borderLeftWidth: ARROW, borderRightWidth: ARROW, borderBottomWidth: ARROW, borderBottomColor: fill, left: -adjust })
        if (dir === 'right') Object.assign(base, { borderTopWidth: ARROW, borderBottomWidth: ARROW, borderLeftWidth: ARROW, borderLeftColor: fill, top: -adjust })
        if (dir === 'left') Object.assign(base, { borderTopWidth: ARROW, borderBottomWidth: ARROW, borderRightWidth: ARROW, borderRightColor: fill, top: -adjust })
        return <Animated.View style={base} />
    }
    const offset = shown.interpolate({ inputRange: [0, 1], outputRange: [from, 0] })
    return (
        <Animated.View
            style={{
                position: 'absolute',
                left,
                top,
                alignItems: 'center',
                flexDirection: horizontal ? 'row' : 'column',
                opacity: size && origin ? shown : 0,
                transform: horizontal ? [{ translateX: offset }] : [{ translateY: offset }],
                zIndex: 1000,
                elevation: 1000,
            }}
            onLayout={(e: any) => {
                const { width, height } = e.nativeEvent.layout
                if (!size || size.width !== width || size.height !== height) setSize({ width, height })
            }}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={req.text}
                onPress={leave}
                onPressIn={() => Animated.spring(pressed, { toValue: 1, ...ON_PRESS_SPRING, useNativeDriver: false }).start()}
                onPressOut={() => Animated.spring(pressed, { toValue: 0, ...ON_PRESS_SPRING, useNativeDriver: false }).start()}
                style={{ alignItems: 'center', flexDirection: horizontal ? 'row' : 'column' }}
            >
                {req.position === 'bottom' ? tri('up') : req.position === 'right' ? tri('left') : null}
                <Animated.View style={[box, { backgroundColor: fill }]}>
                    <Text variant="text-xs/bold" color="text-overlay-light" style={{ textAlign: 'center' }}>
                        {req.text}
                    </Text>
                </Animated.View>
                {req.position === 'top' ? tri('down') : req.position === 'left' ? tri('right') : null}
            </Pressable>
        </Animated.View>
    )
}

/**
 * 막힌 버튼: 흐리게 두고 누르면 툴팁으로 이유를 보여 준다.
 * anchor 로 대상 안의 일부(예: 줄 오른쪽 끝의 스위치)만 가리킬 수 있다.
 */
export function Blocked({
    text,
    position = 'top',
    anchor,
    onBlocked,
    children,
}: {
    text?: string
    position?: Position
    anchor?: (r: Rect) => Rect
    onBlocked?: () => void
    children: any
}) {
    const ctx = useContext(Ctx)
    const ref = useRef<any>(null)
    if (!text) return children
    const press = () => {
        onBlocked?.()
        ref.current?.measureInWindow?.((x: number, y: number, width: number, height: number) => {
            const r = { x, y, width, height }
            ctx?.show({ text, target: anchor ? anchor(r) : r, position })
        })
    }
    return (
        <View ref={ref} collapsable={false}>
            <View style={{ opacity: 0.4 }} pointerEvents="none">
                {children}
            </View>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={press} />
        </View>
    )
}
