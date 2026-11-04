import { getModules, lookupModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { createContext, createElement, isValidElement, useContext, useEffect, useState } from 'react'
import { Animated, BackHandler, DeviceEventEmitter, Dimensions, Easing } from 'react-native'
import { easingFrom, effectOf, exitEffectOf, springFor } from '../effects'
import { makeCardInterpolator } from '../interpolate'
import { nativeScreens } from '../native'
import { active, report, status } from '../settings'

/**
 * 디스코드 설정·프로필·검색 같은 화면은 안드로이드 네이티브 스택(react-native-screens)이다.
 *
 * 1. 네이티브 전환은 정해진 종류만 고를 수 있어서 화면 요소(RNSScreen)의 stackAnimation 을 바꾼다.
 * 2. "화면 전환"에서 직접 만든 효과를 고르면, 새로 쌓이는 화면의 내용을 Animated.View 로 감싸
 *    나타날 때 그 효과를 재생한다. (나갈 때는 네이티브 전환을 쓴다. 기본은 페이드)
 *    스택의 첫 화면(설정 첫 페이지 등)은 재생하지 않으려고, 스택 안 순서를 컨텍스트로 넘긴다.
 * 디스코드가 일부러 "none"으로 둔 화면은 건드리지 않는다.
 */

const IndexContext = createContext(-1)

/**
 * 화면 안에 또 있는 스택인지 (0 = 맨 바깥 스택).
 * 메인 탭(서버·DM·나 탭 스택, 채팅 패널 스택)은 맨 바깥 화면 안에 들어 있는 스택이다.
 * 거기서 채널을 고르면 디스코드가 패널을 미끄러뜨리면서 패널 안 화면을 바꾸는데,
 * 그 화면 전환까지 우리가 바꾸면 패널이 안 열리거나 열렸다가 되돌아간다. 그래서 안쪽 스택은 건드리지 않는다.
 */
const NestContext = createContext(0)

/** 지금 만드는 요소가 화면 안 스택에 속하는지. 렌더 중이 아니면(읽을 수 없으면) 바깥으로 본다 */
function nested(): boolean {
    try {
        // useContext 는 훅 목록에 자리를 차지하지 않아서(readContext) 조건부로 불러도 순서가 어긋나지 않는다
        return useContext(NestContext) > 0
    } catch {
        return false
    }
}

const one = new Animated.Value(1)

/** 꽉 찬 모달 (설정 화면 등). 투명 모달·폼 시트는 창/시트라 빼 둔다 */
const FULL_MODALS = new Set(['modal', 'fullScreenModal', 'containedModal', 'pageSheet'])

/** "화면 전환" 효과를 이 화면에 쓸지 */
/**
 * 디스코드 예전 방식 모달(Navigation.push → 루트의 'modal' 경로)은 반투명 모달로 뜨지만
 * 실제로는 꽉 찬 화면이다 (플러그인 화면들이 주로 이걸 쓴다). 화면 키가 'modal-' 로 시작한다
 */
const isLegacyModal = (presentation: string | undefined, screenId: unknown) =>
    presentation === 'transparentModal' && typeof screenId === 'string' && screenId.startsWith('modal-')

function stackFor(presentation: string | undefined, screenId?: unknown) {
    const m = active('stack')
    if (!m) return
    const pres = presentation ?? 'push'
    if (pres === 'push') return m
    if ((FULL_MODALS.has(pres) || isLegacyModal(pres, screenId)) && m.modals !== false) return m
}

/**
 * 큰 화면에서 "화면 전환" 효과를 어떻게 낼지.
 * 안드로이드 전환과 우리 효과가 동시에 화면을 움직이면 두 겹으로 보이므로 한쪽만 움직이게 한다.
 *  - 화면 전체가 미끄러지는 효과(슬라이드·서랍·아래에서)는 안드로이드 전환으로 (닫힐 때도 자연스럽게 거꾸로)
 *  - 나머지는 안드로이드는 페이드(겹쳐 보이기)만 하고, 우리는 투명도 없이 위치·크기·회전만 움직인다
 */
interface Plan {
    native: string
    enter: boolean
}

function planFor(m: { effect: string; direction?: string }): Plan {
    if (m.effect === 'none') return { native: 'none', enter: false }
    // 네이티브 부분이 화면 전환을 맡으면: 이 표시(ios_from_right)를 보고 열기·닫기·뒤 화면 모두 우리 효과로 바꾼다
    if (nativeScreens()) return { native: 'ios_from_right', enter: false }
    const d = m.direction ?? 'auto'
    if (m.effect === 'slide' || m.effect === 'drawer') {
        const ios = m.effect === 'drawer'
        if (d === 'auto' || d === 'left') return { native: ios ? 'ios_from_right' : 'slide_from_right', enter: false }
        if (d === 'right') return { native: ios ? 'ios_from_left' : 'slide_from_left', enter: false }
        if (d === 'up') return { native: 'slide_from_bottom', enter: false }
    }
    if (m.effect === 'slideUp' && (d === 'auto' || d === 'up')) return { native: 'slide_from_bottom', enter: false }
    return { native: 'fade', enter: true }
}

function Enter({ children, presentation, screenId }: { children?: any; presentation?: string; screenId?: unknown }) {
    const index = useContext(IndexContext)
    const [anim] = useState(() => {
        const m = stackFor(presentation, screenId)
        const pres = presentation ?? 'push'
        // 스택의 첫 화면은 그대로. 순서를 모르면(-1) 모달만 (모달은 첫 화면일 수 없다)
        const first = index === 0 || (index < 0 && pres === 'push')
        if (!m || first || !planFor(m).enter) return undefined
        const { width, height } = Dimensions.get('window')
        const p = new Animated.Value(0)
        // 닫히는 중이면 1 (뒤로 가기에서 나갈 때 효과를 재생할 때)
        const closing = new Animated.Value(0)
        const { opacity, ...style } = makeCardInterpolator(effectOf('stack', m.effect), {
            exit: exitEffectOf('stack', m.effect, m.exit),
            move: { direction: m.direction, position: m.position },
        })({
            current: { progress: p },
            inverted: one,
            layouts: { screen: { width, height } },
            closing,
        }).cardStyle
        // 나타날 땐 투명도를 안드로이드 페이드가 맡고(두 번 흐려지지 않게), 나갈 땐 우리가 흐리게 한다
        if (opacity) (style as any).opacity = Animated.add(Animated.multiply(opacity, closing), Animated.subtract(1, closing))
        return { m, p, style, closing }
    })
    const [busy, setBusy] = useState(!!anim)
    useEffect(() => {
        // 효과가 없는 화면도 순서에 넣어 둔다 (그 화면이 맨 위면 뒤로 가기를 건드리지 않게)
        if (!anim) {
            const plain: ExitHandle = { exiting: false }
            mounted.push(plain)
            return () => {
                const i = mounted.indexOf(plain)
                if (i >= 0) mounted.splice(i, 1)
            }
        }
        status.screens++
        const { m, p } = anim
        const run = animate(p, 1, m)
        run.start(() => setBusy(false))
        const handle: ExitHandle = {
            exiting: false,
            exit(done) {
                handle.exiting = true
                run.stop()
                setBusy(true)
                anim.closing.setValue(1)
                // 닫기는 안드로이드 전환이 이어받으므로 짧게, 그리고 끝나기 전에 미리 닫기 시작해 겹치게 한다
                const duration = Math.max(120, Math.min(260, Math.round(m.duration * 0.6)))
                let closed = false
                const close = () => {
                    if (closed) return
                    closed = true
                    done()
                }
                const timer = setTimeout(close, Math.round(duration * 0.7))
                animate(p, 0, { ...m, duration }).start(({ finished }: any) => {
                    if (finished) close()
                    else if (!closed) {
                        // 중간에 끊기면(다른 이동 등) 닫지 않는다
                        clearTimeout(timer)
                        handle.exiting = false
                    }
                })
            },
        }
        mounted.push(handle)
        ensureBackHandler()
        return () => {
            run.stop()
            const i = mounted.indexOf(handle)
            if (i >= 0) mounted.splice(i, 1)
        }
    }, [])
    // 움직이는 동안만 GPU 텍스처로 그려서 버벅임을 줄인다. 이 화면 안에 들어 있는 스택은 "안쪽"
    return createElement(
        Animated.View,
        { style: anim ? [{ flex: 1 }, anim.style] : { flex: 1 }, collapsable: false, renderToHardwareTextureAndroid: busy },
        createElement(NestContext.Provider, { value: 1 }, children),
    )
}

function animate(p: Animated.Value, to: number, m: { duration: number; easing: string }, speed = 1) {
    const duration = Math.round(m.duration * speed)
    return m.easing === 'spring'
        ? Animated.spring(p, { toValue: to, ...springFor(duration, 0.7), useNativeDriver: true } as any)
        : Animated.timing(p, { toValue: to, duration, easing: easingFrom(Easing, m.easing), useNativeDriver: true })
}

// ── 뒤로 가기 (안드로이드 내비게이션 바) ─────────────────────────────
// 네이티브 화면은 닫히는 순간 JS 가 끼어들 수 없어서, 뒤로 가기를 먼저 받아 나갈 때 효과를 재생한 뒤 닫는다

interface ExitHandle {
    exiting: boolean
    exit?(done: () => void): void
}

/** 효과가 걸린 채 열려 있는 화면들 (나중에 열린 게 위) */
const mounted: ExitHandle[] = []
let backSub: { remove(): void } | undefined
let replaying = false

function goBack() {
    try {
        for (const [mod] of lookupModules(withProps('getRootNavigationRef') as any) as any) {
            const ref = mod?.getRootNavigationRef?.()
            if (ref?.canGoBack?.()) {
                ref.goBack()
                return
            }
        }
    } catch (e) {
        report('back', e)
    }
    // 못 찾으면 뒤로 가기를 한 번 더 흘려보낸다 (이번엔 우리가 건너뛴다)
    replaying = true
    try {
        DeviceEventEmitter.emit('hardwareBackPress')
    } finally {
        replaying = false
    }
}

function onBack() {
    if (replaying) return false
    const top = mounted[mounted.length - 1]
    if (!top?.exit) return false
    if (top.exiting) return true
    try {
        top.exit(goBack)
        status.screenExits++
        return true
    } catch (e) {
        report('back', e)
        return false
    }
}

/** 디스코드(react-navigation)의 뒤로 가기 처리보다 먼저 불리게, 화면이 처음 열릴 때 등록한다 */
function ensureBackHandler() {
    if (backSub) return
    try {
        backSub = BackHandler.addEventListener('hardwareBackPress', onBack) as any
    } catch (e) {
        report('back', e)
    }
}

export function removeBackHandler() {
    backSub?.remove()
    backSub = undefined
    mounted.length = 0
}

/** 네이티브 전환 종류 */
function nativeAnimationFor(props: any) {
    const presentation = props.stackPresentation ?? 'push'
    const stack = stackFor(presentation, props.screenId)
    if (stack) return planFor(stack).native
    return presentation !== 'push' ? active('modal')?.effect : active('push')?.effect
}

function wrapStackChildren(children: any) {
    const wrap = (child: any, i: number) => (isValidElement(child) ? createElement(IndexContext.Provider, { key: child.key ?? i, value: i }, child) : child)
    return Array.isArray(children) ? children.map(wrap) : wrap(children, 0)
}

export function patchNativeScreens(cleanup: (...fns: Array<() => unknown>) => void) {
    cleanup(removeBackHandler)
    cleanup(
        beforeJSX('RNSScreen' as any, (args: any[]) => {
            try {
                const props = args[1]
                if (!props || props.stackAnimation === 'none' || nested()) return args as any
                const next = nativeAnimationFor(props)
                if (!next || next === props.stackAnimation) return args as any
                status.nativeScreens++
                return [args[0], { ...props, stackAnimation: next }, ...args.slice(2)] as any
            } catch (e) {
                report('screens', e)
                return args as any
            }
        }),
        // 스택 안 화면 순서 (첫 화면은 효과 없이)
        beforeJSX('RNSScreenStack' as any, (args: any[]) => {
            try {
                const props = args[1]
                if (!props?.children || nested()) return args as any
                return [args[0], { ...props, children: wrapStackChildren(props.children) }, ...args.slice(2)] as any
            } catch (e) {
                report('screenStack', e)
                return args as any
            }
        }),
    )
    // 화면 내용 감싸기. 헤더 설정은 headerConfig 로 따로 오므로 children 만 감싸면 된다
    cleanup(
        getModules(withProps('ScreenStackItem', 'ScreenStack') as any, (mod: any) => {
            const Item = mod?.ScreenStackItem
            if (!Item) return
            status.found.screens = true
            cleanup(
                beforeJSX(Item, (args: any[]) => {
                    try {
                        const props = args[1]
                        if (!props || props.children === undefined || nested()) return args as any
                        const next: any = { ...props, children: createElement(Enter, { presentation: props.stackPresentation, screenId: props.screenId }, props.children) }
                        // 네이티브 전환도 여기서 바꾼다 (RNSScreen 요소까지 안 내려오는 경우가 있어서)
                        if (props.stackAnimation !== 'none') {
                            const anim = nativeAnimationFor(props)
                            if (anim && anim !== props.stackAnimation) {
                                next.stackAnimation = anim
                                status.nativeScreens++
                            }
                        }
                        return [args[0], next, ...args.slice(2)] as any
                    } catch (e) {
                        report('screenItem', e)
                        return args as any
                    }
                }),
            )
        }) as any,
    )
}
