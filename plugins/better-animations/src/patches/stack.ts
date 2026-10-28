import { ReactNavigationStack } from '@valenced/externals/react-navigation'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { effectOf, exitEffectOf } from '../effects'
import { makeCardInterpolator, noAnimation, transitionSpecFor } from '../interpolate'
import { active, report, status, version } from '../settings'

/**
 * 디스코드 설정·서버 설정 같은 안쪽 화면은 JS 스택(@react-navigation/stack)으로 넘어간다.
 * 여기선 애니메이션을 마음대로 만들 수 있어서, StackView 에 넘어가는 각 화면 옵션에
 * 우리 cardStyleInterpolator / transitionSpec 을 넣는다.
 */

let cache: { key: string; options: any } | undefined

function overrides() {
    const m = active('stack')
    if (!m) return
    const key = `${version}:${m.effect}:${m.duration}:${m.easing}:${m.exit}:${m.direction}:${m.position}`
    if (cache?.key === key) return cache.options

    let options: any
    if (m.effect === 'none') {
        const spec = { animation: 'timing', config: { duration: 0 } }
        options = { cardStyleInterpolator: noAnimation, transitionSpec: { open: spec, close: spec } }
    } else {
        const effect = effectOf('stack', m.effect)
        const spec = transitionSpecFor(m.duration, m.easing)
        options = {
            cardStyleInterpolator: makeCardInterpolator(effect, {
                exit: exitEffectOf('stack', m.effect, m.exit),
                move: { direction: m.direction, position: m.position },
            }),
            transitionSpec: { open: spec, close: spec },
            gestureDirection: effect.gesture ?? 'horizontal',
            cardOverlayEnabled: !!effect.dim,
        }
    }
    cache = { key, options }
    return options
}

/** 디스코드가 일부러 애니메이션을 끈 화면, 투명 모달은 그대로 둔다 */
function shouldSkip(options: any) {
    return !options || options.animation === 'none' || options.animationEnabled === false || options.presentation === 'transparentModal'
}

export function patchJsStack() {
    const StackView = (ReactNavigationStack as any)?.StackView
    if (typeof StackView !== 'function' && typeof StackView !== 'object') throw new Error('StackView not found')
    status.found.stack = true
    return beforeJSX(StackView, (args: any[]) => {
        try {
            const props = args[1]
            const extra = overrides()
            if (!extra || !props?.descriptors) return args as any
            const descriptors: Record<string, any> = {}
            for (const k in props.descriptors) {
                const d = props.descriptors[k]
                descriptors[k] = shouldSkip(d?.options) ? d : { ...d, options: { ...d.options, ...extra } }
            }
            status.stack++
            return [args[0], { ...props, descriptors }, ...args.slice(2)] as any
        } catch (e) {
            report('stack', e)
            return args as any
        }
    })
}
