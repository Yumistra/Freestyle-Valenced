import { ToastActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { reloadApp } from '@valenced/modules/native/app'
import { instead } from '@valenced/patcher'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text as RNText, View } from 'react-native'

/**
 * Color Finder: 화면의 어떤 부분이 어느 테마 색(시맨틱 토큰)으로 칠해지는지 찾는다.
 *  - 색 하나를 고르면 그 색을 쓰는 곳이 전부 형광색으로 바뀐다 (위에 이름 바가 뜬다)
 *  - "어떤 색인지 찾기" 는 색들의 절반을 형광색으로 칠하고, 찾는 부분이 형광색인지 답하면 절반씩 줄여 하나로 좁힌다
 * 디스코드가 색을 미리 계산해 두기 때문에 바꿀 때마다 앱을 다시 켠다.
 */

const D = () => Design as any
const T = () => (Tokens as any).default ?? Tokens
const HIGHLIGHTS = ['#00FFFF', '#FF00FF', '#39FF14', '#FFEA00']

interface Search {
    /** 아직 후보인 색 이름 */
    left: string[]
    /** 지금 칠한 쪽 (left 의 앞 절반) */
    lit: string[]
    step: number
}
interface Store {
    /** 칠할 색 이름 하나 */
    token?: string
    search?: Search
    highlight: string
    result?: string
}

let storage: any
const state = (): Store => ({ highlight: HIGHLIGHTS[0], ...(storage?.cache ?? {}) })
const save = async (patch: Partial<Store>) => {
    if (storage && !storage.cache) await storage.get?.().catch?.(() => {})
    return storage?.set({ ...state(), ...patch }, true)
}

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`color-finder-${Date.now()}-${seq++}`, { text })
    } catch {}
}

/** 모든 시맨틱 색 이름 (가나다순) */
let names: string[] | undefined
function allNames(): string[] {
    if (names) return names
    try {
        names = Object.keys(T().colors ?? {}).sort()
    } catch {
        names = []
    }
    return names
}

const theme = () => {
    try {
        return (Stores as any).ThemeStore?.theme ?? 'dark'
    } catch {
        return 'dark'
    }
}

/** 칠하기 전의 원래 색 (설정 화면의 견본용) */
let original: ((...a: any[]) => any) | undefined
function colorOf(name: string): string | undefined {
    try {
        const t = T()
        const key = t.colors?.[name]
        const fn = original ?? t.internal.resolveSemanticColor
        const c = fn.call(t.internal, theme(), key)
        return typeof c === 'string' ? c : undefined
    } catch {}
}

/** 지금 칠하는 색 이름들 */
function litSet(): Set<string> {
    const s = state()
    if (s.search) return new Set(s.search.lit)
    return new Set(s.token ? [s.token] : [])
}

function patchTokens(cleanup: (...f: any[]) => void) {
    const t = T()
    const internal = t?.internal
    if (typeof internal?.resolveSemanticColor !== 'function') return toast('Color Finder: could not find Discord colors')
    original = internal.resolveSemanticColor
    // 저장 파일을 읽은 뒤 한 번만 정한다 (바꿀 때는 앱을 다시 켜니까)
    let lit: Set<string> | undefined
    let color = HIGHLIGHTS[0]
    cleanup(
        instead(internal, 'resolveSemanticColor', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
            if (!lit && storage?.cache) {
                lit = litSet()
                color = state().highlight
            }
            if (!lit?.size) return orig.apply(this, args)
            try {
                const c = args[1]
                const name = internal.isSemanticColor?.(c) ? internal.getSemanticColorName?.(c) : typeof c === 'string' ? c : undefined
                if (name && lit.has(name)) return color
            } catch {}
            return orig.apply(this, args)
        }),
    )
}

// ── 바꾸기 (다시 켜기) ──────────────────────────────────────────

async function pick(token: string | undefined) {
    await save({ token, search: undefined })
    reloadApp()
}

async function startSearch() {
    const left = allNames()
    if (!left.length) return toast('No colors found')
    await save({ token: undefined, search: { left, lit: left.slice(0, Math.ceil(left.length / 2)), step: 1 } })
    reloadApp()
}

/** 찾는 부분이 형광색이면 칠한 쪽, 아니면 나머지 쪽 */
async function answer(lit: boolean) {
    const s = state().search
    if (!s) return
    const litSet = new Set(s.lit)
    const left = lit ? s.lit : s.left.filter(n => !litSet.has(n))
    if (left.length <= 1) {
        await save({ search: undefined, token: left[0], result: left[0] })
        if (!left[0]) toast('Not found. The part may not use a theme color')
        return reloadApp()
    }
    await save({ search: { left, lit: left.slice(0, Math.ceil(left.length / 2)), step: s.step + 1 } })
    reloadApp()
}

async function stop() {
    await save({ token: undefined, search: undefined })
    reloadApp()
}

function step(dir: 1 | -1) {
    const list = allNames()
    const i = list.indexOf(state().token ?? '')
    const next = list[(i + dir + list.length) % list.length]
    pick(next)
}

function copy(text: string) {
    try {
        Clipboard.setString(text)
        toast(`Copied ${text}`)
    } catch {}
}

// ── 위에 뜨는 바 ────────────────────────────────────────────────

function Bar() {
    storage?.use?.()
    const s = state()
    if (!s.token && !s.search) return null
    const btn = (label: string, onPress: () => void, accent?: boolean) => (
        <Pressable key={label} onPress={onPress} style={({ pressed }: any) => ({ paddingHorizontal: 12, height: 36, borderRadius: 10, justifyContent: 'center', backgroundColor: accent ? '#5865F2' : '#2b2d31', opacity: pressed ? 0.6 : 1 })}>
            <RNText style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{label}</RNText>
        </Pressable>
    )
    return (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 44, left: 12, right: 12, zIndex: 9999, elevation: 9999 }}>
            <View style={{ backgroundColor: '#111214', borderRadius: 14, borderWidth: 2, borderColor: s.highlight, padding: 8, gap: 8 }}>
                {s.search ? (
                    <>
                        <RNText style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{`Step ${s.search.step}, ${s.search.left.length} colors left. Is the part you want ${s.highlight === '#00FFFF' ? 'cyan' : 'the bright color'}?`}</RNText>
                        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                            {btn('Yes', () => answer(true), true)}
                            {btn('No', () => answer(false))}
                            {btn('Stop', stop)}
                        </View>
                    </>
                ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Pressable onPress={() => copy(s.token!)} style={{ flex: 1, minWidth: 0 }}>
                            <RNText numberOfLines={1} ellipsizeMode="middle" style={{ color: '#fff', fontSize: 14, fontWeight: '700', backgroundColor: s.highlight + '33', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6 }}>
                                {s.token}
                            </RNText>
                        </Pressable>
                        {btn('‹', () => step(-1))}
                        {btn('›', () => step(1))}
                        {btn('Stop', stop)}
                    </View>
                )}
            </View>
        </View>
    )
}

function patchBar(cleanup: (...f: any[]) => void) {
    // 토스트를 그리는 곳은 앱 전체 위에 늘 있어서, 그 옆에 바를 같이 그린다
    cleanup(
        getModuleWithImportedPath('modules/toast/native/AppToastContainer.tsx', (mod: any) => {
            if (typeof mod?.default !== 'function') return
            cleanup(
                instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    const out = orig.apply(this, args)
                    return (
                        <>
                            {out}
                            <Bar />
                        </>
                    )
                }),
            )
        }) as any,
    )
}

// ── 설정 화면 ───────────────────────────────────────────────────

function SettingsPage({ api }: { api: any }) {
    const { Stack, TableRowGroup, TableRow, TextInput, Button, Text } = D()
    storage ??= api?.jsonStorage
    storage?.use?.()
    const s = state()
    const [q, setQ] = useState('')
    const [limit, setLimit] = useState(80)
    const list = useMemo(() => {
        const query = q.trim().toLowerCase().replace(/^#/, '')
        const all = allNames()
        if (!query) return all
        // #색 코드로도 찾는다
        const hex = /^[0-9a-f]{3,8}$/.test(query)
        return all.filter(n => n.toLowerCase().includes(query.replace(/ /g, '_')) || (hex && (colorOf(n) ?? '').toLowerCase().replace('#', '').startsWith(query)))
    }, [q])
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={24}>
                {s.result ? (
                    <TableRowGroup title="Last found">
                        <TableRow label={s.result} subLabel="Tap to copy" onPress={() => copy(s.result!)} />
                    </TableRowGroup>
                ) : null}
                <TableRowGroup title="Find the color of a part">
                    <TableRow label="How it works" subLabel="Half of all theme colors turn bright. Look at the part you want and answer if it turned bright. Each answer halves the list, about 10 answers in total. Discord reloads after each answer." />
                </TableRowGroup>
                <Stack spacing={8}>
                    <Button text={s.search ? 'Searching… answer on the bar at the top' : 'Find which color it is'} variant="primary" size="lg" disabled={!!s.search} onPress={startSearch} />
                    {s.token || s.search ? <Button text="Stop and reload" variant="secondary" size="md" onPress={stop} /> : null}
                </Stack>
                <TableRowGroup title="Highlight color">
                    <View style={{ flexDirection: 'row', gap: 12, padding: 12 }}>
                        {HIGHLIGHTS.map(h => (
                            <Pressable key={h} accessibilityLabel={h} onPress={() => save({ highlight: h })} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: h, borderWidth: s.highlight === h ? 3 : 0, borderColor: '#fff' }} />
                        ))}
                    </View>
                </TableRowGroup>
                <View style={{ gap: 8 }}>
                    <Text variant="text-sm/semibold" color="text-muted">{`ALL COLORS (${list.length})`}</Text>
                    <TextInput value={q} placeholder="Search a name, or a color like #ffffff" onChange={(v: string) => (setQ(v), setLimit(80))} isClearable />
                </View>
                <TableRowGroup>
                    {list.slice(0, limit).map(n => {
                        const c = colorOf(n)
                        return (
                            <TableRow
                                key={n}
                                label={n}
                                subLabel={`${c ?? '?'}${s.token === n ? ', lit now' : ''}`}
                                icon={<View style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: c ?? 'transparent', borderWidth: 1, borderColor: 'rgba(128,128,128,0.5)' }} />}
                                onPress={() => pick(n)}
                            />
                        )
                    })}
                    {list.length > limit ? <TableRow label={`Show more (${list.length - limit} left)`} onPress={() => setLimit(l => l + 120)} /> : null}
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: { highlight: HIGHLIGHTS[0] } },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        patchTokens(cleanup)
        patchBar(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
