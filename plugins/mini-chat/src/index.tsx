import { ActionSheetActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { Dispatcher } from '@valenced/discord/common/flux'
import { RootNavigationRef } from '@valenced/discord/modules/main_tabs_v2'
import { getModuleWithImportedPath, lookupModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Component, createElement, memo, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, BackHandler, Dimensions, Image, Keyboard, LayoutAnimation, UIManager, PanResponder, Platform, Pressable, ScrollView, StatusBar, Text as RNText, View } from 'react-native'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { withProps } from '@valenced/modules/finders/filters'

/**
 * Mini Chat: 채널을 디스코드 안의 떠 있는 창(팝업)이나 아래쪽 분할 창으로 열어, 여러 채널을 한 번에 본다.
 *
 * 창 안에는 디스코드가 포럼, 스레드를 열 때 쓰는 진짜 채널 화면(StandaloneChannelScreen)을 그대로 그린다.
 * 그 화면이 받는 props 는 디스코드가 채널 화면을 그릴 때 받은 것을 기억해 두고, 채널 ID 만 바꿔서 쓴다.
 * (실험 버전: 무엇이 되고 안 되는지 Copy log 에 자세히 남긴다)
 */

const VERSION = '1.2.7'
const SCREEN_PATH = 'modules/main_tabs_v2/native/channel/StandaloneChannelScreen.tsx'
const TOAST_PATH = 'modules/toast/native/AppToastContainer.tsx'
const SHEET_PATH = 'modules/channel/native/ChannelLongPressActionSheet.tsx'
const MARK = '__miniChat'

const S = () => Stores as any
const D = () => Design as any

// ── 설정 ────────────────────────────────────────────────────────
type Host = 'global' | 'screen'
/** 창을 그리는 실제 자리: 앱 맨 바깥(root, 분할 화면이 되는 곳), 토스트 자리(global), 채팅 화면 안(screen) */
type Place = Host | 'root' | 'stack'
interface Settings {
    /** 창을 어디에 그릴지: global = 앱 전체 위 (토스트 자리), screen = 채팅 화면 안 */
    host: Host
    /** 채팅 화면 모듈 번호 (한 번 불린 걸 본 뒤 기억해 두고, 다음에 앱을 켰을 때 채널을 안 열어도 직접 부른다) */
    screenModuleId?: number
    /** 분할선 위치 (위에서부터 비율) */
    splitRatio?: number
    /** 분할 화면에서 Mini Chat 을 아래로 */
    splitSwap?: boolean
}
const DEFAULTS: Settings = { host: 'global' }
let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
async function save(patch: Partial<Settings>) {
    if (storage && !storage.cache) await storage.get?.().catch?.(() => {})
    await storage?.set?.({ ...settings(), ...patch }, true)
    emit()
}

// ── 로그 ────────────────────────────────────────────────────────
const logs: string[] = []
function note(msg: string) {
    const d = new Date()
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
    logs.push(`${t} ${msg}`)
    if (logs.length > 200) logs.shift()
}
const status = {
    screenFound: false,
    screenRenders: 0,
    ourRenders: 0,
    toastHost: false,
    toastHostRenders: 0,
    screenHostRenders: 0,
    sheetRows: 0,
    errors: 0,
}

let seq = 0
function toast(text: string) {
    try {
        ;(ToastActionCreators as any).open(`mini-chat-${Date.now()}-${seq++}`, { text })
    } catch {}
}

// ── 창 상태 ─────────────────────────────────────────────────────
interface Win {
    id: number
    channelId: string
    x: number
    y: number
    w: number
    h: number
    minimized: boolean
    docked: boolean
    /** 화면 가득 */
    maximized?: boolean
    /** 반투명 */
    transparent?: boolean
    /** 방울 위치 (작게 줄였을 때) */
    bx?: number
    by?: number
    /** 겹침 순서 (클수록 앞) */
    z: number
    /** 분할 화면에서 차지하는 몫 (없으면 똑같이) */
    share?: number
    /** 분할 화면에서 위에서부터의 순서 */
    slot?: number
}
let wins: Win[] = []
/** 창들을 그리는 컴포넌트가 화면에 붙어 있는지 */
let hostMounted = false
let nextId = 1
const listeners = new Set<() => void>()
function emit() {
    for (const l of listeners) {
        try {
            l()
        } catch {}
    }
}
function useStore() {
    const [, set] = useState(0)
    useEffect(() => {
        const f = () => set(n => n + 1)
        listeners.add(f)
        return () => void listeners.delete(f)
    }, [])
}
function setWin(id: number, patch: Partial<Win>) {
    wins = wins.map(w => (w.id === id ? { ...w, ...patch } : w))
    emit()
}
// ── 누른 창 (뒤로가기를 받는 창) ─────────────────────────────────
/** 마지막으로 누른 Mini Chat. null 이면 디스코드 쪽을 누른 것 */
let focusId: number | null = null
let backSub: any
function setFocus(id: number | null) {
    if (focusId === id) {
        if (id != null) armBack()
        return
    }
    focusId = id
    if (id != null) armBack()
    emit()
}
/** 뒤로가기 처리는 마지막에 붙인 것이 먼저 받는다: 창을 누를 때마다 다시 붙여서 디스코드보다 먼저 받게 한다 */
function armBack() {
    try {
        backSub?.remove?.()
        backSub = (BackHandler as any).addEventListener('hardwareBackPress', onBack)
    } catch (e: any) {
        note(`back handler failed: ${e?.message ?? e}`)
    }
}
function onBack(): boolean {
    const w = wins.find(x => x.id === focusId && !x.minimized)
    if (!w || hiddenByOverlay()) return false
    smooth()
    if (w.maximized) {
        // 화면 가득이면 원래 크기로
        setWin(w.id, { maximized: false })
        note(`back: window ${w.id} restored`)
    } else {
        // 아니면 방울로 줄인다 (닫지는 않는다)
        setWin(w.id, { minimized: true, docked: false })
        focusId = null
        note(`back: window ${w.id} minimized`)
        emit()
    }
    return true
}

function closeWin(id: number) {
    if (focusId === id) focusId = null
    wins = wins.filter(w => w.id !== id)
    note(`close window ${id}`)
    emit()
}
/** 맨 앞으로 (순서를 바꾸면 창이 다시 붙으며 입력창 포커스가 풀려서, 겹침 순서 값만 올린다) */
let zTop = 1
function bringToFront(id: number) {
    const w = wins.find(x => x.id === id)
    setFocus(id)
    if (!w || w.z === zTop) return
    setWin(id, { z: ++zTop })
}
export function openChannel(channelId: string) {
    if (!channelId) return
    // 채널 꾹 누르기 창에서 열었으면 그 창은 닫혔다
    sheetOpen = false
    const existing = wins.find(w => w.channelId === channelId)
    if (existing) {
        setWin(existing.id, { minimized: false })
        bringToFront(existing.id)
        return
    }
    const { width, height } = Dimensions.get('window')
    const n = wins.length
    const w = Math.round(width * 0.86)
    const h = Math.round(height * 0.5)
    const win: Win = {
        id: nextId++,
        channelId,
        x: Math.round((width - w) / 2) + (n % 4) * 18,
        y: Math.round(height * 0.12) + (n % 4) * 28,
        w,
        h,
        minimized: false,
        docked: false,
        z: ++zTop,
    }
    wins = [...wins, win]
    focusId = win.id
    armBack()
    note(`open window ${win.id} channel=${channelId} (${channelName(channelId)}) host=${settings().host} propsCaptured=${!!lastProps} hostRenders=${status.toastHostRenders}/${status.screenHostRenders}`)
    emit()
    ack(channelId, 'opened')
    // 창을 그리는 자리(토스트 자리)는 플러그인이 켜지기 전에 이미 그려져 있어서, 다시 그려질 때까지 창이 안 나온다.
    // 토스트를 하나 띄우면 그 자리가 다시 그려진다 (그 뒤로는 창들이 알아서 다시 그린다)
    if (settings().host === 'global' && !hostMounted) toast(`Opening ${channelName(channelId)}`)
}

// ── 채널 정보 ───────────────────────────────────────────────────
function channelName(id: string, plain = false): string {
    try {
        const ch = S().ChannelStore?.getChannel?.(id)
        if (!ch) return id
        if (ch.name) return plain ? ch.name : `#${ch.name}`
        const rid = ch.recipients?.[0] ?? ch.rawRecipients?.[0]?.id
        const u = rid ? S().UserStore?.getUser?.(rid) : undefined
        const n = u ? `${u.globalName ?? u.global_name ?? u.username}` : 'Direct message'
        return plain ? n : `@${n}`
    } catch {
        return id
    }
}
const guildOf = (id: string): string | null => {
    try {
        return S().ChannelStore?.getChannel?.(id)?.guild_id ?? null
    } catch {
        return null
    }
}

// ── 진짜 채널 화면 ──────────────────────────────────────────────
let Screen: any
/** 디스코드가 채널 화면을 그릴 때 마지막으로 받은 props */
let lastProps: any
let lastChannel: string | undefined
let lastGuild: string | null | undefined
let propsSummary = '(not seen yet)'

const isPlain = (v: any) => v != null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) && !v.$$typeof

/** props 안에서 채널 ID 를 찾는다 (바로 아래, 또는 route.params 같은 한 단계 안) */
function findChannelId(p: any): string | undefined {
    if (!p || typeof p !== 'object') return
    if (typeof p.channelId === 'string') return p.channelId
    if (typeof p.channel?.id === 'string') return p.channel.id
    for (const k of Object.keys(p)) {
        const v = p[k]
        if (isPlain(v)) {
            if (typeof v.channelId === 'string') return v.channelId
            if (isPlain(v.params) && typeof v.params.channelId === 'string') return v.params.channelId
        }
    }
}

function describe(v: any, depth = 0): string {
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    const t = typeof v
    if (t === 'string') return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`
    if (t === 'number' || t === 'boolean') return String(v)
    if (t === 'function') return `fn ${v.name || ''}`.trim()
    if (Array.isArray(v)) return `array(${v.length})`
    if (v.$$typeof) return 'element'
    if (depth >= 2) return isPlain(v) ? `{${Object.keys(v).slice(0, 8).join(',')}}` : `${v.constructor?.name ?? 'object'}`
    if (!isPlain(v)) return `${v.constructor?.name ?? 'object'}{${Object.keys(v).slice(0, 10).join(',')}}`
    return `{ ${Object.keys(v)
        .slice(0, 20)
        .map(k => `${k}: ${describe(v[k], depth + 1)}`)
        .join(', ')} }`
}

/** 기억한 props 에서 채널 ID, 서버 ID 를 새 채널로 바꾼다 (한 단계 안의 평범한 객체까지) */
function swap(v: any, channelId: string, guildId: string | null, depth: number): any {
    if (typeof v === 'string' && v === lastChannel) return channelId
    if (!isPlain(v) || depth > 3) return v
    const out: any = {}
    for (const k of Object.keys(v)) {
        const x = v[k]
        if (/guild_?id$/i.test(k) && (typeof x === 'string' || x == null)) out[k] = guildId
        else if (k === 'channel' && x && typeof x === 'object' && typeof x.id === 'string') out[k] = S().ChannelStore?.getChannel?.(channelId) ?? x
        else out[k] = swap(x, channelId, guildId, depth + 1)
    }
    return out
}

/** 디스코드가 채널 화면에 주는 props 모양 (기억한 게 없을 때) */
const BASE_PROPS = { isActive: true, isNavigationTTIVisible: true, showCreateThread: false, isNavigationScreen: false, frame: null, screenIndex: 0 }

function makeProps(win: Win) {
    // DM 은 서버 ID 대신 "@me" 를 쓴다 (없으면 "채팅 채널 없음" 화면이 나온다)
    const guildId = guildOf(win.channelId) ?? '@me'
    const p = lastProps ? swap(lastProps, win.channelId, guildId, 0) : { ...BASE_PROPS }
    p.channelId = win.channelId
    p.guildId = guildId
    p.isNavigationTTIVisible = true
    // 보고 있는 화면으로 다뤄야 읽음 처리가 된다
    p.isActive = true
    // 내비게이션 화면으로 다루면 맨 위에 (창에서는 작동하지 않는) 뒤로 가기 화살표가 붙는다
    p.isNavigationScreen = false
    p[MARK] = win.id
    return p
}

let treeLogged = false
let startCleanup: ((...f: any[]) => void) | undefined
let loadTried = false
/** 화면 모듈을 직접 불러온다 (채널을 아직 하나도 안 열었을 때) */
function rememberScreenId() {
    try {
        const m: any = lookupModuleWithImportedPath(SCREEN_PATH)
        const id = Array.isArray(m) ? m[1] : undefined
        if (typeof id === 'number' && settings().screenModuleId !== id) {
            void save({ screenModuleId: id })
            note(`remembered screen module #${id}`)
        }
    } catch {}
}

function loadScreen(why: string) {
    if (Screen || loadTried || !startCleanup) return
    loadTried = true
    try {
        const m: any = lookupModuleWithImportedPath(SCREEN_PATH)
        let exports = Array.isArray(m) ? m[0] : m
        // 아직 한 번도 안 불린 모듈이면 번호로 직접 부른다
        const r = (globalThis as any).__r
        if (!exports && Array.isArray(m) && m[1] != null && typeof r === 'function') {
            exports = r(m[1])
            note(`required screen module #${m[1]}`)
        }
        // 이 경로가 아직 안 불렸으면 경로로는 번호를 모른다: 전에 기억해 둔 번호로 부르고, 그게 정말 채팅 화면인지 확인한다
        const saved = settings().screenModuleId
        if (!exports && typeof saved === 'number' && typeof r === 'function') {
            try {
                r(saved)
                const again: any = lookupModuleWithImportedPath(SCREEN_PATH)
                const ok = Array.isArray(again) && again[1] === saved ? again[0] : undefined
                note(`required saved screen module #${saved}: ${ok ? 'matches' : 'not the screen (Discord updated?)'}`)
                if (ok) exports = ok
            } catch (e: any) {
                note(`saved module #${saved} failed: ${e?.message ?? e}`)
            }
        }
        note(`load screen (${why}): ${exports ? 'ok' : 'not available'}`)
        if (exports && !Screen) {
            patchScreen(exports, startCleanup)
            setTimeout(emit, 0)
            rememberScreenId()
        }
    } catch (e: any) {
        note(`load screen failed: ${e?.message ?? e}`)
    }
}
/** 그린 결과의 모양 (컴포넌트 이름과 props 이름) */
function tree(n: any, depth: number): string {
    if (n == null || typeof n !== 'object') return ''
    if (Array.isArray(n)) return n.map(x => tree(x, depth)).filter(Boolean).join(', ')
    if (!n.props) return ''
    const t = n.type
    const name = typeof t === 'string' ? t : t?.displayName || t?.name || t?.type?.displayName || t?.type?.name || t?.render?.name || (t?.$$typeof ? String(t.$$typeof.description ?? '?') : '?')
    const keys = Object.keys(n.props).filter(k => k !== 'children').slice(0, 12).join(',')
    const kids = depth < 7 ? tree(n.props.children, depth + 1) : ''
    return `${name}(${keys})${kids ? `[${kids}]` : ''}`
}

function patchScreen(exports: any, cleanup: (...f: any[]) => void) {
    const memo = exports?.default
    if (typeof memo?.type !== 'function') {
        note(`screen module found but default is ${describe(memo)}`)
        return
    }
    Screen = memo
    status.screenFound = true
    note('screen found')
    cleanup(
        instead(memo, 'type', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
            const props = args[0]
            if (props?.[MARK]) {
                status.ourRenders++
                const out = orig.apply(this, args)
                if (!treeLogged) {
                    treeLogged = true
                    try {
                        note(`window screen tree: ${tree(out, 0)}`)
                    } catch {}
                }
                return out
            }
            status.screenRenders++
            try {
                const ch = findChannelId(props)
                if (ch && (props !== lastProps || ch !== lastChannel)) {
                    const first = !lastProps
                    lastProps = props
                    lastChannel = ch
                    lastGuild = guildOf(ch)
                    propsSummary = describe(props)
                    if (first) note(`captured screen props: ${propsSummary}`)
                }
            } catch (e: any) {
                note(`capture failed: ${e?.message ?? e}`)
            }
            const out = orig.apply(this, args)
            // 채팅 화면 안에 그리는 설정이면 맨 아래 채팅 화면(screenIndex 0)에 창들을 얹는다
            if (settings().host === 'screen' && (props?.screenIndex ?? 0) === 0) {
                status.screenHostRenders++
                return (
                    <View style={{ flex: 1 }}>
                        {out}
                        <Windows host="screen" />
                    </View>
                )
            }
            return out
        }),
    )
}

// ── 오류 막이 ───────────────────────────────────────────────────
class Boundary extends Component<{ win: Win; children: any }, { error?: any; stack?: string }> {
    state: { error?: any; stack?: string } = {}
    static getDerivedStateFromError(error: any) {
        return { error }
    }
    componentDidCatch(error: any, info: any) {
        status.errors++
        const stack = String(info?.componentStack ?? '')
            .split('\n')
            .filter(Boolean)
            .slice(0, 12)
            .join(' < ')
        this.setState({ stack })
        note(`window ${this.props.win.id} crashed: ${error?.message ?? error}\n  js: ${String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ')}\n  components: ${stack}`)
    }
    render() {
        if (!this.state.error) return this.props.children
        const { Text, Button } = D()
        return (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
                <Text variant="text-md/semibold" color="text-danger">
                    This channel could not be shown here
                </Text>
                <Text variant="text-sm/normal" color="text-muted">
                    {String(this.state.error?.message ?? this.state.error)}
                </Text>
                {Button ? <Button text="Copy log" size="sm" variant="secondary" onPress={copyLog} /> : null}
            </ScrollView>
        )
    }
}

// ── 창 ──────────────────────────────────────────────────────────
function color(name: string, fallback: string) {
    try {
        const t: any = (Tokens as any).default ?? Tokens
        const theme = S().ThemeStore?.theme ?? 'dark'
        const c = t.internal.resolveSemanticColor(theme, t.colors[name])
        return typeof c === 'string' ? c : fallback
    } catch {
        return fallback
    }
}

const TITLE_H = 40
const MIN_W = 200
const MIN_H = 160

/** 디스코드 아이콘 (이름 여러 개 중 있는 것, 없으면 글자) */
function DIcon({ names, fallback, c, size = 20 }: { names: string[]; fallback: string; c: string; size?: number }) {
    let C: any
    for (const n of names) C ??= icon(n)
    if (C) return <C size="sm" color={c} style={{ width: size, height: size }} />
    return <RNText style={{ color: c, fontSize: 18, fontWeight: '700' }}>{fallback}</RNText>
}

function IconButton({ names, fallback, onPress }: { names: string[]; fallback: string; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} hitSlop={6} style={{ width: 36, height: TITLE_H, alignItems: 'center', justifyContent: 'center' }}>
            <DIcon names={names} fallback={fallback} c={color('INTERACTIVE_NORMAL', '#ddd')} />
        </Pressable>
    )
}

const MIN_ICON = ['MinusIcon', 'WindowMinimizeIcon', 'MinimizeIcon']
const DOCK_ICON = ['WindowMaximizeIcon', 'MaximizeIcon', 'ScreenIcon', 'FullscreenEnterIcon']
const UNDOCK_ICON = ['WindowLaunchIcon', 'FullscreenExitIcon', 'MinimizeIcon']
const CLOSE_ICON = ['XSmallIcon', 'XLargeIcon', 'CloseSmallIcon']

/** 채널 종류 아이콘 */
function channelIconNames(id: string): string[] {
    try {
        const t = S().ChannelStore?.getChannel?.(id)?.type
        switch (t) {
            case 1:
                return ['AtIcon', 'UserIcon']
            case 3:
                return ['GroupIcon', 'UserIcon']
            case 2:
            case 13:
                return ['VoiceNormalIcon']
            case 5:
                return ['AnnouncementsIcon', 'TextIcon']
            case 10:
            case 11:
            case 12:
                return ['ThreadIcon', 'TextIcon']
            case 15:
                return ['ForumIcon', 'TextIcon']
            default:
                return ['TextIcon']
        }
    } catch {
        return ['TextIcon']
    }
}

function Title({ win, text }: { win: Win; text: string }) {
    return (
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <DIcon names={channelIconNames(win.channelId)} fallback="#" c={color('INTERACTIVE_MUTED', '#999')} size={18} />
            <RNText numberOfLines={1} style={{ flexShrink: 1, color: text, fontWeight: '700' }}>
                {channelName(win.channelId, true)}
            </RNText>
        </View>
    )
}

// ── 키보드 ──────────────────────────────────────────────────────
let keyboard = 0
function useKeyboard() {
    const [h, setH] = useState(keyboard)
    useEffect(() => {
        const a = Keyboard.addListener('keyboardDidShow', (e: any) => {
            keyboard = e?.endCoordinates?.height ?? 0
            setH(keyboard)
        })
        const b = Keyboard.addListener('keyboardDidHide', () => {
            keyboard = 0
            setH(0)
        })
        return () => {
            a.remove()
            b.remove()
        }
    }, [])
    return h
}

// ── 화면 위아래 여백 (상태 바 자리) 없애기 ──────────────────────
let insetsCtx: any
let insetsLooked = false
function insetsContext() {
    if (insetsLooked) return insetsCtx
    insetsLooked = true
    try {
        const r: any = lookupModule(withProps('SafeAreaInsetsContext') as any)
        const m = Array.isArray(r) ? r[0] : r
        insetsCtx = m?.SafeAreaInsetsContext
    } catch {}
    note(`safe area context: ${insetsCtx ? 'found' : 'missing'}`)
    return insetsCtx
}
const ZERO = { top: 0, bottom: 0, left: 0, right: 0 }

// ── 삼성 팝업 모양 ──────────────────────────────────────────────
const HANDLE_H = 22
const BUBBLE = 54
const OPACITY_ICON = ['EyeIcon', 'EyeSlashIcon']
const SPLIT_ICON = ['WindowMaximizeIcon', 'ScreenIcon', 'ScreenArrowIcon']
const MAX_ICON = ['FullscreenEnterIcon', 'MaximizeIcon', 'ArrowsOutwardIcon']
const RESTORE_ICON = ['FullscreenExitIcon', 'MinimizeIcon', 'WindowLaunchIcon']

/** 작게 줄였을 때 방울에 넣을 그림 (서버 아이콘 또는 DM 상대 프로필 사진) */
function bubbleImage(channelId: string): string | undefined {
    try {
        const ch = S().ChannelStore?.getChannel?.(channelId)
        if (!ch) return
        if (ch.guild_id) {
            const g = S().GuildStore?.getGuild?.(ch.guild_id)
            if (g?.icon) return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`
            return
        }
        if (ch.icon) return `https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.png?size=96`
        const rid = ch.recipients?.[0] ?? ch.rawRecipients?.[0]?.id
        const u = rid ? S().UserStore?.getUser?.(rid) : undefined
        if (u?.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=96`
    } catch {}
}

function Window({ win, dockIndex, dockCount, kb, front }: { win: Win; dockIndex: number; dockCount: number; kb: number; front: boolean }) {
    const { width, height } = Dimensions.get('window')
    const [drag, setDrag] = useState<{ dx: number; dy: number; dw: number; dh: number; left?: boolean }>({ dx: 0, dy: 0, dw: 0, dh: 0 })
    const [bar, setBar] = useState(false)
    const barTimer = useRef<any>()
    const winRef = useRef(win)
    winRef.current = win
    // 나타나기, 사라지기 (창과 방울 모두)
    const appear = useRef(new Animated.Value(0)).current
    useEffect(() => {
        appear.setValue(0)
        Animated.spring(appear, { toValue: 1, useNativeDriver: true, stiffness: 320, damping: 26, mass: 0.8 }).start()
    }, [win.minimized])
    const animateOut = (then: () => void) => {
        Animated.timing(appear, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => then())
    }
    // 버튼 줄
    const barAnim = useRef(new Animated.Value(0)).current
    useEffect(() => () => clearTimeout(barTimer.current), [])
    const showBar = (on: boolean) => {
        clearTimeout(barTimer.current)
        if (on) {
            setBar(true)
            barAnim.setValue(0)
            Animated.spring(barAnim, { toValue: 1, useNativeDriver: true, stiffness: 420, damping: 24, mass: 0.6 }).start()
            // 삼성처럼 잠시 뒤 저절로 숨긴다
            barTimer.current = setTimeout(() => barRef.current(false), 4000)
        } else {
            Animated.timing(barAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => setBar(false))
        }
    }
    const barRef = useRef(showBar)
    barRef.current = showBar
    const barOn = useRef(bar)
    barOn.current = bar
    const lastTap = useRef(0)
    // 위로 끌어 올리는 중: 놓으면 분할 화면이 된다는 표시
    const [snap, setSnap] = useState(false)

    // 위 손잡이: 끌면 옮기고, 톡 누르면 버튼 줄을 연다
    const move = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
            // 방울 안의 누르기 버튼이 터치를 먼저 가져가도, 끌기 시작하면 가져온다
            onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
            onPanResponderGrant: () => bringToFront(winRef.current.id),
            onPanResponderMove: (_e, g) => {
                const w = winRef.current
                if (!w.minimized && w.docked) {
                    // 분할 창: 위아래로만 따라오고, 분할선을 넘겨 놓으면 자리를 바꾼다
                    setDrag({ dx: 0, dy: g.dy, dw: 0, dh: 0 })
                    return
                }
                if (!w.minimized && w.maximized) return
                setDrag({ dx: g.dx, dy: g.dy, dw: 0, dh: 0 })
                if (!w.minimized) setSnap(g.moveY < (StatusBar.currentHeight ?? 24) + SNAP_ZONE)
            },
            onPanResponderRelease: (_e, g) => {
                const w = winRef.current
                setDrag({ dx: 0, dy: 0, dw: 0, dh: 0 })
                setSnap(false)
                if (Math.abs(g.dx) + Math.abs(g.dy) < 6) {
                    // 두 번 톡: 바로 화면 가득 펼치기 (다시 두 번 톡하면 원래대로)
                    const now = Date.now()
                    if (!w.minimized && now - lastTap.current < 320) {
                        lastTap.current = 0
                        barRef.current(false)
                        smooth()
                        setWin(w.id, { maximized: !w.maximized, docked: false })
                        return
                    }
                    lastTap.current = now
                    barRef.current(!barOn.current)
                    return
                }
                const { width: W, height: H } = Dimensions.get('window')
                if (w.minimized) {
                    // 방울은 가까운 화면 가장자리에 붙인다
                    const cx = (w.bx ?? W - BUBBLE - 6) + g.dx + BUBBLE / 2
                    smooth()
                    setWin(w.id, { bx: cx < W / 2 ? 6 : W - BUBBLE - 6, by: Math.min(Math.max((w.by ?? w.y) + g.dy, StatusBar.currentHeight ?? 0), H - BUBBLE - 8) })
                    return
                }
                if (w.docked) {
                    const sg = splitGeom()
                    if (sg.swap ? g.moveY < sg.L : g.moveY > sg.L) return splitActions.swap()
                    // 다른 분할 창 위에 놓으면 그 창과 자리를 바꾼다
                    const list = dockLayout()
                    const target = list.find(r => r.w.id !== w.id && g.moveY >= r.top && g.moveY <= r.top + r.height)
                    if (target) swapDocked(w.id, target.w.id)
                    return
                }
                if (w.maximized) return
                // 화면 맨 위로 끌어 놓으면 분할 화면으로
                if (g.moveY < (StatusBar.currentHeight ?? 24) + SNAP_ZONE) {
                    smooth()
                    setWin(w.id, { docked: true })
                    return
                }
                setWin(w.id, {
                    x: Math.min(Math.max(w.x + g.dx, -w.w + 80), W - 80),
                    y: Math.min(Math.max(w.y + g.dy, StatusBar.currentHeight ?? 0), H - HANDLE_H - 40),
                })
            },
            onPanResponderTerminate: () => {
                setDrag({ dx: 0, dy: 0, dw: 0, dh: 0 })
                setSnap(false)
            },
        }),
    ).current

    // 아래 양쪽 모서리: 끌어서 크기 바꾸기
    const makeResize = (left: boolean) =>
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => bringToFront(winRef.current.id),
            onPanResponderMove: (_e, g) => setDrag({ dx: 0, dy: 0, dw: left ? -g.dx : g.dx, dh: g.dy, left }),
            onPanResponderRelease: (_e, g) => {
                const w = winRef.current
                setDrag({ dx: 0, dy: 0, dw: 0, dh: 0 })
                const nw = Math.max(MIN_W, w.w + (left ? -g.dx : g.dx))
                setWin(w.id, { w: nw, h: Math.max(MIN_H, w.h + g.dy), x: left ? w.x + (w.w - nw) : w.x })
            },
            onPanResponderTerminate: () => setDrag({ dx: 0, dy: 0, dw: 0, dh: 0 }),
        })
    const resizeR = useRef(makeResize(false)).current
    const resizeL = useRef(makeResize(true)).current

    const bg = color('BACKGROUND_BASE_LOWER', '#1e1f22')
    const strip = color('BACKGROUND_BASE_LOWEST', '#111214')
    const subtle = color('BORDER_SUBTLE', '#ffffff22')
    const accent = color('TEXT_BRAND', '#5865f2')
    const muted = color('INTERACTIVE_MUTED', '#888')

    // 작게 줄인 창: 동그란 방울 (누르면 다시 펴고, 꾹 누르면 닫는다)
    if (win.minimized) {
        const img = bubbleImage(win.channelId)
        return (
            <Animated.View
                {...move.panHandlers}
                style={{
                    opacity: appear,
                    transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
                    position: 'absolute',
                    left: (win.bx ?? width - BUBBLE - 6) + drag.dx,
                    top: (win.by ?? win.y) + drag.dy,
                    width: BUBBLE,
                    height: BUBBLE,
                    borderRadius: BUBBLE / 2,
                    backgroundColor: strip,
                    borderWidth: 2,
                    borderColor: accent,
                    overflow: 'hidden',
                    alignItems: 'center',
                    justifyContent: 'center',
                    elevation: 16,
                    zIndex: 1000000,
                }}
            >
                <Pressable onPress={() => animateOut(() => setWin(win.id, { minimized: false }))} onLongPress={() => animateOut(() => closeWin(win.id))} style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                    {img ? <Image source={{ uri: img }} style={{ width: '100%', height: '100%' }} /> : <DIcon names={channelIconNames(win.channelId)} fallback="#" c={color('INTERACTIVE_NORMAL', '#ddd')} size={26} />}
                </Pressable>
            </Animated.View>
        )
    }

    const minTop = StatusBar.currentHeight ?? 24
    let frame = win.maximized
        ? { left: 0, top: minTop, width, height: height - minTop }
        : win.docked
          ? (() => {
                // 분할: 화면 아래 절반을 도킹한 창끼리 나눠 쓴다
                // 분할: 위 절반은 창(들), 아래 절반은 디스코드 (앱 바깥 자리가 있으면 디스코드를 아래로 줄인다)
                const r = dockLayout().find(x => x.w.id === win.id)
                const g = splitGeom()
                return { left: 0, top: (r?.top ?? g.chatTop) + drag.dy, width, height: r?.height ?? g.chatBottom - g.chatTop }
            })()
          : {
                left: win.x + drag.dx - (drag.left ? drag.dw : 0),
                top: win.y + drag.dy,
                width: Math.max(MIN_W, win.w + drag.dw),
                height: Math.max(MIN_H, win.h + drag.dh),
            }
    // 키보드가 열리면 채널 화면은 키보드 높이만큼 아래를 비운다 (화면 맨 아래까지 닿는다고 생각한다).
    // 그래서 맨 앞 창은 아래쪽을 화면 끝까지 늘리고, 키보드 위로 원래 높이만큼 보이게 올린다
    // 창 크기는 그대로 두고, 안의 채널 화면만 키보드 높이만큼 아래로 늘려 잘라 낸다 (NoInsets).
    // (예전처럼 창을 늘리면 아래의 분할 창, 디스코드를 덮어 검게 보였다)
    // 지금 입력하는 창(마지막에 누른 창)만 키보드에 가리면 키보드 위로 올리고, 그래도 안 되면 줄인다
    if (kb > 0 && focusId === win.id && frame.top + frame.height > height - kb) {
        const top = Math.max(minTop, height - kb - frame.height)
        frame = { ...frame, top, height: Math.max(80, Math.min(frame.height, height - kb - top)) }
    }
    const free = !win.docked && !win.maximized
    const act = (f: () => void) => () => {
        showBar(false)
        f()
    }

    return (
        <>
        {snap ? (
            <View pointerEvents="none" style={{ position: 'absolute', left: 6, right: 6, top: minTop + 4, height: splitGeom().chatBottom - minTop - 8, borderRadius: 16, borderWidth: 2, borderColor: accent, backgroundColor: accent + '33', alignItems: 'center', justifyContent: 'center' }}>
                <RNText style={{ color: color('TEXT_NORMAL', '#fff'), fontSize: 14, fontWeight: '700' }}>Drop here for split screen</RNText>
            </View>
        ) : null}
        <Animated.View
            onStartShouldSetResponderCapture={() => {
                if (focusId !== winRef.current.id) bringToFront(winRef.current.id)
                return false
            }}
            style={{
                position: 'absolute',
                ...frame,
                transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
                backgroundColor: bg,
                borderRadius: free ? 16 : 0,
                // 앞에 있는 창은 테두리 색으로 표시한다
                borderWidth: free ? (focusId === win.id ? 2 : 1) : 0,
                borderColor: focusId === win.id ? accent : subtle,
                overflow: 'hidden',
                opacity: win.transparent ? Animated.multiply(appear, 0.55) : appear,
                // 겹침 순서는 zIndex 로만 (안드로이드는 그림자 높이가 다르면 그게 순서를 정해 버린다)
                zIndex: win.z,
                elevation: 16,
            }}
        >
            {/* 위 손잡이 */}
            <View {...move.panHandlers} style={{ height: HANDLE_H, alignItems: 'center', justifyContent: 'center', backgroundColor: strip }}>
                <View style={{ width: focusId === win.id ? 46 : 40, height: 4, borderRadius: 2, backgroundColor: focusId === win.id ? accent : muted }} />
            </View>
            <View style={{ flex: 1, overflow: 'hidden' }}>
                <Boundary win={win}>
                    <NoInsets kb={kb}>
                        <ChannelView id={win.id} channelId={win.channelId} ready={!!Screen} />
                    </NoInsets>
                </Boundary>
                {/* 뒤에 있는 창: 안의 채팅 목록은 터치를 디스코드가 직접 받아서 눌린 걸 알 수 없다.
                    그래서 뒤의 창 위에는 투명한 판을 덮어, 처음 누르면 앞으로만 올린다 */}
                <Pressable
                    pointerEvents={front && focusId === win.id ? 'none' : 'auto'}
                    onPressIn={() => bringToFront(win.id)}
                    style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
                />
            </View>
            {/* 버튼 줄: 손잡이를 누르면 위에 뜬다 */}
            {bar ? (
                <Animated.View
                    style={{
                        opacity: barAnim,
                        transform: [{ translateY: barAnim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }, { scale: barAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
                        position: 'absolute',
                        top: 2,
                        alignSelf: 'center',
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 6,
                        height: 38,
                        borderRadius: 19,
                        backgroundColor: strip,
                        borderWidth: 1,
                        borderColor: subtle,
                        elevation: 4,
                    }}
                >
                    <BarButton names={OPACITY_ICON} fallback="◐" on={win.transparent} accent={accent} onPress={act(() => setWin(win.id, { transparent: !win.transparent }))} />
                    <BarButton names={MIN_ICON} fallback="–" accent={accent} onPress={act(() => animateOut(() => setWin(win.id, { minimized: true })))} />
                    <BarButton names={SPLIT_ICON} fallback="▤" on={win.docked} accent={accent} onPress={act(() => {
                            smooth()
                            setWin(win.id, { docked: !win.docked, maximized: false })
                        })} />
                    <BarButton names={win.maximized ? RESTORE_ICON : MAX_ICON} fallback="⤢" on={win.maximized} accent={accent} onPress={act(() => {
                            smooth()
                            setWin(win.id, { maximized: !win.maximized, docked: false })
                        })} />
                    <BarButton names={CLOSE_ICON} fallback="×" accent={accent} onPress={act(() => animateOut(() => closeWin(win.id)))} />
                </Animated.View>
            ) : null}
            {free ? (
                <>
                    <View {...resizeR.panHandlers} style={{ position: 'absolute', right: 0, bottom: 0, width: 30, height: 30 }} />
                    <View {...resizeL.panHandlers} style={{ position: 'absolute', left: 0, bottom: 0, width: 30, height: 30 }} />
                </>
            ) : null}
        </Animated.View>
        </>
    )
}

/** 다음 한 번의 배치 변화(전체 화면, 분할, 방울 붙이기)를 부드럽게 */
let layoutAnimReady = false
function smooth() {
    try {
        if (!layoutAnimReady) {
            layoutAnimReady = true
            ;(UIManager as any).setLayoutAnimationEnabledExperimental?.(true)
        }
        LayoutAnimation.configureNext({ duration: 220, update: { type: 'easeInEaseOut' }, create: { type: 'easeInEaseOut', property: 'opacity' }, delete: { type: 'easeInEaseOut', property: 'opacity' } })
    } catch {}
}

function BarButton({ names, fallback, onPress, on, accent }: { names: string[]; fallback: string; onPress: () => void; on?: boolean; accent: string }) {
    return (
        <Pressable onPress={onPress} hitSlop={4} style={{ width: 36, height: 34, alignItems: 'center', justifyContent: 'center' }}>
            <DIcon names={names} fallback={fallback} c={on ? accent : color('INTERACTIVE_NORMAL', '#ddd')} size={18} />
        </Pressable>
    )
}

/** 창 안의 채널 화면이 상태 바, 아래 바 자리만큼 비우지 않게 한다 */
/** 아래 내비게이션 바 높이 (채팅 화면이 그만큼 아래를 비운다) */
function navBarHeight() {
    try {
        const scr = Dimensions.get('screen').height
        const win = Dimensions.get('window').height
        const h = scr - win - (StatusBar.currentHeight ?? 0)
        return h > 4 && h < 120 ? h : 32
    } catch {
        return 32
    }
}

function NoInsets({ children, kb }: { children: any; kb: number }) {
    const Ctx = insetsContext()
    // 위 여백은 디스코드가 기기 값을 직접 읽어서 비워서(알려 줘도 그대로였다), 상태 바 높이만큼 끌어올려 가린다
    // 아래 내비게이션 바 자리도 (키보드가 없을 때만) 아래로 내려 가린다
    const inner = <View style={{ flex: 1, marginTop: -(StatusBar.currentHeight ?? 0), marginBottom: kb > 0 ? -kb : -navBarHeight() }}>{children}</View>
    return Ctx?.Provider ? <Ctx.Provider value={ZERO}>{inner}</Ctx.Provider> : inner
}

/**
 * 창 안의 채널 화면. 창을 옮기거나 앞으로 올릴 때마다 채널 화면을 다시 그리면 느려서,
 * 채널이 바뀔 때만 다시 그린다 (props 도 그때만 새로 만든다)
 */
const ChannelView = memo(function ChannelView({ id, channelId, ready }: { id: number; channelId: string; ready: boolean }) {
    const props = useMemo(() => (ready ? makeProps({ id, channelId } as Win) : null), [id, channelId, ready])
    return <ChannelBody id={id} channelId={channelId} props={props} />
})

function ChannelBody({ id, channelId, props }: { id: number; channelId: string; props: any }) {
    const { Text } = D()
    if (!Screen || !props) {
        loadScreen('window')
        return (
            <View style={{ flex: 1, padding: 12, paddingTop: 12 + (StatusBar.currentHeight ?? 0) }}>
                <Text variant="text-sm/normal" color="text-muted">
                    Loading Discord's channel screen. If this stays, copy the log from the settings.
                </Text>
            </View>
        )
    }
    return createElement(Screen, { key: `mini-${id}-${channelId}`, ...props })
}

function Windows({ host }: { host: Place }) {
    useStore()
    useEffect(() => {
        if (host === 'screen') return
        if (host === 'stack') stackHost = true
        hostMounted = true
        note(`${host} host mounted`)
        emit()
        return () => {
            if (host === 'stack') stackHost = false
            hostMounted = false
        }
    }, [])
    // 훅은 언제나 같은 순서로 (일찍 돌려주기 전에)
    const kb = useKeyboard()
    if (settings().host !== (host === 'root' || host === 'stack' ? 'global' : host) || !wins.length) return null
    // 화면 묶음 자리가 있으면 토스트 자리에는 그리지 않는다
    if (host === 'global' && stackHost) return null
    const hidden = host !== 'screen' && hiddenByOverlay()
    // 분할 중에는 디스코드의 시트, 화면이 아래 절반 안에서만 열려서 위의 분할 창은 가리지 않는다: 그대로 둔다
    const shown = (w: Win) => !hidden || (rootActive && w.docked && !w.minimized)
    const hiddenCount = wins.filter(w => !shown(w)).length
    const docked = wins.filter(w => w.docked && !w.minimized)
    const open = wins.filter(w => !w.minimized && shown(w))
    const frontId = open.reduce<Win | undefined>((a, w) => (!a || w.z > a.z ? w : a), undefined)?.id
    // 숨길 때도 창을 빼지 않고 투명하게만 한다 (빼면 채널 화면을 처음부터 다시 불러와 깜빡인다)
    return (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
            {wins.map(w => (
                <View key={w.id} pointerEvents={shown(w) ? 'box-none' : 'none'} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, opacity: shown(w) ? 1 : 0, zIndex: w.z }}>
                    <Window win={w} dockIndex={docked.indexOf(w)} dockCount={docked.length} kb={kb} front={w.id === frontId} />
                </View>
            ))}
            {host === 'stack' && rootActive && docked.length ? <Divider /> : null}
            {host === 'stack' && rootActive ? dockLayout().slice(0, -1).map((r, i) => <SubDivider key={`sub-${r.w.id}`} index={i} />) : null}
            {hiddenCount ? (
                // 숨긴 동안은 작은 표시만 (혹시 숨긴 채로 남으면 눌러서 다시 보이게)
                <Pressable
                    onPress={() => {
                        forceShow = true
                        emit()
                    }}
                    style={{ position: 'absolute', right: 8, top: (StatusBar.currentHeight ?? 24) + 4, paddingHorizontal: 10, height: 26, borderRadius: 13, justifyContent: 'center', backgroundColor: color('BACKGROUND_BASE_LOWEST', '#111214'), opacity: 0.85, zIndex: 2000000 }}
                >
                    <RNText style={{ color: color('TEXT_MUTED', '#aaa'), fontSize: 12, fontWeight: '700' }}>{`Mini Chat ${hiddenCount}`}</RNText>
                </Pressable>
            ) : null}
        </View>
    )
}

// ── 읽음 처리 ───────────────────────────────────────────────────
/** 창으로 보고 있는 채널을 읽음으로 (디스코드는 메인 화면에서 보는 채널만 읽음 처리한다) */
const ackTimers = new Map<string, any>()
function ack(channelId: string, why: string) {
    clearTimeout(ackTimers.get(channelId))
    ackTimers.set(
        channelId,
        setTimeout(() => {
            ackTimers.delete(channelId)
            try {
                const rs = S().ReadStateStore
                const last = rs?.lastMessageId?.(channelId) ?? S().ChannelStore?.getChannel?.(channelId)?.lastMessageId ?? S().ChannelStore?.getChannel?.(channelId)?.last_message_id
                const unread = rs?.hasUnread?.(channelId)
                if (!last) return
                ;(Dispatcher as any).dispatch({ type: 'BULK_ACK', context: 'APP', channels: [{ channelId, messageId: last, readStateType: 0 }] })
                note(`ack ${channelName(channelId)} (${why}) unreadBefore=${unread} after=${rs?.hasUnread?.(channelId)}`)
            } catch (e: any) {
                note(`ack failed: ${e?.message ?? e}`)
            }
        }, 600),
    )
}
function patchAck(cleanup: (...f: any[]) => void) {
    const onMessage = (e: any) => {
        const id = e?.channelId ?? e?.message?.channel_id
        if (!id) return
        if (wins.some(w => w.channelId === id && !w.minimized && !hiddenByOverlay())) ack(id, 'new message')
    }
    try {
        ;(Dispatcher as any).subscribe('MESSAGE_CREATE', onMessage)
        cleanup(() => (Dispatcher as any).unsubscribe('MESSAGE_CREATE', onMessage))
    } catch (e: any) {
        note(`message subscribe failed: ${e?.message ?? e}`)
    }
}

// ── 다른 창(시트, 모달)이 열리면 창을 숨긴다 ──────────────────
// 창은 앱 전체 위(토스트 자리)에 그려서 디스코드의 시트, 모달보다 위에 온다. 그런 게 열려 있는 동안은 숨긴다
let sheetOpen = false
let navCovered = false
let forceShow = false
const hiddenByOverlay = () => !forceShow && (sheetOpen || navCovered)
function setSheet(open: boolean, why: string) {
    if (sheetOpen === open) return
    sheetOpen = open
    if (!open) forceShow = false
    note(`sheet ${open ? 'open' : 'closed'} (${why})`)
    emit()
}
function patchOverlays(cleanup: (...f: any[]) => void) {
    const A: any = ActionSheetActionCreators
    try {
        note(`sheet creators: ${Object.keys(A ?? {}).join(',')}`)
    } catch {}
    for (const k of ['open', 'openLazy']) {
        if (typeof A?.[k] !== 'function') continue
        cleanup(
            instead(A, k, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                setSheet(true, `${k} ${typeof args[1] === 'string' ? args[1] : ''}`)
                return orig.apply(this, args)
            }),
        )
    }
    if (typeof A?.hideActionSheet === 'function')
        cleanup(
            instead(A, 'hideActionSheet', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                setSheet(false, 'hide')
                return orig.apply(this, args)
            }),
        )
    // 화면 위에 쌓이는 화면(프로필, 사진 보기 등): 루트 내비게이션 상태를 본다
    let base: string | undefined
    const check = () => {
        try {
            const ref = (RootNavigationRef as any).getRootNavigationRef?.()
            const st = ref?.getRootState?.() ?? ref?.getState?.()
            const routes: any[] = st?.routes ?? []
            const names = routes.map(r => r?.name).join(' > ')
            base ??= routes[0]?.name
            const top = routes[routes.length - 1]?.name
            const covered = routes.length > 1 && top !== base && !/channel/i.test(String(top))
            if (covered !== navCovered || names !== lastNav) note(`navigation: ${names}${covered ? ' (hide windows)' : ''}`)
            lastNav = names
            if (covered !== navCovered) {
                navCovered = covered
                if (!covered) forceShow = false
                emit()
            }
        } catch {}
    }
    let lastNav = ''
    let sub: any
    const attach = () => {
        try {
            const ref = (RootNavigationRef as any).getRootNavigationRef?.()
            if (!ref?.addListener) return false
            sub = ref.addListener('state', check)
            check()
            return true
        } catch {
            return false
        }
    }
    if (!attach()) {
        const t = setInterval(() => attach() && clearInterval(t), 1000)
        cleanup(() => clearInterval(t))
    }
    cleanup(() => {
        try {
            sub?.()
        } catch {}
    })
}

// ── 분할 화면: 디스코드 전체를 아래 절반으로 ────────────────────
let rootActive = false
let stackHost = false
const DIV = 14
/** 분할선을 잡는 자리 (보이는 선보다 넓게) */
const DIV_TOUCH = 40
const SNAP_ZONE = 40
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
/** 분할 화면 배치: 분할선 위치, Mini Chat 자리, 디스코드 자리 */
function splitGeom() {
    const H = Dimensions.get('window').height
    const SB = StatusBar.currentHeight ?? 0
    const st = settings()
    const r = clamp(st.splitRatio ?? 0.5, 0.2, 0.8)
    const L = Math.round(SB + (H - SB) * r)
    const swap = !!st.splitSwap
    return {
        H,
        SB,
        L,
        swap,
        chatTop: swap ? L + DIV / 2 : SB,
        chatBottom: swap ? H : L - DIV / 2,
        discordTop: swap ? SB : L + DIV / 2,
        discordBottom: swap ? L - DIV / 2 : H,
    }
}
const splitLine = () => splitGeom().L
const anyDocked = () => wins.some(w => w.docked && !w.minimized)

const WRAP = '__miniChatInner'
const SKIP = '__miniChatSkip'
const stackKeysSeen = new Set<string>()

/** 루트 화면 스택인지 (그 안에 "main" 화면이 있다) */
function isRootStack(props: any): boolean {
    let found = false
    const keys: string[] = []
    const visit = (c: any) => {
        if (Array.isArray(c)) return c.forEach(visit)
        const k = c?.key != null ? String(c.key) : ''
        if (k) keys.push(k)
        if (/^main(-|$)/.test(k) || c?.props?.route?.name === 'main' || c?.props?.descriptor?.route?.name === 'main') found = true
    }
    visit(props?.children)
    const sig = keys.slice(0, 6).join(',')
    if (sig && !stackKeysSeen.has(sig) && stackKeysSeen.size < 12) {
        stackKeysSeen.add(sig)
        note(`screen stack: ${sig}${found ? ' (root)' : ''}`)
    }
    return found
}

/**
 * 루트 화면 스택(메인, 설정 등 디스코드 화면 전부)을 감싼다: 분할 중이면 그 스택을 아래 절반으로 민다.
 * 스택은 안드로이드 쪽 화면이라 위치만 바꾸면 디스코드가 그 크기에 맞춰 다시 그린다
 */
function SplitStack(props: any) {
    useStore()
    const { [WRAP]: Inner, ...rest } = props
    const split = settings().host === 'global' && anyDocked()
    const g = splitGeom()
    // 디스코드 화면은 원래 상태 바 아래부터 그려진다: 위로 Mini Chat 이면 위를 비우고, 아래로 Mini Chat 이면 아래를 비운다
    const top = split && !g.swap ? g.discordTop - g.SB : 0
    const bottom = split && g.swap ? g.H - g.discordBottom : 0
    // 창들도 여기(화면 묶음 바로 옆, 맨 위)에 그린다. 토스트 자리는 다시 그려지지 않으면 창이 안 나왔다
    return (
        <>
            {/* 디스코드 쪽을 누르면 뒤로가기는 다시 디스코드가 받는다 */}
            <View
                collapsable={false}
                style={{ flex: 1 }}
                onStartShouldSetResponderCapture={() => {
                    if (focusId != null) setFocus(null)
                    return false
                }}
            >
                {createElement(Inner, { ...rest, [SKIP]: true, style: [rest.style, top || bottom ? { marginTop: top, marginBottom: bottom } : null] })}
            </View>
            <Windows host="stack" />
        </>
    )
}

const SWAP_ICON = ['ArrowsUpDownIcon', 'ArrowsVerticalIcon', 'RefreshIcon']
const POPUP_ICON = ['WindowLaunchIcon', 'ScreenArrowIcon', 'FullscreenExitIcon']

/** 분할한 창 중 맨 앞 */
const frontDocked = () => {
    const list = wins.filter(w => w.docked && !w.minimized)
    return list.find(w => w.id === focusId) ?? list.reduce<Win | undefined>((a, w) => (!a || w.z > a.z ? w : a), undefined)
}

/** 분할 창들의 자리 (위에서부터, 각자 몫만큼, 사이에 얇은 선) */
function dockLayout(): { w: Win; top: number; height: number }[] {
    const g = splitGeom()
    const list = wins.filter(w => w.docked && !w.minimized).sort((a, b) => (a.slot ?? a.id) - (b.slot ?? b.id))
    if (!list.length) return []
    const known = list.filter(w => w.share != null)
    const avg = known.length ? known.reduce((a, w) => a + (w.share as number), 0) / known.length : 1
    const shares = list.map(w => w.share ?? avg)
    const total = shares.reduce((a, b) => a + b, 0)
    const avail = Math.max(0, g.chatBottom - g.chatTop - DIV * (list.length - 1))
    let y = g.chatTop
    return list.map((w, i) => {
        const h = (avail * shares[i]) / total
        const r = { w, top: y, height: h }
        y += h + DIV
        return r
    })
}
/** 두 분할 창의 자리를 바꾼다 (크기는 자리를 따라간다) */
function swapDocked(a: number, b: number) {
    const list = dockLayout()
    const ia = list.findIndex(r => r.w.id === a)
    const ib = list.findIndex(r => r.w.id === b)
    if (ia < 0 || ib < 0) return
    const slots = list.map((r, i) => i)
    ;[slots[ia], slots[ib]] = [slots[ib], slots[ia]]
    const heights = list.map(r => r.height)
    smooth()
    wins = wins.map(w => {
        const i = list.findIndex(r => r.w.id === w.id)
        return i < 0 ? w : { ...w, slot: slots[i], share: heights[slots[i]] }
    })
    note(`split: swap windows ${a} and ${b}`)
    emit()
}

/** 분할 창 사이의 선: 끌면 두 창의 크기를 나눠 바꾼다 */
function SubDivider({ index }: { index: number }) {
    useStore()
    const [dy, setDy] = useState(0)
    const list = dockLayout()
    const a = list[index]
    const b = list[index + 1]
    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderMove: (_e, g) => setDy(g.dy),
            onPanResponderRelease: (_e, g) => {
                setDy(0)
                const l = dockLayout()
                const A = l[index]
                const B = l[index + 1]
                if (!A || !B) return
                const sum = A.height + B.height
                const ha = clamp(A.height + g.dy, 0, sum)
                smooth()
                // 한쪽을 거의 다 줄이면 그 창은 방울로
                if (ha < 70 || sum - ha < 70) {
                    const gone = ha < 70 ? A.w : B.w
                    wins = wins.map(w => (w.id === gone.id ? { ...w, docked: false, minimized: true } : w))
                    note(`split: window ${gone.id} minimized from divider`)
                    emit()
                    return
                }
                const heights = new Map(l.map(r => [r.w.id, r.height]))
                heights.set(A.w.id, ha)
                heights.set(B.w.id, sum - ha)
                wins = wins.map(w => (heights.has(w.id) ? { ...w, share: heights.get(w.id) } : w))
                emit()
            },
            onPanResponderTerminate: () => setDy(0),
        }),
    ).current
    if (!a || !b) return null
    const sum = a.height + b.height
    const ha = clamp(a.height + dy, 0, sum)
    const line = a.top + ha + DIV / 2
    const strip = color('BACKGROUND_BASE_LOWEST', '#111214')
    const accent = color('TEXT_BRAND', '#5865f2')
    const danger = color('TEXT_FEEDBACK_CRITICAL', '#f23f43')
    const closing = dy ? (ha < 70 ? 'a' : sum - ha < 70 ? 'b' : null) : null
    return (
        <>
            {dy ? (
                <>
                    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: a.top, height: ha, backgroundColor: closing === 'a' ? danger + '55' : color('BACKGROUND_BASE_LOW', '#232428'), alignItems: 'center', justifyContent: 'center', zIndex: 999998 }}>
                        <RNText numberOfLines={1} style={{ color: color('TEXT_NORMAL', '#fff'), fontSize: 13, fontWeight: '700' }}>{channelName(a.w.channelId)}</RNText>
                    </View>
                    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: a.top + ha + DIV, height: sum - ha, backgroundColor: closing === 'b' ? danger + '55' : color('BACKGROUND_BASE_LOW', '#232428'), alignItems: 'center', justifyContent: 'center', zIndex: 999998 }}>
                        <RNText numberOfLines={1} style={{ color: color('TEXT_NORMAL', '#fff'), fontSize: 13, fontWeight: '700' }}>{channelName(b.w.channelId)}</RNText>
                    </View>
                </>
            ) : null}
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: line - DIV / 2, height: DIV, backgroundColor: strip, zIndex: 999999, elevation: 18 }} />
            <View {...pan.panHandlers} style={{ position: 'absolute', left: 0, right: 0, top: line - DIV_TOUCH / 2, height: DIV_TOUCH, alignItems: 'center', justifyContent: 'center', zIndex: 999999, elevation: 18 }}>
                <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: dy ? accent : color('INTERACTIVE_MUTED', '#888') }} />
            </View>
        </>
    )
}

/** 분할 화면 동작 (분할선 버튼, 메뉴) */
const splitActions = {
    swap() {
        const st = settings()
        smooth()
        // 자리를 바꿔도 각자 크기는 그대로
        save({ splitSwap: !st.splitSwap, splitRatio: 1 - clamp(st.splitRatio ?? 0.5, 0.2, 0.8) })
        note(`split swap -> chat ${!st.splitSwap ? 'bottom' : 'top'}`)
    },
    full() {
        const w = frontDocked()
        if (!w) return
        smooth()
        setWin(w.id, { docked: false, maximized: true })
        bringToFront(w.id)
        note(`split: window ${w.id} full screen`)
    },
    popup() {
        smooth()
        wins = wins.map(w => (w.docked ? { ...w, docked: false, maximized: false } : w))
        note('split: back to pop-up')
        emit()
    },
    minimize() {
        smooth()
        wins = wins.map(w => (w.docked && !w.minimized ? { ...w, docked: false, minimized: true } : w))
        note('split: minimized to bubble')
        emit()
    },
    close() {
        const w = frontDocked()
        if (w) closeWin(w.id)
    },
}

/**
 * 분할선: 가운데 버튼이 있는 띠.
 * 끌면 비율이 바뀌고, 끝까지 끌면 한쪽을 닫거나(방울로) 펼친다. 톡 누르면 메뉴, 두 번 톡하면 바로 화면 가득.
 */
function Divider() {
    const g = splitGeom()
    const [dy, setDy] = useState(0)
    const [menu, setMenu] = useState(false)
    const menuAnim = useRef(new Animated.Value(0)).current
    const press = useRef(new Animated.Value(0)).current
    const menuTimer = useRef<any>()
    const lastTap = useRef(0)
    const menuOn = useRef(menu)
    menuOn.current = menu
    useEffect(() => () => clearTimeout(menuTimer.current), [])

    const showMenu = (on: boolean) => {
        clearTimeout(menuTimer.current)
        if (on) {
            setMenu(true)
            menuAnim.setValue(0)
            Animated.spring(menuAnim, { toValue: 1, useNativeDriver: true, stiffness: 420, damping: 24, mass: 0.6 }).start()
            menuTimer.current = setTimeout(() => menuRef.current(false), 5000)
        } else {
            Animated.timing(menuAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => setMenu(false))
        }
    }
    const menuRef = useRef(showMenu)
    menuRef.current = showMenu

    // 끄는 중 어느 쪽이 거의 없어지는지 (놓으면 그쪽을 닫는다)
    const edgeOf = (d: number): 'chat' | 'discord' | null => {
        const s = splitGeom()
        const frac = (s.L + d - s.SB) / (s.H - s.SB)
        const chatFrac = s.swap ? 1 - frac : frac
        if (chatFrac < 0.12) return 'chat'
        if (chatFrac > 0.88) return 'discord'
        return null
    }

    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                Animated.spring(press, { toValue: 1, useNativeDriver: true, stiffness: 500, damping: 26 }).start()
            },
            onPanResponderMove: (_e, s) => setDy(s.dy),
            onPanResponderRelease: (_e, s) => {
                Animated.spring(press, { toValue: 0, useNativeDriver: true, stiffness: 400, damping: 22 }).start()
                setDy(0)
                if (Math.abs(s.dy) < 6 && Math.abs(s.dx) < 10) {
                    const now = Date.now()
                    if (now - lastTap.current < 320) {
                        lastTap.current = 0
                        menuRef.current(false)
                        splitActions.full()
                        return
                    }
                    lastTap.current = now
                    menuRef.current(!menuOn.current)
                    return
                }
                menuRef.current(false)
                const edge = edgeOf(s.dy)
                if (edge === 'chat') return splitActions.minimize()
                if (edge === 'discord') return splitActions.full()
                const st = splitGeom()
                const ratio = clamp((st.L + s.dy - st.SB) / (st.H - st.SB), 0.2, 0.8)
                smooth()
                save({ splitRatio: ratio })
                note(`split ratio ${Math.round(ratio * 100)}%`)
            },
            onPanResponderTerminate: () => {
                Animated.spring(press, { toValue: 0, useNativeDriver: true }).start()
                setDy(0)
            },
        }),
    ).current

    const strip = color('BACKGROUND_BASE_LOWEST', '#111214')
    const accent = color('TEXT_BRAND', '#5865f2')
    const knob = color('INTERACTIVE_NORMAL', '#ddd')
    const subtle = color('BORDER_SUBTLE', '#ffffff22')
    const danger = color('TEXT_FEEDBACK_CRITICAL', '#f23f43')
    const edge = dy ? edgeOf(dy) : null
    const line = clamp(g.L + dy, g.SB + DIV, g.H - DIV)
    const act = (f: () => void) => () => {
        showMenu(false)
        f()
    }

    // 끄는 중: 삼성처럼 양쪽을 판으로 덮어 새 크기를 보여 준다 (놓아야 실제로 바뀐다)
    const fw = frontDocked()
    const chatPanel = { top: g.swap ? line + DIV / 2 : g.SB, bottom: g.swap ? g.H : line - DIV / 2 }
    const discordPanel = { top: g.swap ? g.SB : line + DIV / 2, bottom: g.swap ? line - DIV / 2 : g.H }
    const panel = (key: string, r: { top: number; bottom: number }, closing: boolean, filling: boolean, label: string, names: string[], img?: string) => (
        <View
            key={key}
            pointerEvents="none"
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: r.top,
                height: Math.max(0, r.bottom - r.top),
                backgroundColor: closing ? danger + '55' : filling ? accent + '33' : color('BACKGROUND_BASE_LOW', '#232428'),
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                zIndex: 999998,
            }}
        >
            <View style={{ width: 48, height: 48, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: strip }}>
                {img ? <Image source={{ uri: img }} style={{ width: 48, height: 48 }} /> : <DIcon names={names} fallback="#" c={knob} size={26} />}
            </View>
            <RNText numberOfLines={1} style={{ marginTop: 8, color: color('TEXT_NORMAL', '#fff'), fontSize: 13, fontWeight: '700' }}>{label}</RNText>
        </View>
    )

    return (
        <>
            {dy
                ? [
                      panel('chat', chatPanel, edge === 'chat', edge === 'discord', dockLayout().length > 1 ? `Mini Chat ${dockLayout().length}` : fw ? channelName(fw.channelId) : 'Mini Chat', fw ? channelIconNames(fw.channelId) : ['ChatIcon'], fw ? bubbleImage(fw.channelId) : undefined),
                      panel('discord', discordPanel, edge === 'discord', edge === 'chat', 'Discord', ['ClydeIcon', 'DiscordIcon', 'HomeIcon']),
                  ]
                : null}
            {/* 보이는 선은 얇게, 잡는 자리는 넓게 */}
            <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: line - DIV / 2, height: DIV, backgroundColor: strip, zIndex: 999999, elevation: 18 }} />
            <View
                {...pan.panHandlers}
                style={{ position: 'absolute', left: 0, right: 0, top: line - DIV_TOUCH / 2, height: DIV_TOUCH, alignItems: 'center', justifyContent: 'center', zIndex: 999999, elevation: 18 }}
            >
                <Animated.View
                    style={{
                        width: 12,
                        height: 12,
                        borderRadius: 6,
                        backgroundColor: dy ? accent : knob,
                        transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }],
                    }}
                />
            </View>
            {menu ? (
                <Animated.View
                    style={{
                        opacity: menuAnim,
                        transform: [{ scale: menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
                        position: 'absolute',
                        top: line - 20,
                        alignSelf: 'center',
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 4,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: strip,
                        borderWidth: 1,
                        borderColor: subtle,
                        elevation: 20,
                        zIndex: 1000001,
                    }}
                >
                    <BarButton names={SWAP_ICON} fallback="⇅" accent={accent} onPress={act(splitActions.swap)} />
                    <BarButton names={POPUP_ICON} fallback="❐" accent={accent} onPress={act(splitActions.popup)} />
                    <BarButton names={MIN_ICON} fallback="–" accent={accent} onPress={act(splitActions.minimize)} />
                    <BarButton names={MAX_ICON} fallback="⤢" accent={accent} onPress={act(splitActions.full)} />
                    <BarButton names={CLOSE_ICON} fallback="×" accent={accent} onPress={act(splitActions.close)} />
                </Animated.View>
            ) : null}
        </>
    )
}

function patchRoot(cleanup: (...f: any[]) => void) {
    cleanup(
        beforeJSX('RNSScreenStack' as any, (args: any[]) => {
            try {
                const props = args[1]
                if (!props || props[SKIP] || !isRootStack(props)) return args as any
                if (!rootActive) {
                    rootActive = true
                    note('root screen stack wrapped (split screen ready)')
                }
                return [SplitStack, { ...props, [WRAP]: args[0] }, ...args.slice(2)] as any
            } catch {
                return args as any
            }
        }),
    )
}

// ── 앱 전체 위에 그리기 (토스트 자리) ───────────────────────────
function patchToastHost(cleanup: (...f: any[]) => void) {
    cleanup(
        getModuleWithImportedPath(TOAST_PATH, (mod: any) => {
            if (typeof mod?.default !== 'function') {
                note(`toast host not usable: ${describe(mod)}`)
                return
            }
            status.toastHost = true
            cleanup(
                instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    const out = orig.apply(this, args)
                    status.toastHostRenders++
                    return (
                        <>
                            {out}
                            <Windows host="global" />
                        </>
                    )
                }),
            )
        }) as any,
    )
}

// ── 채널 꾹 누르기 창에 "Open in Mini Chat" ─────────────────────
/** 아이콘 하나 (없는 이름이면 오류 대신 undefined) */
function icon(name: string): any {
    try {
        return lookupGeneratedIconComponent(name as any) ?? undefined
    } catch {
        return undefined
    }
}

const nameOf = (t: any): string => t?.name || t?.displayName || t?.type?.name || t?.type?.displayName || t?.render?.name || ''
function isGroup(n: any) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false
    const G = D().ActionSheetRow?.Group
    return (G && n.type === G) || /ActionSheetRowGroup$/.test(nameOf(n.type))
}
const flat = (c: any): any[] => (Array.isArray(c) ? c.flatMap(flat) : [c])

function addRow(node: any, channel: any, close: () => void, depth = 0): any {
    if (!node || typeof node !== 'object' || depth > 10) return node
    if (Array.isArray(node)) {
        let changed = false
        const out = node.map(n => {
            const r = addRow(n, channel, close, depth + 1)
            if (r !== n) changed = true
            return r
        })
        return changed ? out : node
    }
    const props = node.props
    if (!props) return node
    if ((props.showGradient !== undefined && 'header' in props) || flat(props.children).some(isGroup)) {
        const { ActionSheetRow } = D()
        if (!ActionSheetRow?.Group) return node
        const kids = Array.isArray(props.children) ? props.children : [props.children]
        if (kids.some((k: any) => k?.key === 'mini-chat')) return node
        const Icon: any = icon('WindowLaunchIcon') ?? icon('ChatIcon') ?? icon('ChatSmileIcon')
        status.sheetRows++
        const group = (
            <ActionSheetRow.Group key="mini-chat" hasIcons={!!Icon}>
                <ActionSheetRow
                    label="Open in Mini Chat"
                    icon={Icon ? <ActionSheetRow.Icon IconComponent={Icon} /> : undefined}
                    onPress={() => {
                        close()
                        setTimeout(() => openChannel(channel.id), 250)
                    }}
                />
            </ActionSheetRow.Group>
        )
        return { ...node, props: { ...props, children: [group, ...kids] } }
    }
    if (props.children == null || typeof props.children !== 'object') return node
    const kids = addRow(props.children, channel, close, depth + 1)
    return kids === props.children ? node : { ...node, props: { ...props, children: kids } }
}

/** 채널, DM, 그룹 DM, 포럼 글, 사람을 꾹 누른 창 */
const SHEET_KEY = /(Channel|DM|PrivateChannel|Group|ForumPost|Thread|User)\w*LongPress|LongPress\w*(Channel|DM|Thread|User)/i

/** 꾹 누른 창이 가리키는 채널 (사람이면 그 사람과의 DM) */
function sheetChannel(p: any): any {
    try {
        const CS = S().ChannelStore
        const get = (id: any) => (typeof id === 'string' ? CS?.getChannel?.(id) : undefined)
        const direct = p?.channel ?? p?.thread ?? p?.privateChannel ?? get(p?.channelId) ?? get(p?.threadId) ?? get(p?.privateChannelId)
        if (direct?.id) return direct
        const userId = p?.userId ?? p?.user?.id
        if (userId) return get(CS?.getDMFromUserId?.(userId))
    } catch {}
}

const wrapped = new WeakMap<any, any>()
function wrapInner(type: any, channel: any, close: () => void) {
    const MEMO = Symbol.for('react.memo')
    const render = type?.$$typeof === MEMO ? type.type : type
    if (typeof render !== 'function') return
    let w = wrapped.get(type)
    if (!w) {
        w = function MiniChatSheet(props: any) {
            const out = render(props)
            try {
                const r = addRow(out, props?.channel ?? channel, typeof props?.onClose === 'function' ? () => props.onClose() : close)
                if (r === out) note('sheet: inner had no row group')
                return r
            } catch (e: any) {
                note(`sheet inner error: ${e?.message ?? e}`)
                return out
            }
        }
        wrapped.set(type, w)
    }
    return w
}

function patchSheet(cleanup: (...f: any[]) => void) {
    const patched = new WeakSet<any>()
    const render = (args: any[], orig: (...a: any[]) => any, self: unknown) => {
        const out = orig.apply(self, args)
        const p = args[0]
        const channel = sheetChannel(p)
        if (!channel) return out
        const close = () => {
            try {
                if (typeof p?.onClose === 'function') p.onClose()
                else (ActionSheetActionCreators as any).hideActionSheet()
            } catch {}
        }
        try {
            const direct = addRow(out, channel, close)
            if (direct !== out) return direct
            if (out?.type && typeof out.type !== 'string') {
                const w = wrapInner(out.type, channel, close)
                if (w) return { ...out, type: w }
            }
            note(`sheet: no place for the row (${describe(out)})`)
        } catch (e: any) {
            note(`sheet error: ${e?.message ?? e}`)
        }
        return out
    }
    const patchMod = (mod: any) => {
        if (!mod || typeof mod.default !== 'function' || patched.has(mod)) return mod
        try {
            cleanup(
                instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    return render(args, orig, this)
                }),
            )
            patched.add(mod)
            return mod
        } catch {
            const Original = mod.default
            return { ...mod, default: (props: any) => render([props], Original, undefined) }
        }
    }
    try {
        cleanup(
            instead(ActionSheetActionCreators as any, 'openLazy', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                try {
                    const [sheet, key] = args
                    if (typeof key === 'string' && SHEET_KEY.test(key) && !/Message/i.test(key) && typeof sheet?.then === 'function') {
                        note(`sheet opened: ${key}`)
                        args[0] = sheet.then((m: any) => patchMod(m))
                    }
                } catch {}
                return orig.apply(this, args)
            }),
        )
    } catch (e: any) {
        note(`sheet patch failed: ${e?.message ?? e}`)
    }
    cleanup(getModuleWithImportedPath(SHEET_PATH, (m: any) => void patchMod(m)) as any)
}

// ── 로그 복사 ───────────────────────────────────────────────────
function buildLog(): string {
    const lines: string[] = ['Mini Chat log']
    lines.push(`Time: ${new Date().toISOString()}`)
    lines.push(`Plugin: ${VERSION}`)
    try {
        const C: any = (Platform as any).constants ?? {}
        lines.push(`Platform: ${Platform.OS} ${Platform.Version}`)
        lines.push(`Device: ${C.Manufacturer ?? '?'} ${C.Model ?? '?'}`)
    } catch {}
    lines.push(`Settings: ${JSON.stringify(settings())}`)
    lines.push(`Status: ${JSON.stringify(status)}`)
    lines.push(`Last channel: ${lastChannel ?? 'none'} (${lastChannel ? channelName(lastChannel) : ''}), guild ${lastGuild ?? 'none'}`)
    lines.push(`Screen props: ${propsSummary}`)
    lines.push(`Windows: ${wins.length ? wins.map(w => `#${w.id} ${channelName(w.channelId)} ${w.docked ? 'docked' : `${Math.round(w.w)}x${Math.round(w.h)}`}${w.minimized ? ' min' : ''}`).join(', ') : 'none'}`)
    try {
        lines.push(`Selected channel: ${S().SelectedChannelStore?.getChannelId?.() ?? 'none'}`)
    } catch {}
    lines.push('')
    lines.push('Recent:')
    lines.push(logs.length ? logs.join('\n') : '(nothing yet)')
    return lines.join('\n')
}
function copyLog() {
    try {
        Clipboard.setString(buildLog())
        toast('Mini Chat log copied')
    } catch {}
}

// ── 설정 화면 ───────────────────────────────────────────────────
function SettingsPage() {
    useStore()
    storage?.use?.()
    const { Stack, TableRowGroup, TableRow, TableRadioGroup, TableRadioRow, Button, Text } = D()
    const s = settings()
    const current = (() => {
        try {
            return S().SelectedChannelStore?.getChannelId?.()
        } catch {
            return undefined
        }
    })()
    return (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            <Stack spacing={16}>
                <Text variant="text-sm/normal" color="text-muted">
                    Long press a channel and pick "Open in Mini Chat". Drag the title bar to move a window, drag the corner to resize it, "–" to shrink it into a bubble. Double tap the title bar to fill the screen. Drag a window to the top edge (or use the split button) for split screen: drag the title bar across the middle line (or onto another split window) to swap, the back button acts on the Mini Chat you touched last, drag the middle dot to change the size, drag it to an edge to close or fill a side, tap it for swap, pop-up, minimize, full screen and close, double tap it to fill the screen.
                </Text>
                <TableRowGroup title="Open">
                    <TableRow
                        label="Open the current channel"
                        subLabel={current ? channelName(current) : 'No channel open'}
                        onPress={() => current && openChannel(current)}
                        arrow
                    />
                    {wins.length ? (
                        <TableRow label="Close all windows" onPress={() => {
                            wins = []
                            emit()
                        }} />
                    ) : null}
                </TableRowGroup>
                {TableRadioGroup && TableRadioRow ? (
                    <TableRadioGroup title="Draw windows" defaultValue={s.host} onChange={(v: Host) => void save({ host: v })}>
                        <TableRadioRow label="Over the whole app" subLabel="Stays open on every screen" value="global" />
                        <TableRadioRow label="Inside the chat screen" subLabel="Try this if windows fail to show a channel" value="screen" />
                    </TableRadioGroup>
                ) : null}
                <Button text="Copy log" variant="secondary" size="lg" onPress={copyLog} />
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        note(`start ${VERSION}`)
        startCleanup = cleanup
        const bind = (exports: any, how: string) => {
            if (!exports || Screen) return
            try {
                note(`screen module ${how}`)
                patchScreen(exports, cleanup)
                emit()
                rememberScreenId()
            } catch (e: any) {
                note(`screen patch failed: ${e?.message ?? e}`)
            }
        }
        cleanup(
            getModuleWithImportedPath(SCREEN_PATH, (exports: any) => {
                if (exports) bind(exports, 'loaded')
                // 채널을 아직 하나도 안 열었으면 화면 모듈이 안 불러와져 있다: 불러와질 때까지 기다린다
                else cleanup(waitForModuleWithImportedPath(SCREEN_PATH, (x: any) => bind(x, 'loaded later')) as any)
            }) as any,
        )
        try {
            patchRoot(cleanup)
        } catch (e: any) {
            note(`app root failed: ${e?.message ?? e}`)
        }
        try {
            patchToastHost(cleanup)
        } catch (e: any) {
            note(`toast host failed: ${e?.message ?? e}`)
        }
        try {
            patchSheet(cleanup)
        } catch (e: any) {
            note(`sheet failed: ${e?.message ?? e}`)
        }
        try {
            patchAck(cleanup)
            patchOverlays(cleanup)
        } catch (e: any) {
            note(`overlay/ack failed: ${e?.message ?? e}`)
        }
        cleanup(() => {
            wins = []
            focusId = null
            try {
                backSub?.remove?.()
            } catch {}
            emit()
        })
    },
    SettingsComponent: SettingsPage,
} as any)
