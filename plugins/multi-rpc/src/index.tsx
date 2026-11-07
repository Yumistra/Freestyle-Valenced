import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Animated, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { Blocked, TooltipHost, useTooltipHide } from './tooltip'
import { alpha, T, useColor } from './colors'

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
    /** 활동 아래 버튼 (다른 사람에게 보인다). 디스코드는 2개까지만 보여 준다 */
    buttons?: Array<{ label: string; url: string }>
    /** Streaming 방송 주소 (트위치, 유튜브) */
    url?: string
    /** 파티 인원 (지금, 최대) */
    party_size?: number
    party_max?: number
    /** 멤버 목록에 이름 아래로 보일 것: 0 이름, 1 State, 2 Details */
    status_display?: number
    /** 글자, 이미지를 누르면 열리는 주소 */
    details_url?: string
    state_url?: string
    large_url?: string
    small_url?: string
}

const DEFAULT_APP_ID = '1054951789318909972'
const TYPES: Array<[number, string]> = [
    [0, 'Playing'],
    [1, 'Streaming'],
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
const STREAMING = 1
type Why = { text: string; id?: boolean } | undefined
const appIdOf = (a: Activity) => String(a.application_id || DEFAULT_APP_ID)
const typeLabel = (t: number) => TYPES.find(([v]) => v === t)?.[1] ?? 'Playing'
/** a 를 shown 옆에 더 보여 줄 수 없는 이유 */
function conflict(a: Activity, shown: Activity[]): Why {
    if (shown.some(b => appIdOf(b) === appIdOf(a))) return { text: 'Another activity uses the same Application ID', id: true }
    // 이름이 같은 활동은 프로필에서 하나로 합쳐진다 (코드, 직접 해 본 결과 둘 다 확인)
    if (shown.some(b => (b.name || '').trim() === (a.name || '').trim())) return { text: 'Another activity has the same name' }
    // Listening, Streaming 은 여러 개 보인다 (직접 해 본 결과, 전체 5개 안에서)
    if (a.type !== LISTENING && a.type !== STREAMING && shown.some(b => b.type === a.type)) return { text: `Only one ${typeLabel(a.type)} activity can show` }
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

const isUrl = (v: string) => /^https?:\/\//i.test(v)
/** 디스코드에 올라간 이미지는 미디어 프록시 경로(mp:)로 바로 쓴다 */
function discordMedia(v: string): string | undefined {
    const m = v.match(/^https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(.+)$/i)
    return m ? `mp:${m[1]}` : undefined
}

/**
 * 이미지 칸 값을 디스코드가 보여 줄 수 있는 값으로.
 *  - 에셋 이름: 그 활동의 Application ID 로 찾는다
 *  - 바깥 주소(imgur 등): 디스코드 미디어 프록시(mp:external/...)로 바꿔야 보인다.
 *    바꾸는 요청은 실제로 있는 앱이어야 해서, 활동마다 쓰는 무작위 ID 대신 기본 앱 ID 로 한다
 *    (나온 mp: 경로는 앱과 상관없이 보인다)
 */
async function resolveAssets(appId: string, keys: Array<{ field: string; value: string }>) {
    const out: Record<string, string> = {}
    const present = keys.filter(k => k.value)
    if (!present.length) return out
    const assets = find('getAssetIds')
    const run = async (id: string, list: Array<{ field: string; value: string }>) => {
        if (!list.length) return
        const raw = list.map(k => k.value)
        try {
            let ids = assets?.getAssetIds?.(id, raw)
            if (!ids?.length || ids.some((x: any) => !x)) ids = await assets?.fetchAssetIds?.(id, raw)
            list.forEach((k, i) => (out[k.field] = ids?.[i] || k.value))
        } catch {
            for (const k of list) out[k.field] = k.value
        }
    }
    const urls: Array<{ field: string; value: string }> = []
    const named: Array<{ field: string; value: string }> = []
    for (const k of present) {
        const media = isUrl(k.value) ? discordMedia(k.value) : undefined
        if (media) out[k.field] = media
        else if (k.value.startsWith('mp:')) out[k.field] = k.value
        else (isUrl(k.value) ? urls : named).push(k)
    }
    await run(DEFAULT_APP_ID, urls)
    await run(appId, named)
    return out
}

async function build(a: Activity) {
    const appId = String(a.application_id || DEFAULT_APP_ID)
    const act: any = { name: (a.name || '').trim() || 'Discord', type: Number(a.type) || 0, application_id: appId, flags: 0 }
    if (a.details?.trim()) act.details = a.details.trim()
    if (a.state?.trim()) act.state = a.state.trim()
    if (act.type === STREAMING && a.url?.trim()) act.url = a.url.trim()
    if (act.details && a.details_url?.trim()) act.details_url = a.details_url.trim()
    if (act.state && a.state_url?.trim()) act.state_url = a.state_url.trim()
    if (Number(a.party_size) > 0 && Number(a.party_max) > 0) act.party = { id: `multirpc-${a.id}`, size: [Number(a.party_size), Number(a.party_max)] }
    if (a.status_display != null && fieldsOf(a).includes('status')) act.status_display_type = Number(a.status_display) || 0
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
    if (resolved.large_image && a.large_url?.trim()) assets.large_url = a.large_url.trim()
    if (resolved.small_image && a.small_url?.trim()) assets.small_url = a.small_url.trim()
    if (Object.keys(assets).length) act.assets = assets
    // 버튼: 글자는 buttons, 주소는 metadata.button_urls (디스코드 RPC 와 같은 모양)
    const buttons = (a.buttons ?? [])
        .map(b => ({ label: (b.label || '').trim(), url: (b.url || '').trim() }))
        .filter(b => b.label && b.url)
        // 디스코드는 2개까지만 보여 준다 (직접 해 본 결과)
        .slice(0, 2)
    if (buttons.length) {
        act.buttons = buttons.map(b => b.label)
        act.metadata = { button_urls: buttons.map(b => b.url) }
    }
    return act
}

/** 실제로 보낼 내용만 모은 값 (보이는 칸 정리 같은 화면 변화는 빼고). 마지막으로 적용한 것과 다르면 Apply 를 보여 준다 */
function signature(items: Activity[]) {
    const why = reasons(items)
    return JSON.stringify(
        items
            .filter((a, i) => a.enabled && !why[i])
            .map(a => [a.id, a.type, a.name, a.application_id, a.details, a.state, a.large_image, a.large_text, a.small_image, a.small_text, a.use_timestamps, a.start, a.length_min, a.url, a.party_size, a.party_max, fieldsOf(a).includes('status') ? a.status_display : null, a.details_url, a.state_url, a.large_url, a.small_url, (a.buttons ?? []).filter(b => b.label?.trim() && b.url?.trim()).slice(0, 2)]),
    )
}
let appliedSig: string | undefined

async function apply() {
    if (!isOn()) return clearAll()
    appliedSig = signature(list())
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
type FieldKey = 'details' | 'state' | 'application_id' | 'large_image' | 'large_text' | 'small_image' | 'small_text' | 'time' | 'buttons' | 'party' | 'status' | 'details_url' | 'state_url' | 'large_url' | 'small_url'
const FIELDS: Array<[FieldKey, string, string]> = [
    ['details', 'Details', 'Top line'],
    ['state', 'State', 'Bottom line'],
    ['large_image', 'Large image', 'Asset key or URL'],
    ['large_text', 'Large image text', 'Hover text'],
    ['small_image', 'Small image', 'Asset key or URL'],
    ['small_text', 'Small image text', 'Hover text'],
    ['time', 'Time', ''],
    ['party', 'Party', ''],
    ['buttons', 'Button', ''],
    ['status', 'Status display', ''],
    ['details_url', 'Details link', 'https://'],
    ['state_url', 'State link', 'https://'],
    ['large_url', 'Large image link', 'https://'],
    ['small_url', 'Small image link', 'https://'],
    ['application_id', 'Application ID', DEFAULT_APP_ID],
]
/** 지금 보이는 칸: 추가한 것 + (예전 버전에서) 값이 들어 있는 것 */
function fieldsOf(a: Activity): FieldKey[] {
    const out = (a.fields ?? []).filter(k => FIELDS.some(([f]) => f === k)) as FieldKey[]
    for (const [k] of FIELDS) {
        if (out.includes(k) || k === 'application_id') continue
        if (k === 'status') continue
        const has = k === 'time' ? a.use_timestamps : k === 'buttons' ? (a.buttons ?? []).length > 0 : k === 'party' ? Number(a.party_size) > 0 || Number(a.party_max) > 0 : String((a as any)[k] ?? '').trim()
        if (has) out.push(k)
    }
    return out
}

const animate = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
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
    const red = useColor(['CONTROL_CRITICAL_PRIMARY_BACKGROUND_DEFAULT', 'STATUS_DANGER', 'TEXT_DANGER'], '#da373c')
    const onRed = useColor(['CONTROL_CRITICAL_PRIMARY_TEXT_DEFAULT', 'WHITE'], '#ffffff')
    const muted = useColor(['INTERACTIVE_TEXT_DEFAULT', 'INTERACTIVE_NORMAL', 'TEXT_MUTED'], '#b5bac1')
    // 빨갛게 될 때 부드럽게 칠하고 살짝 튀어나온다
    const arm = useRef(new Animated.Value(0)).current
    const pop = useRef(new Animated.Value(1)).current
    useEffect(() => {
        Animated.timing(arm, { toValue: armed ? 1 : 0, duration: 160, useNativeDriver: false }).start()
        if (armed) Animated.sequence([Animated.spring(pop, { toValue: 1.18, stiffness: 600, damping: 14, mass: 0.5, useNativeDriver: true }), Animated.spring(pop, { toValue: 1, stiffness: 400, damping: 18, mass: 0.5, useNativeDriver: true })]).start()
    }, [armed])
    const fill = arm.interpolate({ inputRange: [0, 1], outputRange: [alpha(red, 0), red] })
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
        >
            <Animated.View style={{ transform: [{ scale: pop }] }}>
                <Animated.View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="TrashIcon" alt={['TrashFilledIcon']} size={18} color={armed ? onRed : muted} />
                </Animated.View>
            </Animated.View>
        </Pressable>
    )
}
/** 새로고침: 보낸 활동을 모두 내렸다가 지금 목록대로 다시 보낸다 (디스코드에 안 바뀌어 보일 때) */
function RefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
    const bg = useColor(['CONTROL_SECONDARY_BACKGROUND_DEFAULT', 'BUTTON_SECONDARY_BACKGROUND', 'BACKGROUND_MOD_NORMAL'], '#4e5058')
    const bgPressed = useColor(['CONTROL_SECONDARY_BACKGROUND_ACTIVE', 'CONTROL_SECONDARY_BACKGROUND_DEFAULT'], '#6d6f78')
    const fg = useColor(['CONTROL_SECONDARY_TEXT_DEFAULT', 'INTERACTIVE_TEXT_ACTIVE', 'WHITE'], '#ffffff')
    const spin = useRef(new Animated.Value(0)).current
    const [busy, setBusy] = useState(false)
    const turn = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh activities"
            disabled={busy}
            onPress={() => {
                setBusy(true)
                spin.setValue(0)
                Animated.timing(spin, { toValue: 1, duration: 700, useNativeDriver: true }).start()
                onRefresh()
                    .catch(() => {})
                    .finally(() => setBusy(false))
            }}
            style={({ pressed }: any) => ({ height: 40, width: 40, borderRadius: 999, backgroundColor: pressed ? bgPressed : bg, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.6 : 1 })}
        >
            <Animated.View style={{ transform: [{ rotate: turn }] }}>
                <Icon name="RefreshIcon" alt={['RetryIcon']} size={20} color={fg} />
            </Animated.View>
        </Pressable>
    )
}

const num = (v: any, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function Card({ a, why, blockOn, blockType, onChange, onRemove }: { a: Activity; why: Why; blockOn: Why; blockType: (t: number) => Why; onChange: (a: Activity) => void; onRemove: () => void }) {
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TextInput, Button, Text } = Design as any
    const [open, setOpen] = useState(false)
    const [adding, setAdding] = useState(false)
    // 펼침 화살표 돌리기
    const turn = useRef(new Animated.Value(0)).current
    useEffect(() => {
        Animated.spring(turn, { toValue: open ? 1 : 0, stiffness: 300, damping: 26, mass: 1, useNativeDriver: true }).start()
    }, [open])
    const set = (patch: Partial<Activity>) => onChange({ ...a, ...patch })
    // 숫자만 (ID 처럼 긴 숫자는 글자로 둔다. Number 로 바꾸면 끝자리가 뭉개진다)
    const digits = (v: string) => v.replace(/[^0-9]/g, '')
    const muted = useColor(['INTERACTIVE_TEXT_DEFAULT', 'INTERACTIVE_NORMAL', 'TEXT_MUTED'], '#b5bac1')
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
    // 버튼은 2개가 될 때까지 + Add 에 계속 남는다
    const left = FIELDS.filter(([k]) => (k === 'buttons' ? (a.buttons ?? []).length < 2 : !shown.includes(k)))
    const add = (k: FieldKey) => {
        animate()
        setAdding(false)
        set({
            fields: shown.includes(k) ? shown : [...shown, k],
            ...(k === 'time' ? { use_timestamps: true } : {}),
            ...(k === 'status' ? { status_display: a.status_display ?? 0 } : {}),
            ...(k === 'buttons' ? { buttons: [...(a.buttons ?? []), { label: '', url: '' }] } : {}),
        })
    }
    const remove = (k: FieldKey) => {
        animate()
        const patch: any = { fields: shown.filter(f => f !== k) }
        if (k === 'time') patch.use_timestamps = false
        else if (k === 'buttons') patch.buttons = []
        else if (k === 'party') Object.assign(patch, { party_size: 0, party_max: 0 })
        else if (k === 'status') patch.status_display = undefined
        else if (k !== 'application_id') patch[k] = ''
        set(patch)
    }
    const typeName = TYPES.find(([v]) => v === a.type)?.[1] ?? 'Playing'
    const showing = !!a.enabled && !why
    // 켜진 활동은 테마의 강조색을 아주 옅게 덮어 구분한다
    const radius = num(T()?.radii?.lg, 16)
    // 켜짐 색은 서서히 들어오고 빠진다
    const lit = useRef(new Animated.Value(showing ? 1 : 0)).current
    useEffect(() => {
        Animated.timing(lit, { toValue: showing ? 1 : 0, duration: 220, useNativeDriver: true }).start()
    }, [showing])
    const tint = alpha(useColor(['CONTROL_PRIMARY_BACKGROUND_DEFAULT', 'BACKGROUND_BRAND', 'TEXT_BRAND'], '#5865f2'), 0.1)
    return (
        <View>
            <View style={{ borderRadius: radius, overflow: 'hidden' }}>
                <TableRowGroup>
                    <TableRow
                        label={a.name || 'Activity'}
                        trailing={
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <DeleteButton onDelete={onRemove} />
                                <Animated.View style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}>
                                    <TableRowAssetIcon name="ChevronSmallDownIcon" />
                                </Animated.View>
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
                            <TableSwitchRow label="Show this" value={showing} onValueChange={(enabled: boolean) => (animate(), set({ enabled }))} />
                        </Blocked>
                    ) : null}
                    {open ? (
                        <View style={{ padding: 12 }}>
                            <Stack spacing={10}>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                    {TYPES.map(([v, label]) => (
                                        <Blocked key={v} text={a.type === v ? undefined : blockType(v)?.text}>
                                            <Button size="sm" text={label} variant={a.type === v ? 'primary' : 'secondary'} onPress={() => (animate(), set({ type: v }))} />
                                        </Blocked>
                                    ))}
                                </View>
                                {input('Name', 'name', 'Spotify')}
                                {a.type === STREAMING ? input('Stream link', 'url', 'https://twitch.tv/…') : null}
                                {shown.map(k => {
                                    if (k === 'time')
                                        return (
                                            <Stack key={k} spacing={10}>
                                                {input('Start (ms, 0 = when Discord opened)', 'start', '0', 'number', () => remove(k))}
                                                {input('Length in minutes (0 = elapsed time)', 'length_min', '0', 'number')}
                                                <Button size="sm" variant="secondary" text="Start the time from now" onPress={() => set({ start: Date.now() })} />
                                            </Stack>
                                        )
                                    if (k === 'buttons') {
                                        const list = a.buttons?.length ? a.buttons : [{ label: '', url: '' }]
                                        const setBtn = (i: number, patch: Partial<{ label: string; url: string }>) => set({ buttons: list.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
                                        const dropBtn = (i: number) => {
                                            animate()
                                            const next = list.filter((_, j) => j !== i)
                                            if (next.length) set({ buttons: next })
                                            else remove('buttons')
                                        }
                                        return (
                                            <Stack key={k} spacing={10}>
                                                {list.map((b, i) => (
                                                    <View key={i}>
                                                        <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 8 }}>
                                                            {`Button ${i + 1}`}
                                                        </Text>
                                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                            <View style={{ flex: 1 }}>
                                                                <Stack spacing={8}>
                                                                    <TextInput value={b.label} placeholder="Button text" onChange={(v: string) => setBtn(i, { label: v })} />
                                                                    <TextInput value={b.url} placeholder="https://" autoCapitalize="none" keyboardType="url" onChange={(v: string) => setBtn(i, { url: v })} />
                                                                </Stack>
                                                            </View>
                                                            <Pressable accessibilityRole="button" accessibilityLabel="Remove" hitSlop={10} onPress={() => dropBtn(i)} style={{ padding: 6, marginLeft: 6 }}>
                                                                <Icon name="XSmallIcon" alt={['XLargeIcon', 'CloseSmallIcon', 'CircleXIcon']} color={muted} />
                                                            </Pressable>
                                                        </View>
                                                    </View>
                                                ))}
                                            </Stack>
                                        )
                                    }
                                    if (k === 'party')
                                        return (
                                            <Stack key={k} spacing={10}>
                                                {input('Party, people now', 'party_size', '1', 'number', () => remove(k))}
                                                {input('Party, max people', 'party_max', '4', 'number')}
                                            </Stack>
                                        )
                                    if (k === 'status')
                                        return (
                                            <View key={k}>
                                                <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 8 }}>
                                                    Status display
                                                </Text>
                                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                                        {(
                                                            [
                                                                [0, 'Name'],
                                                                [1, 'State'],
                                                                [2, 'Details'],
                                                            ] as Array<[number, string]>
                                                        ).map(([v, label]) => (
                                                            <Button key={v} size="sm" text={label} variant={(a.status_display ?? 0) === v ? 'primary' : 'secondary'} onPress={() => (animate(), set({ status_display: v }))} />
                                                        ))}
                                                    </View>
                                                    <Pressable accessibilityRole="button" accessibilityLabel="Remove" hitSlop={10} onPress={() => remove(k)} style={{ padding: 6, marginLeft: 6 }}>
                                                        <Icon name="XSmallIcon" alt={['XLargeIcon', 'CloseSmallIcon', 'CircleXIcon']} color={muted} />
                                                    </Pressable>
                                                </View>
                                            </View>
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
                <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tint, opacity: lit }} />
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
    // 설정 화면 바탕색 (떠 있는 Add activity 뒤에 깐다). 색 칸을 띄워 재 보니 화면 배경은 BACKGROUND_SURFACE_HIGH
    const pageBg = useColor(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_BASE_LOW'], '#000000')
    // 켜져 있고 마지막으로 적용한 뒤 바뀐 게 있을 때만 Apply 를 보여 준다
    const [, tick] = useState(0)
    const dirty = on && appliedSig !== undefined && signature(items) !== appliedSig
    const wasDirty = useRef(dirty)
    if (wasDirty.current !== dirty) {
        wasDirty.current = dirty
        animate()
    }
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
                            animate()
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
            <View style={{ paddingVertical: 8, marginHorizontal: -16, paddingHorizontal: 16, backgroundColor: pageBg }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    {dirty ? (
                        <View style={{ flex: 1 }}>
                            <Button
                                size="md"
                                variant="primary"
                                text="Apply"
                                onPress={() => {
                                    setList(items, true)
                                    apply()
                                        .catch(() => {})
                                        .finally(() => tick(n => n + 1))
                                }}
                            />
                        </View>
                    ) : null}
                    <View style={{ flex: 1 }}>
                        <Button size="md" variant="secondary" text="Add activity" onPress={() => (animate(), setItems(x => [...x, newActivity({ application_id: randomAppId() })]))} />
                    </View>
                    {on ? (
                        <RefreshButton
                            onRefresh={async () => {
                                setList(items, true)
                                clearAll()
                                // 디스코드가 내린 것을 받아들일 틈을 준 뒤 다시 보낸다
                                await new Promise(r => setTimeout(r, 600))
                                await apply()
                                tick(n => n + 1)
                            }}
                        />
                    ) : null}
                </View>
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
