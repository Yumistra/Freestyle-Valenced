import { useSyncExternalStore } from 'react'
import { Dimensions } from 'react-native'
import { channel, FORUMS } from './data'
import { knownThread } from './forum'

/** 이보다 좁으면 목록과 채팅을 한 번에 하나씩 보여 준다 */
export const NARROW = 760
export const isNarrow = (width = Dimensions.get('window')?.width ?? 1000) => width < NARROW

/**
 * 화면 상태 (어느 화면을 보고 있는지). 플러그인 안에서만 쓰는 작은 저장소.
 */
export type Route = 'lobby' | 'heart' | 'depart' | 'guild' | 'inbox'
export type HeartTab = 'contacts' | 'requests' | 'friends'

export interface UiState {
    /** 게임 화면을 띄우고 있는지 (끄면 원래 디스코드가 보인다) */
    visible: boolean
    route: Route
    /** 하트챗에서 연 DM */
    dmId?: string
    heartTab: HeartTab
    /** 출발에서 고른 서버, 그 서버에서 연 채널 */
    guildId?: string
    channelId?: string
    /** 메뉴 창 */
    menu: boolean
    /** 프로필 창 (누구, 어느 서버에서) */
    profile?: { userId: string; guildId?: string }
    /** 화면이 바뀔 때마다 늘어난다 (전환 효과) */
    turn: number
}

const INITIAL: UiState = { visible: false, route: 'lobby', heartTab: 'contacts', menu: false, turn: 0 }

let state: UiState = INITIAL
const listeners = new Set<() => void>()

export const getState = () => state

export function setState(patch: Partial<UiState>) {
    const next = { ...state, ...patch }
    if (patch.route && patch.route !== state.route) next.turn = state.turn + 1
    // 바뀐 게 없으면 다시 그리지 않는다
    if ((Object.keys(next) as (keyof UiState)[]).every(k => next[k] === state[k])) return
    state = next
    listeners.forEach(f => f())
}

export function resetState(patch: Partial<UiState> = {}) {
    state = { ...INITIAL, ...patch }
    listeners.forEach(f => f())
}

const subscribe = (f: () => void) => {
    listeners.add(f)
    return () => {
        listeners.delete(f)
    }
}

/** 상태의 한 부분만 본다 (그 부분이 바뀔 때만 다시 그린다) */
export function useUi<T>(pick: (s: UiState) => T): T {
    return useSyncExternalStore(
        subscribe,
        () => pick(state),
        () => pick(state),
    )
}

// ── 이동 ────────────────────────────────────────────────────────────────
export const go = {
    lobby: () => setState({ route: 'lobby', menu: false }),
    heart: (dmId?: string) => setState({ route: 'heart', dmId, menu: false }),
    depart: () => setState({ route: 'depart', menu: false }),
    inbox: () => setState({ route: 'inbox', menu: false }),
    profile: (userId: string, guildId?: string) => setState({ profile: { userId, guildId } }),
    /** 어떤 채널이든 그 자리로 (DM 은 하트챗, 서버는 그 서버) */
    open: (ch: any) => (ch?.guild_id ? setState({ route: 'guild', guildId: ch.guild_id, channelId: ch.id, menu: false }) : ch?.id ? setState({ route: 'heart', dmId: ch.id, heartTab: 'contacts', menu: false }) : undefined),
    guild: (guildId: string) => setState({ route: 'guild', guildId, channelId: guildId === state.guildId ? state.channelId : undefined, menu: false }),
    channel: (channelId: string) => setState({ channelId }),
}

/** 뒤로 가기. 더 갈 곳이 없으면 false */
export function back(): boolean {
    if (state.profile) return setState({ profile: undefined }), true
    if (state.menu) return setState({ menu: false }), true
    switch (state.route) {
        case 'guild': {
            // 포럼 글에서는 그 포럼으로
            const ch = channel(state.channelId) ?? knownThread(state.channelId)
            if (ch?.parent_id && FORUMS.has(channel(ch.parent_id)?.type)) {
                setState({ channelId: ch.parent_id })
                return true
            }
            if (state.channelId && isNarrow()) setState({ channelId: undefined })
            else go.depart()
            return true
        }
        case 'heart':
            if (state.dmId && isNarrow()) setState({ dmId: undefined })
            else go.lobby()
            return true
        case 'depart':
        case 'inbox':
            go.lobby()
            return true
        default:
            return false
    }
}
