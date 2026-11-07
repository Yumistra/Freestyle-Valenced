import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { Blocked, TooltipHost, useTooltipHide } from './tooltip'

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
    /** + 로 추가한 칸 (보이는 순서) */
    fields?: string[]
}

const DEFAULT_APP_ID = '1054951789318909972'
const TYPES: Array<[number, string]> = [
    [0, 'Playing'],
    [2, 'Listening'],
    [3, 'Watching'],
    [5, 'Competing'],
]
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
    activities: [newActivity({ name: 'A game', type: 0 }), newActivity({ name: 'A song', type: 2, use_timestamps: true, length_min: 3 }), newActivity({ name: 'A show', type: 3, use_timestamps: true })],
}

// ── 저장 ────────────────────────────────────────────────────────
let storage: any
const list = (): Activity[] => (Array.isArray(storage?.cache?.activities) ? storage.cache.activities : DEFAULTS.activities)
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
    // 이름이 같은 활동은 프로필에서 하나로 합쳐진다 (코드, 직접 해 본 결과 둘 다 확인)
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
    // 모두 한꺼번에 보낸다
    for (let i = 0; i < built.length; i++) {
        const b = built[i]
        send(b.socketId, b.pid, b.activity)
        live.set(b.socketId, b.pid)
    }
}

function clearAll() {
    runId++
    const ids = new Set([...live.keys(), ...sentIds(), ...list().map(a => `MultiRPC-${a.id}@Valenced`)])
    for (const sid of ids) send(sid, live.get(sid) ?? 0, null)
    live.clear()
}

// ── 설정 화면 ───────────────────────────────────────────────────

/** 디스코드는 같은 Application ID 의 활동을 하나만 보여 준다 */
const randomAppId = () => '1' + Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('')

/** + 로 추가하는 칸 */
type FieldKey = 'details' | 'state' | 'application_id' | 'large_image' | 'large_text' | 'small_image' | 'small_text' | 'time'
const FIELDS: Array<[FieldKey, string, string]> = [
    ['details', 'Details', 'Top line'],
    ['state', 'State', 'Bottom line'],
    ['large_image', 'Large image', 'Asset key or URL'],
    ['large_text', 'Large image text', 'Hover text'],
    ['small_image', 'Small image', 'Asset key or URL'],
    ['small_text', 'Small image text', 'Hover text'],
    ['time', 'Time', ''],
    ['application_id', 'Application ID', DEFAULT_APP_ID],
]
/** 지금 보이는 칸: 추가한 것 + (예전 버전에서) 값이 들어 있는 것 */
function fieldsOf(a: Activity): FieldKey[] {
    const out = (a.fields ?? []).filter(k => FIELDS.some(([f]) => f === k)) as FieldKey[]
    for (const [k] of FIELDS) {
        if (out.includes(k) || k === 'application_id') continue
        if (k === 'time' ? a.use_timestamps : String((a as any)[k] ?? '').trim()) out.push(k)
    }
    return out
}

const animate = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
const T = (): any => (Tokens as any)?.default ?? {}
function tokenColor(names: string[], fallback: string) {
    try {
        const t = T()
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}
function Icon({ name, color, size = 20, alt = [] }: { name: string; color: string; size?: number; alt?: string[] }) {
    let C: any
    for (const n of [name, ...alt])
        try {
            C ??= lookupGeneratedIconComponent(n as any)
        } catch {}
    if (C) return <C size="sm" color={color} style={{ width: size, height: size }} />
    const { Text } = Design as any
    return <Text variant="text-md/bold" style={{ color }}>{name.startsWith('X') ? '×' : '🗑'}</Text>
}

/** 드롭다운 앞 지우기 버튼: 두 번 눌러야 지운다 */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
    const [armed, setArmed] = useState(false)
    const timer = useRef<any>()
    useEffect(() => () => clearTimeout(timer.current), [])
    const red = tokenColor(['CONTROL_CRITICAL_PRIMARY_BACKGROUND_DEFAULT', 'STATUS_DANGER', 'TEXT_DANGER'], '#da373c')
    const muted = tokenColor(['INTERACTIVE_TEXT_DEFAULT', 'INTERACTIVE_NORMAL', 'TEXT_MUTED'], '#b5bac1')
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={armed ? 'Tap again to delete' : 'Delete'}
            onPress={() => {
                if (!armed) {
                    setArmed(true)
                    clearTimeout(timer.current)
                    timer.current = setTimeout(() => setArmed(false), 3000)
                    return
                }
                clearTimeout(timer.current)
                animate()
                onDelete()
            }}
            hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: armed ? red : 'transparent', alignItems: 'center', justifyContent: 'center' }}
        >
            <Icon name="TrashIcon" alt={['TrashFilledIcon']} size={18} color={armed ? '#ffffff' : muted} />
        </Pressable>
    )
}
/** 설정 화면 바탕색 (테마) */
const pageBg = () => tokenColor(['BACKGROUND_BASE_LOWEST', 'BACKGROUND_MOBILE_PRIMARY', 'BACKGROUND_PRIMARY'], '#000000')
function alpha(color: string, a: number) {
    const h = /^#([0-9a-f]{6})/i.exec(color)
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color)
    if (h) {
        const n = parseInt(h[1], 16)
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
    }
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`
    return color
}
const num = (v: any, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function Card({ a, why, blockOn, blockType, onChange, onRemove }: { a: Activity; why: Why; blockOn: Why; blockType: (t: number) => Why; onChange: (a: Activity) => void; onRemove: () => void }) {
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TextInput, Button, Text } = Design as any
    const [open, setOpen] = useState(false)
    const [adding, setAdding] = useState(false)
    const set = (patch: Partial<Activity>) => onChange({ ...a, ...patch })
    // 숫자만 (ID 처럼 긴 숫자는 글자로 둔다. Number 로 바꾸면 끝자리가 뭉개진다)
    const digits = (v: string) => v.replace(/[^0-9]/g, '')
    const muted = tokenColor(['INTERACTIVE_TEXT_DEFAULT', 'INTERACTIVE_NORMAL', 'TEXT_MUTED'], '#b5bac1')
    // 이름표는 칸 위에 따로 두고, 칸 오른쪽에 × 를 칸 높이 가운데에 맞춘다
    const input = (label: string, key: keyof Activity, placeholder: string, numeric: false | 'number' | 'id' = false, onRemoveField?: () => void) => (
        <View>
            <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 8 }}>
                {label}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                    <TextInput
                        value={a[key] ? String(a[key]) : ''}
                        placeholder={placeholder}
                        keyboardType={numeric ? 'numeric' : undefined}
                        onChange={(v: string) => set({ [key]: numeric === 'number' ? Number(digits(v)) || 0 : numeric === 'id' ? digits(v) : v } as any)}
                    />
                </View>
                {onRemoveField ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="Remove" hitSlop={10} onPress={onRemoveField} style={{ padding: 6, marginLeft: 6 }}>
                        <Icon name="XSmallIcon" alt={['XLargeIcon', 'CloseSmallIcon', 'CircleXIcon']} color={muted} />
                    </Pressable>
                ) : null}
            </View>
        </View>
    )
    const shown = fieldsOf(a)
    const left = FIELDS.filter(([k]) => !shown.includes(k))
    const add = (k: FieldKey) => {
        animate()
        setAdding(false)
        set({ fields: [...shown, k], ...(k === 'time' ? { use_timestamps: true } : {}) })
    }
    const remove = (k: FieldKey) => {
        animate()
        const patch: any = { fields: shown.filter(f => f !== k) }
        if (k === 'time') patch.use_timestamps = false
        else if (k !== 'application_id') patch[k] = ''
        set(patch)
    }
    const typeName = TYPES.find(([v]) => v === a.type)?.[1] ?? 'Playing'
    const showing = !!a.enabled && !why
    // 켜진 활동은 테마의 강조색을 아주 옅게 덮어 구분한다
    const radius = num(T()?.radii?.lg, 16)
    const tint = alpha(tokenColor(['CONTROL_PRIMARY_BACKGROUND_DEFAULT', 'BACKGROUND_BRAND', 'TEXT_BRAND'], '#5865f2'), 0.1)
    return (
        <View>
            <View style={{ borderRadius: radius, overflow: 'hidden' }}>
                <TableRowGroup>
                    <TableRow
                        label={a.name || 'Activity'}
                        subLabel={showing ? typeName : `${typeName}, off`}
                        trailing={
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <DeleteButton onDelete={onRemove} />
                                <TableRowAssetIcon name={open ? 'ChevronSmallUpIcon' : 'ChevronSmallDownIcon'} />
                            </View>
                        }
                        onPress={() => (animate(), setOpen(o => !o))}
                    />
                    {open ? (
                        <Blocked
                            text={(a.enabled ? why : blockOn)?.text}
                            anchor={r => ({ x: r.x + r.width - 68, y: r.y, width: 52, height: r.height })}
                            onBlocked={() => a.enabled && set({ enabled: false })}
                        >
                            <TableSwitchRow label="Show this" value={showing} onValueChange={(enabled: boolean) => set({ enabled })} />
                        </Blocked>
                    ) : null}
                    {open ? (
                        <View style={{ padding: 12 }}>
                            <Stack spacing={10}>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                    {TYPES.map(([v, label]) => (
                                        <Blocked key={v} text={a.type === v ? undefined : blockType(v)?.text}>
                                            <Button size="sm" text={label} variant={a.type === v ? 'primary' : 'secondary'} onPress={() => set({ type: v })} />
                                        </Blocked>
                                    ))}
                                </View>
                                {input('Name', 'name', 'Spotify')}
                                {shown.map(k => {
                                    if (k === 'time')
                                        return (
                                            <Stack key={k} spacing={10}>
                                                {input('Start (ms, 0 = when Discord opened)', 'start', '0', 'number', () => remove(k))}
                                                {input('Length in minutes (0 = elapsed time)', 'length_min', '0', 'number')}
                                                <Button size="sm" variant="secondary" text="Start the time from now" onPress={() => set({ start: Date.now() })} />
                                            </Stack>
                                        )
                                    const f = FIELDS.find(([x]) => x === k)!
                                    return <View key={k}>{input(f[1], k as keyof Activity, f[2], k === 'application_id' ? 'id' : false, () => remove(k))}</View>
                                })}
                                {left.length ? (
                                    adding ? (
                                        <Stack spacing={12}>
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                                {left.map(([k, label]) => (
                                                    <Button key={k} size="sm" variant="secondary" text={label} onPress={() => add(k)} />
                                                ))}
                                            </View>
                                            <Button size="md" variant="primary" text="Cancel" onPress={() => (animate(), setAdding(false))} />
                                        </Stack>
                                    ) : (
                                        <Button size="sm" variant="secondary" text="+ Add" onPress={() => (animate(), setAdding(true))} />
                                    )
                                ) : null}
                            </Stack>
                        </View>
                    ) : null}
                </TableRowGroup>
                {showing ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tint }} /> : null}
            </View>
        </View>
    )
}

function SettingsPage({ api }: { api?: any }) {
    if (!storage && api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const [items, setItems] = useState<Activity[]>(list)
    const [on, setOnState] = useState(isOn)
    const first = useRef(true)
    useEffect(() => {
        if (first.current) {
            first.current = false
            return
        }
        setList(items)
        // 바꾸면 바로 적용 (글자를 치는 동안은 잠깐 기다렸다가)
        if (!isOn()) return
        const t = setTimeout(() => apply().catch(() => {}), 700)
        return () => clearTimeout(t)
    }, [items])
    return (
        <TooltipHost>
            <Page items={items} setItems={setItems} on={on} setOnState={setOnState} />
        </TooltipHost>
    )
}

function Page({ items, setItems, on, setOnState }: { items: Activity[]; setItems: (f: (x: Activity[]) => Activity[]) => void; on: boolean; setOnState: (v: boolean) => void }) {
    const { Stack, Button, TableRowGroup, TableSwitchRow } = Design as any
    const hide = useTooltipHide()
    const whys = reasons(items)
    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 160 }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            onScrollBeginDrag={hide}
            // Add activity 는 위로 밀려 가려지면 맨 위에 붙어 떠 있는다
            stickyHeaderIndices={[1]}
        >
            <View style={{ marginBottom: 8 }}>
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
            </View>
            {/* 떠 있을 때 뒤가 비치지 않게 화면 바탕색을 깐다 */}
            <View style={{ paddingVertical: 8, marginHorizontal: -16, paddingHorizontal: 16, backgroundColor: pageBg() }}>
                <Button size="md" variant="secondary" text="Add activity" onPress={() => (animate(), setItems(x => [...x, newActivity({ application_id: randomAppId() })]))} />
            </View>
            <Stack spacing={16} style={{ marginTop: 8 }}>
                {items.map((a, i) => (
                    <Card
                        key={a.id}
                        a={a}
                        why={whys[i]}
                        blockOn={blockedBy(items, whys, i, {})}
                        blockType={(t: number) => (a.enabled && !whys[i] ? blockedBy(items, whys, i, { type: t }) : undefined)}
                        onChange={n => setItems(x => x.map(y => (y.id === n.id ? n : y)))}
                        onRemove={() => setItems(x => x.filter(y => y.id !== a.id))}
                    />
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
