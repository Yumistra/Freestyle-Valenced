import { instead } from '@valenced/patcher'
import { createElement, forwardRef, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, Easing, Pressable, StyleSheet } from 'react-native'
import { easingFrom, effectOf, normalize, springFor } from '../effects'
import { active, report, status, version } from '../settings'

/**
 * 버튼 누르기: 원래 움직임이 없던 버튼(RN Pressable 로 만든 것 전부)에도 같은 효과를.
 *
 * 디스코드가 원래 작아지게 만든 버튼은 Reanimated 워클릿(useButtonScaleStyles)이라 worklets.ts 가 맡는다.
 * 그 버튼도 속은 Pressable 이지만 Reanimated 가 collapsable: false 를 붙여 넘기므로 그건 건너뛴다.
 * 나머지 Pressable 은 같은 Pressable(안쪽 forwardRef) 을 Animated 로 감싼 것으로 바꿔 그린다.
 * 큰 버튼(목록 한 줄 등)은 크기에 맞춰 덜 움직인다.
 *
 * 바꿔치기는 그리는 순간(Pressable 안쪽 forwardRef 의 render)에 한다. 요소 종류(element.type)는 그대로 Pressable 이라서
 * 다른 플러그인이 "이게 Pressable 인지" 확인하거나 그 children 을 고쳐도 그대로 된다 (예: File Size on Picker).
 */

/** 이 비율 이상 넓은 버튼은 누르기 효과 없음 (화면 폭 기준) */
const WIDE = 0.7

/** Animated 로 감싼 쪽에서 원래 Pressable 을 그릴 때 붙이는 표시 */
const MARK = '__baPressInner'

const inner: any = (Pressable as any)?.type ?? Pressable
const AnimatedPressable: any = inner && inner !== Pressable ? Animated.createAnimatedComponent(inner) : undefined

function poseFor(effect: string) {
    return normalize(effectOf('press', effect).hidden)
}

function run(p: Animated.Value, to: number) {
    const m = active('press')
    if (!m) return
    const cfg =
        m.easing === 'spring'
            ? Animated.spring(p, { toValue: to, useNativeDriver: true, ...springFor(m.duration, 0.45) })
            : Animated.timing(p, { toValue: to, duration: m.duration, easing: easingFrom(Easing, m.easing as any), useNativeDriver: true })
    cfg.start()
}

const PressAnim = forwardRef(function BetterAnimationsPressable(props: any, ref: any) {
    const p = useRef<Animated.Value>(null as any)
    if (!p.current) p.current = new Animated.Value(0)
    const [size, setSize] = useState(0)
    const [pressed, setPressed] = useState(false)
    const m = active('press')
    const effect = m?.effect ?? 'none'
    const fnStyle = typeof props.style === 'function'

    const anim = useMemo(() => {
        const h = poseFor(effect)
        // 큰 버튼은 덜 (가로·세로 중 긴 쪽 120px 넘으면 그만큼 줄여서).
        // 화면 폭에 가까운 줄(채널 목록 한 줄 등)은 움직이지 않는다: 누르는 동안 줄이 변형되면
        // 디스코드가 눌린 자리를 다시 재고, 패널 열기 제스처와 겹친다
        const k = size <= 0 ? 1 : size >= Dimensions.get('window').width * WIDE ? 0 : Math.min(1, 120 / size)
        if (k === 0) return { t: [] as any[], o: undefined }
        const ip = (to: number) => p.current.interpolate({ inputRange: [0, 1], outputRange: [0, to] })
        const t: any[] = []
        if (h.rx) t.push({ perspective: 600 })
        if (h.tx) t.push({ translateX: ip(h.tx * k) })
        if (h.ty) t.push({ translateY: ip(h.ty * k) })
        if (h.s !== 1) t.push({ scale: p.current.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + (h.s - 1) * k] }) })
        if (h.sy !== 1) t.push({ scaleY: p.current.interpolate({ inputRange: [0, 1], outputRange: [1, 1 + (h.sy - 1) * k] }) })
        if (h.r) t.push({ rotate: p.current.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${h.r * k}deg`] }) })
        if (h.rx) t.push({ rotateX: p.current.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${h.rx * k}deg`] }) })
        return { t, o: h.o !== 1 ? p.current.interpolate({ inputRange: [0, 1], outputRange: [1, h.o] }) : undefined }
    }, [effect, size, version])

    const base = fnStyle ? props.style({ pressed, hovered: false }) : props.style
    let style: any = base
    if (anim.t.length || anim.o) {
        const flat: any = StyleSheet.flatten(base) ?? {}
        const extra: any = {}
        if (anim.t.length) extra.transform = Array.isArray(flat.transform) ? [...flat.transform, ...anim.t] : anim.t
        if (anim.o) extra.opacity = typeof flat.opacity === 'number' ? Animated.multiply(anim.o, flat.opacity) : anim.o
        style = [base, extra]
    }

    return createElement(AnimatedPressable, {
        ...props,
        [MARK]: true,
        ref,
        style,
        onLayout(e: any) {
            const l = e?.nativeEvent?.layout
            if (l) {
                const s = Math.round(Math.max(l.width, l.height))
                if (s !== size) setSize(s)
            }
            props.onLayout?.(e)
        },
        onPressIn(e: any) {
            run(p.current, 1)
            status.presses++
            if (fnStyle) setPressed(true)
            props.onPressIn?.(e)
        },
        onPressOut(e: any) {
            run(p.current, 0)
            if (fnStyle) setPressed(false)
            props.onPressOut?.(e)
        },
    })
})

export function patchPress() {
    if (!AnimatedPressable || typeof inner?.render !== 'function') {
        report('press', 'Pressable not found')
        return
    }
    status.found.press = true
    return instead(inner, 'render', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
        const [props, ref] = args
        // Animated 로 감싼 쪽 안의 원래 Pressable
        if (props?.[MARK]) {
            const { [MARK]: _, ...rest } = props
            return orig.apply(this, [rest, ...args.slice(1)])
        }
        // 버튼마다 처음 그릴 때 한 번 정한다 (그다음에 바뀌면 훅 순서가 어긋난다)
        const decided = useRef<boolean | null>(null)
        if (decided.current === null) {
            try {
                const m = active('press')
                // 이미 Reanimated 로 움직이는 버튼(디스코드 기본 버튼 등)은 그대로
                decided.current = !!props && props.collapsable !== false && !!m && m.effect !== 'none'
            } catch (e) {
                report('press', e)
                decided.current = false
            }
        }
        if (!decided.current) return orig.apply(this, args)
        return createElement(PressAnim, { ...props, ref })
    })
}
