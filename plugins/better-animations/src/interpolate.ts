import { Animated, Easing } from 'react-native'
import { applyMove, easingFrom, normalize, springFor, type Effect, type EasingKey, type MoveOptions, type Normalized } from './effects'

/**
 * @react-navigation/stack 의 cardStyleInterpolator 를 효과 정의(hidden/under/dim)로 만든다.
 * 설정 화면 미리보기도 같은 함수를 쓴다.
 *
 * 나갈 때 효과가 따로 있으면 react-navigation 이 넘기는 closing(닫히는 중이면 1)으로
 * 나타날 때 값과 나갈 때 값을 섞는다. 둘 다 Animated 노드라 네이티브 드라이버로 돈다.
 */

const clamp = 'clamp' as const
const lerp = (node: any, from: any, to: any) => node.interpolate({ inputRange: [0, 1], outputRange: [from, to], extrapolate: clamp })
const toDeg = (node: any) => node.interpolate({ inputRange: [-720, 720], outputRange: ['-720deg', '720deg'] })

function isIdentity(h: Normalized) {
    return h.o === 1 && !h.tx && !h.ty && !h.txW && !h.tyH && h.s === 1 && h.sy === 1 && !h.r && !h.rx && !h.ry
}

/** progress 0 → hidden, 1 → 원래 모습. hx/closing 이 있으면 닫히는 동안은 hx 를 쓴다 */
export function partsFor(progress: any, h: Normalized, W: number, H: number, inverted: any, hx?: Normalized, closing?: any) {
    const blend = (from: number, fromX: number, to: number) => {
        if (!hx || !closing || from === fromX) return lerp(progress, from, to)
        return Animated.add(Animated.multiply(lerp(progress, from, to), Animated.subtract(1, closing)), Animated.multiply(lerp(progress, fromX, to), closing))
    }
    const x = hx ?? h
    const transform: any[] = []
    const tx = h.tx + h.txW * W
    const ty = h.ty + h.tyH * H
    const txX = x.tx + x.txW * W
    const tyX = x.ty + x.tyH * H
    if (tx || txX) {
        const v = blend(tx, txX, 0)
        transform.push({ translateX: inverted ? Animated.multiply(v, inverted) : v })
    }
    if (ty || tyX) transform.push({ translateY: blend(ty, tyX, 0) })
    if (h.s !== 1 || x.s !== 1) transform.push({ scale: blend(h.s, x.s, 1) })
    if (h.sy !== 1 || x.sy !== 1) transform.push({ scaleY: blend(h.sy, x.sy, 1) })
    const deg = (from: number, fromX: number) => (!hx || !closing || from === fromX ? lerp(progress, `${from}deg`, '0deg') : toDeg(blend(from, fromX, 0)))
    if (h.r || x.r) transform.push({ rotate: deg(h.r, x.r) })
    if (h.rx || x.rx) transform.push({ rotateX: deg(h.rx, x.rx) })
    if (h.ry || x.ry) transform.push({ rotateY: deg(h.ry, x.ry) })
    const opacity = h.o !== 1 || x.o !== 1 ? blend(h.o, x.o, 1) : undefined
    return { transform, opacity }
}

export interface CardOptions {
    /** 나갈 때 효과 (없거나 같으면 나타날 때 효과를 거꾸로) */
    exit?: Effect
    move?: MoveOptions
}

export function makeCardInterpolator(effect: Effect, opts?: CardOptions) {
    const under = effect.under ? normalize(effect.under) : undefined
    const dim = effect.dim ?? 0
    const exit = opts?.exit && opts.exit.id !== effect.id ? opts.exit : undefined
    return ({ current, next, inverted, layouts, closing }: any) => {
        const W = layouts?.screen?.width ?? 400
        const H = layouts?.screen?.height ?? 800
        const h = applyMove(effect.hidden, opts?.move, W, H)
        const hx = exit ? applyMove(exit.hidden, opts?.move, W, H) : undefined
        const enter = partsFor(current.progress, h, W, H, inverted, hx, closing)
        // 위에 새 화면이 덮일 때(next) 이 화면이 어떻게 변하는지: next 0 → 원래, 1 → under
        const cover = under && next ? partsFor(Animated.subtract(1, next.progress), under, W, H, inverted) : undefined
        const transform = [{ perspective: 1000 }, ...enter.transform, ...(cover?.transform ?? [])]
        const opacity =
            enter.opacity && cover?.opacity ? Animated.multiply(enter.opacity, cover.opacity) : (enter.opacity ?? cover?.opacity ?? undefined)
        const cardStyle: any = { transform }
        if (opacity !== undefined) cardStyle.opacity = opacity
        const out: any = { cardStyle }
        if (dim) out.overlayStyle = { opacity: lerp(current.progress, 0, dim) }
        return out
    }
}

export const noAnimation = () => ({})

export function transitionSpecFor(duration: number, easing: EasingKey) {
    if (easing === 'spring') return { animation: 'spring', config: springFor(duration, 0.7) }
    return { animation: 'timing', config: { duration, easing: easingFrom(Easing, easing) } }
}

export const isStatic = (effect: Effect) => isIdentity(normalize(effect.hidden)) && !effect.under
