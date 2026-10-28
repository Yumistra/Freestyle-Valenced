import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules, lookupModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { cloneElement, createContext, createElement, isValidElement, useContext, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

/**
 * 포럼·스레드는 채널 화면(StandaloneChannelScreen)을 채팅 위에 한 장 더 쌓아서 연다.
 *
 * 모드 "screen" (기본): 위 화면을 반투명하게 해서 바로 아래 채팅 화면이 비친다.
 *  - 위 화면이 직접 칠하는 배경색을 걷어내고, 정한 투명도의 배경색 한 겹만 깐다
 *  - 디스코드는 완전히 덮인 아래 화면을 숨긴다 (투명도 0 + Freeze). 바로 아래 화면 하나만 계속 보이게 한다
 * 모드 "image": 아래 화면 대신 테마 배경 이미지만 비친다 (1.1.0 동작)
 */

const SCREEN_PATH = 'modules/main_tabs_v2/native/channel/StandaloneChannelScreen.tsx'
const STYLES_PATH = 'modules/main_tabs_v2/native/panels/useMainTabsChannelScreenStyles.tsx'
const MAX_DEPTH = 8

type Mode = 'screen' | 'image'
interface Settings {
    mode: Mode
    /** 위 화면 배경색의 불투명도 (0~1). 높을수록 아래 화면이 덜 비친다 */
    alpha: number
}
const DEFAULTS: Settings = { mode: 'screen', alpha: 0 }

let storage: any
let cachedFrom: unknown
let cached: Settings | undefined
/** 화면을 그릴 때마다 불리므로 저장 내용이 그대로면 만든 걸 다시 쓴다 */
const settings = (): Settings => {
    const saved = storage?.cache ?? {}
    if (!cached || cachedFrom !== saved) {
        cached = { ...DEFAULTS, ...saved }
        cachedFrom = saved
    }
    return cached
}

interface ScreenProps {
    isNavigationScreen?: boolean
    screenIndex?: number
}

// ../discord_app/modules/client_themes/native/ThemedGradient.tsx
let gradientModule: { default: any } | undefined
/** 위에 쌓인 화면 안쪽인지 알려주는 컨텍스트 (React가 준비된 뒤 start에서 만든다) */
let OverlayContext: any
// ../discord_common/js/packages/design/components/ThemeContextProvider/ThemeContext.tsx
let ThemeContextModule: { ThemeContext: any } | undefined

/**
 * 위 화면 안쪽의 테마 컨텍스트에 붙이는 표시. 스타일 색을 풀 때(getSemanticColorContextFromThemeContext → resolveSemanticColor)
 * 이 표시가 있으면 화면 바탕색(표면색)을 투명으로 바꾼다
 */
const MARK = '__yumistraOverlay'
const markedContexts = new WeakMap<object, object>()
function markContext(ctx: any) {
    if (!ctx || typeof ctx !== 'object') return ctx
    let marked = markedContexts.get(ctx)
    if (!marked) {
        // key가 달라야 createStyles 캐시가 따로 잡혀서 색을 다시 푼다
        marked = { ...ctx, key: `${ctx.key ?? ''}:overlay`, [MARK]: true }
        markedContexts.set(ctx, marked)
    }
    return marked
}

/** 위 화면 안쪽을 표시된 테마 컨텍스트로 감싼다 */
function OverlayTheme({ children }: { children: any }) {
    const Ctx = ThemeContextModule?.ThemeContext
    // 훅은 항상 한 번 부른다 (컨텍스트를 못 찾았으면 우리 것으로 대신)
    const ctx: any = useContext(Ctx ?? OverlayContext)
    if (!Ctx || !ctx || typeof ctx !== 'object') return children
    return createElement(Ctx.Provider, { value: markContext(ctx) }, children)
}

const SURFACES = ['BACKGROUND_BASE_LOWER', 'BACKGROUND_BASE_LOW', 'BACKGROUND_BASE_LOWEST', 'CHANNEL_BACKGROUND_DEFAULT', 'STANDALONE_CHANNEL_CONTENT_BACKGROUND', 'BG_BASE_PRIMARY', 'BG_BASE_SECONDARY']
const TRANSPARENT = '#00000000'
const rgbOf = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(1, 7).toLowerCase() : undefined)
let ScreenMemo: any

// 지금 떠 있는 채널 화면들의 screenIndex (마운트 수)
const mounted = new Map<number, number>()
const topIndex = () => {
    let max = -1
    for (const [i, n] of mounted) if (n > 0 && i > max) max = i
    return max
}

// 설정 화면에 보여줄 상태
const status = { contextPatched: false, surfacesCleared: 0, gradientsHidden: 0, revealed: 0, screenPatched: false, stylesPatched: false, stylesCalls: 0, coveredCleared: 0, freezePatched: 0, freezeCalls: 0, overlays: 0, stripped: 0, frozenSeen: 0, unfrozen: 0, lastError: '' }

// 맨 아래 채팅은 screenIndex 0. 그 위에 쌓인 화면만 건드린다
const isOverlayScreen = (props: ScreenProps | undefined) => (props?.screenIndex ?? 0) > 0

function hasBackground(style: unknown) {
    if (!style) return false
    try {
        const bg = (StyleSheet.flatten(style as any) as any)?.backgroundColor
        return bg != null && bg !== 'transparent'
    } catch {
        return false
    }
}

const CLEAR = { backgroundColor: 'transparent' }

/** 이 화면이 만든 요소들(자식 컴포넌트 내부 말고)에서 배경색을 걷어낸다 */
function stripBackgrounds(node: any, depth: number): any {
    if (depth > MAX_DEPTH || node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) {
        let changed = false
        const next = node.map(child => {
            const c = stripBackgrounds(child, depth)
            if (c !== child) changed = true
            return c
        })
        return changed ? next : node
    }
    if (!isValidElement(node)) return node

    const props: any = node.props
    const patch: any = {}
    let changed = false
    if (hasBackground(props.style)) {
        patch.style = [props.style, CLEAR]
        status.stripped++
        changed = true
    }
    const children = props.children
    if (children != null && typeof children !== 'function') {
        const next = stripBackgrounds(children, depth + 1)
        if (next !== children) {
            patch.children = next
            changed = true
        }
    }
    return changed ? cloneElement(node, patch) : node
}

/** 테마의 기본 배경색(BACKGROUND_BASE_LOWER)에 투명도를 붙인다 */
function surfaceColor(alpha: number) {
    let base = '#000000'
    try {
        const tokens: any = Tokens
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        const resolved = tokens.default.internal.resolveSemanticColor(theme, tokens.default.colors.BACKGROUND_BASE_LOWER)
        if (typeof resolved === 'string' && /^#[0-9a-f]{6}/i.test(resolved)) base = resolved.slice(0, 7)
    } catch {}
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
        .toString(16)
        .padStart(2, '0')
    return base + a
}

function useMountedIndex(index: number | undefined) {
    useEffect(() => {
        if (typeof index !== 'number') return
        mounted.set(index, (mounted.get(index) ?? 0) + 1)
        return () => {
            const n = (mounted.get(index) ?? 1) - 1
            if (n > 0) mounted.set(index, n)
            else mounted.delete(index)
        }
    }, [index])
}

function patchScreen(exports: any, cleanup: (...f: Array<() => void>) => void) {
    const Screen = exports?.default
    if (typeof Screen?.type !== 'function') return
    ScreenMemo = Screen
    status.screenPatched = true
    cleanup(
        instead(Screen, 'type', function (this: any, args: any[], orig: any) {
            const props: ScreenProps & { isNavigationTTIVisible?: boolean } = args[0]
            useMountedIndex(props?.screenIndex)
            let callArgs = args
            // 350.8: 덮인 화면은 isNavigationTTIVisible=false를 받아 NavTTISurfaceProvider(visibilityMode 'prerendered')가 통째로 숨긴다.
            // 맨 위 바로 아래 화면은 계속 보이는 것으로 넘긴다
            if (
                settings().mode === 'screen' &&
                props?.isNavigationTTIVisible === false &&
                typeof props.screenIndex === 'number' &&
                props.screenIndex === topIndex() - 1
            ) {
                callArgs = [{ ...props, isNavigationTTIVisible: true }, ...args.slice(1)]
                status.revealed++
            }
            const el = orig.apply(this, callArgs)
            if (!el || !isOverlayScreen(props)) return el
            status.overlays++
            try {
                const s = settings()
                let stripped = stripBackgrounds(el, 0)
                // 채팅 영역 안의 배경 레이어(ThemedGradient)는 테마 배경이 있으면 불투명하게 그려져서 아래 화면을 가린다.
                // 이 화면 안쪽에서는 그 레이어를 숨기도록 표시한다
                if (s.mode === 'screen' && OverlayContext) {
                    stripped = createElement(OverlayContext.Provider, { value: true }, stripped)
                    // 채팅 목록·입력창 등 안쪽 컴포넌트의 반투명 바탕색까지 투명하게 (덧칠 0%면 아래가 그대로 보임)
                    stripped = createElement(OverlayTheme, null, stripped)
                }
                if (s.mode === 'image') {
                    if (!gradientModule?.default) return stripped
                    return createElement(View, { style: { flex: 1 } }, createElement(gradientModule.default, { key: 'overlay-background', absolute: true, mix: true }), stripped)
                }
                // 추가 배경 0%면 화면 안쪽 반투명 배경만 남기고 그대로 비친다
                if (!(s.alpha > 0)) return stripped
                return createElement(
                    View,
                    { style: { flex: 1 } },
                    createElement(View, { key: 'overlay-background', pointerEvents: 'none', style: [StyleSheet.absoluteFill, { backgroundColor: surfaceColor(s.alpha) }] }),
                    stripped,
                )
            } catch (e) {
                status.lastError = String((e as Error)?.message ?? e)
                return el
            }
        }),
    )
}

/** 표시된 컨텍스트에서 표면색(화면 바탕색)이면 투명을 돌려준다 */
function patchSurfaceColors(cleanup: (...f: Array<() => void>) => void) {
    let internal: any
    try {
        internal = (Tokens as any).default.internal
    } catch {}
    if (typeof internal?.resolveSemanticColor !== 'function') return
    const surfaceCache = new Map<string, Set<string>>()
    cleanup(
        instead(internal, 'resolveSemanticColor', function (this: any, args: any[], orig: any) {
            const out = orig.apply(this, args)
            const ctx = args[2]
            if (!ctx?.[MARK] || settings().mode !== 'screen') return out
            const rgb = rgbOf(out)
            if (!rgb) return out
            const theme = args[0]
            const cacheKey = `${theme}`
            let surfaces = surfaceCache.get(cacheKey)
            if (!surfaces) {
                surfaces = new Set()
                const plain = { ...ctx }
                delete plain[MARK]
                const colors = (Tokens as any).default.colors
                for (const name of SURFACES) {
                    try {
                        const c = rgbOf(orig.apply(this, [theme, colors[name], plain]))
                        if (c) surfaces.add(c)
                    } catch {}
                }
                surfaceCache.set(cacheKey, surfaces)
            }
            if (!surfaces.has(rgb)) return out
            status.surfacesCleared++
            return TRANSPARENT
        }),
    )
}

/** 완전히 덮인 화면을 투명도 0으로 숨기는 걸 막는다 (4번째 인자 isCompletelyCovered를 비운다) */
function patchScreenStyles(exports: any, cleanup: (...f: Array<() => void>) => void) {
    if (typeof exports?.useMainTabsChannelScreenStyles !== 'function') return
    status.stylesPatched = true
    cleanup(
        instead(exports, 'useMainTabsChannelScreenStyles', function (this: any, args: any[], orig: any) {
            status.stylesCalls++
            if (settings().mode !== 'screen') return orig.apply(this, args)
            if (args[3] != null) status.coveredCleared++
            const next = args.slice()
            next[3] = undefined
            return orig.apply(this, next)
        }),
    )
}

/**
 * Freeze 안에 든 게 채널 화면이면 그 화면 번호를 찾는다.
 * 350.8 구조: Freeze > View > (화면 표시 추적 컴포넌트, props.index) > StandaloneChannelScreen
 */
function screenIndexOf(node: any, depth: number): number | undefined {
    if (depth > 5 || node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const child of node) {
            const i = screenIndexOf(child, depth)
            if (i !== undefined) return i
        }
        return
    }
    if (!isValidElement(node)) return
    const props: any = node.props
    if (ScreenMemo && node.type === ScreenMemo && typeof props.screenIndex === 'number') return props.screenIndex
    if (typeof props.index === 'number' && 'highestFullyRenderedScreenIndex' in props) return props.index
    return screenIndexOf(props.children, depth + 1)
}

/** 맨 위 화면 바로 아래 채널 화면은 얼리지(Freeze, 숨김) 않는다 */
function patchFreeze(mod: any, cleanup: (...f: Array<() => void>) => void, done: Set<unknown>) {
    if (typeof mod?.Freeze !== 'function' || done.has(mod)) return
    done.add(mod)
    status.freezePatched++
    cleanup(
        instead(mod, 'Freeze', function (this: any, args: any[], orig: any) {
            const props = args[0]
            status.freezeCalls++
            if (props?.freeze && settings().mode === 'screen') {
                const index = screenIndexOf(props.children, 0)
                if (typeof index === 'number') status.frozenSeen++
                if (typeof index === 'number' && index === topIndex() - 1) {
                    status.unfrozen++
                    return orig.apply(this, [{ ...props, freeze: false }, ...args.slice(1)])
                }
            }
            return orig.apply(this, args)
        }),
    )
}

/** 테마 색 하나 (실패하면 대체색) */
function tokenColor(name: string, fallback: string) {
    try {
        const tokens: any = Tokens
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        const c = tokens.default.internal.resolveSemanticColor(theme, tokens.default.colors[name])
        return typeof c === 'string' ? c : fallback
    } catch {
        return fallback
    }
}

/** 채팅 한 줄 모양 (아바타 + 글자 막대 두 개) */
function FakeMessage({ name, width, color, muted }: { name: string; width: string; color: string; muted: string }) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: name }} />
            <View style={{ flex: 1, gap: 4 }}>
                <View style={{ width: '35%', height: 6, borderRadius: 3, backgroundColor: color }} />
                <View style={{ width: width as any, height: 6, borderRadius: 3, backgroundColor: muted }} />
            </View>
        </View>
    )
}

/** 아래 채팅 위에 스레드가 덮인 모습을 미리 보여준다 */
function Preview({ mode, alpha }: { mode: Mode; alpha: number }) {
    const Gradient = gradientModule?.default
    const brand = tokenColor('TEXT_BRAND', '#c92e5c')
    const text = tokenColor('TEXT_DEFAULT', '#fff7f9')
    const muted = tokenColor('TEXT_MUTED', '#a17882')
    const border = tokenColor('BORDER_SUBTLE', '#ffffff22')
    const showBeneath = mode === 'screen'
    return (
        <View style={{ height: 190, borderRadius: 16, overflow: 'hidden', backgroundColor: tokenColor('BACKGROUND_BASE_LOWER', '#2b0d1c') }}>
            {Gradient ? <Gradient absolute /> : null}
            {/* 아래 채팅 화면 */}
            {showBeneath && (
                <View style={{ position: 'absolute', top: 16, left: 14, right: 14 }}>
                    <FakeMessage name={brand} width="80%" color={text} muted={muted} />
                    <FakeMessage name={muted} width="55%" color={text} muted={muted} />
                    <FakeMessage name={brand} width="70%" color={text} muted={muted} />
                    <FakeMessage name={muted} width="45%" color={text} muted={muted} />
                </View>
            )}
            {/* 위에 덮인 스레드 화면 */}
            <View
                style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 56,
                    right: 0,
                    borderLeftWidth: 1,
                    borderLeftColor: border,
                    backgroundColor: mode === 'screen' ? surfaceColor(alpha) : 'transparent',
                    paddingTop: 30,
                    paddingHorizontal: 12,
                }}
            >
                <View style={{ position: 'absolute', top: 10, left: 12, width: 70, height: 8, borderRadius: 4, backgroundColor: brand }} />
                <FakeMessage name={brand} width="65%" color={text} muted={text} />
                <FakeMessage name={muted} width="85%" color={text} muted={text} />
                <FakeMessage name={brand} width="50%" color={text} muted={text} />
            </View>
        </View>
    )
}

/** 놓았을 때 저장하는 슬라이더 (끄는 동안엔 값만 보여줌) */
function AlphaSlider({ value, onChange, onCommit }: { value: number; onChange(v: number): void; onCommit(v: number): void }) {
    const { Slider, TableRow, Text } = Design as any
    return (
        <TableRow
            label="Tint"
            trailing={
                <Text variant="text-sm/semibold" color="text-muted">
                    {value > 0 ? `${Math.round(value * 100)}%` : 'Off'}
                </Text>
            }
            subLabel={
                Slider ? (
                    <Slider
                        value={value}
                        step={0.05}
                        // 디스코드 버전마다 이름이 다르다 (351: minimumValue·onSlidingComplete, 352+: minValue·onChangeEnd)
                        minimumValue={0}
                        maximumValue={0.9}
                        minValue={0}
                        maxValue={0.9}
                        onValueChange={(x: unknown) => typeof x === 'number' && onChange(x)}
                        onChange={(x: unknown) => typeof x === 'number' && onChange(x)}
                        onSlidingComplete={(x: unknown) => typeof x === 'number' && onCommit(x)}
                        onChangeEnd={(x: unknown) => typeof x === 'number' && onCommit(x)}
                    />
                ) : undefined
            }
        />
    )
}

function StatusRows() {
    const { TableRow, Text } = Design as any
    const [open, setOpen] = useState(false)
    const working = status.screenPatched && status.stylesPatched && !!gradientModule
    const summary = working ? (status.gradientsHidden > 0 ? 'Working' : 'Ready') : 'Some patches failed'
    const rows: Array<[string, string]> = [
        ['Channel screen', status.screenPatched ? 'patched' : 'not found'],
        ['Gradients hidden', `${status.gradientsHidden}`],
        ['Surfaces', `${status.contextPatched ? 'patched' : 'not found'} · ${status.surfacesCleared}`],
        ['Revealed', `${status.revealed}`],
        ['Styles', `${status.stylesPatched ? 'patched' : 'not found'} · ${status.coveredCleared}`],
        ['Freeze', `${status.freezePatched} · ${status.unfrozen}`],
        ['Overlays', `${status.overlays} · ${status.stripped}`],
    ]
    if (status.lastError) rows.push(['Last error', status.lastError])
    return [
        <TableRow
            key="summary"
            label={summary}
            trailing={<Text variant="text-lg/bold">{working ? '✓' : '!'}</Text>}
            onPress={() => setOpen(!open)}
        />,
        ...(open ? rows.map(([k, v]) => <TableRow key={k} label={k} trailing={<Text variant="text-sm/medium" color="text-muted">{v}</Text>} />) : []),
    ]
}

function SettingsPage({ api }: { api: any }) {
    const { Stack, TableRadioGroup, TableRadioRow, TableRowGroup, Text } = Design as any
    const [s, setS] = useState<Settings>(settings)
    const [alpha, setAlpha] = useState(s.alpha)
    const save = (patch: Partial<Settings>) => {
        const next = { ...s, ...patch }
        setS(next)
        api.jsonStorage.set({ ...next, v: 2 }, true)
    }
    return (
        <ScrollView style={{ flex: 1 }}>
            <Stack spacing={24} style={{ padding: 16, paddingBottom: 48 }}>
                <Preview mode={s.mode} alpha={alpha} />

                <TableRadioGroup title="Show" value={s.mode} onChange={(mode: Mode) => save({ mode })}>
                    <TableRadioRow value="screen" label="Chat" />
                    <TableRadioRow value="image" label="Background image" />
                </TableRadioGroup>

                {s.mode === 'screen' && (
                    <TableRowGroup title="Opacity">
                        <AlphaSlider value={alpha} onChange={setAlpha} onCommit={v => save({ alpha: Math.round(v * 100) / 100 })} />
                    </TableRowGroup>
                )}

                <TableRowGroup title="Status">{StatusRows()}</TableRowGroup>

            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    async start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        // 1.2.2: 덧칠 배경 기본값이 70% → 없음으로 바뀜. 예전 값은 한 번 초기화
        try {
            const saved = (await jsonStorage.get()) ?? {}
            if (saved.v !== 2) await jsonStorage.set({ ...DEFAULTS, ...saved, alpha: 0, v: 2 }, true)
        } catch {}
        OverlayContext ??= createContext(false)
        patchSurfaceColors(cleanup)
        const freezeDone = new Set<unknown>()
        for (const [mod] of lookupModules(withProps('Freeze'))) patchFreeze(mod, cleanup, freezeDone)
        cleanup(
            getModules(
                withProps('CustomThemedGradient', 'validateColors'),
                (mod: any) => {
                    gradientModule = mod
                    if (typeof mod?.default !== 'function') return
                    cleanup(
                        instead(mod, 'default', function (this: any, args: any[], orig: any) {
                            const inOverlay = useContext(OverlayContext)
                            const out = orig.apply(this, args)
                            if (!inOverlay || settings().mode !== 'screen') return out
                            status.gradientsHidden++
                            // 훅 순서를 지키려고 원래 것도 그리되 숨긴다
                            return createElement(View, { style: { display: 'none' } }, out)
                        }),
                    )
                },
                { cached: true } as any,
            ),
            getModules(withProps('Freeze'), (mod: any) => patchFreeze(mod, cleanup, freezeDone)),
            getModules(
                withProps('ThemeContext', 'useThemeContext'),
                (mod: any) => {
                    ThemeContextModule = mod
                },
                { cached: true } as any,
            ),
            getModules(
                withProps('getSemanticColorContextFromThemeContext'),
                (mod: any) => {
                    cleanup(
                        instead(mod, 'getSemanticColorContextFromThemeContext', function (this: any, args: any[], orig: any) {
                            const out = orig.apply(this, args)
                            return args[0]?.[MARK] && out && typeof out === 'object' ? { ...out, [MARK]: true } : out
                        }),
                    )
                    status.contextPatched = true
                },
                { cached: true } as any,
            ),
            getModuleWithImportedPath(SCREEN_PATH, (exports: any) => patchScreen(exports, cleanup)),
            getModuleWithImportedPath(STYLES_PATH, (exports: any) => patchScreenStyles(exports, cleanup)),
        )
    },
    SettingsComponent: SettingsPage,
} as any)
