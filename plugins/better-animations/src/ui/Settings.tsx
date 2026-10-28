import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import {
    AMOUNT_RANGE,
    decodeEasing,
    DIRECTIONS,
    EASING_BEZIERS,
    EASING_STYLES,
    EASING_TYPES,
    EASINGS,
    EFFECTS,
    easingLabel,
    encodeEasing,
    exitChoices,
    isCustomEasing,
    type Position,
    SAME_ID,
    type CustomEasing,
    type EasingKey,
    type ModuleKey,
} from '../effects'
import { pingNative, VERSION } from '../native'
import { bindStorage, DEFAULTS, hasStorage, save, settings, status, type ModuleSettings, type Settings } from '../settings'
import { palette } from './colors'
import Preview from './Preview'

const D = () => Design as any

interface ModuleInfo {
    title: string
    /** 네이티브 전환이라 속도·움직임을 못 바꿈 */
    native?: boolean
    /** 고를 수 있는 움직임 (없으면 전부 + 직접 만들기) */
    easings?: EasingKey[]
    /** 나갈 때 효과를 따로 고를 수 있음 */
    exit?: boolean
    /** 방향·위치를 고를 수 있음 */
    move?: boolean
    /** 움직임(곡선)을 고를 수 없음 (효과마다 정해져 있음) */
    noEasing?: boolean
    /** 바꾼 뒤 앱을 다시 시작해야 확실히 적용됨 */
    restart?: boolean
    test?: () => void
}

let seq = 0

const LAYOUT_EASINGS: EasingKey[] = ['out', 'smooth', 'linear', 'spring', 'back']

const MODULES: Record<ModuleKey, ModuleInfo> = {
    messages: {
        title: 'Messages',
        exit: true,
        move: true,
    },
    lists: {
        title: 'Lists',
        noEasing: true,
    },
    stack: { title: 'Screens', exit: true, move: true },
    push: {
        title: 'Screens (Android)',
        native: true,
    },
    modal: { title: 'Modals (Android)', native: true },
    panel: {
        title: 'Panels',
        restart: true,
    },
    channelList: {
        title: 'Channel list',
    },
    servers: {
        title: 'Server switch',
        exit: true,
        move: true,
    },
    folder: { title: 'Server folders', exit: true, move: true },
    subtle: {
        title: 'Subtle',
        easings: ['smooth', 'spring', 'back', 'bounce', 'elastic'],
    },
    media: { title: 'Media', exit: true, move: true },
    press: { title: 'Buttons', easings: ['spring', 'out', 'smooth', 'back', 'bounce', 'elastic'] },
    sheet: { title: 'Sheets' },
    menu: { title: 'Menus', exit: true, move: true },
    alert: {
        title: 'Alerts',
        exit: true,
        move: true,
        test: () => {
            const { AlertModal, AlertActionButton, Text } = D()
            AlertActionCreators.openAlert(
                `better-animations-test-${seq++}`,
                <AlertModal
                    title="Better Animations"
                    content={<Text variant="text-md/normal">Better Animations</Text>}
                    actions={<AlertActionButton text="Close" variant="primary" />}
                />,
            )
        },
    },
    backdrop: {
        title: 'Backdrop',
        easings: ['out', 'smooth', 'linear', 'expo'],
    },
    notice: {
        title: 'Notifications',
        move: true,
    },
    toast: {
        title: 'Toasts',
        exit: true,
        move: true,
        test: () => {
            try {
                ToastActionCreators.open(`better-animations-${Date.now()}-${seq++}`, { text: 'Better Animations' })
            } catch {}
        },
    },
}

// ── 작은 부품 ────────────────────────────────────────────────────

function Chips<T extends string>({ items, value, onChange }: { items: Array<{ id: T; label: string }>; value: T; onChange(v: T): void }) {
    const { Text } = D()
    const c = useMemo(palette, [])
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
            {items.map(item => {
                const on = item.id === value
                return (
                    <Pressable
                        key={item.id}
                        onPress={() => onChange(item.id)}
                        style={{
                            paddingHorizontal: 14,
                            height: 34,
                            borderRadius: 17,
                            justifyContent: 'center',
                            backgroundColor: on ? c.brand : c.surface,
                            borderWidth: 1,
                            borderColor: on ? c.brand : c.border,
                        }}
                    >
                        <Text variant="text-sm/semibold" style={{ color: on ? '#ffffff' : c.text }}>
                            {item.label}
                        </Text>
                    </Pressable>
                )
            })}
        </ScrollView>
    )
}

/** 기준 위치: 자동 + 3×3 칸 */
const ORIGIN_ARROWS: Record<string, string> = { tl: '↖', t: '↑', tr: '↗', l: '←', c: '○', r: '→', bl: '↙', b: '↓', br: '↘' }
const ORIGIN_ROWS: Position[][] = [
    ['tl', 't', 'tr'],
    ['l', 'c', 'r'],
    ['bl', 'b', 'br'],
]

function OriginPicker({ value, onChange }: { value: Position; onChange(v: Position): void }) {
    const { Text } = D()
    const c = useMemo(palette, [])
    const auto = value === 'auto'
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Pressable
                onPress={() => onChange('auto')}
                style={{ paddingHorizontal: 14, height: 34, borderRadius: 17, justifyContent: 'center', backgroundColor: auto ? c.brand : c.surface, borderWidth: 1, borderColor: auto ? c.brand : c.border }}
            >
                <Text variant="text-sm/semibold" style={{ color: auto ? '#ffffff' : c.text }}>
                    Auto
                </Text>
            </Pressable>
            <View style={{ gap: 4, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: c.border }}>
                {ORIGIN_ROWS.map((row, i) => (
                    <View key={i} style={{ flexDirection: 'row', gap: 4 }}>
                        {row.map(id => {
                            const on = id === value
                            return (
                                <Pressable
                                    key={id}
                                    onPress={() => onChange(id)}
                                    style={{ width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.brand : c.surface, borderWidth: 1, borderColor: on ? c.brand : c.border }}
                                >
                                    <Text variant="text-sm/bold" style={{ color: on ? '#ffffff' : c.muted }}>
                                        {ORIGIN_ARROWS[id]}
                                    </Text>
                                </Pressable>
                            )
                        })}
                    </View>
                ))}
            </View>
        </View>
    )
}

function Label({ children, trailing }: { children: string; trailing?: string }) {
    const { Text } = D()
    return (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="text-sm/semibold" color="text-muted">
                {children}
            </Text>
            {trailing ? (
                <Text variant="text-sm/semibold" color="text-muted">
                    {trailing}
                </Text>
            ) : null}
        </View>
    )
}

function Field({ label, trailing, children }: { label: string; trailing?: string; children: any }) {
    return (
        <View style={{ gap: 8 }}>
            <Label trailing={trailing}>{label}</Label>
            {children}
        </View>
    )
}

/** 슬라이더 (움직이는 동안은 숫자만, 손을 떼면 저장) */
function SliderField({
    label,
    value,
    min,
    max,
    step,
    format,
    presets,
    onCommit,
}: {
    label: string
    value: number
    min: number
    max: number
    step: number
    format(v: number): string
    presets: number[]
    onCommit(v: number): void
}) {
    const { Slider } = D()
    const [v, setV] = useState(value)
    useEffect(() => setV(value), [value])
    const round = (x: number) => Math.round(x / step) * step
    return (
        <Field label={label} trailing={format(v)}>
            {Slider ? (
                <Slider
                    value={v}
                    step={step}
                    // 디스코드 버전마다 이름이 다르다 (351: minimumValue·onSlidingComplete, 352+: minValue·onChangeEnd)
                    minimumValue={min}
                    maximumValue={max}
                    minValue={min}
                    maxValue={max}
                    onValueChange={(x: unknown) => typeof x === 'number' && setV(round(x))}
                    onChange={(x: unknown) => typeof x === 'number' && setV(round(x))}
                    onSlidingComplete={(x: unknown) => typeof x === 'number' && onCommit(round(x))}
                    onChangeEnd={(x: unknown) => typeof x === 'number' && onCommit(round(x))}
                />
            ) : (
                <Chips
                    items={presets.map(n => ({ id: String(n), label: format(n) }))}
                    value={String(value)}
                    onChange={x => {
                        setV(Number(x))
                        onCommit(Number(x))
                    }}
                />
            )}
        </Field>
    )
}

function SwitchRow({ label, subLabel, value, onChange }: { label: string; subLabel?: string; value: boolean; onChange(v: boolean): void }) {
    const { TableRowGroup, TableSwitchRow } = D()
    return (
        <TableRowGroup>
            <TableSwitchRow label={label} subLabel={subLabel} value={value} onValueChange={onChange} />
        </TableRowGroup>
    )
}

/** BetterDiscord Easing 처럼: 종류 → 방향 → 모양 → 세기 */
function EasingEditor({ value, onChange }: { value: EasingKey; onChange(v: EasingKey): void }) {
    const c = useMemo(palette, [])
    const e = decodeEasing(value)
    const set = (patch: Partial<CustomEasing>) => {
        const next = { ...e, ...patch }
        if (patch.type && patch.type !== e.type && patch.type !== 'linear' && patch.type !== 'ease') next.amount = AMOUNT_RANGE[patch.type].def
        onChange(encodeEasing(next))
    }
    const range = e.type === 'back' || e.type === 'elastic' || e.type === 'steps' ? AMOUNT_RANGE[e.type] : undefined
    return (
        <View style={{ gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border }}>
            <Field label="Type">
                <Chips items={EASING_TYPES} value={e.type} onChange={type => set({ type })} />
            </Field>
            {e.type !== 'linear' && e.type !== 'steps' && (
                <Field label="Direction">
                    <Chips items={EASING_BEZIERS} value={e.bezier} onChange={bezier => set({ bezier })} />
                </Field>
            )}
            {e.type === 'ease' && (
                <Field label="Style">
                    <Chips items={EASING_STYLES} value={e.style} onChange={style => set({ style })} />
                </Field>
            )}
            {range && (
                <SliderField
                    label={e.type === 'steps' ? 'Steps' : e.type === 'back' ? 'Overshoot' : 'Bounciness'}
                    value={e.amount}
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    format={v => (e.type === 'steps' ? `${Math.round(v)}` : v.toFixed(1))}
                    presets={e.type === 'steps' ? [3, 5, 8, 12] : [range.min, range.def, range.max]}
                    onCommit={amount => set({ amount })}
                />
            )}
        </View>
    )
}

// ── 모듈 카드 ────────────────────────────────────────────────────

/** 메시지 애니메이션(네이티브)이 안 될 때 이유 */
function nativeNotice(): string | undefined {
    if (status.native === false) return 'Native part not loaded. Restart Discord.'
    if (status.native !== true) return
    if (status.nativeVersion !== VERSION) return 'Restart Discord to finish updating.'
    if (status.nativeChat === false) return 'Chat list not found on this Discord version.'
}

function summaryOf(key: ModuleKey, m: ModuleSettings) {
    const effect = EFFECTS[key].find(e => e.id === m.effect)?.label ?? m.effect
    if (m.effect === 'default') return 'Default'
    if (key === 'lists' && m.effect !== 'default') return `${effect} · ${m.duration}ms`
    if (key === 'backdrop') return m.effect === 'solid' ? `Solid · ${Math.round((m.amount ?? 0.6) * 100)}%` : effect
    if (MODULES[key].native || m.effect === 'none') return effect
    return `${effect} · ${m.duration}ms · ${easingLabel(m.easing)}`
}

function ModuleCard({ id, value, open, onToggle, onChange, enabled }: { id: ModuleKey; value: ModuleSettings; open: boolean; onToggle(): void; onChange(next: ModuleSettings): void; enabled: boolean }) {
    const { Text, Button } = D()
    const c = useMemo(palette, [])
    const info = MODULES[id]
    const set = (patch: Partial<ModuleSettings>) => onChange({ ...value, ...patch })
    const custom = value.effect !== 'default' && value.effect !== 'none' && !info.native
    // 사진·동영상은 열기를 디스코드대로 두고 닫기만 바꿀 수도 있다
    const mediaExit = id === 'media' && !!value.exit && value.exit !== 'default'
    const showSpeed = (custom || mediaExit) && !(id === 'backdrop' && value.effect !== 'solid')
    const easingItems = info.easings ? EASINGS.filter(e => info.easings!.includes(e.id)) : [...EASINGS, { id: 'custom', label: 'Custom' }]
    const easingValue = isCustomEasing(value.easing) && !info.easings ? 'custom' : value.easing

    return (
        <View style={{ borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: open ? c.brandSoft : c.border, overflow: 'hidden', opacity: enabled ? 1 : 0.55 }}>
            <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="text-md/semibold">{info.title}</Text>
                    <Text variant="text-xs/medium" style={{ color: value.effect === 'default' ? c.muted : c.brand }}>
                        {summaryOf(id, value)}
                    </Text>
                </View>
                <Chevron open={open} />
            </Pressable>
            {open && (
                <View style={{ paddingHorizontal: 14, paddingBottom: 16, gap: 14 }}>
                    {id === 'messages' && nativeNotice() && (
                        <Text variant="text-xs/semibold" style={{ color: '#f23f43' }}>
                            {nativeNotice()}
                        </Text>
                    )}
                    <Preview module={id} settings={value} />
                    <Field label="Effect">
                        <Chips items={EFFECTS[id]} value={value.effect} onChange={effect => set({ effect })} />
                    </Field>
                    {info.exit && (custom || id === 'media') && (
                        <Field label="Exit">
                            <Chips items={exitChoices(id)} value={value.exit ?? SAME_ID} onChange={exit => set({ exit })} />
                        </Field>
                    )}
                    {id === 'backdrop' && value.effect === 'solid' && (
                        <SliderField
                            label="Opacity"
                            value={Math.round((value.amount ?? 0.6) * 100)}
                            min={0}
                            max={100}
                            step={5}
                            format={v => `${v}%`}
                            presets={[20, 40, 60, 80, 100]}
                            onCommit={v => set({ amount: v / 100 })}
                        />
                    )}
                    {showSpeed && (
                        <SliderField label="Duration" value={value.duration} min={100} max={1500} step={20} format={v => `${v}ms`} presets={[200, 300, 400, 600, 900]} onCommit={duration => set({ duration })} />
                    )}
                    {showSpeed && !info.noEasing && (
                        <Field label="Easing">
                            <Chips
                                items={easingItems}
                                value={easingValue}
                                onChange={(easing: string) => set({ easing: easing === 'custom' ? encodeEasing(decodeEasing(value.easing)) : easing })}
                            />
                        </Field>
                    )}
                    {showSpeed && !info.noEasing && easingValue === 'custom' && <EasingEditor value={value.easing} onChange={easing => set({ easing })} />}
                    {info.move && (custom || mediaExit) && (
                        <Field label="Direction">
                            <Chips items={DIRECTIONS} value={value.direction ?? 'auto'} onChange={direction => set({ direction })} />
                        </Field>
                    )}
                    {info.move && (custom || mediaExit) && (
                        <Field label="Origin">
                            <OriginPicker value={value.position ?? 'auto'} onChange={position => set({ position })} />
                        </Field>
                    )}
                    {id === 'lists' && custom && (
                        <SwitchRow label="Fresh view" value={!!value.always} onChange={always => set({ always })} />
                    )}
                    {id === 'servers' && custom && (
                        <SwitchRow label="Follow server position" value={value.follow !== false} onChange={follow => set({ follow })} />
                    )}
                    {id === 'stack' && custom && (
                        <SwitchRow label="Modals" value={value.modals !== false} onChange={modals => set({ modals })} />
                    )}
                    {id === 'messages' && custom && (
                        <SliderField
                            label="Stagger"
                            value={value.stagger ?? 30}
                            min={0}
                            max={150}
                            step={5}
                            format={v => `${v}ms`}
                            presets={[0, 20, 40, 80]}
                            onCommit={stagger => set({ stagger })}
                        />
                    )}
                    {id === 'messages' && custom && (
                        <SwitchRow label="On channel open" value={value.onOpen !== false} onChange={onOpen => set({ onOpen })} />
                    )}
                    {id === 'messages' && (
                        <SwitchRow
                            label="Shift"
                            value={value.shift !== false}
                            onChange={shift => set({ shift })}
                        />
                    )}
                    {id === 'messages' && value.shift !== false && (
                        <SliderField
                            label="Shift duration"
                            value={value.shiftDuration ?? 200}
                            min={80}
                            max={800}
                            step={20}
                            format={v => `${v}ms`}
                            presets={[120, 200, 320, 500]}
                            onCommit={shiftDuration => set({ shiftDuration })}
                        />
                    )}
                    {info.test && enabled && <Button text="Test" variant="secondary" size="sm" onPress={info.test} />}
                </View>
            )}
        </View>
    )
}

/** 펼침 표시 (› 를 돌려서) */
function Chevron({ open }: { open: boolean }) {
    const { Text } = D()
    return (
        <Text variant="text-lg/bold" color="text-muted" style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
            ›
        </Text>
    )
}

/** 묶음 제목 */
function Section({ title, children }: { title: string; children: any }) {
    const { Text } = D()
    return (
        <View style={{ gap: 8 }}>
            <Text variant="text-xs/bold" color="text-muted" style={{ marginLeft: 4, letterSpacing: 0.6 }}>
                {title.toUpperCase()}
            </Text>
            <View style={{ gap: 8 }}>{children}</View>
        </View>
    )
}

const SECTIONS: Array<[string, ModuleKey[]]> = [
    ['Chat', ['messages', 'media']],
    ['Screens', ['stack', 'push', 'modal', 'panel']],
    ['Lists', ['lists', 'channelList', 'servers', 'folder']],
    ['Popups', ['sheet', 'menu', 'alert', 'backdrop', 'toast', 'notice']],
    ['Other', ['press', 'subtle']],
]

function StatusRows() {
    const { Text } = D()
    const c = useMemo(palette, [])
    const [open, setOpen] = useState(false)
    const [, rerender] = useState(0)
    useEffect(() => {
        if (open) pingNative().then(() => rerender(n => n + 1))
    }, [open])
    const f = status.found
    const ok = (b: unknown) => (b ? 'ok' : 'missing')
    const rows: Array<[string, string]> = [
        ['Native', status.native === null ? '…' : status.native ? `loaded${status.nativeVersion ? ` · ${status.nativeVersion}` : ''}` : 'not loaded'],
        ['Native screens', status.nativeScreenHook ? `${status.nativePlayed}` : 'JS'],
        ['Chat list', status.nativeChat === null ? '…' : status.nativeChat ? 'ok' : 'missing'],
        ['Screens', `${status.screens} · ${status.screenExits} · ${status.nativeScreens}`],
        ['Stack', `${ok(f.stack)} · ${status.stack}`],
        ['Sheets', `${ok(f.sheets)} · ${status.sheets}`],
        ['Reanimated', `${ok(f.worklets)} · ${f.reanimated ? 'ready' : 'waiting'}`],
        ['Menus', `${status.menus}`],
        ['Alerts', `${status.alerts}`],
        ['Backdrops', `${status.backdrops}`],
        ['Toasts', `${status.toasts}`],
        ['Notifications', `${status.notices}`],
        ['Media', `${ok(f.media)} · ${status.media}`],
        ['Folders', `${status.folders}`],
        ['Buttons', `${ok(f.press)} · ${status.presses}`],
        ['Lists', `${Object.keys(f).filter(k => k.startsWith('list:')).map(k => k.slice(5)).join(', ') || 'missing'} · ${status.listCells}`],
        ['Channel list', `${ok(f.layout)} · ${ok(f.channelRows)} · ${ok(f.servers)} · ${status.layouts}`],
        ['Constants', status.constants.length ? status.constants.join(', ') : 'missing'],
    ]
    if (status.nativeProblems) rows.push(['Native problems', status.nativeProblems])
    if (status.lastError) rows.push(['Last error', status.lastError])
    return (
        <View style={{ borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, padding: 14, gap: 10 }}>
            <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="text-sm/semibold">Status</Text>
                <Chevron open={open} />
            </Pressable>
            {open &&
                rows.map(([k, v]) => (
                    <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                        <Text variant="text-xs/medium" color="text-muted">
                            {k}
                        </Text>
                        <Text variant="text-xs/medium" style={{ flexShrink: 1, textAlign: 'right', color: c.text }}>
                            {v}
                        </Text>
                    </View>
                ))}
        </View>
    )
}

function confirmReset(onConfirm: () => void) {
    const { AlertModal, AlertActionButton, Text } = D()
    AlertActionCreators.openAlert(
        `better-animations-reset-${seq++}`,
        <AlertModal
            title="Reset all?"
            content={<Text variant="text-md/normal">Every animation goes back to default.</Text>}
            actions={
                <>
                    <AlertActionButton text="Reset" variant="destructive" onPress={onConfirm} />
                    <AlertActionButton text="Cancel" variant="secondary" />
                </>
            }
        />,
    )
}

export default function SettingsPage({ api }: { api?: any }) {
    const { Stack, Text, TableRowGroup, TableSwitchRow, Button } = D()
    if (!hasStorage() && api?.jsonStorage) bindStorage(api.jsonStorage)
    const [s, setS] = useState<Settings>(settings)
    const [open, setOpen] = useState<ModuleKey | null>(null)

    const commit = (next: Settings) => {
        setS(next)
        save(next)
    }

    return (
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={16} style={{ padding: 16, paddingBottom: 48 }}>
                <TableRowGroup>
                    <TableSwitchRow
                        label="Enabled"
                        value={s.enabled}
                        onValueChange={(enabled: boolean) => commit({ ...s, enabled })}
                    />
                </TableRowGroup>

                <Section title="Scrolling">
                    <TableRowGroup>
                        <TableSwitchRow
                            label="iOS bounce"
                            subLabel="Lists stretch and spring back at their ends"
                            value={s.modules.messages.bounce !== false}
                            onValueChange={(bounce: boolean) => commit({ ...s, modules: { ...s.modules, messages: { ...s.modules.messages, bounce } } })}
                        />
                        {s.modules.messages.bounce !== false && (
                            <TableSwitchRow
                                label="Everywhere"
                                subLabel="Every scrolling list, not just the chat"
                                value={s.modules.messages.bounceAll !== false}
                                onValueChange={(bounceAll: boolean) => commit({ ...s, modules: { ...s.modules, messages: { ...s.modules.messages, bounceAll } } })}
                            />
                        )}
                    </TableRowGroup>
                </Section>

                {SECTIONS.map(([title, keys]) => (
                    <Section key={title} title={title}>
                        {keys.map(key => (
                            <ModuleCard
                                key={key}
                                id={key}
                                value={s.modules[key]}
                                enabled={s.enabled}
                                open={open === key}
                                onToggle={() => setOpen(open === key ? null : key)}
                                onChange={m => commit({ ...s, modules: { ...s.modules, [key]: m } })}
                            />
                        ))}
                    </Section>
                ))}

                <StatusRows />

                <Button text="Reset all" variant="destructive" size="md" onPress={() => confirmReset(() => commit({ ...DEFAULTS, modules: { ...DEFAULTS.modules } }))} />
            </Stack>
        </ScrollView>
    )
}
