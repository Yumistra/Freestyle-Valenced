import Page from '@valenced/components/Page'
import { Design } from '@valenced/discord/design'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { ReactNativeSafeAreaContext } from '@valenced/externals/react-native-safe-area-context'
import { instead } from '@valenced/patcher'
import { Component, useEffect, useState } from 'react'
import { BackHandler, Image, Pressable, useWindowDimensions, View } from 'react-native'
import { forgetModules, forgetSync, forgetThreads, pickImage, toast } from './data'
import { resetForums } from './forum'
import { Icon, T, Wipe } from './parts'
import { DepartScreen } from './screens/Depart'
import { GuildScreen } from './screens/Guild'
import { HeartScreen } from './screens/Heart'
import { InboxScreen } from './screens/Inbox'
import { ProfileCard } from './screens/Profile'
import { QuestsScreen } from './screens/Quests'
import { ShopScreen } from './screens/Shop'
import { forgetSticker } from './screens/Sticker'
import { forgetDrafts } from './compose'
import { ImageViewer } from './viewer'
import { chooseCharacter, LobbyScreen } from './screens/Lobby'
import { bindStorage, DEFAULTS, save, useSettings } from './settings'
import { back, getState, resetState, setState, useUi } from './state'
import { C, shadow } from './theme'

/**
 * Stella UI: 디스코드를 게임 로비처럼 쓰는 화면.
 * 앱 맨 위(토스트가 뜨는 자리)에 화면 전체를 덮는 창을 그린다. 원래 디스코드는 그 아래 그대로 있고,
 * 깊은 화면(설정, 상점, 알림 등)은 이 창을 내리고 디스코드 화면을 연다. 오른쪽 가장자리 탭으로 다시 연다.
 */

const TOAST_PATH = 'modules/toast/native/AppToastContainer.tsx'

export const status = { mounted: false, renders: 0, lastError: '' }

// ── 화면 위아래 여백 ────────────────────────────────────────────────────
const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 }
const noInsets = () => NO_INSETS
let insetsHook: (() => typeof NO_INSETS) | undefined
/** 처음 그릴 때 한 번 정한다 (그 뒤로 같은 훅을 쓴다). 스크립트를 읽을 때는 아직 없을 수 있다 */
function useInsets() {
    if (!insetsHook) {
        try {
            const f = (ReactNativeSafeAreaContext as any)?.useSafeAreaInsets
            insetsHook = typeof f === 'function' ? f : noInsets
        } catch {
            insetsHook = noInsets
        }
    }
    try {
        return insetsHook!() ?? NO_INSETS
    } catch {
        // 위에 SafeAreaProvider 가 없으면 여백 없이
        return NO_INSETS
    }
}

// ── 오류가 나면 게임 화면을 내리고 디스코드를 보여 준다 ───────────────────
class Guard extends Component<{ children?: any; resetKey: boolean }, { failed: boolean; key: boolean }> {
    state = { failed: false, key: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    /** 게임 화면을 다시 열면 다시 그려 본다 */
    static getDerivedStateFromProps(props: { resetKey: boolean }, state: { key: boolean }) {
        return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
    }
    componentDidCatch(e: any) {
        status.lastError = String(e?.message ?? e)
        setState({ visible: false })
        toast('Stella UI 화면에 문제가 생겨 디스코드 화면으로 돌아왔어요')
    }
    render() {
        return this.state.failed ? null : this.props.children
    }
}

// ── 화면 ────────────────────────────────────────────────────────────────
function Screen({ width, height }: { width: number; height: number }) {
    const route = useUi(s => s.route)
    switch (route) {
        case 'heart':
            return <HeartScreen width={width} />
        case 'depart':
            return <DepartScreen width={width} height={height} />
        case 'guild':
            return <GuildScreen width={width} />
        case 'inbox':
            return <InboxScreen width={width} />
        case 'shop':
            return <ShopScreen width={width} />
        case 'quests':
            return <QuestsScreen width={width} />
        default:
            return <LobbyScreen width={width} height={height} />
    }
}

/** 게임 화면이 내려가 있을 때 오른쪽 가장자리의 탭 (누르면 다시 연다) */
function EdgeTab({ height }: { height: number }) {
    return (
        <Pressable onPress={() => setState({ visible: true })} accessibilityRole="button" accessibilityLabel="Open Stella UI" hitSlop={8} style={{ position: 'absolute', right: 0, top: height * 0.34 }}>
            <View style={[{ width: 30, height: 52, borderTopLeftRadius: 26, borderBottomLeftRadius: 26, backgroundColor: C.navyDeep, alignItems: 'center', justifyContent: 'center', paddingLeft: 4 }, shadow(6)]}>
                <Icon names={['ChevronLargeLeftIcon', 'ChevronSmallLeftIcon', 'ArrowLargeLeftIcon']} color={C.white} size={20} />
            </View>
        </Pressable>
    )
}

function Stage() {
    const visible = useUi(s => s.visible)
    const { width, height } = useWindowDimensions()
    const insets = useInsets()
    status.renders++

    // 안드로이드 뒤로 가기: 게임 화면 안에서 먼저 처리, 로비면 디스코드 화면으로
    useEffect(() => {
        if (!visible) return
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (back()) return true
            setState({ visible: false })
            return true
        })
        return () => sub.remove()
    }, [visible])

    if (!visible) return <EdgeTab height={height} />
    const w = width - insets.left - insets.right
    const h = height - insets.top - insets.bottom
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, width, height, backgroundColor: C.skyMid, overflow: 'hidden' }}>
            <View style={{ position: 'absolute', top: insets.top, left: insets.left, width: w, height: h }}>
                <Screen width={w} height={h} />
                <ProfileCard />
                <ImageViewer width={w} height={h} />
            </View>
            <Wipe width={width} />
        </View>
    )
}

function Root() {
    const visible = useUi(s => s.visible)
    return (
        <Guard resetKey={visible}>
            <Stage />
        </Guard>
    )
}

// ── 붙이기 ──────────────────────────────────────────────────────────────
function mount(cleanup: (f: any) => void) {
    let done = false
    const apply = (mod: any) => {
        if (done || typeof mod?.default !== 'function') return
        done = true
        status.mounted = true
        cleanup(
            instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                // 토스트가 게임 화면 위에 보이게 먼저 그린다
                return (
                    <>
                        <Root />
                        {orig.apply(this, args)}
                    </>
                )
            }),
        )
    }
    cleanup(
        getModuleWithImportedPath(TOAST_PATH, (mod: any) => {
            if (mod) apply(mod)
            else cleanup(waitForModuleWithImportedPath(TOAST_PATH, apply) as any)
        }) as any,
    )
}

// ── 설정 화면 ───────────────────────────────────────────────────────────
function ImageRow({ label, value, onPick, onClear }: { label: string; value: string; onPick: () => void; onClear: () => void }) {
    const { TableRow } = Design as any
    return (
        <TableRow
            label={label}
            subLabel={value ? 'Tap to change' : 'Not set, a default is used'}
            trailing={value ? <Image source={{ uri: value }} style={{ width: 44, height: 44, borderRadius: 8 }} /> : undefined}
            onPress={onPick}
            onLongPress={value ? onClear : undefined}
        />
    )
}

function UrlInput({ label, onSave }: { label: string; onSave: (v: string) => void }) {
    const { TextInput } = Design as any
    const [text, setText] = useState('')
    return (
        <TextInput
            label={label}
            value={text}
            placeholder="https://…"
            onChange={setText}
            onSubmitEditing={() => {
                if (/^https?:\/\//.test(text.trim())) {
                    onSave(text.trim())
                    setText('')
                }
            }}
            returnKeyType="done"
            size="md"
        />
    )
}

/** 말풍선 글 (치는 동안은 저장하지 않고 잠깐 멈추면 저장) */
let linesTimer: any
function LinesInput({ value }: { value: string }) {
    const { TextInput } = Design as any
    const [text, setText] = useState(value)
    useEffect(() => () => clearTimeout(linesTimer), [])
    return (
        <TextInput
            label="Character lines"
            value={text}
            placeholder="One line each, empty for the default greetings"
            multiline
            onChange={(lines: string) => {
                setText(lines)
                clearTimeout(linesTimer)
                linesTimer = setTimeout(() => save({ lines }), 500)
            }}
            size="md"
        />
    )
}

export function SettingsPage() {
    const s = useSettings()
    const { Stack, TableRowGroup, TableSwitchRow, TableRow } = Design as any
    const pickBackground = async () => {
        const uri = await pickImage()
        if (uri) save({ background: uri })
    }
    return (
        <Page>
            <Stack spacing={16}>
                <TableRowGroup title="Lobby">
                    <TableRow label="Open the lobby" subLabel="Shows the game screen now" onPress={() => setState({ visible: true, route: 'lobby', menu: false })} arrow />
                    <TableSwitchRow label="Open on start" subLabel="Starts Discord in the lobby" value={s.openOnStart} onValueChange={(openOnStart: boolean) => save({ openOnStart })} />
                </TableRowGroup>
                <TableRowGroup title="Pictures">
                    <ImageRow label="Character" value={s.character} onPick={chooseCharacter} onClear={() => save({ character: '' })} />
                    <ImageRow label="Background" value={s.background} onPick={pickBackground} onClear={() => save({ background: '' })} />
                    {s.character || s.background ? (
                        <TableRow label="Remove pictures" subLabel="Go back to the default sky and your avatar" onPress={() => save({ character: '', background: '' })} />
                    ) : null}
                </TableRowGroup>
                <UrlInput label="Character from a link" onSave={character => save({ character })} />
                <UrlInput label="Background from a link" onSave={background => save({ background })} />
                <LinesInput value={s.lines} />
                {status.lastError ? <T color={C.red}>{`Last error: ${status.lastError}`}</T> : null}
            </Stack>
        </Page>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bindStorage(jsonStorage)
        resetState()
        mount(cleanup)
        // 저장된 설정을 읽은 뒤에 첫 화면을 정한다
        Promise.resolve(jsonStorage?.get?.())
            .catch(() => {})
            .then(() => {
                if (jsonStorage?.cache?.openOnStart !== false && !getState().visible) setState({ visible: true })
            })
        cleanup(() => {
            resetState()
            forgetModules()
            resetForums()
            forgetSync()
            forgetThreads()
            forgetSticker()
            forgetDrafts()
            status.mounted = false
        })
    },
    SettingsComponent: SettingsPage,
} as any)

// 시험용 (Valenced 는 default 만 쓴다)
export { getState } from './state'
export { greetings } from './screens/Lobby'
export { buildRows } from './screens/Chat'
export { guildSections } from './data'
export { blocks, formatTime, inline, plainText, previewText } from './markdown'
export { embedColor } from './screens/Rich'
