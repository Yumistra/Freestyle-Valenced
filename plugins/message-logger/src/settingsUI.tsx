import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { useEffect, useLayoutEffect, useState } from 'react'
import { LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { CompanionGroup, sendCompanion, useWatchStatus } from './companion'
import { FilterSettings } from './filtersUI'
import { clearAll, expire } from './logger'
import { LOGS_ROUTE, palette } from './logs'
import { SERVERS_ROUTE } from './servers'
import { bindIfNone, events, KEEP_OPTIONS, logs, onChange, seen, setSettings, settings, type Settings } from './store'
import { exportLogs, importLogs } from './transfer'

/**
 * 설정: 첫 화면은 저장 현황, 로그 보기, 그룹 목록. 그룹마다 눌러서 들어가는 화면.
 * (값은 그대로, 자리만 나눴다)
 */

const PARENT = 'yumistra.message-logger'
const routeOf = (key: string) => `${PARENT}.group.${key}`

/** 색 고르기 창에 보이는 추천 색 */
const SUGGESTED = [0xf23f43, 0xff7a45, 0xf0b232, 0x23a55a, 0x00a8fc, 0x5865f2, 0xb45cf6, 0xeb459e, 0x949ba4]
const PICKER = 'modules/color_picker/native/showCustomColorPickerActionSheet.tsx'

const toInt = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined)
const toHex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`

/** 디스코드의 색 고르기 창 (프로필 테마 색과 같은 것). 못 찾으면 false */
function openPicker(color: number, onPick: (hex: string) => void): boolean {
    let mod: any
    try {
        const un = getModuleWithImportedPath(PICKER, (m: any) => (mod = m)) as any
        if (typeof un === 'function') un()
    } catch {}
    const show = mod?.default ?? mod?.showCustomColorPickerActionSheet
    if (typeof show !== 'function') return false
    try {
        show({ color, suggestedColors: SUGGESTED, onSelect: (c: number) => onPick(toHex(c)) })
        return true
    } catch {
        return false
    }
}

/** 색 한 줄: 누르면 디스코드 색 고르기 창. 고른 색이 있으면 테마 색으로 되돌리는 줄도 */
function ColorRow({ label, value, theme, onPick }: { label: string; value: string; theme: string; onPick: (v: string) => void }) {
    const { TableRow, Text } = Design as any
    const [fallback, setFallback] = useState(false)
    const shown = value || theme
    const swatch = <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: shown, borderWidth: 1, borderColor: 'rgba(128,128,128,0.4)' }} />
    return (
        <>
            <TableRow label={label} trailing={swatch} onPress={() => openPicker(toInt(value) ?? toInt(theme) ?? SUGGESTED[0], onPick) || setFallback(v => !v)} />
            {fallback ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
                    {SUGGESTED.map(n => (
                        <Pressable key={n} accessibilityLabel={`${label} ${toHex(n)}`} onPress={() => (onPick(toHex(n)), setFallback(false))} style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: toHex(n), borderWidth: value === toHex(n) ? 3 : 0, borderColor: '#ffffff' }} />
                    ))}
                </View>
            ) : null}
            {value ? (
                <TableRow
                    label={
                        <Text variant="text-md/medium" color="text-link">
                            Use theme color
                        </Text>
                    }
                    onPress={() => onPick('')}
                />
            ) : null}
        </>
    )
}

/** 설정이 바뀌면 다시 그리고, 바꾸는 함수를 준다 */
function useSettings() {
    const [, force] = useState(0)
    useEffect(() => onChange(() => force(n => n + 1)) as any, [])
    const set = (patch: Partial<Settings>) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        // 알림 기억하기를 끄면 알림으로만 알던 메시지도 잊는다
        if (patch.rememberPushes === false) {
            const sn = seen() as any
            for (const k of Object.keys(sn)) if (sn[k]?.p) delete sn[k]
        }
        setSettings(patch)
        force(n => n + 1)
    }
    return { s: settings(), set }
}

function useNav(): any {
    try {
        return (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
}

function Page({ children }: { children: any }) {
    const { Stack } = Design as any
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Stack spacing={24}>{children}</Stack>
        </ScrollView>
    )
}

// ── 그룹 화면들 ─────────────────────────────────────────────────────────

function WhatToLog() {
    const { s, set } = useSettings()
    const { TableRowGroup, TableSwitchRow } = Design as any
    return (
        <Page>
            <TableRowGroup title="Messages">
                <TableSwitchRow icon={<TableRowAssetIcon name="TrashIcon" />} label="Deleted messages" value={s.logDeletes} onValueChange={(logDeletes: boolean) => set({ logDeletes })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="PencilIcon" />} label="Edited messages" value={s.logEdits} onValueChange={(logEdits: boolean) => set({ logEdits })} />
                <TableSwitchRow label="Log DMs and group DMs" value={s.logDms} onValueChange={(logDms: boolean) => set({ logDms })} />
                <TableSwitchRow label="Ignore my messages" value={s.ignoreSelf} onValueChange={(ignoreSelf: boolean) => set({ ignoreSelf })} />
                <TableSwitchRow label="Ignore bots" value={s.ignoreBots} onValueChange={(ignoreBots: boolean) => set({ ignoreBots })} />
            </TableRowGroup>
            <TableRowGroup title="Other changes">
                <TableSwitchRow icon={<TableRowAssetIcon name="ReactionIcon" />} label="Removed reactions" value={s.logReactions} onValueChange={(logReactions: boolean) => set({ logReactions })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="TextIcon" />} label="Deleted channels and threads" value={s.logChannels} onValueChange={(logChannels: boolean) => set({ logChannels })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="UserIcon" />} label="Profile changes" value={s.logProfiles} onValueChange={(logProfiles: boolean) => set({ logProfiles })} />
            </TableRowGroup>
        </Page>
    )
}

function WhoAndWhere() {
    const { s, set } = useSettings()
    const nav = useNav()
    const { TableRowGroup, TableSwitchRow, TableRow } = Design as any
    return (
        <Page>
            <TableRowGroup title="Servers">
                <TableSwitchRow label="Only log chosen servers" value={s.onlyServersOn} onValueChange={(onlyServersOn: boolean) => set({ onlyServersOn })} />
                {s.onlyServersOn ? <TableRow icon={<TableRowAssetIcon name="ServerIcon" />} label="Choose servers" subLabel={`${(s.onlyServers ?? []).length} chosen`} arrow onPress={() => nav?.navigate?.(SERVERS_ROUTE)} /> : null}
            </TableRowGroup>
            <FilterSettings set={set} />
        </Page>
    )
}

function InChat() {
    const { s, set } = useSettings()
    const { TableRowGroup, TableSwitchRow } = Design as any
    return (
        <Page>
            <TableRowGroup title="Edits">
                <TableSwitchRow label="Show previous versions" value={s.showHistoryInChat} onValueChange={(showHistoryInChat: boolean) => set({ showHistoryInChat })} />
                <TableSwitchRow label="Show edit time" value={s.showEditTime} onValueChange={(showEditTime: boolean) => set({ showEditTime })} />
            </TableRowGroup>
            <TableRowGroup title="Deletions">
                <TableSwitchRow label="Show deletion time" value={s.showDeleteTime} onValueChange={(showDeleteTime: boolean) => set({ showDeleteTime })} />
                <TableSwitchRow label="Color deleted usernames" value={s.colorDeletedNames} onValueChange={(colorDeletedNames: boolean) => set({ colorDeletedNames })} />
            </TableRowGroup>
            <TableRowGroup title="Time">
                <TableSwitchRow label="Show seconds" value={s.seconds} onValueChange={(seconds: boolean) => set({ seconds })} />
                <TableSwitchRow label="Use a 12-hour clock" value={s.clock12} onValueChange={(clock12: boolean) => set({ clock12 })} />
            </TableRowGroup>
            <TableRowGroup title="Colors">
                <ColorRow label="Deleted messages" value={s.deletedColor} theme={palette().danger} onPick={deletedColor => set({ deletedColor })} />
                <ColorRow label="Edited messages" value={s.editedColor} theme={palette().muted} onPick={editedColor => set({ editedColor })} />
            </TableRowGroup>
        </Page>
    )
}

function Notifications() {
    const { s, set } = useSettings()
    const { st, missing, send } = useWatchStatus()
    const { TableRowGroup, TableSwitchRow, TableRow } = Design as any
    return (
        <Page>
            <TableRowGroup title="While Discord runs">
                <TableSwitchRow icon={<TableRowAssetIcon name="BellIcon" />} label="Notify when a DM or mention is deleted" value={s.notifyDeletes} onValueChange={(notifyDeletes: boolean) => set({ notifyDeletes })} />
            </TableRowGroup>
            <TableRowGroup title="While Discord is closed">
                {st?.hasToken && !missing ? (
                    <>
                        <TableSwitchRow
                            icon={<TableRowAssetIcon name="BellIcon" />}
                            label="Notify when a DM or mention is deleted"
                            subLabel={st?.notifPermission === false && st?.notify ? 'Blocked' : undefined}
                            value={!!st?.notify}
                            onValueChange={(notify: boolean) => send('setup', { notify })}
                        />
                        {st?.notifPermission === false && st?.notify ? <TableRow label="Allow notifications for Discord Watch" arrow onPress={() => send('setup', { notify: true, enabled: !!st?.enabled })} /> : null}
                    </>
                ) : (
                    <TableRow label="Discord Watch is not set up" />
                )}
            </TableRowGroup>
        </Page>
    )
}

function WhileClosed() {
    const { s, set } = useSettings()
    const { TableRowGroup, TableSwitchRow } = Design as any
    return (
        <Page>
            <CompanionGroup />
            <TableRowGroup title="Without the app">
                <TableSwitchRow icon={<TableRowAssetIcon name="BellIcon" />} label="Remember notifications" value={s.rememberPushes} onValueChange={(rememberPushes: boolean) => set({ rememberPushes })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="ClockIcon" />} label="Find changes when you come back" value={s.detectAway} onValueChange={(detectAway: boolean) => set({ detectAway })} />
            </TableRowGroup>
        </Page>
    )
}

function Storage() {
    const { s, set } = useSettings()
    const { TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, Stack, Text } = Design as any
    const [msg, setMsg] = useState('')
    const run = (f: () => Promise<string>) =>
        f()
            .then(setMsg)
            .catch((e: any) => setMsg(`Failed: ${e?.message ?? e}`))
    return (
        <Page>
            <TableRadioGroup
                title="Keep logs for"
                defaultValue={String(s.keepHours)}
                onChange={(v: string) => {
                    set({ keepHours: Number(v) })
                    expire()
                }}
            >
                {KEEP_OPTIONS.map(([h, label]) => (
                    <TableRadioRow key={h} label={label} value={String(h)} />
                ))}
            </TableRadioGroup>
            <TableRowGroup title="Attachments">
                <TableSwitchRow icon={<TableRowAssetIcon name="ImageIcon" />} label="Save deleted attachments" value={s.saveAttachments} onValueChange={(saveAttachments: boolean) => set({ saveAttachments })} />
            </TableRowGroup>
            <Stack spacing={8}>
                <NavButton icon="DownloadIcon" label="Export logs" arrow={false} onPress={() => run(async () => `Saved to ${await exportLogs()}`)} />
                <NavButton icon="UploadIcon" label="Import logs" arrow={false} onPress={() => run(async () => `Added ${await importLogs()} log(s)`)} />
                {msg ? <Text variant="text-sm/medium" color="text-muted">{msg}</Text> : null}
            </Stack>
            <Button text="Clear all logs" variant="destructive" size="md" disabled={!Object.keys(logs()).length && !events().length} onPress={() => clearAll()} />
        </Page>
    )
}

// ── 그룹 목록 ───────────────────────────────────────────────────────────

interface Group {
    key: string
    title: string
    icon: string
    screen: () => any
}

const GROUPS: Group[] = [
    {
        key: 'log',
        title: 'What to log',
        icon: 'ChatXIcon',
        screen: WhatToLog,
    },
    {
        key: 'who',
        title: 'Who and where',
        icon: 'FiltersHorizontalIcon',
        screen: WhoAndWhere,
    },
    {
        key: 'chat',
        title: 'In chat',
        icon: 'PencilIcon',
        screen: InChat,
    },
    {
        key: 'notify',
        title: 'Notifications',
        icon: 'BellIcon',
        screen: Notifications,
    },
    {
        key: 'closed',
        title: 'While Discord is closed',
        icon: 'ClockIcon',
        screen: WhileClosed,
    },
    {
        key: 'storage',
        title: 'Storage',
        icon: 'DownloadIcon',
        screen: Storage,
    },
]

/**
 * 그룹 화면 컴포넌트는 그룹마다 한 번만 만든다.
 * (화면을 열 때마다 새로 만들면, 제목을 바꿀 때 내비게이터가 다시 그리면서 또 새 화면이 되고,
 *  그게 끝없이 반복돼 화면이 멈춘다)
 */
const screens = new Map<string, any>()
function groupScreen(g: Group) {
    const made = screens.get(g.key)
    if (made) return made
    const C = makeScreen(g)
    screens.set(g.key, C)
    return C
}

function makeScreen(g: Group) {
    return function GroupScreen({ navigation }: { navigation?: any }) {
        useLayoutEffect(() => {
            try {
                navigation?.setOptions?.({ title: g.title })
            } catch {}
        }, [])
        const Screen = g.screen
        return <Screen />
    }
}

/** 그룹 화면 경로를 등록한다 (설정 목록에는 안 보인다) */
export function registerGroups(cleanup: (...f: any[]) => void) {
    for (const g of GROUPS) {
        try {
            cleanup(
                registerSettingsItem(routeOf(g.key), {
                    type: 'route',
                    parent: PARENT,
                    unsearchable: true,
                    usePredicate: () => false,
                    useTitle: () => g.title,
                    screen: { route: routeOf(g.key), getComponent: () => groupScreen(g) },
                } as any),
            )
        } catch {}
    }
    try {
        refreshSettings()
    } catch {}
}

/** 디스코드 Row Button (카드 모양 큰 버튼), 없으면 표 줄 */
function NavButton({ icon, label, sub, onPress, arrow = true }: { icon: string; label: string; sub?: string; onPress: () => void; arrow?: boolean; key?: string }) {
    const { RowButton, TableRow } = Design as any
    if (RowButton) return <RowButton icon={<TableRowAssetIcon name={icon} />} label={label} subLabel={sub} arrow={arrow} onPress={onPress} />
    return <TableRow icon={<TableRowAssetIcon name={icon} />} label={label} subLabel={sub} arrow={arrow} onPress={onPress} />
}

/** 숫자들: 디스코드 Tag Group (읽기 전용 태그), 없으면 글 */
function Counts({ items }: { items: string[] }) {
    const { TagGroup, Text } = Design as any
    if (TagGroup) return <TagGroup label="Logs" items={items.map((label, i) => ({ id: String(i), label }))} />
    return (
        <Text variant="text-sm/medium" color="text-muted">
            {items.join(', ')}
        </Text>
    )
}

export function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bindIfNone(api.jsonStorage)
    useSettings()
    const nav = useNav()
    const all = Object.values(logs())
    const ev = events()
    const deleted = all.filter(e => e.d).length
    const edited = all.filter(e => !e.d && e.e?.length).length
    const away = all.filter(e => e.away).length
    const { Stack } = Design as any
    return (
        <Page>
            <Stack spacing={12}>
                <Counts
                    items={[
                        `${deleted} deleted`,
                        `${edited} edited`,
                        `${ev.filter(e => e.k === 'r').length} reactions`,
                        `${ev.filter(e => e.k === 'c').length} channels`,
                        `${ev.filter(e => e.k === 'p').length} profiles`,
                        `${away} while away`,
                        `${Object.keys(seen()).length} remembered`,
                    ]}
                />
                <NavButton icon="ChatXIcon" label="View logs" onPress={() => nav?.navigate?.(LOGS_ROUTE)} />
            </Stack>
            <Stack spacing={8}>
                {GROUPS.map(g => (
                    <NavButton key={g.key} icon={g.icon} label={g.title} onPress={() => nav?.navigate?.(routeOf(g.key))} />
                ))}
            </Stack>
        </Page>
    )
}

export { sendCompanion }
