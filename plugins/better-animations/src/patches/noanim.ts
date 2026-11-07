import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { Animated, LayoutAnimation } from 'react-native'
import { onSettingsChange, report, settings } from '../settings'

/**
 * "No animations": 폰의 "애니메이션 제거"처럼 디스코드의 모든 움직임을 없앤다.
 *  - 디스코드의 "동작 줄이기"(AccessibilityStore.useReducedMotion)를 켠 것으로 보이게
 *  - Reanimated 의 동작 줄이기(ReducedMotionManager)를 켠다 (워클릿 애니메이션이 바로 끝난다)
 *  - React Native Animated.timing, spring, decay 를 바로 끝나게, LayoutAnimation 은 건너뛴다
 *  - 안드로이드 쪽(화면 전환, ValueAnimator)은 네이티브가 같은 설정을 읽어 끈다
 * 끄면 모두 원래대로 돌린다.
 */

const on = () => {
    const s = settings()
    return !!s.noAnimations
}

function patchAnimated(): () => void {
    const A: any = Animated
    const timing = A.timing
    const spring = A.spring
    const decay = A.decay
    const configureNext = (LayoutAnimation as any).configureNext
    A.timing = function (value: any, config: any) {
        return timing.call(this, value, on() ? { ...config, duration: 0, delay: 0 } : config)
    }
    A.spring = function (value: any, config: any) {
        if (!on()) return spring.call(this, value, config)
        return timing.call(this, value, { toValue: config?.toValue, duration: 0, delay: 0, useNativeDriver: !!config?.useNativeDriver, isInteraction: false })
    }
    A.decay = function (value: any, config: any) {
        if (!on()) return decay.call(this, value, config)
        // 굴러가며 멈추는 움직임은 그 자리에서 멈춘다
        return timing.call(this, value, { toValue: value?.__getValue?.() ?? 0, duration: 0, useNativeDriver: !!config?.useNativeDriver, isInteraction: false })
    }
    ;(LayoutAnimation as any).configureNext = function (...args: any[]) {
        if (on()) {
            // 끝났다는 콜백은 그대로 불러 준다
            try {
                args[1]?.()
            } catch {}
            return
        }
        return configureNext.apply(this, args)
    }
    return () => {
        A.timing = timing
        A.spring = spring
        A.decay = decay
        ;(LayoutAnimation as any).configureNext = configureNext
    }
}

/** 디스코드 설정의 "동작 줄이기"가 켜진 것처럼 보이게 한다 (디스코드 안 애니메이션 대부분이 이걸 본다) */
function patchReducedMotion(): () => void {
    const store: any = (Stores as any).AccessibilityStore
    if (!store) return () => {}
    let proto: any = Object.getPrototypeOf(store)
    let desc: PropertyDescriptor | undefined
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'useReducedMotion'))) proto = Object.getPrototypeOf(proto)
    const own = Object.getOwnPropertyDescriptor(store, 'useReducedMotion')
    const original = () => (desc?.get ? desc.get.call(store) : own ? own.value : desc?.value)
    try {
        Object.defineProperty(store, 'useReducedMotion', {
            configurable: true,
            enumerable: true,
            get: () => on() || !!original(),
        })
    } catch (e) {
        report('noAnimations.store', e)
        return () => {}
    }
    const changed = () => {
        try {
            store.emitChange?.()
        } catch {}
    }
    const off = onSettingsChange(changed)
    changed()
    return () => {
        off()
        try {
            if (own) Object.defineProperty(store, 'useReducedMotion', own)
            else delete store.useReducedMotion
        } catch {}
        changed()
    }
}

/** Reanimated: 동작 줄이기를 켜면 withTiming, withSpring 같은 워클릿 애니메이션이 바로 끝난다 */
function patchReanimated(cleanup: (...f: Array<() => void>) => void) {
    let manager: any
    let before: boolean | undefined
    const apply = () => {
        if (!manager) return
        const want = on()
        try {
            before ??= !!manager.jsValue
            const next = want || before
            if (typeof manager.setEnabled === 'function') manager.setEnabled(next)
            else {
                manager.jsValue = next
                if (manager.uiValue && 'value' in manager.uiValue) manager.uiValue.value = next
            }
        } catch (e) {
            report('noAnimations.reanimated', e)
        }
    }
    cleanup(
        getModules(withProps('ReducedMotionManager') as any, (mod: any) => {
            if (manager || !mod?.ReducedMotionManager) return
            manager = mod.ReducedMotionManager
            apply()
        }) as any,
        onSettingsChange(apply) as any,
        () => {
            if (!manager || before === undefined) return
            try {
                if (typeof manager.setEnabled === 'function') manager.setEnabled(before)
                else manager.jsValue = before
            } catch {}
        },
    )
}

export function patchNoAnimations(cleanup: (...f: Array<() => void>) => void) {
    for (const [name, fn] of [
        ['animated', patchAnimated],
        ['store', patchReducedMotion],
    ] as const) {
        try {
            cleanup(fn())
        } catch (e) {
            report(`noAnimations.${name}`, e)
        }
    }
    try {
        patchReanimated(cleanup)
    } catch (e) {
        report('noAnimations.reanimated', e)
    }
}
