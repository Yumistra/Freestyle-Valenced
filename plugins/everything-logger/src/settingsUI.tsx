import { rowIcon } from './icons'
import { Design } from '@valenced/discord/design'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { useEffect, useLayoutEffect, useState } from 'react'
import { LayoutAnimation, ScrollView, View } from 'react-native'
import { openColorPicker, SUGGESTED, toInt } from './colorPicker'
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

const PARENT = 'yumistra.everything-logger'
const routeOf = (key: string) => `${PARENT}.group.${key}`

/** 색 한 줄: 누르면 디스코드 색 고르기 창. 고른 색이 있으면 테마 색으로 되돌리는 줄도 */
function ColorRow({ label, value, theme, onPick }: { label: string; value: string; theme: string; onPick: (v: string) => void }) {
    const { TableRow, Text } = Design as any
    const shown = value || theme
    const swatch = <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: shown, borderWidth: 1, borderColor: 'rgba(128,128,128,0.4)' }} />
    return (
        <>
            <TableRow label={label} trailing={swatch} onPress={() => openColorPicker(toInt(value) ?? toInt(theme) ?? SUGGESTED[0], onPick)} />
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
                <TableSwitchRow icon={rowIcon('TrashIcon')} label="Deleted messages" value={s.logDeletes} onValueChange={(logDeletes: boolean) => set({ logDeletes })} />
                <TableSwitchRow icon={rowIcon('PencilIcon')} label="Edited messages" value={s.logEdits} onValueChange={(logEdits: boolean) => set({ logEdits })} />
                <TableSwitchRow icon={rowIcon('ChatIcon')} label="Log DMs and group DMs" value={s.logDms} onValueChange={(logDms: boolean) => set({ logDms })} />
                <TableSwitchRow icon={rowIcon('UserCircleIcon')} label="Ignore my messages" value={s.ignoreSelf} onValueChange={(ignoreSelf: boolean) => set({ ignoreSelf })} />
                <TableSwitchRow icon={rowIcon('AppsIcon')} label="Ignore bots" value={s.ignoreBots} onValueChange={(ignoreBots: boolean) => set({ ignoreBots })} />
            </TableRowGroup>
            <TableRowGroup title="Other changes">
                <TableSwitchRow icon={rowIcon('ReactionIcon')} label="Removed reactions" value={s.logReactions} onValueChange={(logReactions: boolean) => set({ logReactions })} />
                <TableSwitchRow icon={rowIcon('HashmarkIcon')} label="Deleted channels and threads" value={s.logChannels} onValueChange={(logChannels: boolean) => set({ logChannels })} />
                <TableSwitchRow icon={rowIcon('UserIcon')} label="Profile changes" value={s.logProfiles} onValueChange={(logProfiles: boolean) => set({ logProfiles })} />
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
                {s.onlyServersOn ? <TableRow icon={rowIcon('ServerIcon')} label="Choose servers" subLabel={`${(s.onlyServers ?? []).length} chosen`} arrow onPress={() => nav?.navigate?.(SERVERS_ROUTE)} /> : null}
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
                <TableSwitchRow icon={rowIcon('BellIcon')} label="Notify when a DM or mention is deleted" value={s.notifyDeletes} onValueChange={(notifyDeletes: boolean) => set({ notifyDeletes })} />
            </TableRowGroup>
            {st?.hasToken && !missing ? (
                <TableRowGroup title="Discord Watch">
                        <TableSwitchRow
                            icon={rowIcon('BellIcon')}
                            label="Notify when a DM or mention is deleted"
                            subLabel={st?.notifPermission === false && st?.notify ? 'Blocked' : undefined}
                            value={!!st?.notify}
                            onValueChange={(notify: boolean) => send('setup', { notify })}
                        />
                        {st?.notifPermission === false && st?.notify ? <TableRow label="Allow notifications for Discord Watch" arrow onPress={() => send('setup', { notify: true, enabled: !!st?.enabled })} /> : null}
                </TableRowGroup>
            ) : null}
        </Page>
    )
}

/**
 * Discord Watch 는 계정 토큰으로 디스코드 밖에서 따로 접속한다 (셀프봇과 같은 방식, 계정이 정지될 수 있다).
 * 그래서 고급 설정 안에 두고, 처음엔 경고를 보여 주고 두 번 눌러야 켤 수 있게 한다.
 */
export const WATCH_WARNING = 'This method connects your account outside of Discord. There is a high chance of getting banned. The author of this plugin is not responsible for anything that happens to your account.'

/** 켜려면 그대로 적어야 하는 문장 */
export const WATCH_PHRASE = 'If I get banned, it is my own responsibility'
/** 대소문자, 띄어쓰기, 끝의 마침표, it's 는 봐준다 */
export const phraseOk = (t: string) => {
    const norm = (x: string) => x.toLowerCase().replace(/it's/g, 'it is').replace(/[.!]+$/, '').replace(/\s+/g, ' ').trim()
    return norm(t) === norm(WATCH_PHRASE)
}

function WatchGate({ onUnlock }: { onUnlock: () => void }) {
    const { TableRowGroup, Text, Button, TextInput } = Design as any
    const [open, setOpen] = useState(false)
    const [typed, setTyped] = useState('')
    const ok = phraseOk(typed)
    return (
        <TableRowGroup title="Discord Watch">
            <View style={{ padding: 16, gap: 12 }}>
                <Text variant="text-md/semibold" style={{ color: palette().danger }}>
                    {WATCH_WARNING}
                </Text>
                {open ? (
                    <>
                        <Text variant="text-sm/medium" color="text-muted">
                            {`Type "${WATCH_PHRASE}" to turn it on.`}
                        </Text>
                        <TextInput value={typed} placeholder={WATCH_PHRASE} onChange={setTyped} autoCapitalize="none" autoCorrect={false} size="md" />
                        <Button text="I understand, turn it on" variant="destructive" size="md" disabled={!ok} onPress={() => ok && onUnlock()} />
                    </>
                ) : (
                    <Button text="Turn on Discord Watch" variant="secondary" size="md" onPress={() => setOpen(true)} />
                )}
            </View>
        </TableRowGroup>
    )
}

function Advanced() {
    const { s, set } = useSettings()
    const { st } = useWatchStatus(false)
    const { TableRowGroup, TableSwitchRow } = Design as any
    const unlocked = !!s.watchUnlocked || !!st?.hasToken
    return (
        <Page>
            <TableRowGroup title="While Discord is closed">
                <TableSwitchRow icon={rowIcon('BellZIcon')} label="Remember notifications" value={s.rememberPushes} onValueChange={(rememberPushes: boolean) => set({ rememberPushes })} />
                <TableSwitchRow icon={rowIcon('ClockIcon')} label="Find changes when you come back" value={s.detectAway} onValueChange={(detectAway: boolean) => set({ detectAway })} />
            </TableRowGroup>
            {unlocked ? <CompanionGroup /> : <WatchGate onUnlock={() => set({ watchUnlocked: true })} />}
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
                <TableSwitchRow icon={rowIcon('ImagesIcon')} label="Save deleted attachments" value={s.saveAttachments} onValueChange={(saveAttachments: boolean) => set({ saveAttachments })} />
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
        icon: 'ChatIcon',
        screen: InChat,
    },
    {
        key: 'notify',
        title: 'Notifications',
        icon: 'BellIcon',
        screen: Notifications,
    },
    {
        key: 'storage',
        title: 'Storage',
        icon: 'SaveIcon',
        screen: Storage,
    },
    {
        key: 'advanced',
        title: 'Advanced',
        icon: 'WrenchIcon',
        screen: Advanced,
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
    if (RowButton) return <RowButton icon={rowIcon(icon)} label={label} subLabel={sub} arrow={arrow} onPress={onPress} />
    return <TableRow icon={rowIcon(icon)} label={label} subLabel={sub} arrow={arrow} onPress={onPress} />
}

export function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bindIfNone(api.jsonStorage)
    useSettings()
    const nav = useNav()
    const { Stack } = Design as any
    return (
        <Page>
            <NavButton icon="ClipboardListIcon" label="View logs" onPress={() => nav?.navigate?.(LOGS_ROUTE)} />
            <Stack spacing={8}>
                {GROUPS.map(g => (
                    <NavButton key={g.key} icon={g.icon} label={g.title} onPress={() => nav?.navigate?.(routeOf(g.key))} />
                ))}
            </Stack>
        </Page>
    )
}

export { sendCompanion }

/** 시험용: 그룹 화면들 */
export const groupScreens = () => GROUPS.map(g => ({ key: g.key, title: g.title, Screen: g.screen }))
