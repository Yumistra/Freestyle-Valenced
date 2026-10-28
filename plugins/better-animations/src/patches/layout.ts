import { Dispatcher } from '@valenced/discord/common/flux'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { instead } from '@valenced/patcher'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { createElement, useEffect, useRef, useState } from 'react'
import { Animated, Dimensions, Easing, LayoutAnimation } from 'react-native'
import { applyMove, decodeEasing, easingFrom, effectOf, exitPoseOf, isCustomEasing, springFor, zetaOf, type Normalized } from '../effects'
import { partsFor } from '../interpolate'
import { nativeGuildOut } from '../native'
import { hideCollapsing, markExpanded, restoreCollapsed } from './channels'
import { active, report, status, type ModuleSettings } from '../settings'

/**
 * 채널 목록의 카테고리 접기·펼치기, 서버 바꾸기는 디스코드가 애니메이션 없이 목록을 다시 그린다.
 * 그 동작을 일으키는 Flux 액션이 지나갈 때 LayoutAnimation 을 걸어 두면,
 * 바로 다음 화면 갱신에서 줄이 생기고 사라지고 밀리는 것이 부드럽게 바뀐다.
 * (BetterDiscord 의 Channel List 모듈에 해당)
 *
 * 서버 바꾸기는 목록 칸이 재사용돼서 LayoutAnimation 이 먹지 않는다. 대신 채널 목록 화면
 * (RedesignChannelList) 전체를 Animated.View 로 감싸고, 고른 서버가 바뀌면 그 효과를 재생한다.
 * (BetterDiscord 의 Servers 모듈)
 *
 * 옛 목록이 나가는 효과: 서버를 바꾸는 액션(CHANNEL_SELECT)이 지나갈 때, 액션보다 먼저 네이티브에
 * "지금 목록을 찍어 덮어라"를 보낸다. JS 가 새 목록을 그리기 전에 네이티브가 찍으므로 옛 목록이 찍히고,
 * 그 그림은 나가는 효과로 치워지며 새 목록은 그 밑에서 나타난다.
 * (액션을 붙잡으면 디스코드 화면이 선택 상태를 맞추려다 무한 반복에 빠지므로 붙잡지 않는다)
 */

/** 서버의 채널 목록, DM 목록 */
const LIST_PATHS = ['modules/channel_list_v2/native/RedesignChannelList.tsx', 'modules/main_tabs_v2/native/tabs/messages/MessagesFastestList.tsx']
/** 감싸기를 못 하면 LayoutAnimation 으로라도 */
let wrapped = false
/** 마지막으로 본 서버 (채널 목록이 서버마다 새로 만들어져도 바뀐 걸 알 수 있게) */
let seenGuild: string | null | undefined

const guildStore = () => (Stores as any).SelectedGuildStore

function currentGuild(): string | null | undefined {
    try {
        return guildStore()?.getGuildId?.() ?? null
    } catch {
        return undefined
    }
}

function play(value: Animated.Value, m: ModuleSettings, done?: () => void) {
    value.setValue(0)
    const run =
        m.easing === 'spring'
            ? Animated.spring(value, { toValue: 1, ...springFor(m.duration, 0.7), useNativeDriver: true } as any)
            : Animated.timing(value, { toValue: 1, duration: m.duration, easing: easingFrom(Easing, m.easing), useNativeDriver: true })
    run.start(() => done?.())
    status.layouts++
}

interface Instance {
    nativeId: string
    kind: 'guild' | 'dm'
}
const instances = new Set<Instance>()
let instanceSeq = 0

/**
 * 이번 서버 바꾸기의 세로 방향. 1 = 위쪽 서버로 (위로 움직임: 옛 목록은 위로, 새 목록은 아래에서),
 * -1 = 아래쪽 서버로 (아래로 움직임). 효과에 적힌 모습이 "위로"라서 -1 이면 세로만 뒤집는다
 */
let switchSign = 1

/** 서버 목록에서의 순서 (DM = 맨 위) */
function orderOf(id: string | null): number | undefined {
    if (id === null) return -1
    try {
        const ids: string[] | undefined = (Stores as any).SortedGuildStore?.getFlattenedGuildIds?.()
        const i = ids?.indexOf(id) ?? -1
        return i >= 0 ? i : undefined
    } catch {
        return undefined
    }
}

function signFor(from: string | null, to: string | null) {
    const a = orderOf(from)
    const b = orderOf(to)
    if (a === undefined || b === undefined || a === b) return 1
    return b < a ? 1 : -1
}

function vertical(h: Normalized, m: ModuleSettings): Normalized {
    if (switchSign > 0 || m.follow === false) return h
    return { ...h, ty: -h.ty, tyH: -h.tyH, rx: -h.rx }
}

function enterPose(m: ModuleSettings, W: number, H: number) {
    return vertical(applyMove(effectOf('servers', m.effect).hidden, { direction: m.direction, position: m.position }, W, H), m)
}

function exitPose(m: ModuleSettings, W: number, H: number) {
    return vertical(exitPoseOf('servers', m.effect, m.exit, { direction: m.direction, position: m.position }, W, H), m)
}

function GuildSwitch({ __type, __props, __kind }: { __type: any; __props: any; __kind: 'guild' | 'dm' }) {
    const [value] = useState(() => new Animated.Value(1))
    const [busy, setBusy] = useState(false)
    const [nativeId] = useState(() => `better-animations-guild-${instanceSeq++}`)
    const last = useRef<string | null | undefined>(undefined)
    const [run, setRun] = useState(0)
    useEffect(() => {
        if (!run) return
        const m = active('servers')
        if (!m || m.effect === 'none') {
            value.setValue(1)
            setBusy(false)
            return
        }
        play(value, m, () => setBusy(false))
    }, [run])
    useEffect(() => {
        const inst: Instance = { nativeId, kind: __kind }
        instances.add(inst)
        const check = () => {
            const g = currentGuild()
            if (g === undefined || g === last.current) return
            const changed = last.current !== undefined || (seenGuild !== undefined && seenGuild !== g)
            last.current = g
            seenGuild = g
            const m = active('servers')
            if (changed && m && m.effect !== 'none') {
                // 새 방향으로 다시 그린 다음에 움직이기 시작한다 (그 전까지는 숨은 상태)
                value.setValue(0)
                setBusy(true)
                setRun(n => n + 1)
            }
        }
        check()
        const store = guildStore()
        store?.addChangeListener?.(check)
        return () => {
            instances.delete(inst)
            store?.removeChangeListener?.(check)
        }
    }, [])
    const m = active('servers')
    let style: any = { flex: 1 }
    if (m && m.effect !== 'none') {
        const { width, height } = Dimensions.get('window')
        const h = enterPose(m, width, height)
        const parts = partsFor(value, h, width, height, undefined)
        style = [{ flex: 1 }, { transform: parts.transform, ...(parts.opacity ? { opacity: parts.opacity } : {}) }]
    }
    return createElement(Animated.View, { style, nativeID: nativeId, collapsable: false, renderToHardwareTextureAndroid: busy }, createElement(__type, __props))
}

// ── 옛 목록 내보내기 ──────────────────────────────────────────────

/** 서버가 바뀌는 액션이면 (액션보다 먼저) 네이티브에 옛 목록을 찍어 치우라고 보낸다 */
function guildOut(action: any) {
    const type = action?.type
    if ((type !== 'CHANNEL_SELECT' && type !== 'GUILD_SELECT') || !action || !('guildId' in action)) return
    const next = action.guildId ?? null
    const cur = currentGuild()
    if (cur === undefined || next === cur) return
    switchSign = signFor(cur, next)
    if (!instances.size) return
    const m = active('servers')
    if (!m || m.effect === 'none') return
    const { width, height } = Dimensions.get('window')
    const pose = exitPose(m, width, height)
    const all = [...instances]
    const visible = all.filter(i => i.kind === (cur === null ? 'dm' : 'guild'))
    const ids = [...visible, ...all.filter(i => !visible.includes(i))].map(i => i.nativeId)
    nativeGuildOut({ ids, pose, duration: m.duration, easing: m.easing, position: m.position ?? 'auto', deadline: Date.now() + 400 }).then(r => {
        if (r === 'ok') status.layouts++
        else if (r !== 'noview' && r !== 'nonative') report('servers', `native ${r}`)
    })
}

export function patchServerSwitch(cleanup: (...fns: Array<() => unknown>) => void) {
    const done = new Set<any>()
    for (const path of LIST_PATHS) {
        cleanup(
            getModuleWithImportedPath(path, (exports: any) => {
                const List = exports?.default ?? exports
                if (!List || done.has(List)) return
                done.add(List)
                wrapped = true
                status.found.servers = true
                cleanup(
                    beforeJSX(List, (args: any[]) => {
                        try {
                            if (!active('servers')) return args as any
                            const kind = path.includes('MessagesFastestList') ? 'dm' : 'guild'
                            // 다른 플러그인이 목록 옆에 칸을 붙여 감싸 뒀으면 (Server Folders 옆 칸) 그 칸은 두고 안쪽 목록만 움직인다
                            const outer = args[0] as any
                            if (outer?.__innerList && args[1]?.__type) {
                                const inner = args[1]
                                return [outer, { ...inner, __type: GuildSwitch, __props: { __type: inner.__type, __props: inner.__props, __kind: kind } }, ...args.slice(2)] as any
                            }
                            return [GuildSwitch, { __type: args[0], __props: args[1], __kind: kind }, ...args.slice(2)] as any
                        } catch (e) {
                            report('servers', e)
                            return args as any
                        }
                    }),
                )
            }) as any,
        )
    }
}

const COLLAPSE = new Set(['CATEGORY_COLLAPSE', 'CATEGORY_EXPAND', 'CATEGORY_COLLAPSE_ALL', 'CATEGORY_EXPAND_ALL'])

function animFor(easing: string): any {
    if (easing === 'spring' || zetaOf(easing) < 1) return { type: 'spring', springDamping: Math.max(0.2, Math.min(1, easing === 'spring' ? 0.7 : zetaOf(easing) + 0.2)) }
    if (easing === 'linear') return { type: 'linear' }
    if (easing === 'smooth') return { type: 'easeInEaseOut' }
    if (isCustomEasing(easing)) {
        const c = decodeEasing(easing)
        if (c.type === 'linear' || c.type === 'steps') return { type: 'linear' }
        return { type: c.bezier === 'in' ? 'easeIn' : c.bezier === 'inOut' ? 'easeInEaseOut' : 'easeOut' }
    }
    return { type: 'easeOut' }
}

export function layoutConfigFor(m: ModuleSettings, rowsHandled = false) {
    const anim = animFor(m.easing)
    const property = m.effect === 'scale' ? 'scaleXY' : 'opacity'
    // 줄이 나타나고 사라지는 건 ChannelRow 가 하므로, 여기선 남은 줄이 밀리는 것만
    if (rowsHandled) return { duration: m.duration, update: anim }
    return {
        duration: m.duration,
        create: { ...anim, property },
        update: anim,
        delete: { ...anim, property },
    }
}

let lastGuild: string | null | undefined

function onAction(action: any) {
    const type = action?.type
    if (!type) return
    if (COLLAPSE.has(type)) {
        const m = active('channelList')
        if (!m) return
        if (type === 'CATEGORY_EXPAND' || type === 'CATEGORY_EXPAND_ALL') markExpanded(type === 'CATEGORY_EXPAND' ? categoryIdOf(action) : undefined)
        LayoutAnimation.configureNext(layoutConfigFor(m, true) as any)
        status.layouts++
    } else if (!wrapped && (type === 'CHANNEL_SELECT' || type === 'GUILD_SELECT')) {
        const guild = action.guildId ?? null
        const first = lastGuild === undefined
        if (guild === lastGuild) return
        lastGuild = guild
        const m = active('servers')
        if (!m || first) return
        LayoutAnimation.configureNext(layoutConfigFor(m) as any)
        status.layouts++
    }
}

function categoryIdOf(action: any): string | undefined {
    const id = action?.id ?? action?.categoryId ?? action?.channelId
    return id == null ? undefined : String(id)
}

/** 접기: 줄들이 먼저 사라지게 하고 그동안 실제 액션을 미룬다. 미룰 시간(ms) */
function collapseDelay(action: any) {
    const type = action?.type
    if (action?.__betterAnimations || (type !== 'CATEGORY_COLLAPSE' && type !== 'CATEGORY_COLLAPSE_ALL')) return 0
    const m = active('channelList')
    if (!m) return 0
    return hideCollapsing(type === 'CATEGORY_COLLAPSE' ? categoryIdOf(action) : undefined, m)
}

export function patchLayout() {
    const D: any = Dispatcher
    if (typeof D?.dispatch !== 'function') throw new Error('Dispatcher not found')
    status.found.layout = true
    return instead(D, 'dispatch', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
        let wait = 0
        try {
            if (!args[0]?.__betterAnimations) guildOut(args[0])
            wait = collapseDelay(args[0])
        } catch (e) {
            report('layout', e)
        }
        if (wait > 0) {
            const self = this
            return new Promise(resolve => {
                setTimeout(() => {
                    try {
                        onAction(args[0])
                    } catch (e) {
                        report('layout', e)
                    }
                    const out = orig.apply(self, args)
                    try {
                        const m = active('channelList')
                        if (m) restoreCollapsed(m)
                    } catch (e) {
                        report('layout', e)
                    }
                    resolve(out)
                }, wait)
            })
        }
        try {
            onAction(args[0])
        } catch (e) {
            report('layout', e)
        }
        return orig.apply(this, args)
    })
}
