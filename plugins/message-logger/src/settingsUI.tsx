import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { useEffect, useLayoutEffect, useState } from 'react'
import { LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { CompanionGroup, describe, myId, sendCompanion, useWatchStatus } from './companion'
import { FilterSettings } from './filtersUI'
import { clearAll, expire } from './logger'
import { LOGS_ROUTE } from './logs'
import { SERVERS_ROUTE } from './servers'
import { bindIfNone, KEEP_OPTIONS, logs, onChange, seen, setSettings, settings, type Settings } from './store'
import { exportLogs, importLogs } from './transfer'

/**
 * 설정: 첫 화면은 저장 현황, 로그 보기, 그룹 목록. 그룹마다 눌러서 들어가는 화면.
 * (값은 그대로, 자리만 나눴다)
 */

const PARENT = 'yumistra.message-logger'
const routeOf = (key: string) => `${PARENT}.group.${key}`

/** 고를 수 있는 색 (비우면 테마 색) */
const COLORS = ['', '#f23f43', '#ff7a45', '#f0b232', '#23a55a', '#00a8fc', '#5865f2', '#b45cf6', '#eb459e', '#949ba4']

function ColorRow({ label, value, onPick }: { label: string; value: string; onPick: (v: string) => void }) {
    const { Text } = Design as any
    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10 }}>
            <Text variant="text-md/semibold" color="text-strong">
                {label}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {COLORS.map(c => (
                    <Pressable
                        key={c || 'theme'}
                        accessibilityRole="radio"
                        accessibilityLabel={`${label} ${c || 'theme'}`}
                        accessibilityState={{ selected: value === c }}
                        onPress={() => onPick(c)}
                        style={{ width: 30, height: 30, borderRadius: 15, borderWidth: value === c ? 3 : 1, borderColor: value === c ? '#ffffff' : 'rgba(128,128,128,0.5)', backgroundColor: c || 'transparent', alignItems: 'center', justifyContent: 'center' }}
                    >
                        {!c ? (
                            <Text variant="text-xs/bold" color="text-muted">
                                A
                            </Text>
                        ) : null}
                    </Pressable>
                ))}
            </View>
        </View>
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
                <TableSwitchRow icon={<TableRowAssetIcon name="ReactionIcon" />} label="Removed reactions" subLabel="Shown under the message and in View logs" value={s.logReactions} onValueChange={(logReactions: boolean) => set({ logReactions })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="TextIcon" />} label="Deleted channels and threads" subLabel="Keeps the name and the last messages" value={s.logChannels} onValueChange={(logChannels: boolean) => set({ logChannels })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="UserIcon" />} label="Profile changes" subLabel="Username, display name, avatar and status of friends and people you DM" value={s.logProfiles} onValueChange={(logProfiles: boolean) => set({ logProfiles })} />
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
                <TableSwitchRow label="Only log chosen servers" subLabel="Direct messages are not affected" value={s.onlyServersOn} onValueChange={(onlyServersOn: boolean) => set({ onlyServersOn })} />
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
                <ColorRow label="Deleted message color" value={s.deletedColor} onPick={deletedColor => set({ deletedColor })} />
                <ColorRow label="Edited message color" value={s.editedColor} onPick={editedColor => set({ editedColor })} />
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
                <TableSwitchRow icon={<TableRowAssetIcon name="BellIcon" />} label="Notify when a DM or mention is deleted" subLabel="Phone notification from Discord" value={s.notifyDeletes} onValueChange={(notifyDeletes: boolean) => set({ notifyDeletes })} />
            </TableRowGroup>
            <TableRowGroup title="While Discord is closed">
                {st?.hasToken && !missing ? (
                    <>
                        <TableSwitchRow
                            icon={<TableRowAssetIcon name="BellIcon" />}
                            label="Notify when a DM or mention is deleted"
                            subLabel={st?.notifPermission === false && st?.notify ? 'Notifications are blocked for Discord Watch' : 'Phone notification from Discord Watch'}
                            value={!!st?.notify}
                            onValueChange={(notify: boolean) => send('setup', { notify })}
                        />
                        {st?.notifPermission === false && st?.notify ? <TableRow label="Allow notifications for Discord Watch" arrow onPress={() => send('setup', { notify: true, enabled: !!st?.enabled })} /> : null}
                    </>
                ) : (
                    <TableRow label="Discord Watch is not set up" subLabel="Turn it on in While Discord is closed" />
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
                <TableSwitchRow icon={<TableRowAssetIcon name="BellIcon" />} label="Remember notifications" subLabel="Keeps messages that came as notifications" value={s.rememberPushes} onValueChange={(rememberPushes: boolean) => set({ rememberPushes })} />
                <TableSwitchRow icon={<TableRowAssetIcon name="ClockIcon" />} label="Find changes when you come back" subLabel="Compares channels you open with what you saw" value={s.detectAway} onValueChange={(detectAway: boolean) => set({ detectAway })} />
            </TableRowGroup>
        </Page>
    )
}

function Storage() {
    const { s, set } = useSettings()
    const { TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, TableRow, Button } = Design as any
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
                <TableSwitchRow icon={<TableRowAssetIcon name="ImageIcon" />} label="Save deleted attachments" subLabel="Keeps images, videos and files of deleted messages on this device, up to 25 MB each" value={s.saveAttachments} onValueChange={(saveAttachments: boolean) => set({ saveAttachments })} />
            </TableRowGroup>
            <TableRowGroup title="Backup">
                <TableRow icon={<TableRowAssetIcon name="DownloadIcon" />} label="Export logs" subLabel="Saves a file in Download/MessageLogger" onPress={() => run(async () => `Saved to ${await exportLogs()}`)} />
                <TableRow icon={<TableRowAssetIcon name="UploadIcon" />} label="Import logs" subLabel="Adds logs from an exported file, nothing is removed" onPress={() => run(async () => `Added ${await importLogs()} log(s)`)} />
                {msg ? <TableRow label={msg} /> : null}
            </TableRowGroup>
            <Button text="Clear all logs" variant="destructive" size="md" disabled={!Object.keys(logs()).length} onPress={() => clearAll()} />
        </Page>
    )
}

// ── 그룹 목록 ───────────────────────────────────────────────────────────

interface Group {
    key: string
    title: string
    icon: string
    screen: () => any
    sub: (s: Settings, watch: string) => string
}

const on = (pairs: Array<[boolean, string]>, none: string) => pairs.filter(p => p[0]).map(p => p[1]).join(', ') || none

const GROUPS: Group[] = [
    {
        key: 'log',
        title: 'What to log',
        icon: 'ChatXIcon',
        screen: WhatToLog,
        sub: s => on([[s.logDeletes, 'Deleted'], [s.logEdits, 'edited'], [s.logReactions, 'reactions'], [s.logChannels, 'channels'], [s.logProfiles, 'profiles']], 'Nothing is logged').replace(/^./, c => c.toUpperCase()),
    },
    {
        key: 'who',
        title: 'Who and where',
        icon: 'FiltersHorizontalIcon',
        screen: WhoAndWhere,
        sub: s => [s.onlyServersOn ? `${(s.onlyServers ?? []).length} servers` : 'All servers', `${(s.allow ?? []).length} whitelisted`, `${(s.block ?? []).length} blacklisted`, ...(s.friendsOnly ? ['friends only'] : [])].join(', '),
    },
    {
        key: 'chat',
        title: 'In chat',
        icon: 'PencilIcon',
        screen: InChat,
        sub: s => on([[s.showHistoryInChat, 'Previous versions'], [s.showEditTime, 'edit time'], [s.showDeleteTime, 'deletion time']], 'Only colors').replace(/^./, c => c.toUpperCase()),
    },
    {
        key: 'notify',
        title: 'Notifications',
        icon: 'BellIcon',
        screen: Notifications,
        sub: s => `${s.notifyDeletes ? 'On' : 'Off'} while Discord runs`,
    },
    {
        key: 'closed',
        title: 'While Discord is closed',
        icon: 'ClockIcon',
        screen: WhileClosed,
        sub: (_s, watch) => `Discord Watch: ${watch}`,
    },
    {
        key: 'storage',
        title: 'Storage',
        icon: 'DownloadIcon',
        screen: Storage,
        sub: s => `Keep ${KEEP_OPTIONS.find(o => o[0] === s.keepHours)?.[1] ?? `${s.keepHours} hours`}, attachments ${s.saveAttachments ? 'saved' : 'not saved'}`,
    },
]

function groupScreen(g: Group) {
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

export function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bindIfNone(api.jsonStorage)
    const { s } = useSettings()
    const nav = useNav()
    const { st, missing } = useWatchStatus(false)
    const all = Object.values(logs())
    const deleted = all.filter(e => e.d).length
    const edited = all.filter(e => !e.d && e.e?.length).length
    const away = all.filter(e => e.away).length
    const remembered = Object.keys(seen()).length
    const watch = missing ? 'not installed' : describe(st, missing, myId()).replace(/^./, c => c.toLowerCase())
    const { TableRowGroup, TableRow } = Design as any
    return (
        <Page>
            <TableRowGroup title="Logs">
                <TableRow icon={<TableRowAssetIcon name="ChatXIcon" />} label="View logs" subLabel={`${deleted} deleted, ${edited} edited`} arrow onPress={() => nav?.navigate?.(LOGS_ROUTE)} />
                <TableRow label={`${away} found while you were away`} subLabel={`${remembered} messages remembered`} />
            </TableRowGroup>
            <TableRowGroup title="Settings">
                {GROUPS.map(g => (
                    <TableRow key={g.key} icon={<TableRowAssetIcon name={g.icon} />} label={g.title} subLabel={g.sub(s, watch)} arrow onPress={() => nav?.navigate?.(routeOf(g.key))} />
                ))}
            </TableRowGroup>
        </Page>
    )
}

export { sendCompanion }
