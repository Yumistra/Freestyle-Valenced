import { BottomSheet } from '@valenced/externals/gorhom'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { springFor } from '../effects'
import { active, report, status, version } from '../settings'
import { ensureReanimated, reaEasing } from './worklets'

/**
 * 아래 창(액션시트)은 @gorhom/bottom-sheet 다. animationConfigs 에
 *  - duration/easing 이 있으면 withTiming,
 *  - 없으면 withSpring 으로 열고 닫는다.
 * 디스코드가 넘기는 값 대신 우리 설정을 넣는다.
 */

let cache: { key: string; config: any } | undefined

function config() {
    const m = active('sheet')
    if (!m) return
    const key = `${version}:${m.duration}:${m.easing}`
    if (cache?.key === key) return cache.config
    let cfg: any
    if (m.easing === 'spring') {
        // duration 이 있으면 gorhom 이 타이밍으로 여기므로, 물리 값만 넘긴다
        cfg = springFor(m.duration, 0.7)
    } else {
        const easing = ensureReanimated() ? reaEasing(m.easing) : undefined
        if (!easing) return
        cfg = { duration: m.duration, easing }
    }
    cache = { key, config: cfg }
    return cfg
}

export function patchSheets() {
    const lib: any = BottomSheet
    const targets = new Set<any>([lib?.default, lib?.BottomSheetModal].filter(Boolean))
    if (!targets.size) throw new Error('bottom-sheet component not found')
    status.found.sheets = true
    const unpatches = [...targets].map(type =>
        beforeJSX(type, (args: any[]) => {
            try {
                const cfg = config()
                if (!cfg || !args[1]) return args as any
                status.sheets++
                return [args[0], { ...args[1], animationConfigs: cfg }, ...args.slice(2)] as any
            } catch (e) {
                report('sheets', e)
                return args as any
            }
        }),
    )
    return () => {
        for (const u of unpatches) u()
    }
}
