import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { useState } from 'react'
import { View } from 'react-native'

/**
 * Silent Leave (il1ll/RevengePlugins 의 SilentLeave 를 Valenced 로 옮김)
 *
 * Valenced 에는 명령어 API 가 없어서, 디스코드 기본 명령어(/shrug 등) 목록을
 * 돌려주는 getBuiltInCommands 결과에 우리 명령어를 덧붙인다.
 * 실행하면 DELETE /channels/:id?silent=true 로 그룹 DM 을 조용히 나간다.
 *
 * 그룹 나가기 확인창에도 "Leave without notifying other members" 체크를 넣는다.
 *  - 그 창은 actions/native/AlertActionCreators.tsx 의 show({ title, body, confirmText, cancelText, onConfirm }) 로 뜬다
 *  - 제목이 디스코드의 "'{name}' 나가기" 문구(언어 상관없이 intl 로 만든 틀)와 맞으면 우리 창으로 바꿔 띄운다
 *  - 체크하고 Yes 를 누르면 디스코드의 onConfirm 이 부르는 closePrivateChannel(id, unselect, silent) 의 silent 를 켠다
 */

const GROUP_DM = 3
const CHAT = 1
const COMMAND_ID = '-73917'

let seq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`silent-leave-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function enumValue(name: string, key: string, fallback: any) {
    try {
        const [mod] = lookupModule(withProps(name) as any) as any
        return mod?.[name]?.[key] ?? fallback
    } catch {
        return fallback
    }
}

let http: any
function HTTP() {
    if (!http) [http] = lookupModule(withProps('getAPIBaseURL', 'del') as any) as any
    return http
}

let command: any
function silentLeaveCommand() {
    if (command) return command
    command = {
        id: COMMAND_ID,
        untranslatedName: 'leave-silent',
        displayName: 'leave-silent',
        type: CHAT,
        inputType: enumValue('ApplicationCommandInputType', 'BUILT_IN_TEXT', 1),
        applicationId: '-1',
        untranslatedDescription: 'Leave this group DM silently',
        displayDescription: 'Leave this group DM silently',
        options: [],
        predicate(ctx: any) {
            const id = ctx?.channel?.id
            const channel = id ? (Stores as any).ChannelStore?.getChannel(id) : undefined
            return channel?.type === GROUP_DM
        },
        async execute(_args: unknown, ctx: any) {
            const id = ctx?.channel?.id
            const channel = id ? (Stores as any).ChannelStore?.getChannel(id) : undefined
            if (channel?.type !== GROUP_DM) {
                toast('Only works in group DMs')
                return
            }
            try {
                const api = HTTP()
                if (!api) throw new Error('HTTP module not found')
                await api.del({ url: `/channels/${id}`, query: { silent: true } })
                toast('Left silently')
            } catch (e: any) {
                toast(`Couldn't leave${e?.body?.message ? `: ${e.body.message}` : e?.message ? `: ${e.message}` : ''}`)
            }
        },
    }
    return command
}

const ALERT_PATH = 'actions/native/AlertActionCreators.tsx'
/** 디스코드 문구 키: 그룹 나가기 제목, 관리되는 그룹 나가기 제목 */
const LEAVE_TITLE_KEYS = ['hJ5Ap4', 'hVGjEW']
const MARK = '\u0001'

let intlMod: any
function leaveTitles(): Array<[string, string]> {
    const out: Array<[string, string]> = []
    try {
        intlMod ??= (lookupModule(withProps('intl', 't') as any) as any)?.[0]
        const intl = intlMod?.intl
        const t = intlMod?.t
        for (const key of LEAVE_TITLE_KEYS) {
            const msg = t?.[key]
            if (!msg || typeof intl?.formatToPlainString !== 'function') continue
            const text = String(intl.formatToPlainString(msg, { name: MARK }))
            const at = text.indexOf(MARK)
            if (at >= 0) out.push([text.slice(0, at), text.slice(at + MARK.length)])
        }
    } catch {}
    return out
}
function isLeaveAlert(props: any): boolean {
    const title = props?.title
    if (typeof title !== 'string' || typeof props?.onConfirm !== 'function') return false
    const forms = leaveTitles()
    if (forms.length) return forms.some(([a, b]) => title.length > a.length + b.length && title.startsWith(a) && title.endsWith(b))
    return /^Leave ['‘"]/i.test(title)
}

/** 다음 closePrivateChannel 한 번을 조용히 (Yes 를 누른 직후에만) */
let silentUntil = 0

let alertSeq = 0
function SilentCheck({ onChange }: { onChange: (v: boolean) => void }) {
    const { TableCheckboxRow } = Design as any
    const [checked, setChecked] = useState(false)
    return (
        <View style={{ alignSelf: 'stretch', marginTop: 12 }}>
            <TableCheckboxRow
                label="Leave without notifying other members"
                checked={checked}
                start
                end
                onPress={() => {
                    const next = !checked
                    setChecked(next)
                    onChange(next)
                }}
            />
        </View>
    )
}

function openLeaveAlert(props: any) {
    const { AlertModal, AlertActionButton, Text } = Design as any
    let silent = false
    const body = props.body
    AlertActionCreators.openAlert(
        `silent-leave-${alertSeq++}`,
        <AlertModal
            title={props.title}
            content={
                body == null || typeof body === 'string' ? (
                    body
                ) : (
                    <Text variant="text-md/medium" color="text-default" style={{ textAlign: 'center' }}>
                        {body}
                    </Text>
                )
            }
            extraContent={<SilentCheck onChange={v => (silent = v)} />}
            actions={
                <>
                    <AlertActionButton
                        text={props.confirmText ?? 'Yes'}
                        variant="primary"
                        onPress={() => {
                            if (silent) silentUntil = Date.now() + 5000
                            try {
                                props.onConfirm?.()
                            } finally {
                                // onConfirm 이 closePrivateChannel 을 바로 부르지 않았다면 다음 것에 번지지 않게
                                setTimeout(() => (silentUntil = 0), 5000)
                            }
                        }}
                    />
                    <AlertActionButton text={props.cancelText ?? 'No'} variant="secondary" onPress={() => props.onCancel?.()} />
                </>
            }
        />,
    )
}

function patchAlerts(cleanup: (...f: any[]) => void) {
    const done = new WeakSet<object>()
    const apply = (m: any) => {
        const target = typeof m?.show === 'function' ? m : typeof m?.default?.show === 'function' ? m.default : undefined
        if (!target || done.has(target)) return
        done.add(target)
        cleanup(
            instead(target, 'show', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                try {
                    if (isLeaveAlert(args[0])) {
                        openLeaveAlert(args[0])
                        return
                    }
                } catch {}
                return orig.apply(this, args)
            }),
        )
    }
    cleanup(
        getModuleWithImportedPath(ALERT_PATH, (m: any) => {
            if (m) apply(m)
            else cleanup(waitForModuleWithImportedPath(ALERT_PATH, (x: any) => apply(x)) as any)
        }) as any,
    )
}

function patchClose(cleanup: (...f: any[]) => void) {
    const done = new WeakSet<object>()
    cleanup(
        getModules(withProps('closePrivateChannel') as any, (mod: any) => {
            if (typeof mod?.closePrivateChannel !== 'function' || done.has(mod)) return
            done.add(mod)
            cleanup(
                instead(mod, 'closePrivateChannel', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    if (silentUntil > Date.now()) {
                        silentUntil = 0
                        const [id, unselect] = args
                        return orig.call(this, id, unselect ?? false, true)
                    }
                    return orig.apply(this, args)
                }),
            )
        }) as any,
    )
}

export default plugin({
    start({ cleanup }: any) {
        patchAlerts(cleanup)
        patchClose(cleanup)
        cleanup(
            getModules(withProps('getBuiltInCommands') as any, (mod: any) => {
                cleanup(
                    instead(mod, 'getBuiltInCommands', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const result = orig.apply(this, args)
                        try {
                            const types = args?.[0]
                            const wantsChat = Array.isArray(types) ? types.includes(CHAT) : types == null || types === CHAT
                            if (!wantsChat || !Array.isArray(result) || result.some((c: any) => c?.id === COMMAND_ID)) return result
                            return [...result, silentLeaveCommand()]
                        } catch {
                            return result
                        }
                    }),
                )
            }) as any,
        )
    },
} as any)
