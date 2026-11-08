import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { reloadApp } from '@valenced/modules/native/app'
import * as Internal from '@valenced/plugins/_'
import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'

/**
 * Lag Finder: 어떤 플러그인이 렉을 만드는지 찾는다.
 * 의심 목록의 절반을 끄고 앱을 다시 켠 뒤 "아직 렉이 있나요?" 에 답하면,
 * 답에 따라 의심 목록을 절반으로 줄인다. 하나 남으면 그게 범인이고, 처음 켜져 있던 것들을 다시 켠다.
 * 플러그인을 켜고 끄는 데 Valenced 내부 API 를 쓰므로 Developer Mode 가 필요하다.
 */

const SELF = 'yumistra.lag-finder'
const D = () => Design as any

interface Run {
    /** 시작할 때 켜져 있던 플러그인 (끝나면 이대로 되돌린다) */
    original: string[]
    /** 아직 의심하는 플러그인 */
    suspects: string[]
    /** 지금 꺼 둔 플러그인 (의심 목록의 앞 절반) */
    off: string[]
    /** 모두 끄고 확인하는 중 */
    allOff?: boolean
    step: number
}
interface Store {
    run?: Run
    result?: { culprit?: string; note: string; at: number }
}

let storage: any
const state = (): Store => storage?.cache ?? {}
const save = (s: Store) => storage?.set?.(s, true)

let seq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`lag-finder-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function api(): any {
    const I: any = Internal
    if (!I?.pList || typeof I.disablePluginInActiveSlot !== 'function') throw new Error('Turn on "Developer Mode" in Settings → Valenced first.')
    return I
}

const nameOf = (id: string) => {
    try {
        return api().pList.get(id)?.manifest?.name ?? id
    } catch {
        return id
    }
}

/** 지금 켜져 있고, 끌 수 있는 플러그인 (Valenced 기본 플러그인과 이 플러그인은 뺀다) */
function enabledPlugins(): string[] {
    const I = api()
    const out: string[] = []
    for (const p of I.pList.values() as Iterable<any>) {
        const id = p.manifest?.id
        if (!id || id === SELF) continue
        try {
            if (I.isPluginInternal?.(p)) continue
        } catch {}
        if (I.isPluginEnabledInActiveSlot(p)) out.push(id)
    }
    return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

/** original 중 off 만 끄고 나머지는 켠다 */
async function apply(original: string[], off: string[]) {
    const I = api()
    const offSet = new Set(off)
    // 켜는 것 먼저 (의존 플러그인도 같이 켜진다), 끄는 건 나중에
    for (const want of [true, false])
        for (const id of original) {
            if (offSet.has(id) === want) continue
            const p = I.pList.get(id)
            if (!p) continue
            const now = !!I.isPluginEnabledInActiveSlot(p)
            if (now === want) continue
            try {
                if (want) await I.enablePluginInActiveSlot(p, true)
                else await I.disablePluginInActiveSlot(p)
            } catch {}
        }
}

async function next(run: Run) {
    const half = run.suspects.slice(0, Math.ceil(run.suspects.length / 2))
    const r: Run = { ...run, off: half, allOff: false, step: run.step + 1 }
    await apply(run.original, half)
    await save({ ...state(), run: r })
    reloadApp()
}

async function finish(culprit: string | undefined, note: string, run: Run) {
    await apply(run.original, [])
    await save({ run: undefined, result: { culprit, note, at: Date.now() } })
    reloadApp()
}

export async function start() {
    const original = enabledPlugins()
    if (!original.length) return toast('No plugins to check')
    await next({ original, suspects: original, off: [], step: 0 })
}

/** 모두 끄고 렉이 남는지 (디스코드 자체 문제인지) */
export async function allOff() {
    const original = enabledPlugins()
    const run: Run = { original, suspects: original, off: original, allOff: true, step: 0 }
    await apply(original, original)
    await save({ ...state(), run })
    reloadApp()
}

export async function answer(laggy: boolean) {
    const run = state().run
    if (!run) return
    if (run.allOff) {
        if (laggy) return finish(undefined, 'Still laggy with every plugin off, so Discord itself is slow on this phone, not a plugin.', run)
        // 플러그인 문제라는 게 확인됐으니 반으로 나누기 시작
        return next({ ...run, allOff: false, step: 0 })
    }
    // 끈 절반에서 렉이 사라졌으면 범인은 끈 쪽, 아니면 켜 둔 쪽
    const offSet = new Set(run.off)
    const suspects = laggy ? run.suspects.filter(id => !offSet.has(id)) : run.off
    if (!suspects.length) return finish(undefined, 'Could not narrow it down. The lag may come from two plugins together, or it comes and goes.', run)
    if (suspects.length === 1) return finish(suspects[0], `Found in ${run.step} steps.`, run)
    return next({ ...run, suspects })
}

export async function cancel() {
    const run = state().run
    if (!run) return
    await apply(run.original, [])
    await save({ ...state(), run: undefined })
    reloadApp()
}

// ── 프레임 재기 ─────────────────────────────────────────────────

/** 10초 동안 JS 프레임을 잰다. 느린 프레임(50ms 넘게)이 많으면 JS 쪽이 바쁘다 */
function measure(seconds: number, done: (text: string) => void) {
    const deltas: number[] = []
    let last = 0
    const end = Date.now() + seconds * 1000
    const tick = (t: number) => {
        if (last) deltas.push(t - last)
        last = t
        if (Date.now() < end) requestAnimationFrame(tick)
        else {
            const total = deltas.reduce((a, b) => a + b, 0)
            const fps = deltas.length ? Math.round((deltas.length * 1000) / total) : 0
            const slow = deltas.filter(d => d > 50).length
            const worst = deltas.length ? Math.round(Math.max(...deltas)) : 0
            done(`${fps} fps, ${slow} slow frames, worst ${worst} ms`)
        }
    }
    requestAnimationFrame(tick)
}

// ── 설정 화면 ───────────────────────────────────────────────────

function confirm(title: string, body: string, actionText: string, action: () => void) {
    const { AlertModal, AlertActionButton, Text } = D()
    AlertActionCreators.openAlert(
        `lag-finder-confirm-${seq++}`,
        <AlertModal title={title} content={<Text variant="text-md/normal">{body}</Text>} actions={[<AlertActionButton key="ok" text={actionText} variant="primary" onPress={action} />, <AlertActionButton key="no" text="Cancel" variant="secondary" />]} />,
    )
}

function SettingsPage({ api: pluginApi }: { api: any }) {
    const { Stack, TableRowGroup, TableRow, Button, Text } = D()
    storage ??= pluginApi?.jsonStorage
    const [, tick] = useState(0)
    const [busy, setBusy] = useState(false)
    const [fps, setFps] = useState('')
    useEffect(() => {
        storage?.get?.().then(() => tick(n => n + 1)).catch(() => {})
    }, [])
    const s = state()
    const run = s.run
    const go = (fn: () => Promise<unknown>) => async () => {
        if (busy) return
        setBusy(true)
        try {
            await fn()
        } catch (e: any) {
            toast(String(e?.message ?? e))
        } finally {
            setBusy(false)
        }
    }
    let ok = true
    try {
        api()
    } catch {
        ok = false
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }}>
            <Stack spacing={24}>
                {!ok ? (
                    <TableRowGroup title="Lag Finder">
                        <TableRow label="Developer Mode is off" subLabel='Turn on "Developer Mode" in Settings → Valenced, then come back.' />
                    </TableRowGroup>
                ) : run ? (
                    <>
                        <TableRowGroup title={run.allOff ? 'Every plugin is off' : `Step ${run.step}, ${run.suspects.length} plugins left`}>
                            <TableRow label="Now go and test" subLabel="Open the channel that lags, scroll through the GIFs and animated emojis, then come back and answer." />
                            <TableRow label={`Turned off (${run.off.length})`} subLabel={run.off.map(nameOf).join(', ') || 'None'} />
                            {!run.allOff ? <TableRow label={`Still suspected (${run.suspects.length})`} subLabel={run.suspects.map(nameOf).join(', ')} /> : null}
                        </TableRowGroup>
                        <Stack spacing={8}>
                            <Text variant="text-md/semibold">Is it still laggy?</Text>
                            <Button text="Yes, still laggy" variant="primary" size="lg" disabled={busy} onPress={go(() => answer(true))} />
                            <Button text="No, the lag is gone" variant="secondary" size="lg" disabled={busy} onPress={go(() => answer(false))} />
                            <Button text="Stop and turn everything back on" variant="destructive" size="md" disabled={busy} onPress={() => confirm('Stop Lag Finder?', 'Every plugin that was on goes back on, and Discord reloads.', 'Stop', go(cancel))} />
                        </Stack>
                    </>
                ) : (
                    <>
                        {s.result ? (
                            <TableRowGroup title="Last result">
                                <TableRow label={s.result.culprit ? nameOf(s.result.culprit) : 'No single plugin'} subLabel={s.result.note} />
                            </TableRowGroup>
                        ) : null}
                        <TableRowGroup title="How it works">
                            <TableRow label="1. Half of your plugins are turned off" subLabel="Discord reloads by itself." />
                            <TableRow label="2. You test and answer" subLabel="Go to where it lags, then come back here and tell it if the lag is still there." />
                            <TableRow label="3. Repeat" subLabel="Each answer halves the list. About 7 answers for 70 plugins. At the end, every plugin goes back on." />
                        </TableRowGroup>
                        <Stack spacing={8}>
                            <Button text="Find the laggy plugin" variant="primary" size="lg" disabled={busy} onPress={() => confirm('Start Lag Finder?', 'Half of your plugins will be turned off and Discord will reload. Everything goes back on when it ends.', 'Start', go(start))} />
                            <Button text="First check with every plugin off" variant="secondary" size="md" disabled={busy} onPress={() => confirm('Turn every plugin off?', 'Checks if Discord itself is slow. Discord will reload.', 'Turn off', go(allOff))} />
                        </Stack>
                    </>
                )}
                <TableRowGroup title="Frame meter">
                    <TableRow label="Measure for 10 seconds" subLabel={fps || 'Tap, then go scroll where it lags. The result shows up as a message.'} onPress={() => {
                        setFps('Measuring…')
                        toast('Measuring for 10 seconds, go scroll now')
                        measure(10, text => {
                            setFps(text)
                            toast(`Lag Finder: ${text}`)
                        })
                    }} arrow />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: {} },
    start({ jsonStorage }: any) {
        storage = jsonStorage
        // 다시 켜진 뒤 할 일을 알려 준다
        setTimeout(() => {
            const run = state().run
            if (run) toast(run.allOff ? 'Lag Finder: every plugin is off. Test, then answer in Lag Finder settings' : `Lag Finder step ${run.step}: test, then answer in Lag Finder settings`)
        }, 4000)
    },
    SettingsComponent: SettingsPage,
} as any)
