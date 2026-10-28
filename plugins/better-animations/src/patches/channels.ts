import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { createElement, useEffect, useState } from 'react'
import { Animated, Easing } from 'react-native'
import { applyMove, easingFrom, effectOf, springFor } from '../effects'
import { partsFor } from '../interpolate'
import { active, report, status, type ModuleSettings } from '../settings'

/**
 * 채널 목록 카테고리 접기·펼치기 (BetterDiscord 의 Channel List).
 *
 * 채널 목록은 칸을 재사용하는 목록이라 LayoutAnimation 만으로는 줄이 나타나고 사라지는 게 보이지 않는다.
 * 그래서 채널 줄을 그리는 renderChannelListItem 의 결과를 우리 ChannelRow 로 감싼다.
 *  - 펼칠 때: 방금 펼친 카테고리의 줄이 새로 그려지면 차례로 나타난다.
 *  - 접을 때: 접기 액션을 잠깐 붙잡아 두고 그 카테고리의 줄을 먼저 사라지게 한 뒤 실제로 접는다.
 *    (선택된 채널·안 읽은 채널은 접어도 남으므로 건드리지 않는다)
 */

interface Row {
    parent: string | null
    stays(): boolean
    hide(m: ModuleSettings): void
    show(m: ModuleSettings): void
    hidden: boolean
}

const rows = new Set<Row>()
const expandedAt = new Map<string, number>()
const ALL = '*'

export function markExpanded(categoryId: string | undefined) {
    expandedAt.set(categoryId ?? ALL, Date.now())
}

/** 접힐 줄들을 사라지게 하고, 기다릴 시간(ms)을 돌려준다. 0 이면 바로 접는다 */
export function hideCollapsing(categoryId: string | undefined, m: ModuleSettings) {
    let n = 0
    for (const row of rows) {
        if (!row.parent || (categoryId && row.parent !== categoryId)) continue
        if (row.stays()) continue
        row.hide(m)
        n++
    }
    return n ? Math.min(600, Math.round(m.duration * 0.8)) : 0
}

/**
 * 접은 뒤에도 목록에 남은 줄은 다시 보이게 한다.
 * 디스코드는 선택한 채널·안 읽은 채널·들어가 있는 음성 채널 등을 접어도 남겨 두는데,
 * 우리가 미리 알아채지 못한 줄이 투명한 채로 굳지 않게 하는 안전장치.
 */
export function restoreCollapsed(m: ModuleSettings) {
    const check = () => {
        for (const row of rows) if (row.hidden) row.show(m)
    }
    // 디스코드가 줄을 지우는 건 액션 뒤 다음 화면 갱신이라, 조금 기다린 뒤 남은 줄만
    setTimeout(check, 160)
    setTimeout(check, 600)
}

function justExpanded(parent: string | null) {
    if (!parent) return false
    const t = Math.max(expandedAt.get(parent) ?? 0, expandedAt.get(ALL) ?? 0)
    return Date.now() - t < 700
}

function staysVisible(id: string, guildId: string | undefined, selected: boolean) {
    if (selected) return true
    try {
        const s: any = Stores
        // 렌더 때 받은 값은 오래됐을 수 있어서 지금 선택된 채널을 다시 본다
        if (s.SelectedChannelStore?.getChannelId?.() === id) return true
        if (s.SelectedChannelStore?.getVoiceChannelId?.() === id) return true
        const unread = s.ReadStateStore?.hasUnread?.(id)
        const muted = guildId ? s.UserGuildSettingsStore?.isChannelMuted?.(guildId, id) : false
        return !!unread && !muted
    } catch {
        return false
    }
}

function run(value: Animated.Value, to: number, m: ModuleSettings, delay = 0) {
    const anim =
        m.easing === 'spring'
            ? Animated.spring(value, { toValue: to, ...springFor(m.duration, 0.7), useNativeDriver: true } as any)
            : Animated.timing(value, { toValue: to, duration: m.duration, easing: easingFrom(Easing, m.easing), useNativeDriver: true })
    ;(delay ? Animated.sequence([Animated.delay(delay), anim]) : anim).start()
}

function ChannelRow({ id, parent, guildId, selected, index, children }: { id: string; parent: string | null; guildId?: string; selected: boolean; index: number; children: any }) {
    const [state] = useState(() => {
        const enter = !!active('channelList') && justExpanded(parent)
        return { enter, value: new Animated.Value(enter ? 0 : 1), selected }
    })
    // 처음 그려진 뒤에 선택돼도 접을 때 알 수 있게 매번 최신 값으로
    state.selected = selected
    useEffect(() => {
        const row: Row = {
            parent,
            hidden: false,
            stays: () => staysVisible(id, guildId, state.selected),
            hide: m => {
                row.hidden = true
                run(state.value, 0, m)
            },
            show: m => {
                row.hidden = false
                run(state.value, 1, m)
            },
        }
        rows.add(row)
        const m = active('channelList')
        if (state.enter && m) {
            run(state.value, 1, m, Math.min(Math.max(0, index) * 18, 180))
            status.layouts++
        }
        return () => {
            rows.delete(row)
        }
    }, [])
    const m = active('channelList')
    if (!m) return children
    const h = applyMove(effectOf('channelList', m.effect).hidden, undefined, 300, 40)
    const parts = partsFor(state.value, h, 300, 40, undefined)
    const style: any = { transform: parts.transform }
    if (parts.opacity) style.opacity = parts.opacity
    return createElement(Animated.View, { style }, children)
}

export function patchChannelRows(cleanup: (...fns: Array<() => unknown>) => void) {
    const done = new Set<any>()
    cleanup(
        getModules(
            withProps('renderChannelListItem', 'getChannelListItemSize') as any,
            (mod: any) => {
                if (!mod || done.has(mod)) return
                done.add(mod)
                status.found.channelRows = true
                cleanup(
                    instead(mod, 'renderChannelListItem', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const el = orig.apply(this, args)
                        try {
                            if (!el || !active('channelList')) return el
                            const a = args[0]
                            let ch: any
                            try {
                                ch = a?.guildChannels?.getChannelFromSectionRow?.(a.section, a.row)?.channel?.record
                            } catch {
                                // 채널이 아닌 줄 (이벤트·부스트 같은 서버 메뉴 줄)
                                return el
                            }
                            if (!ch?.id) return el
                            return createElement(
                                ChannelRow,
                                { key: ch.id, id: ch.id, parent: ch.parent_id ?? null, guildId: a.guild?.id, selected: a.selectedChannelId === ch.id, index: a.row ?? 0 },
                                el,
                            )
                        } catch (e) {
                            report('channelRows', e)
                            return el
                        }
                    }),
                )
            },
            { max: 3 } as any,
        ) as any,
    )
}
