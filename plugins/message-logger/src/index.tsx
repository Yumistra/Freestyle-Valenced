import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { useEffect, useState } from 'react'
import { AppState, LayoutAnimation, ScrollView } from 'react-native'
import { trim } from './away'
import { bindNotes, nativeStatus, readTray, trimNotes } from './tray'
import { clearAll, expire, importPushes, intercept } from './logger'
import { bindNavigation, LOGS_ROUTE, LogsScreen } from './logs'
import { patchSheet } from './sheet'
import { setNative, styleRow } from './rows'
import { bind, KEEP_OPTIONS, logs, notes, onChange, seen, setSettings, settings, type Settings } from './store'

/**
 * Message Logger: 지운 메시지는 빨간, 수정한 메시지는 연한 회색으로 핑(노란 배경)과 같은 모양으로 남긴다.
 * 핑 배경은 메시지 줄 데이터의 backgroundHighlight { backgroundColor, gutterColor } 로 그려지므로 그 색만 바꿔 넣는다.
 * 로그는 저장되어 디스코드를 다시 켜도 남고 (지운 메시지는 채널을 불러올 때 제자리에 다시 넣는다), 보관 시간이 지나면 사라진다.
 */

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const [, force] = useState(0)
    let nav: any
    try {
        nav = (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
    useEffect(() => {
        const off = onChange(() => force(n => n + 1))
        return () => {
            off()
        }
    }, [])
    const s = settings()
    const all = Object.values(logs())
    const deleted = all.filter(e => e.d).length
    const edited = all.filter(e => !e.d && e.e?.length).length
    const away = all.filter(e => e.away).length
    const remembered = Object.keys(seen()).length
    const { Stack, TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, TableRow, Button } = Design as any
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
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Log">
                    <TableSwitchRow icon={<TableRowAssetIcon name="TrashIcon" />} label="Deleted messages" value={s.logDeletes} onValueChange={(logDeletes: boolean) => set({ logDeletes })} />
                    <TableSwitchRow icon={<TableRowAssetIcon name="PencilIcon" />} label="Edited messages" value={s.logEdits} onValueChange={(logEdits: boolean) => set({ logEdits })} />
                    <TableSwitchRow label="Ignore my messages" value={s.ignoreSelf} onValueChange={(ignoreSelf: boolean) => set({ ignoreSelf })} />
                    <TableSwitchRow label="Ignore bots" value={s.ignoreBots} onValueChange={(ignoreBots: boolean) => set({ ignoreBots })} />
                </TableRowGroup>
                <TableRowGroup title="While you're away">
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="BellIcon" />}
                        label="Remember notifications"
                        value={s.rememberPushes}
                        onValueChange={(rememberPushes: boolean) => set({ rememberPushes })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ClockIcon" />}
                        label="Find changes when you come back"
                        value={s.detectAway}
                        onValueChange={(detectAway: boolean) => set({ detectAway })}
                    />
                </TableRowGroup>
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
                <TableRowGroup title="Logs">
                    <TableRow
                        icon={<TableRowAssetIcon name="ChatXIcon" />}
                        label="View logs"
                        arrow
                        onPress={() => nav?.navigate?.(LOGS_ROUTE)}
                    />
                </TableRowGroup>
                <TableRowGroup title="Saved">
                    <TableRow label={`${deleted} deleted, ${edited} edited`} subLabel={`${away} found after coming back, ${remembered} messages remembered`} />
                </TableRowGroup>
                <Button text="Clear all logs" variant="destructive" size="md" disabled={!all.length} onPress={() => clearAll()} />
            </Stack>
        </ScrollView>
    )
}

/** 같은 RowManager 를 두 번 감싸지 않게 (모듈이 여러 번 잡혀도) */
const patched = new WeakSet<object>()
/**
 * 예전 내용·시간을 만드는 중 (그 안에서 불리는 generate 는 어느 층이든 꾸미지 않는다).
 * 플러그인을 다시 설치·업데이트해서 예전 인스턴스가 남아 있어도 같이 보도록 전역에 둔다
 */
const INNER = Symbol.for('yumistra.message-logger.inner')
const g: any = globalThis as any
const innerCount = () => g[INNER] ?? 0
const enter = () => {
    g[INNER] = innerCount() + 1
}
const leave = () => {
    g[INNER] = Math.max(0, innerCount() - 1)
}

export default plugin({
    jsonStorage: { load: true, default: {} },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        // 저장된 로그가 불러와지면 오래된 것부터 정리
        const me = () => {
            try {
                return (Stores as any).AuthenticationStore?.getId?.()
            } catch {}
        }
        bindNotes(notes)
        bindNavigation(cleanup)
        // 네이티브 부분이 켜져 있는지 묻고, 대답하면 수정 기록을 꾸며서 보여 준다
        setNative(false)
        nativeStatus()
            .then(r => setNative(!!r && !String(r).startsWith('error')))
            .catch(() => setNative(false))
        cleanup(() => setNative(false))
        // 로그 보기는 디스코드 설정 화면처럼 새 화면으로 넘어간다 (목록에는 안 보이는 경로)
        try {
            cleanup(
                registerSettingsItem(LOGS_ROUTE, {
                    type: 'route',
                    parent: 'yumistra.message-logger',
                    unsearchable: true,
                    usePredicate: () => false,
                    useTitle: () => 'Logs',
                    screen: { route: LOGS_ROUTE, getComponent: () => LogsScreen },
                } as any),
                () => {
                    try {
                        refreshSettings()
                    } catch {}
                },
            )
            refreshSettings()
        } catch {}
        patchSheet(cleanup)
        const pull = () => {
            importPushes(me()).catch(() => {})
            readTray().catch(() => {})
        }
        Promise.resolve(jsonStorage.cache ?? jsonStorage.get?.())
            .then(() => {
                expire()
                trim()
                trimNotes()
                return pull()
            })
            .catch(() => {})
        // 앱으로 돌아올 때마다 그동안 온 알림을 가져온다
        const sub: any = (AppState as any)?.addEventListener?.('change', (state: string) => {
            if (state === 'active') pull()
        })
        const timer = setInterval(() => {
            try {
                expire()
            } catch {}
        }, 10 * 60_000)
        cleanup(
            () => clearInterval(timer),
            () => sub?.remove?.(),
            ...(intercept() as any[]),
            // modules/messages/native/renderer/RowGenerator.tsx
            getModules(withName('RowManager') as any, (RowManager: any) => {
                const proto = RowManager?.prototype
                if (typeof proto?.generate !== 'function') return
                // 예전 내용·시간 글자를 만들 때는 다른 플러그인 패치까지 거친 generate 로 만든다
                // (메시지 옆 시간을 "10 minutes ago"처럼 바꾸는 플러그인과 같은 글자가 나오게). 그동안 우리는 끼어들지 않는다
                if (patched.has(proto)) return
                patched.add(proto)
                cleanup(
                    () => patched.delete(proto),
                    instead(proto, 'generate', function (this: any, args: any[], orig: (...a: any[]) => any) {
                        const row = orig.apply(this, args)
                        if (innerCount()) return row
                        try {
                            styleRow(
                                row,
                                args[0],
                                // 예전 내용: 디스코드 원래 것만 (다른 플러그인이 덧붙이는 것—다른 로거의 수정 기록 등—이 섞이지 않게)
                                (a: any) => {
                                    enter()
                                    try {
                                        return orig.call(this, a)
                                    } finally {
                                        leave()
                                    }
                                },
                                // 시간: 다른 플러그인까지 거친 것 (메시지 옆 시간과 같은 글자)
                                (a: any) => {
                                    enter()
                                    try {
                                        return proto.generate.call(this, a)
                                    } finally {
                                        leave()
                                    }
                                },
                            )
                        } catch {}
                        return row
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
