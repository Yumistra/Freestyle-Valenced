import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { ActionSheetActionCreators, AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'

/**
 * Voice Tools: 음성, 스테이지 채널을 꾹 누르면 나오는 창에 "모두 음소거, 음소거 해제, 헤드셋 끄기, 켜기, 연결 끊기" 줄을 넣는다.
 * 그 채널에서 멤버 음소거(MUTE_MEMBERS), 헤드셋 끄기(DEAFEN_MEMBERS), 멤버 이동(MOVE_MEMBERS) 권한이 있을 때만 보인다.
 * 한 명씩 PATCH /guilds/{서버}/members/{사람} 로 바꾼다. 너무 빨리 보내면 기다렸다가 다시 보낸다.
 */

const S = () => Stores as any
const SHEET = 'modules/channel/native/ChannelLongPressActionSheet.tsx'
const VOCAL = new Set([2, 13])

// ── 설정 ────────────────────────────────────────────────────────────────
interface Settings {
    /** 나도 같이 바꾸기 */
    includeMe: boolean
}
const DEFAULTS: Settings = { includeMe: false }
let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const s = settings()
    const { TableRowGroup, TableSwitchRow } = Design as any
    return (
        <Page>
            <TableRowGroup>
                <TableSwitchRow
                    icon={<TableRowAssetIcon name="UserIcon" />}
                    label="Include yourself"
                    value={s.includeMe}
                    onValueChange={(includeMe: boolean) => storage?.set({ ...settings(), includeMe }, true)}
                />
            </TableRowGroup>
        </Page>
    )
}

// ── 도구 ────────────────────────────────────────────────────────────────
function find(...props: string[]): any {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

const BITS = { MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n }
type Perm = keyof typeof BITS
function can(name: Perm, channel: any): boolean {
    try {
        const value = find('Permissions', 'ChannelTypes')?.Permissions?.[name] ?? BITS[name]
        return !!S().PermissionStore?.can?.(value, channel)
    } catch {
        return false
    }
}

let http: any
function api() {
    if (!http) {
        const a = find('HTTP')?.HTTP
        http = a?.patch ? a : find('getAPIBaseURL', 'patch')
    }
    return http
}

let seq = 0
function toast(text: string) {
    try {
        ;(ToastActionCreators as any).open(`voice-tools-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 채널에 있는 사람들과 상태 (설정에 따라 나는 뺀다) */
function people(channelId: string): Array<{ id: string; mute: boolean; deaf: boolean }> {
    const states: Record<string, any> = S().VoiceStateStore?.getVoiceStatesForChannel?.(channelId) ?? {}
    const me = S().UserStore?.getCurrentUser?.()?.id
    return Object.entries(states)
        .filter(([id]) => settings().includeMe || id !== me)
        .map(([id, st]) => ({ id, mute: !!st?.mute, deaf: !!st?.deaf }))
}

interface Action {
    key: string
    label: string
    icon: string
    perm: Perm
    /** 이 사람이 바꿀 대상인지 */
    needs: (p: { mute: boolean; deaf: boolean }) => boolean
    body: Record<string, unknown>
    done: string
    danger?: boolean
}

const ACTIONS: Action[] = [
    { key: 'mute', label: 'Mute everyone', icon: 'MicrophoneSlashIcon', perm: 'MUTE_MEMBERS', needs: p => !p.mute, body: { mute: true }, done: 'Muted' },
    { key: 'unmute', label: 'Unmute everyone', icon: 'MicrophoneIcon', perm: 'MUTE_MEMBERS', needs: p => p.mute, body: { mute: false }, done: 'Unmuted' },
    { key: 'deafen', label: 'Deafen everyone', icon: 'HeadphonesSlashIcon', perm: 'DEAFEN_MEMBERS', needs: p => !p.deaf, body: { deaf: true }, done: 'Deafened' },
    { key: 'undeafen', label: 'Undeafen everyone', icon: 'HeadphonesIcon', perm: 'DEAFEN_MEMBERS', needs: p => p.deaf, body: { deaf: false }, done: 'Undeafened' },
    { key: 'disconnect', label: 'Disconnect everyone', icon: 'PhoneHangUpIcon', perm: 'MOVE_MEMBERS', needs: () => true, body: { channel_id: null }, done: 'Disconnected', danger: true },
]

/** 한 명씩 바꾼다. 너무 빠르면(429) 기다렸다 다시 */
async function apply(channel: any, action: Action) {
    const targets = people(channel.id).filter(action.needs)
    if (!targets.length) {
        toast('Nobody to change')
        return
    }
    const h = api()
    if (!h?.patch) {
        toast("Couldn't find Discord's request module")
        return
    }
    toast(`${action.label}, ${targets.length}...`)
    let ok = 0
    let failed = 0
    let reason = ''
    for (const t of targets) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await h.patch({ url: `/guilds/${channel.guild_id}/members/${t.id}`, body: action.body })
                ok++
                break
            } catch (e: any) {
                const wait = Number(e?.body?.retry_after ?? 0)
                if (e?.status === 429 && attempt < 3) {
                    await sleep(Math.ceil((wait || 1) * 1000) + 100)
                    continue
                }
                failed++
                reason = e?.body?.message ?? e?.message ?? String(e?.status ?? e)
                break
            }
        }
        await sleep(120)
    }
    toast(failed ? `${action.done} ${ok}, ${failed} failed, ${reason}` : `${action.done} ${ok}`)
}

function confirm(channel: any, action: Action, count: number) {
    const { AlertModal, AlertActionButton, Text } = Design as any
    const key = `voice-tools-confirm-${seq++}`
    try {
        ;(AlertActionCreators as any).openAlert(
            key,
            <AlertModal
                title={action.label}
                content={<Text variant="text-md/normal">{`${count} ${count === 1 ? 'person' : 'people'} in this channel will be disconnected.`}</Text>}
                actions={[
                    <AlertActionButton key="go" text="Disconnect" variant="destructive" onPress={() => void apply(channel, action)} />,
                    <AlertActionButton key="no" text="Cancel" variant="secondary" />,
                ]}
            />,
        )
    } catch {
        void apply(channel, action)
    }
}

// ── 꾹 누르기 창에 줄 넣기 (Better Channel List 와 같은 방식) ─────────────
function hideSheet(channelId?: string) {
    try {
        ;(ActionSheetActionCreators as any).hideActionSheet(channelId ? `ChannelLongPress-${channelId}` : undefined)
    } catch {}
}

const nameOf = (t: any): string => t?.name || t?.displayName || t?.type?.name || t?.type?.displayName || t?.render?.name || ''
function isGroup(n: any) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false
    const G = (Design as any).ActionSheetRow?.Group
    return (G && n.type === G) || /ActionSheetRowGroup$/.test(nameOf(n.type))
}
const flat = (c: any): any[] => (Array.isArray(c) ? c.flatMap(flat) : [c])

function group(channel: any, close: () => void) {
    const { ActionSheetRow } = Design as any
    if (!ActionSheetRow?.Group) return null
    const list = people(channel.id)
    const rows = ACTIONS.filter(a => can(a.perm, channel))
        .map(a => ({ a, n: list.filter(a.needs).length }))
        .filter(x => x.n > 0)
    if (!rows.length) return null
    return (
        <ActionSheetRow.Group key="voice-tools" hasIcons>
            {rows.map(({ a, n }) => {
                const Icon: any = lookupGeneratedIconComponent(a.icon as any)
                return (
                    <ActionSheetRow
                        key={a.key}
                        label={a.label}
                        subLabel={`${n} ${n === 1 ? 'person' : 'people'}`}
                        variant={a.danger ? 'danger' : undefined}
                        icon={Icon ? <ActionSheetRow.Icon IconComponent={Icon} variant={a.danger ? 'danger' : undefined} /> : undefined}
                        onPress={() => {
                            close()
                            hideSheet(channel.id)
                            // 창이 닫힌 뒤에
                            setTimeout(() => (a.danger ? confirm(channel, a, n) : void apply(channel, a)), 300)
                        }}
                    />
                )
            })}
        </ActionSheetRow.Group>
    )
}

function addRows(node: any, channel: any, close: () => void, depth = 0): any {
    if (!node || typeof node !== 'object' || depth > 10) return node
    if (Array.isArray(node)) {
        let changed = false
        const out = node.map(n => {
            const r = addRows(n, channel, close, depth + 1)
            if (r !== n) changed = true
            return r
        })
        return changed ? out : node
    }
    const props = node.props
    if (!props) return node
    if ((props.showGradient !== undefined && 'header' in props) || flat(props.children).some(isGroup)) {
        const kids = Array.isArray(props.children) ? props.children : [props.children]
        if (kids.some((k: any) => k?.key === 'voice-tools')) return node
        const g = group(channel, close)
        if (!g) return node
        return { ...node, props: { ...props, children: [g, ...kids] } }
    }
    if (props.children == null || typeof props.children !== 'object') return node
    const kids = addRows(props.children, channel, close, depth + 1)
    return kids === props.children ? node : { ...node, props: { ...props, children: kids } }
}

const wrapped = new WeakMap<any, any>()
function wrapInner(type: any, channel: any, close: () => void) {
    const MEMO = Symbol.for('react.memo')
    const render = type?.$$typeof === MEMO ? type.type : type
    if (typeof render !== 'function') return
    let w = wrapped.get(type)
    if (!w) {
        w = function VoiceToolsSheet(props: any) {
            const out = render(props)
            try {
                const ch = props?.channel ?? channel
                return VOCAL.has(ch?.type) ? addRows(out, ch, typeof props?.onClose === 'function' ? () => props.onClose() : close) : out
            } catch {
                return out
            }
        }
        wrapped.set(type, w)
    }
    return w
}

function patchSheet(cleanup: (...f: any[]) => void) {
    const patched = new WeakSet<any>()
    const render = (args: any[], orig: (...a: any[]) => any, self: unknown) => {
        const out = orig.apply(self, args)
        const p = args[0]
        const channel = p?.channel ?? (p?.channelId ? S().ChannelStore?.getChannel?.(p.channelId) : undefined)
        if (!channel || !VOCAL.has(channel.type) || !channel.guild_id) return out
        const close = () => {
            try {
                if (typeof p?.onClose === 'function') p.onClose()
                else hideSheet()
            } catch {}
        }
        try {
            const direct = addRows(out, channel, close)
            if (direct !== out) return direct
            if (out?.type && typeof out.type !== 'string') {
                const w = wrapInner(out.type, channel, close)
                if (w) return { ...out, type: w }
            }
        } catch {}
        return out
    }
    const patchMod = (mod: any) => {
        if (!mod || typeof mod.default !== 'function' || patched.has(mod)) return mod
        try {
            cleanup(
                instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    return render(args, orig, this)
                }),
            )
            patched.add(mod)
            return mod
        } catch {
            const Original = mod.default
            return { ...mod, default: (props: any) => render([props], Original, undefined) }
        }
    }
    try {
        cleanup(
            instead(ActionSheetActionCreators as any, 'openLazy', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                try {
                    const [sheet, key] = args
                    if (typeof key === 'string' && /ChannelLongPress/i.test(key) && typeof sheet?.then === 'function') args[0] = sheet.then((m: any) => patchMod(m))
                } catch {}
                return orig.apply(this, args)
            }),
        )
    } catch {}
    cleanup(
        getModuleWithImportedPath(SHEET, (m: any) => {
            if (m) patchMod(m)
            else cleanup(waitForModuleWithImportedPath(SHEET, (x: any) => void patchMod(x)) as any)
        }) as any,
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        patchSheet(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
