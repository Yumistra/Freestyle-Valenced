import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, Text, View } from 'react-native'

/**
 * Multi RPC: 내 활동(게임 중, 듣는 중 …)을 여러 개 한꺼번에 보여 준다.
 * Vendetta 플러그인을 옮긴 것. 활동마다 LOCAL_ACTIVITY_UPDATE 를 따로 보낸다 (각자 다른 socketId).
 * 다시 연결되거나 앱으로 돌아오면 다시 보내고, 켜 둔 동안 2분마다 새로 보낸다.
 */

interface Activity {
    id: string
    enabled: boolean
    type: number
    name: string
    application_id: string
    details: string
    state: string
    large_image: string
    large_text: string
    small_image: string
    small_text: string
    use_timestamps: boolean
    start: number
    length_min: number
}

const DEFAULT_APP_ID = '1054951789318909972'
const TYPES: Array<[number, string]> = [
    [0, 'Playing'],
    [2, 'Listening'],
    [3, 'Watching'],
    [5, 'Competing'],
]
/** 활동 사이 간격 (ms). 설정에서 바꾼다 */
const GAPS = [0, 300, 500, 800, 1000, 1500]
const DEFAULT_GAP = 1500
const REFRESH_MS = 120000
const sessionStart = Date.now()

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
function newActivity(o: Partial<Activity> = {}): Activity {
    return {
        id: uid(),
        enabled: false,
        type: 0,
        name: 'New activity',
        application_id: DEFAULT_APP_ID,
        details: '',
        state: '',
        large_image: '',
        large_text: '',
        small_image: '',
        small_text: '',
        use_timestamps: false,
        start: 0,
        length_min: 0,
        ...o,
    }
}

const DEFAULTS = {
    /** Multi RPC 전체 켜기. 꺼져 있으면 아무것도 보내지 않는다 */
    on: false,
    gap: DEFAULT_GAP,
    activities: [newActivity({ name: 'A game', type: 0 }), newActivity({ name: 'A song', type: 2, use_timestamps: true, length_min: 3 }), newActivity({ name: 'A show', type: 3, use_timestamps: true })],
}

// ── 저장 ────────────────────────────────────────────────────────
let storage: any
const list = (): Activity[] => (Array.isArray(storage?.cache?.activities) ? storage.cache.activities : DEFAULTS.activities)
const gap = (): number => {
    const g = Number(storage?.cache?.gap)
    return Number.isFinite(g) && g >= 0 ? g : DEFAULT_GAP
}
function setGap(g: number) {
    if (!storage) return
    if (storage.cache) storage.cache.gap = g
    storage.set({ ...(storage.cache ?? {}), gap: g }, true)
}
const isOn = () => storage?.cache?.on === true
function setOn(on: boolean) {
    if (!storage) return
    if (storage.cache) storage.cache.on = on
    storage.set({ ...(storage.cache ?? {}), on }, true)
}
/** 보낸 적 있는 활동 (디스코드를 다시 켜기 전까지 남아 있어서 끌 때 다 지운다) */
const sentIds = (): string[] => (Array.isArray(storage?.cache?.sent) ? storage.cache.sent : [])
function rememberSent(ids: string[]) {
    if (!storage) return
    const next = [...new Set([...sentIds(), ...ids])].slice(-50)
    if (next.length === sentIds().length) return
    if (storage.cache) storage.cache.sent = next
    storage.set({ ...(storage.cache ?? {}), sent: next }, true)
}
let saveTimer: any
function setList(next: Activity[], now = false) {
    if (!storage) return
    if (storage.cache) storage.cache.activities = next
    clearTimeout(saveTimer)
    const write = () => storage.set({ ...(storage.cache ?? {}), activities: next }, true)
    if (now) write()
    else saveTimer = setTimeout(write, 400)
}

// ── 디스코드가 보여 주는 규칙 (직접 해 본 결과) ──
// 최대 5개, Listening 은 여러 개 되지만 Playing, Watching, Competing 은 하나씩만.
// 프로필은 Application ID 나 이름이 같은 활동을 하나로 합친다 (디스코드 코드에서 확인)
const MAX_SHOWN = 5
const LISTENING = 2
type Why = { text: string; id?: boolean } | undefined
const appIdOf = (a: Activity) => String(a.application_id || DEFAULT_APP_ID)
const typeLabel = (t: number) => TYPES.find(([v]) => v === t)?.[1] ?? 'Playing'
/** a 를 shown 옆에 더 보여 줄 수 없는 이유 */
function conflict(a: Activity, shown: Activity[]): Why {
    if (shown.some(b => appIdOf(b) === appIdOf(a))) return { text: 'Another activity uses the same Application ID', id: true }
    if (shown.some(b => (b.name || '').trim() === (a.name || '').trim())) return { text: 'Another activity has the same name' }
    if (a.type !== LISTENING && shown.some(b => b.type === a.type)) return { text: `Only one ${typeLabel(a.type)} activity can show` }
    if (shown.length >= MAX_SHOWN) return { text: `Only ${MAX_SHOWN} activities can show at once` }
}
/** 켜 둔 활동마다 안 보이는 이유 (위에서부터 차례로) */
function reasons(items: Activity[]): Why[] {
    const shown: Activity[] = []
    return items.map(a => {
        if (!a.enabled) return undefined
        const why = conflict(a, shown)
        if (!why) shown.push(a)
        return why
    })
}
/** i 번째를 patch 대로 바꿔 켜면 안 되는 이유 (다른 보이는 활동과 비교) */
function blockedBy(items: Activity[], whys: Why[], i: number, patch: Partial<Activity>): Why {
    const others = items.filter((b, j) => j !== i && b.enabled && !whys[j])
    return conflict({ ...items[i], ...patch, enabled: true }, others)
}

// ── 보내기 ──────────────────────────────────────────────────────
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}
const live = new Map<string, number>()
let runId = 0

function send(socketId: string, pid: number, activity: any) {
    ;(Dispatcher as any).dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', activity, pid, socketId })
}

async function resolveAssets(appId: string, keys: Array<{ field: string; value: string }>) {
    const out: Record<string, string> = {}
    const present = keys.filter(k => k.value)
    const assets = find('getAssetIds')
    if (!present.length || !assets) {
        for (const k of present) out[k.field] = k.value
        return out
    }
    const raw = present.map(k => k.value)
    try {
        let ids = assets.getAssetIds(appId, raw)
        if (!ids?.length) ids = await assets.fetchAssetIds(appId, raw)
        present.forEach((k, i) => (out[k.field] = ids?.[i] || k.value))
    } catch {
        for (const k of present) out[k.field] = k.value
    }
    return out
}

async function build(a: Activity) {
    const appId = String(a.application_id || DEFAULT_APP_ID)
    const act: any = { name: (a.name || '').trim() || 'Discord', type: Number(a.type) || 0, application_id: appId, flags: 0 }
    if (a.details?.trim()) act.details = a.details.trim()
    if (a.state?.trim()) act.state = a.state.trim()
    if (a.use_timestamps) {
        const start = Number(a.start) > 0 ? Number(a.start) : sessionStart
        act.timestamps = { start }
        const len = Number(a.length_min)
        if (len > 0) act.timestamps.end = start + len * 60000
    }
    const resolved = await resolveAssets(appId, [
        { field: 'large_image', value: (a.large_image || '').trim() },
        { field: 'small_image', value: (a.small_image || '').trim() },
    ])
    const assets: any = { ...resolved }
    if (resolved.large_image && a.large_text?.trim()) assets.large_text = a.large_text.trim()
    if (resolved.small_image && a.small_text?.trim()) assets.small_text = a.small_text.trim()
    if (Object.keys(assets).length) act.assets = assets
    return act
}

async function apply() {
    if (!isOn()) return clearAll()
    const my = ++runId
    // 안 보일 활동은 보내지 않는다 (보내면 다른 활동이 대신 빠지기도 한다)
    const all = list()
    const skip = reasons(all)
    const on = all.filter((a, i) => a?.enabled && !skip[i])
    const built: Array<{ socketId: string; pid: number; activity: any }> = []
    for (let i = 0; i < on.length; i++) {
        try {
            built.push({ socketId: `MultiRPC-${on[i].id}@Valenced`, pid: 1700 + i, activity: await build(on[i]) })
        } catch {}
    }
    if (my !== runId) return
    const keep = new Set(built.map(b => b.socketId))
    // 꺼졌거나 지운 활동은 내린다 (디스코드를 다시 켜기 전 것까지)
    for (const sid of new Set([...live.keys(), ...sentIds()]))
        if (!keep.has(sid)) {
            send(sid, live.get(sid) ?? 0, null)
            live.delete(sid)
        }
    rememberSent([...keep])
    for (let i = 0; i < built.length; i++) {
        const b = built[i]
        send(b.socketId, b.pid, b.activity)
        live.set(b.socketId, b.pid)
        if (i < built.length - 1) {
            const ms = gap()
            if (ms > 0) await new Promise(r => setTimeout(r, ms))
            if (my !== runId) return
        }
    }
}

function clearAll() {
    runId++
    const ids = new Set([...live.keys(), ...sentIds(), ...list().map(a => `MultiRPC-${a.id}@Valenced`)])
    for (const sid of ids) send(sid, live.get(sid) ?? 0, null)
    live.clear()
}

// ── 막힌 버튼: 누르면 이유를 말풍선으로 ─────────────────────────────
function Tip({ text, side = 'above', onBlocked, children }: { text?: string; side?: 'above' | 'left'; onBlocked?: () => void; children: any }) {
    const [shown, setShown] = useState(false)
    const fade = useRef(new Animated.Value(0)).current
    const timer = useRef<any>()
    useEffect(() => () => clearTimeout(timer.current), [])
    if (!text) return children
    const show = () => {
        onBlocked?.()
        setShown(true)
        fade.setValue(0)
        Animated.timing(fade, { toValue: 1, duration: 120, useNativeDriver: true }).start()
        clearTimeout(timer.current)
        timer.current = setTimeout(() => Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => setShown(false)), 2200)
    }
    const BLURPLE = '#5865F2'
    const bubble = (
        <Animated.View
            pointerEvents="none"
            style={[
                { position: 'absolute', zIndex: 20, elevation: 20, opacity: fade, flexDirection: side === 'left' ? 'row' : 'column', alignItems: 'center' },
                side === 'above' ? { bottom: '100%', left: 0, marginBottom: 4 } : { right: 64, top: 0, bottom: 0, justifyContent: 'center' },
            ]}
        >
            <View style={{ backgroundColor: BLURPLE, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 240 }}>
                <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{text}</Text>
            </View>
            <View
                style={[
                    { width: 8, height: 8, backgroundColor: BLURPLE, transform: [{ rotate: '45deg' }] },
                    side === 'above' ? { marginTop: -4, alignSelf: 'flex-start', marginLeft: 14 } : { marginLeft: -4 },
                ]}
            />
        </Animated.View>
    )
    return (
        <View>
            <View style={{ opacity: 0.4 }} pointerEvents="none">
                {children}
            </View>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={show} />
            {shown ? bubble : null}
        </View>
    )
}

// ── 설정 화면 ───────────────────────────────────────────────────
/** 디스코드는 같은 Application ID 의 활동을 하나만 보여 준다. 겹치면 다른 숫자로 바꿀 수 있게 */
const randomAppId = () => '1' + Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('')

function Card({ a, why, blockOn, blockType, onChange, onRemove }: { a: Activity; why: Why; blockOn: Why; blockType: (t: number) => Why; onChange: (a: Activity) => void; onRemove: () => void }) {
    const { Stack, TableRowGroup, TableSwitchRow, TextInput, Button } = Design as any
    const set = (patch: Partial<Activity>) => onChange({ ...a, ...patch })
    // 숫자만 (ID 처럼 긴 숫자는 글자로 둔다. Number 로 바꾸면 끝자리가 뭉개진다)
    const digits = (v: string) => v.replace(/[^0-9]/g, '')
    const field = (label: string, key: keyof Activity, placeholder: string, numeric: false | 'number' | 'id' = false) => (
        <TextInput
            label={label}
            value={a[key] ? String(a[key]) : ''}
            placeholder={placeholder}
            keyboardType={numeric ? 'numeric' : undefined}
            onChange={(v: string) => set({ [key]: numeric === 'number' ? Number(digits(v)) || 0 : numeric === 'id' ? digits(v) : v } as any)}
        />
    )
    const typeName = TYPES.find(([v]) => v === a.type)?.[1] ?? 'Playing'
    return (
        <TableRowGroup title={`${a.name || 'Activity'}, ${typeName}`}>
            {/* 켜도 안 보일 활동은 켤 수 없게 (누르면 이유) */}
            <Tip text={(a.enabled ? why : blockOn)?.text} side="left" onBlocked={() => a.enabled && set({ enabled: false })}>
                <TableSwitchRow label="Show this" value={!!a.enabled && !why} onValueChange={(enabled: boolean) => set({ enabled })} />
            </Tip>
            <View style={{ padding: 12 }}>
                <Stack spacing={10}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {TYPES.map(([v, label]) => (
                            <Tip key={v} text={a.type === v ? undefined : blockType(v)?.text}>
                                <Button size="sm" text={label} variant={a.type === v ? 'primary' : 'secondary'} onPress={() => set({ type: v })} />
                            </Tip>
                        ))}
                    </View>
                    {field('Name', 'name', 'Spotify')}
                    {field('Details', 'details', 'Top line')}
                    {field('State', 'state', 'Bottom line')}
                    {field('Application ID', 'application_id', DEFAULT_APP_ID, 'id')}
                    {field('Large image', 'large_image', 'Asset key or URL')}
                    {field('Large image text', 'large_text', 'Hover text')}
                    {field('Small image', 'small_image', 'Asset key or URL')}
                    {field('Small image text', 'small_text', 'Hover text')}
                </Stack>
            </View>
            <TableSwitchRow label="Show time" value={!!a.use_timestamps} onValueChange={(use_timestamps: boolean) => set({ use_timestamps })} />
            {a.use_timestamps ? (
                <View style={{ padding: 12 }}>
                    <Stack spacing={10}>
                        {field('Start (ms, 0 = when Discord opened)', 'start', '0', 'number')}
                        {field('Length in minutes (0 = elapsed time)', 'length_min', '0', 'number')}
                        <Button size="md" variant="secondary" text="Start the time from now" onPress={() => set({ start: Date.now() })} />
                    </Stack>
                </View>
            ) : null}
            <View style={{ padding: 12 }}>
                <Button size="md" variant="destructive" text="Remove" onPress={onRemove} />
            </View>
        </TableRowGroup>
    )
}

function SettingsPage({ api }: { api?: any }) {
    if (!storage && api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const { Stack, Button, TableRowGroup, TableRadioGroup, TableRadioRow } = Design as any
    const [items, setItems] = useState<Activity[]>(list)
    const [g, setG] = useState(gap)
    const [on, setOnState] = useState(isOn)
    const whys = reasons(items)
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        setList(items)
    }, [items])
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            <Stack spacing={16}>
                <TableRowGroup>
                    <TableSwitchRow
                        label="Multi RPC"
                        value={on}
                        onValueChange={(v: boolean) => {
                            setOnState(v)
                            setList(items, true)
                            setOn(v)
                            if (v) apply().catch(() => {})
                            else clearAll()
                        }}
                    />
                </TableRowGroup>
                <Tip text={on ? undefined : 'Turn on Multi RPC first'}>
                    <Button size="md" variant="primary" text="Apply" onPress={() => (setList(items, true), apply().catch(() => {}))} />
                </Tip>
                <Button size="md" variant="secondary" text="Add activity" onPress={() => setItems(x => [...x, newActivity({ application_id: randomAppId() })])} />
                <TableRadioGroup title="Time between activities" defaultValue={String(g)} onChange={(v: string) => (setG(Number(v)), setGap(Number(v)))}>
                    {GAPS.map(ms => (
                        <TableRadioRow key={ms} value={String(ms)} label={ms === 0 ? 'All at once' : `${ms / 1000}s`} />
                    ))}
                </TableRadioGroup>
                {items.map((a, i) => (
                    <Card
                        key={a.id}
                        a={a}
                        why={whys[i]}
                        blockOn={blockedBy(items, whys, i, {})}
                        blockType={(t: number) => (a.enabled && !whys[i] ? blockedBy(items, whys, i, { type: t }) : undefined)}
                        onChange={n => setItems(x => x.map(y => (y.id === n.id ? n : y)))} onRemove={() => setItems(x => x.filter(y => y.id !== a.id))} />
                ))}
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        let reconnect: any
        const again = () => {
            clearTimeout(reconnect)
            reconnect = setTimeout(() => {
                live.clear()
                apply().catch(() => {})
            }, 2000)
        }
        const onAppState = (e: any) => {
            if (e?.state && e.state !== 'active') return
            again()
        }
        const events: Array<[string, (e: any) => void]> = [
            ['CONNECTION_OPEN', again],
            ['CONNECTION_RESUMED', again],
            ['APP_STATE_UPDATE', onAppState],
        ]
        for (const [ev, fn] of events) (Dispatcher as any).subscribe(ev, fn)
        const refresh = setInterval(() => {
            if (live.size) apply().catch(() => {})
        }, REFRESH_MS)
        // 저장된 설정을 다 불러온 뒤 보낸다
        Promise.resolve(storage?.cache ?? storage?.get?.())
            .then(() => apply())
            .catch(() => {})
        cleanup(() => {
            for (const [ev, fn] of events) (Dispatcher as any).unsubscribe(ev, fn)
            clearTimeout(reconnect)
            clearInterval(refresh)
            clearAll()
        })
    },
    SettingsComponent: SettingsPage,
} as any)
