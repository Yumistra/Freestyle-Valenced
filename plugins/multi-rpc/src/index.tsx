import Page from '@valenced/components/Page'
import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

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
const SEND_GAP_MS = 1500
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
    activities: [newActivity({ name: 'A game', type: 0 }), newActivity({ name: 'A song', type: 2, use_timestamps: true, length_min: 3 }), newActivity({ name: 'A show', type: 3, use_timestamps: true })],
}

// ── 저장 ────────────────────────────────────────────────────────
let storage: any
const list = (): Activity[] => (Array.isArray(storage?.cache?.activities) ? storage.cache.activities : DEFAULTS.activities)
let saveTimer: any
function setList(next: Activity[], now = false) {
    if (!storage) return
    if (storage.cache) storage.cache.activities = next
    clearTimeout(saveTimer)
    const write = () => storage.set({ ...(storage.cache ?? {}), activities: next }, true)
    if (now) write()
    else saveTimer = setTimeout(write, 400)
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
    const my = ++runId
    const on = list().filter(a => a?.enabled)
    const built: Array<{ socketId: string; pid: number; activity: any }> = []
    for (let i = 0; i < on.length; i++) {
        try {
            built.push({ socketId: `MultiRPC-${on[i].id}@Valenced`, pid: 1700 + i, activity: await build(on[i]) })
        } catch {}
    }
    if (my !== runId) return
    const keep = new Set(built.map(b => b.socketId))
    for (const [sid, pid] of live)
        if (!keep.has(sid)) {
            send(sid, pid, null)
            live.delete(sid)
        }
    for (let i = 0; i < built.length; i++) {
        const b = built[i]
        send(b.socketId, b.pid, b.activity)
        live.set(b.socketId, b.pid)
        if (i < built.length - 1) {
            await new Promise(r => setTimeout(r, SEND_GAP_MS))
            if (my !== runId) return
        }
    }
}

function clearAll() {
    runId++
    for (const [sid, pid] of live) send(sid, pid, null)
    live.clear()
}

// ── 설정 화면 ───────────────────────────────────────────────────
function Card({ a, onChange, onRemove }: { a: Activity; onChange: (a: Activity) => void; onRemove: () => void }) {
    const { Stack, TableRowGroup, TableSwitchRow, TextInput, Button } = Design as any
    const set = (patch: Partial<Activity>) => onChange({ ...a, ...patch })
    const field = (label: string, key: keyof Activity, placeholder: string, numeric = false) => (
        <TextInput
            label={label}
            value={a[key] ? String(a[key]) : ''}
            placeholder={placeholder}
            keyboardType={numeric ? 'numeric' : undefined}
            onChange={(v: string) => set({ [key]: numeric ? Number(v) || 0 : v } as any)}
        />
    )
    const typeName = TYPES.find(([v]) => v === a.type)?.[1] ?? 'Playing'
    return (
        <TableRowGroup title={`${a.name || 'Activity'}, ${typeName}`}>
            <TableSwitchRow label="Show this" value={!!a.enabled} onValueChange={(enabled: boolean) => set({ enabled })} />
            <View style={{ padding: 12 }}>
                <Stack spacing={10}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {TYPES.map(([v, label]) => (
                            <Button key={v} size="sm" text={label} variant={a.type === v ? 'primary' : 'secondary'} onPress={() => set({ type: v })} />
                        ))}
                    </View>
                    {field('Name', 'name', 'Spotify')}
                    {field('Details', 'details', 'Top line')}
                    {field('State', 'state', 'Bottom line')}
                    {field('Application ID', 'application_id', DEFAULT_APP_ID, true)}
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
                        {field('Start (ms, 0 = when Discord opened)', 'start', '0', true)}
                        {field('Length in minutes (0 = elapsed time)', 'length_min', '0', true)}
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
    const { Stack, Button } = Design as any
    const [items, setItems] = useState<Activity[]>(list)
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        setList(items)
    }, [items])
    return (
        <Page>
            <Stack spacing={16}>
                <Button size="md" variant="primary" text="Apply" onPress={() => (setList(items, true), apply().catch(() => {}))} />
                <Button size="md" variant="secondary" text="Clear all" onPress={clearAll} />
                <Button size="md" variant="secondary" text="Add activity" onPress={() => setItems(x => [...x, newActivity()])} />
                {items.map(a => (
                    <Card key={a.id} a={a} onChange={n => setItems(x => x.map(y => (y.id === n.id ? n : y)))} onRemove={() => setItems(x => x.filter(y => y.id !== a.id))} />
                ))}
            </Stack>
        </Page>
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
