import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { isSpringy, springFor, zetaOf } from '../effects'
import { active, onSettingsChange, report, status } from '../settings'
import { ensureReanimated, reaEasing } from './worklets'

/**
 * 디스코드가 모듈 상수로 들고 있는 애니메이션 설정을 바꾼다.
 *  - 그리는 순간 모듈에서 읽는 값(SUBTLE_SPRING, TRANSITION_PHYSICS, SIDE_PANEL_*_DURATION_MS)은 내보낸 값을 통째로 바꾼다
 *  - 모듈이 처음 읽혀서 지역 변수로 잡아 둔 값(패널 설정 객체)은 그 객체의 속성을 고친다.
 *    Reanimated 가 처음 UI 스레드로 보낼 때 복사본을 캐시하므로, 앱을 다시 시작해야 확실히 바뀐다.
 * 원래 값은 기억해 두었다가 "기본"으로 돌리거나 플러그인을 끄면 되돌린다.
 */

interface Target {
    mod: any
    originals: Record<string, any>
}

const motion: Target[] = []
const guilds: Target[] = []
const panels: Target[] = []

const PANEL_KEYS = ['swipeSidePanelOpen', 'swipeSidePanelClose', 'nonSwipeSidePanelOpen', 'nonSwipeSidePanelClose'] as const

function remember(list: Target[], mod: any, keys: readonly string[]) {
    if (!mod || list.some(t => t.mod === mod)) return
    const originals: Record<string, any> = {}
    for (const k of keys) originals[k] = mod[k]
    list.push({ mod, originals })
}

/** 내보낸 값 바꾸기. 쓸 수 없는 속성이면 조용히 넘어간다 */
function setExport(mod: any, key: string, value: any) {
    try {
        if (mod[key] === value) return
        mod[key] = value
    } catch (e) {
        report(`constants.${key}`, e)
    }
}

function timingOrSpring(duration: number, easing: any) {
    if (isSpringy(easing)) return springFor(duration, zetaOf(easing))
    const fn = ensureReanimated() ? reaEasing(easing) : undefined
    if (!fn) return springFor(duration, 1)
    return { duration, easing: fn }
}

export function applyConstants() {
    // 작은 움직임: 디스코드 공통 스프링
    const subtle = active('subtle')
    for (const t of motion) setExport(t.mod, 'SUBTLE_SPRING', subtle ? springFor(subtle.duration, zetaOf(subtle.easing)) : t.originals.SUBTLE_SPRING)

    // 서버 폴더: 펼쳐지는 높이 변화
    const folder = active('folder')
    for (const t of guilds) setExport(t.mod, 'TRANSITION_PHYSICS', folder ? springFor(folder.duration, zetaOf(folder.easing)) : t.originals.TRANSITION_PHYSICS)

    // 채널 화면 밀기
    const panel = active('panel')
    for (const t of panels) {
        const open = panel ? timingOrSpring(panel.duration, panel.easing) : undefined
        const close = panel ? timingOrSpring(Math.round(panel.duration * 0.85), panel.easing) : undefined
        for (const key of ['ANDROID_PANELS_ANIMATION_CONFIG', 'DEFAULT_PANELS_ANIMATION_CONFIG']) {
            const cfg = t.mod[key]
            const orig = t.originals[key]
            if (!cfg || !orig) continue
            for (const k of PANEL_KEYS) {
                try {
                    cfg[k] = panel ? (k.endsWith('Open') ? open : close) : orig[k]
                } catch (e) {
                    report('constants.panel', e)
                }
            }
        }
        setExport(t.mod, 'SIDE_PANEL_OPEN_DURATION_MS', panel ? panel.duration : t.originals.SIDE_PANEL_OPEN_DURATION_MS)
        setExport(t.mod, 'SIDE_PANEL_CLOSE_DURATION_MS', panel ? Math.round(panel.duration * 0.85) : t.originals.SIDE_PANEL_CLOSE_DURATION_MS)
    }
}

function found(name: string) {
    if (!status.constants.includes(name)) status.constants.push(name)
}

export function patchConstants(cleanup: (...fns: Array<() => unknown>) => void) {
    cleanup(
        getModules(
            withProps('SUBTLE_SPRING') as any,
            (mod: any) => {
                remember(motion, mod, ['SUBTLE_SPRING'])
                found('subtle')
                applyConstants()
            },
            { max: 3 } as any,
        ) as any,
        getModules(
            withProps('FOLDER_SPRING_PHYSICS', 'TRANSITION_PHYSICS') as any,
            (mod: any) => {
                remember(guilds, mod, ['TRANSITION_PHYSICS'])
                found('folder')
                applyConstants()
            },
            { max: 3 } as any,
        ) as any,
        getModules(
            withProps('ANDROID_PANELS_ANIMATION_CONFIG', 'DEFAULT_PANELS_ANIMATION_CONFIG') as any,
            (mod: any) => {
                // 객체 속성을 고치므로 원래 속성들을 따로 복사해 둔다
                if (panels.some(t => t.mod === mod)) return
                panels.push({
                    mod,
                    originals: {
                        ANDROID_PANELS_ANIMATION_CONFIG: { ...mod.ANDROID_PANELS_ANIMATION_CONFIG },
                        DEFAULT_PANELS_ANIMATION_CONFIG: { ...mod.DEFAULT_PANELS_ANIMATION_CONFIG },
                        SIDE_PANEL_OPEN_DURATION_MS: mod.SIDE_PANEL_OPEN_DURATION_MS,
                        SIDE_PANEL_CLOSE_DURATION_MS: mod.SIDE_PANEL_CLOSE_DURATION_MS,
                    },
                })
                found('panel')
                applyConstants()
            },
            { max: 3 } as any,
        ) as any,
        onSettingsChange(applyConstants) as any,
        // 플러그인을 끄면 원래 값으로
        () => {
            for (const list of [motion, guilds]) for (const t of list) for (const k in t.originals) setExport(t.mod, k, t.originals[k])
            for (const t of panels) {
                for (const key of ['ANDROID_PANELS_ANIMATION_CONFIG', 'DEFAULT_PANELS_ANIMATION_CONFIG']) {
                    const cfg = t.mod[key]
                    const orig = t.originals[key]
                    if (cfg && orig) for (const k of PANEL_KEYS) cfg[k] = orig[k]
                }
                setExport(t.mod, 'SIDE_PANEL_OPEN_DURATION_MS', t.originals.SIDE_PANEL_OPEN_DURATION_MS)
                setExport(t.mod, 'SIDE_PANEL_CLOSE_DURATION_MS', t.originals.SIDE_PANEL_CLOSE_DURATION_MS)
            }
        },
    )
}
