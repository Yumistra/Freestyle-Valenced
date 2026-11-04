import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { useEffect, useState } from 'react'
import { AppState, ScrollView } from 'react-native'
import { trim } from './away'
import { bindNotes, readTray, trimNotes } from './tray'
import { clearAll, expire, importPushes, intercept } from './logger'
import { bindNavigation, LogsView } from './logs'
import { styleRow } from './rows'
import { bind, KEEP_OPTIONS, logs, notes, onChange, seen, setSettings, settings, type Settings } from './store'

/**
 * Message Logger: 지운 메시지는 빨간, 수정한 메시지는 연한 회색으로 핑(노란 배경)과 같은 모양으로 남긴다.
 * 핑 배경은 메시지 줄 데이터의 backgroundHighlight { backgroundColor, gutterColor } 로 그려지므로 그 색만 바꿔 넣는다.
 * 로그는 저장되어 디스코드를 다시 켜도 남고 (지운 메시지는 채널을 불러올 때 제자리에 다시 넣는다), 보관 시간이 지나면 사라진다.
 */

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const [, force] = useState(0)
    const [view, setView] = useState<'settings' | 'logs'>('settings')
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
        setSettings(patch)
        force(n => n + 1)
    }
    if (view === 'logs') return <LogsView onBack={() => setView('settings')} />
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Log">
                    <TableSwitchRow icon={<TableRowAssetIcon name="TrashIcon" />} label="Deleted messages" subLabel="Kept with a red highlight." value={s.logDeletes} onValueChange={(logDeletes: boolean) => set({ logDeletes })} />
                    <TableSwitchRow icon={<TableRowAssetIcon name="PencilIcon" />} label="Edited messages" subLabel="Light gray highlight, old versions shown above." value={s.logEdits} onValueChange={(logEdits: boolean) => set({ logEdits })} />
                    <TableSwitchRow label="Ignore my messages" value={s.ignoreSelf} onValueChange={(ignoreSelf: boolean) => set({ ignoreSelf })} />
                    <TableSwitchRow label="Ignore bots" value={s.ignoreBots} onValueChange={(ignoreBots: boolean) => set({ ignoreBots })} />
                </TableRowGroup>
                <TableRowGroup title="While you're away">
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="BellIcon" />}
                        label="Remember notifications"
                        subLabel="Messages that arrive as notifications are saved, even when Discord is closed."
                        value={s.rememberPushes}
                        onValueChange={(rememberPushes: boolean) => set({ rememberPushes })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ClockIcon" />}
                        label="Find changes when you come back"
                        subLabel="When a channel loads, saved messages that are gone or changed are shown as deleted or edited."
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
                        subLabel="Deleted and edited messages, shown like in chat. Tap one to go to it."
                        arrow
                        onPress={() => setView('logs')}
                    />
                </TableRowGroup>
                <TableRowGroup title="Saved">
                    <TableRow label={`${deleted} deleted, ${edited} edited`} subLabel={`${away} found after coming back, ${remembered} messages remembered. Older than the time above are removed automatically.`} />
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
