import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { companionStatus, pullCompanion } from './transfer'

/**
 * 알림 앱(Discord Watch): 디스코드가 꺼져 있는 동안 지운, 고친 메시지를 잡는 화면 없는 앱.
 * 여기서 켜고 끈다. 명령은 네이티브(Companion.kt)가 앱의 투명한 Activity 로 보내고, 앱은 상태를 방송으로 돌려준다.
 */

const NS = 'yumistra.message-logger'
export const APK_URL = 'https://github.com/Yumistra/Freestyle-Valenced/raw/watch-apk/DiscordWatch.apk'

export interface WatchStatus {
    version?: string
    enabled?: boolean
    hasToken?: boolean
    notify?: boolean
    running?: boolean
    state?: string
    user?: string
    userId?: string
    discordOpen?: boolean
    remembered?: number
    queued?: number
    deleted?: number
    edited?: number
    lastSent?: number
    notifPermission?: boolean
    battery?: boolean
    at?: number
}

const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)

/** 앱에 명령 보내기. "ok" | "missing" | "error: ..." */
export async function sendCompanion(cmd: string, data?: Record<string, unknown>): Promise<string> {
    try {
        return String(unwrap(await (callNativeMethod as any)(`${NS}.companion`, [cmd, data ? JSON.stringify(data) : ''])) ?? '')
    } catch (e: any) {
        return `error: ${e?.message ?? e}`
    }
}

/** 앱이 마지막으로 알려 준 상태 */
export async function readCompanion(): Promise<WatchStatus | undefined> {
    try {
        const t = String(unwrap(await (callNativeMethod as any)(`${NS}.companionStatus`, [])) ?? '')
        return t ? JSON.parse(t) : undefined
    } catch {
        return undefined
    }
}

/** 지금 로그인된 계정의 토큰 */
export function currentToken(): string | undefined {
    const tries: (() => any)[] = [
        () => (lookupModule(withProps('getToken', 'setToken') as any) as any)?.[0]?.getToken?.(),
        () => (lookupModule(withProps('getToken') as any) as any)?.[0]?.getToken?.(),
        () => (Stores as any).AuthenticationStore?.getToken?.(),
    ]
    for (const f of tries) {
        try {
            const t = f()
            if (typeof t === 'string' && t.length > 20) return t
        } catch {}
    }
}

export function myId(): string | undefined {
    try {
        return (Stores as any).AuthenticationStore?.getId?.()
    } catch {}
}

/** 상태 한 줄 (쉼표로 나눈다) */
export function describe(s: WatchStatus | undefined, missing: boolean, me?: string): string {
    if (missing) return 'Not installed'
    if (!s) return 'Waiting for the app'
    if (!s.hasToken) return 'Off, no account yet'
    if (!s.enabled) return s.state && s.state !== '꺼짐' ? `Off, ${s.state}` : 'Off'
    const parts: string[] = []
    parts.push(s.state === '연결됨' ? 'Connected' : s.state ?? 'Starting')
    if (s.user) parts.push(s.userId && me && s.userId !== me ? `watching ${s.user} (another account)` : `as ${s.user}`)
    parts.push(`${s.deleted ?? 0} deleted, ${s.edited ?? 0} edited caught`)
    return parts.join(', ')
}

/** 앱 상태 (설정을 보는 동안 1초마다 읽는다). ask 면 열 때 앱에 상태를 한 번 묻는다 */
export function useWatchStatus(ask = true) {
    const [st, setSt] = useState<WatchStatus | undefined>()
    const [missing, setMissing] = useState(false)
    const [msg, setMsg] = useState('')
    const send = async (cmd: string, data?: Record<string, unknown>) => {
        const r = await sendCompanion(cmd, data)
        if (r === 'missing') setMissing(true)
        else if (r !== 'ok') setMsg(`Failed: ${r}`)
        else setMissing(false)
        return r
    }
    useEffect(() => {
        let alive = true
        readCompanion().then(s => alive && setSt(s))
        if (ask) send('status')
        const t = setInterval(() => {
            readCompanion().then(s => alive && s && setSt(s))
        }, 1000)
        return () => {
            alive = false
            clearInterval(t)
        }
    }, [])
    return { st, missing, msg, setMsg, send }
}

/**
 * 디스코드가 켜지거나 돌아올 때 Discord Watch 에 모아 둔 기록을 보내 달라고 한다.
 * 앱이 없거나 계정이 없으면 하지 않는다. 앱을 여는 것도 디스코드를 잠깐 멈추게 하니 (돌아오면 다시 불린다) 10분에 한 번만.
 * 보낸 기록은 네이티브가 받아 파일에 두고, 잠시 뒤 합친다.
 */
let lastAsk = 0
let noApp = false
export async function autoCollect() {
    if (noApp) return
    const known = await readCompanion()
    if (known && !known.hasToken) return
    const now = Date.now()
    if (now - lastAsk < 10 * 60_000) return
    lastAsk = now
    const r = await sendCompanion('deliver')
    if (r === 'missing') noApp = true
    if (r !== 'ok') return
    for (const ms of [2000, 6000]) setTimeout(() => pullCompanion().catch(() => {}), ms)
}

export function CompanionGroup({ onTurnedOn }: { onTurnedOn?: () => void }) {
    const { TableRowGroup, TableRow, TableSwitchRow, TextInput, Button } = Design as any
    const { st, missing, msg, setMsg, send } = useWatchStatus()
    const [paste, setPaste] = useState(false)
    const [token, setToken] = useState('')
    const me = myId()

    const turnOn = (t: string | undefined) => {
        if (!t || t.trim().length < 20) return setMsg('Could not read the token')
        setMsg('')
        send('setup', { token: t.trim(), enabled: true, notify: st?.notify ?? true }).then(r => {
            if (r === 'ok') {
                setPaste(false)
                setToken('')
                noApp = false
                onTurnedOn?.()
            }
        })
    }

    const sub = describe(st, missing, me)
    return (
        <TableRowGroup title="Discord Watch">
            <TableRow
                icon={<TableRowAssetIcon name="ShieldIcon" />}
                label="Discord Watch"
                subLabel={`${sub}. Catches deleted and edited messages while Discord is closed, they show up in View logs when you open Discord.${companionStatus.last ? ` Added ${companionStatus.received} so far.` : ''}`}
            />
            {missing ? (
                <TableRow icon={<TableRowAssetIcon name="DownloadIcon" />} label="Download the app" subLabel="Install it, then come back here" arrow onPress={() => Linking.openURL(APK_URL)} />
            ) : (
                <>
                    {st?.hasToken ? (
                        <TableSwitchRow
                            label="Running"
                            value={!!st?.enabled}
                            onValueChange={(enabled: boolean) => send('setup', { enabled })}
                        />
                    ) : null}
                    <TableRow
                        icon={<TableRowAssetIcon name="UserIcon" />}
                        label={st?.hasToken ? 'Use this account' : 'Turn on with this account'}
                        subLabel="Uses the account you are logged in with here"
                        onPress={() => turnOn(currentToken())}
                    />
                    <TableRow icon={<TableRowAssetIcon name="LinkIcon" />} label="Paste a token" subLabel="Watch another account instead" arrow onPress={() => setPaste(p => !p)} />
                    {paste ? (
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10 }}>
                            <TextInput label="Token" value={token} placeholder="Token of the account to watch" onChange={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} size="md" />
                            <Button text="Turn on with this token" size="md" disabled={token.trim().length < 20} onPress={() => turnOn(token)} />
                        </View>
                    ) : null}
                    {st?.userId && me && st.userId !== me ? (
                        <TableRow label="Another account is watched" subLabel="Its deleted messages show in View logs, not in chat" />
                    ) : null}
                    {st?.hasToken && st?.battery === false ? (
                        <TableRow icon={<TableRowAssetIcon name="ClockIcon" />} label="Keep running in the background" subLabel="Lets the app ignore battery optimization" arrow onPress={() => send('battery')} />
                    ) : null}
                    {st?.hasToken ? (
                        <TableRow
                            icon={<TableRowAssetIcon name="DownloadIcon" />}
                            label="Get logs now"
                            subLabel={st?.queued ? `${st.queued} kept in the app for 3 days` : 'Nothing caught yet'}
                            onPress={() =>
                                send('deliver').then(() =>
                                    setTimeout(() => {
                                        pullCompanion()
                                            .then(n => setMsg(n ? `Added ${n} new log(s)` : 'Everything is already in View logs'))
                                            .catch(() => {})
                                    }, 1500),
                                )
                            }
                        />
                    ) : null}
                    {st?.hasToken ? <TableRow icon={<TableRowAssetIcon name="TrashIcon" />} label="Remove the account from the app" onPress={() => send('clearToken')} /> : null}
                </>
            )}
            {msg ? <TableRow label={msg} /> : null}
        </TableRowGroup>
    )
}
