import { Stores } from '@valenced/discord/flux'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { AppState } from 'react-native'
import { trim } from './away'
import { bindNotes, nativeStatus, readTray, trimNotes } from './tray'
import { expire, importPushes, intercept } from './logger'
import { bindNavigation, LOGS_ROUTE, LogsScreen } from './logs'
import { registerPicker } from './picker'
import { patchSheet } from './sheet'
import { setNative, setPills, styleRow } from './rows'
import { interceptEvents } from './events'
import { SERVERS_ROUTE, ServersScreen } from './servers'
import { migrateOld, pullCompanion } from './transfer'
import { autoCollect } from './companion'
import { patchReactors } from './reactors'
import { registerGroups, SettingsPage } from './settingsUI'
import { bind, flush, notes, unbind } from './store'

/**
 * Everything Logger: 지운 메시지는 빨간, 수정한 메시지는 연한 회색으로 핑(노란 배경)과 같은 모양으로 남긴다.
 * 핑 배경은 메시지 줄 데이터의 backgroundHighlight { backgroundColor, gutterColor } 로 그려지므로 그 색만 바꿔 넣는다.
 * 로그는 저장되어 디스코드를 다시 켜도 남고 (지운 메시지는 채널을 불러올 때 제자리에 다시 넣는다), 보관 시간이 지나면 사라진다.
 */

/** 같은 RowManager 를 두 번 감싸지 않게 (모듈이 여러 번 잡혀도) */
const patched = new WeakSet<object>()
/**
 * 예전 내용·시간을 만드는 중 (그 안에서 불리는 generate 는 어느 층이든 꾸미지 않는다).
 * 플러그인을 다시 설치·업데이트해서 예전 인스턴스가 남아 있어도 같이 보도록 전역에 둔다
 */
const INNER = Symbol.for('yumistra.everything-logger.inner')
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
        // 처음 켤 때 한 번: 예전 Message Logger 의 로그와 설정을 가져온다
        migrateOld(jsonStorage)
            .then(n => {
                if (n) expire()
            })
            .catch(() => {})
        registerPicker(cleanup)
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
            .then(r => {
                setNative(!!r && !String(r).startsWith('error'))
                try {
                    setPills(!!JSON.parse(String(r)).pills)
                } catch {
                    setPills(false)
                }
            })
            .catch(() => setNative(false))
        cleanup(() => {
            setNative(false)
            setPills(false)
        })
        // 로그 보기는 디스코드 설정 화면처럼 새 화면으로 넘어간다 (목록에는 안 보이는 경로)
        try {
            cleanup(
                registerSettingsItem(LOGS_ROUTE, {
                    type: 'route',
                    parent: 'yumistra.everything-logger',
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
        try {
            cleanup(
                registerSettingsItem(SERVERS_ROUTE, {
                    type: 'route',
                    parent: 'yumistra.everything-logger',
                    unsearchable: true,
                    usePredicate: () => false,
                    useTitle: () => 'Servers to log',
                    screen: { route: SERVERS_ROUTE, getComponent: () => ServersScreen },
                } as any),
            )
            refreshSettings()
        } catch {}
        registerGroups(cleanup)
        // 반응 목록 창에 반응을 지운 사람을 빨갛게
        try {
            patchReactors(cleanup)
        } catch {}
        patchSheet(cleanup)
        const pull = () => {
            importPushes(me()).catch(() => {})
            readTray().catch(() => {})
            pullCompanion().catch(() => {})
            // 디스코드가 꺼진 동안 Discord Watch 가 모은 기록을 보내 달라고 한다
            autoCollect().catch(() => {})
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
            // 뒤로 가면 바로 저장한다 (그대로 꺼져도 방금 잡은 게 남게)
            if (state !== 'active') flush()
            if (state === 'active') pull()
        })
        const timer = setInterval(() => {
            try {
                expire()
            } catch {}
        }, 10 * 60_000)
        // 알림 앱이 보내 둔 기록 (켜 있는 동안 받은 것) 을 자주 합친다
        const companionTimer = setInterval(() => {
            pullCompanion().catch(() => {})
        }, 10_000)
        cleanup(
            () => clearInterval(timer),
            () => clearInterval(companionTimer),
            // 마지막에: 기다리던 저장을 마치고 더는 쓰지 않는다 (업데이트로 예전 것과 새것이 겹칠 때 지워지지 않게)
            () => unbind(),
            () => sub?.remove?.(),
            ...(intercept() as any[]),
            ...(interceptEvents() as any[]),
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

// 시험용 (Valenced 는 default 만 쓴다)
export { diff } from './diff'
export { stats } from './logsMore'
export { exportText, mergeData, pullCompanion } from './transfer'
export { allowed } from './filters'
export { styleRow, setNative } from './rows'
export { LogsView } from './logs'
export { SettingsPage }
export { groupScreens } from './settingsUI'
export { logs as _logs, events as _events, settings as _settings, setSettings as _setSettings } from './store'
