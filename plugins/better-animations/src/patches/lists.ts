import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { createContext, createElement, useContext, useEffect, useState } from 'react'
import { Animated, Dimensions, Easing } from 'react-native'
import * as RN from 'react-native'
import { caskStyleOf } from '../effects'
import { active, report, status } from '../settings'

/**
 * Cask 3 (iOS 목록 스크롤 애니메이션)를 JS 목록(VirtualizedList/FlatList, FlashList, LegendList)에.
 * 목록의 renderItem 결과를 CaskCell 로 감싸서, 스크롤하는 동안 새로 그려지는 줄에 효과를 재생한다.
 * (네이티브 목록은 Cask.kt 가 맡는다)
 */

// ── 스크롤 중인지 ───────────────────────────────────────────────

let dragging = false
let until = 0
const scrolling = () => dragging || Date.now() < until

// ── 효과 ────────────────────────────────────────────────────────

const decel = Easing.out(Easing.quad)
const spring = (decay: number, freq: number) => (t: number) => (t >= 1 ? 1 : 1 - Math.exp(-decay * t) * Math.cos(freq * t))

/** p: 0 → 1 로 움직이는 애니메이션 */
export function caskRun(style: string, p: Animated.Value, duration: number) {
    const timing = (easing: (t: number) => number, to = 1) => Animated.timing(p, { toValue: to, duration, easing, useNativeDriver: true })
    switch (style) {
        case 'bounce':
            return timing(spring(5, 14))
        case 'glitch':
            return timing(spring(2, 30))
        case 'zoom':
        case 'shake':
        case 'swing':
            return timing(Easing.linear)
        case 'jiggle':
            return timing(Easing.inOut(Easing.ease))
        case 'permanentColor':
            return Animated.loop(Animated.sequence([timing(Easing.linear, 1), timing(Easing.linear, 0)]))
        default:
            return timing(decel)
    }
}

const lerp = (p: any, from: any, to: any) => p.interpolate({ inputRange: [0, 1], outputRange: [from, to] })
const frames = (p: any, times: number[], values: any[]) => p.interpolate({ inputRange: times, outputRange: values, extrapolate: 'clamp' })

/** 줄의 스타일과 (컬러 효과면) 덮개 투명도 */
export function caskVisual(style: string, p: any, width: number): { style?: any; overlay?: any } {
    switch (style) {
        case 'fade':
            return { style: { opacity: p } }
        case 'flip':
            return { style: { transform: [{ perspective: 800 }, { rotateX: lerp(p, '180deg', '0deg') }] } }
        case 'bounce':
        case 'stretch':
            return { style: { transform: [{ scaleX: lerp(p, 0.01, 1) }] } }
        case 'glitch':
            return { style: { transform: [{ scaleX: lerp(p, 0.3, 1) }, { scaleY: lerp(p, 0.5, 1) }] } }
        case 'helix':
            return { style: { transform: [{ perspective: 800 }, { rotateY: lerp(p, '180deg', '0deg') }] } }
        case 'rotate':
            // 원본은 360 라디안(= 약 106°)에서 돌아온다
            return { style: { transform: [{ rotate: lerp(p, '106deg', '0deg') }] } }
        case 'zoom':
            return { style: { transform: [{ scale: lerp(p, 5, 1) }] } }
        case 'drop':
            return { style: { transform: [{ translateY: lerp(p, -150, 0) }] } }
        case 'slide':
            return { style: { transform: [{ translateX: lerp(p, width, 0) }] } }
        case 'shake':
            return { style: { transform: [{ translateX: frames(p, [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1], [0, 10, -10, 10, -5, 5, -5, 0, 0]) }] } }
        case 'swing':
            return { style: { transform: [{ translateX: frames(p, [0, 0.16, 0.5, 0.83, 1], [0, 40, -50, 30, 0]) }] } }
        case 'jiggle': {
            const d = 0.075 * 57.29578
            return { style: { transform: [{ rotate: frames(p, [0, 0.2, 0.4, 0.6, 0.8, 1], ['0deg', `${-d}deg`, `${d}deg`, `${-d}deg`, `${d}deg`, '0deg']) }] } }
        }
        case 'color':
            return { overlay: lerp(p, 1, 0) }
        case 'permanentColor':
            return { overlay: lerp(p, 0.6, 0) }
        default:
            return {}
    }
}

export const randomColor = () => `rgb(${Math.floor(Math.random() * 256)},${Math.floor(Math.random() * 256)},${Math.floor(Math.random() * 256)})`

const fill = { position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: 0 }

/** 이 줄이 있는 화면 (다시 보일 때 효과를 다시 재생하려고) */
const FallbackNav = createContext<any>(undefined)
const NavContext: any = (ReactNavigationNative as any)?.NavigationContext ?? FallbackNav

function CaskCell({ children, scrolled, reveal, index = 0 }: { children: any; scrolled?: boolean; reveal?: boolean; index?: number }) {
    const navigation = useContext(NavContext) as any
    const [st] = useState(() => {
        const m = active('lists')
        const style = caskStyleOf(m?.effect)
        // reveal: 서버 목록처럼 화면에 나타날 때마다 다시 재생하는 줄
        const play = !!m && !!style && (m.always || scrolling() || !!scrolled || !!reveal)
        return { play, live: play || (!!reveal && !!style), style: style ?? '', duration: m?.duration ?? 500, p: new Animated.Value(play ? 0 : 1), color: randomColor() }
    })
    useEffect(() => {
        if (!st.live) return
        let run: any
        let timer: any
        // 나타날 땐 위에서부터 차례로
        const start = (stagger: boolean) => {
            run?.stop()
            clearTimeout(timer)
            st.p.setValue(0)
            status.listCells++
            const go = () => {
                run = caskRun(st.style, st.p, st.duration)
                run.start()
            }
            const delay = stagger ? Math.min(index, 10) * 18 : 0
            if (delay) timer = setTimeout(go, delay)
            else go()
        }
        if (st.play) start(!!reveal && !scrolled)
        // 덮고 있던 화면이 닫히기 시작할 때(뒤로 밀기 시작) 바로 다시 재생한다.
        // 다 돌아온 뒤(focus)에 재생하면 이미 보이던 목록이 늦게 다시 움직여서 어색하므로 그때는 안 한다
        const mountedAt = Date.now()
        const subs: any[] = []
        if (reveal) {
            let nav = navigation
            for (let i = 0; i < 4 && typeof nav?.addListener === 'function'; i++) {
                subs.push(
                    nav.addListener('transitionStart', (e: any) => {
                        if (e?.data?.closing === false && Date.now() - mountedAt > 400) start(true)
                    }),
                )
                nav = typeof nav.getParent === 'function' ? nav.getParent() : undefined
            }
        }
        return () => {
            run?.stop()
            clearTimeout(timer)
            for (const off of subs) if (typeof off === 'function') off()
        }
    }, [])
    if (!st.live) return children
    const v = caskVisual(st.style, st.p, Dimensions.get('window').width)
    return createElement(
        Animated.View,
        { style: v.style },
        children,
        v.overlay ? createElement(Animated.View, { pointerEvents: 'none', style: [fill, { backgroundColor: st.color, opacity: v.overlay }] }) : null,
    )
}

// ── 목록 감싸기 ──────────────────────────────────────────────────

const renderCache = new WeakMap<Function, Function>()
const handlerCache = new WeakMap<Function, Function>()
const noop = () => {}

function keyOf(info: any) {
    const item = info?.item
    const k = item?.id ?? item?.key ?? item?.channel?.id ?? info?.index
    return k == null ? undefined : String(k)
}

function wrapRenderItem(orig: any) {
    if (typeof orig !== 'function') return orig
    let w = renderCache.get(orig)
    if (!w) {
        w = function (this: unknown, info: any) {
            const el = orig.apply(this, arguments as any)
            try {
                if (!el || !active('lists')) return el
                // FlashList 는 크기 재기·고정 머리줄에도 renderItem 을 부른다
                if (info?.target && info.target !== 'Cell') return el
                return createElement(CaskCell, { key: keyOf(info) }, el)
            } catch (e) {
                report('lists', e)
                return el
            }
        }
        renderCache.set(orig, w)
    }
    return w
}

function wrapHandler(orig: any, before: () => void) {
    if (orig !== undefined && typeof orig !== 'function') return orig
    const base = orig ?? noop
    let w = handlerCache.get(base)
    if (!w || orig === undefined) {
        w = function (this: unknown) {
            before()
            return base.apply(this, arguments as any)
        }
        if (orig !== undefined) handlerCache.set(base, w)
    }
    return w
}

const begin = () => {
    dragging = true
}
const endDrag = () => {
    dragging = false
    until = Date.now() + 800
}
const settle = () => {
    until = 0
}

/**
 * FastList 의 스크롤 위치(공유 값)가 최근에 바뀌었는지. 서버 목록은 스크롤 이벤트를 JS 로 안 넘겨줘서
 * 새 줄이 그려질 때 위치가 움직였는지로 스크롤 중인지 안다
 */
const fastPos = new WeakMap<object, { pos: unknown; at: number }>()
function movedRecently(sv: any) {
    if (!sv || typeof sv !== 'object') return false
    let pos: unknown
    try {
        pos = typeof sv.get === 'function' ? sv.get() : sv.value
    } catch {
        return false
    }
    const st = fastPos.get(sv)
    if (!st) {
        fastPos.set(sv, { pos, at: 0 })
        return false
    }
    if (pos !== st.pos) {
        st.pos = pos
        st.at = Date.now()
    }
    return Date.now() - st.at < 600
}

const fastCache = new WeakMap<Function, WeakMap<object, Function>>()
const NO_SV = {}
const REVEAL = {}

/** Discord FastList (서버 목록 등): renderItem(section, row, …) */
function wrapFastRenderItem(orig: any, sv: any, reveal: boolean) {
    if (typeof orig !== 'function') return orig
    const svKey = sv && typeof sv === 'object' ? sv : reveal ? REVEAL : NO_SV
    let bySv = fastCache.get(orig)
    if (!bySv) {
        bySv = new WeakMap()
        fastCache.set(orig, bySv)
    }
    let w = bySv.get(svKey)
    if (!w) {
        w = function (this: unknown, section: any, row: any) {
            const el = orig.apply(this, arguments as any)
            try {
                if (!el || !active('lists')) return el
                return createElement(CaskCell, { key: `${section}:${row}`, scrolled: movedRecently(sv), reveal, index: typeof row === 'number' ? row : 0 }, el)
            } catch (e) {
                report('lists', e)
                return el
            }
        }
        bySv.set(svKey, w)
    }
    return w
}

/** 왼쪽 서버 목록 */
const GUILDS_BAR = 'guilds-bar-fast-list'

/** 스크롤 이벤트가 오는 동안은 스크롤 중으로 본다 (FastList 는 끌기 시작·끝 이벤트를 안 넘겨줄 수 있어서) */
const scrolled = () => {
    until = Math.max(until, Date.now() + 250)
}

function patchFastList(type: any) {
    if (!type) return
    status.found['list:FastList'] = true
    return beforeJSX(type, (args: any[]) => {
        try {
            const props = args[1]
            if (!props?.renderItem || !active('lists')) return args as any
            return [
                args[0],
                {
                    ...props,
                    renderItem: wrapFastRenderItem(props.renderItem, props.scrollPosValue, props.nativeID === GUILDS_BAR),
                    onScroll: typeof props.onScroll === 'function' || props.onScroll === undefined ? wrapHandler(props.onScroll, scrolled) : props.onScroll,
                    onScrollBeginDrag: wrapHandler(props.onScrollBeginDrag, begin),
                    onScrollEndDrag: wrapHandler(props.onScrollEndDrag, endDrag),
                    onMomentumScrollEnd: wrapHandler(props.onMomentumScrollEnd, settle),
                },
                ...args.slice(2),
            ] as any
        } catch (e) {
            report('lists', e)
            return args as any
        }
    })
}

function patchListType(type: any, name: string) {
    if (!type) return
    status.found[`list:${name}`] = true
    return beforeJSX(type, (args: any[]) => {
        try {
            const props = args[1]
            if (!props?.renderItem || !active('lists')) return args as any
            return [
                args[0],
                {
                    ...props,
                    renderItem: wrapRenderItem(props.renderItem),
                    onScrollBeginDrag: wrapHandler(props.onScrollBeginDrag, begin),
                    onScrollEndDrag: wrapHandler(props.onScrollEndDrag, endDrag),
                    onMomentumScrollEnd: wrapHandler(props.onMomentumScrollEnd, settle),
                },
                ...args.slice(2),
            ] as any
        } catch (e) {
            report('lists', e)
            return args as any
        }
    })
}

export function patchLists(cleanup: (...fns: Array<() => unknown>) => void) {
    const un = patchListType((RN as any).VirtualizedList, 'VirtualizedList')
    if (un) cleanup(un)
    const done = new Set<any>()
    for (const name of ['FlashList', 'LegendList']) {
        cleanup(
            getModules(
                withProps(name) as any,
                (mod: any) => {
                    const type = mod?.[name]
                    if (!type || done.has(type)) return
                    done.add(type)
                    const u = patchListType(type, name)
                    if (u) cleanup(u)
                },
                { max: 3 } as any,
            ) as any,
        )
    }
    cleanup(
        getModules(
            withProps('AnimatedFastList', 'FastListComputer') as any,
            (mod: any) => {
                const type = mod?.default
                if (!type || done.has(type)) return
                done.add(type)
                const u = patchFastList(type)
                if (u) cleanup(u)
            },
            { max: 1 } as any,
        ) as any,
    )
}
