import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { after, instead } from '@valenced/patcher'
import { cloneElement, createElement, useState } from 'react'
import { ScrollView } from 'react-native'

/**
 * Better Font Scale: 채팅 화면 글자 크기를 종류별로 정한다 (원본: Aliucord 의 RazerTexz/BetterFontScale).
 * 크기를 바꾸는 건 네이티브(안드로이드)가, 설정은 여기(JS)서 보낸다. 0 이면 디스코드 기본 크기.
 */

const NATIVE = 'yumistra.better-font-scale'
const native = (name: string, args: any[] = []) => Promise.resolve((callNativeMethod as any)(`${NATIVE}.${name}`, args))

const FIELDS: Array<[key: string, label: string]> = [
    ['messages', 'Messages'],
    ['chatbox', 'Chatbox'],
    ['username', 'Username'],
    ['timestamp', 'Timestamp'],
    ['reply', 'Reply'],
    ['tags', 'Tags (bot, role, server)'],
    ['embeds', 'Embeds'],
    ['reactions', 'Reactions'],
    ['chatOther', 'Other chat text'],
    ['aboutMe', 'About Me'],
    ['gameStatus', 'Game Status'],
    ['profileStatus', 'Profile Status'],
    ['category', 'Channel Category Name'],
    ['channel', 'Channel Name'],
    ['voice', 'Voice Channel Name'],
    ['thread', 'Channel Thread Name'],
]

// ── React Native 로 그리는 곳: 그 화면 요소가 그린 결과에서 글자 요소를 찾아 크기를 바꾼다 ──
/** 경로, 종류, 바꿀 글 (없으면 그 요소 안의 글 전부). default 함수 하나만 패치한다 */
const RN_TARGETS: Array<{ path: string; key: string; name?: (props: any) => string | undefined }> = [
    { path: 'modules/profile_customization/native/BioText.tsx', key: 'aboutMe' },
    { path: 'modules/user_profile/native/UserProfileCustomStatusBubble.tsx', key: 'profileStatus' },
    { path: 'modules/activity_status/native/ActivityStatusText.tsx', key: 'gameStatus' },
    { path: 'modules/channel_list_v2/native/items/RedesignCategory.tsx', key: 'category', name: p => p?.category?.name ?? p?.channel?.name },
]

const rnStatus: Record<string, string> = {}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** 요소의 글 (children 이 글이거나 글 몇 개의 배열이면) */
function textOf(node: any): string | undefined {
    const c = node?.props?.children
    if (typeof c === 'string') return c
    if (Array.isArray(c) && c.length && c.every(x => typeof x === 'string' || typeof x === 'number')) return c.join('')
}

/** 결과 트리를 돌며 글 요소의 크기를 바꾼다. 바꾼 개수 */
function resize(node: any, size: number, name: string | undefined, depth = 0): number {
    if (!node || typeof node !== 'object' || depth > 14) return 0
    if (Array.isArray(node)) return node.reduce((n, x) => n + resize(x, size, name, depth + 1), 0)
    const props = node.props
    if (!props) return 0
    const t = textOf(node)
    if (t != null && (name == null || norm(t) === norm(name))) {
        props.style = [props.style, { fontSize: size, lineHeight: Math.round(size * 1.3) }]
        return 1
    }
    // 글 요소 안의 글(이모지, 멘션 등이 섞인 About Me) 은 바깥 글 요소째로
    if (name == null && props.variant && props.children != null && typeof props.children === 'object') {
        props.style = [props.style, { fontSize: size, lineHeight: Math.round(size * 1.3) }]
        return 1
    }
    return resize(props.children, size, name, depth + 1)
}

/** 클래스 컴포넌트는 그냥 부르면 안 된다 */
const isPlainFunction = (f: any) => typeof f === 'function' && !f.prototype?.isReactComponent && !/^class\b/.test(Function.prototype.toString.call(f))

function patchRn(cleanup: (...f: any[]) => void) {
    for (const t of RN_TARGETS) {
        const short = t.path.split('/').pop()!
        rnStatus[short] = 'not loaded yet'
        let hits = 0
        cleanup(
            getModuleWithImportedPath(t.path, (mod: any) => {
                const d = mod?.default
                const spot: [any, string] | null = isPlainFunction(d) ? [mod, 'default'] : isPlainFunction(d?.type) ? [d, 'type'] : isPlainFunction(d?.render) ? [d, 'render'] : null
                if (!spot) {
                    rnStatus[short] = 'nothing to patch'
                    return
                }
                cleanup(
                    after(spot[0], spot[1], (args: any[], out: any) => {
                        try {
                            const size = sizes()[t.key]
                            if (!size) return out
                            const n = resize(out, size, t.name?.(args?.[0]))
                            if (n) rnStatus[short] = `patched, ${(hits += n)} changed`
                            else if (!hits) rnStatus[short] = 'patched, no text found'
                        } catch (e: any) {
                            rnStatus[short] = `error: ${e?.message ?? e}`
                        }
                        return out
                    }),
                )
                rnStatus[short] = 'patched'
            }) as any,
        )
    }
    patchChannelNames(cleanup)
}

/**
 * 채널 이름: BaseChannelItem 은 이름을 직접 그리지 않고 name 요소(이름 전용 컴포넌트)로 받는다.
 * 그 요소에 크기를 실어 보내고, 이름 컴포넌트가 그린 글의 크기를 바꾼다. 채널 종류로 채널, 음성, 스레드를 나눈다.
 */
const SIZE_PROP = '__bfsSize'
const patchedNameTypes = new WeakSet<any>()
function patchNameType(type: any, cleanup: (...f: any[]) => void) {
    if (!type || patchedNameTypes.has(type)) return
    const spot: [any, string] | null = isPlainFunction(type) ? null : isPlainFunction(type?.type) ? [type, 'type'] : isPlainFunction(type?.render) ? [type, 'render'] : null
    patchedNameTypes.add(type)
    if (!spot) return false
    cleanup(
        after(spot[0], spot[1], (args: any[], out: any) => {
            const size = args?.[0]?.[SIZE_PROP]
            if (size) {
                try {
                    if (resize(out, size, undefined)) rnStatus['channel names'] = 'patched, changing'
                } catch {}
            }
            return out
        }),
    )
    return true
}
function patchChannelNames(cleanup: (...f: any[]) => void) {
    rnStatus['channel names'] = 'not loaded yet'
    cleanup(
        getModuleWithImportedPath('modules/guild_sidebar/native/BaseChannelItem.tsx', (mod: any) => {
            if (!isPlainFunction(mod?.default)) {
                rnStatus['channel names'] = 'nothing to patch'
                return
            }
            rnStatus['channel names'] = 'patched'
            cleanup(
                instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    try {
                        const p = args[0]
                        const channel = p?.icon?.props?.channel ?? p?.channel
                        const key = [2, 13].includes(channel?.type) ? 'voice' : [10, 11, 12].includes(channel?.type) ? 'thread' : 'channel'
                        const size = sizes()[key]
                        const name = p?.name
                        if (size && name && typeof name === 'object' && name.props) {
                            // 이름 컴포넌트가 함수면 감싸서 그린 결과를 고치고, memo, forwardRef 면 그 안을 패치한다
                            if (isPlainFunction(name.type)) {
                                const el = createElement(wrapName(name.type), { ...name.props, key: name.key, [SIZE_PROP]: size })
                                return orig.apply(this, [{ ...p, name: el }, ...args.slice(1)])
                            }
                            patchNameType(name.type, cleanup)
                            return orig.apply(this, [{ ...p, name: cloneElement(name, { [SIZE_PROP]: size }) }, ...args.slice(1)])
                        }
                    } catch {}
                    return orig.apply(this, args)
                }),
            )
        }) as any,
    )
}

/** 함수 이름 컴포넌트를 감싼 것 (컴포넌트마다 하나, 매번 같은 것을 써야 다시 만들어지지 않는다) */
const wrapped = new WeakMap<any, any>()
function wrapName(Inner: any) {
    let W = wrapped.get(Inner)
    if (!W) {
        W = (props: any) => {
            const out = Inner(props)
            const size = props?.[SIZE_PROP]
            if (size) {
                try {
                    if (resize(out, size, undefined)) rnStatus['channel names'] = 'patched, changing'
                } catch {}
            }
            return out
        }
        wrapped.set(Inner, W)
    }
    return W
}

type Sizes = Record<string, number>
let storage: any
const sizes = (): Sizes => ({ ...(storage?.cache ?? {}) })

function sendConfig() {
    native('config', [JSON.stringify(sizes())]).catch(() => {})
}

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`better-font-scale-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function SizeInput({ label, value, onSave }: { label: string; value: number; onSave: (v: number) => void; key?: string }) {
    const { TextInput } = Design as any
    const [text, setText] = useState(String(value ?? 0))
    const n = Number(text)
    const bad = text.trim() === '' || !Number.isFinite(n) || n < 0 || n > 80
    return (
        <TextInput
            label={label}
            value={text}
            keyboardType="numeric"
            placeholder="0"
            errorMessage={bad ? 'Enter a number from 0 to 80.' : undefined}
            onChange={(v: string) => {
                setText(v)
                const x = Number(v)
                if (v.trim() !== '' && Number.isFinite(x) && x >= 0 && x <= 80) onSave(x)
            }}
            size="md"
        />
    )
}

/** 디스코드 전체 글자 크기 (%) */
function AllInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
    const { TextInput } = Design as any
    const [text, setText] = useState(String(value || 100))
    const n = Number(text)
    const bad = text.trim() === '' || !Number.isFinite(n) || n < 50 || n > 300
    return (
        <TextInput
            label="All text (%)"
            value={text}
            keyboardType="numeric"
            placeholder="100"
            errorMessage={bad ? 'Enter a number from 50 to 300.' : undefined}
            onChange={(v: string) => {
                setText(v)
                const x = Number(v)
                if (v.trim() !== '' && Number.isFinite(x) && x >= 50 && x <= 300) onSave(x)
            }}
            size="md"
        />
    )
}

function SettingsPage() {
    storage?.use?.()
    const s = sizes()
    const { Stack, Text, Button } = Design as any
    const save = (key: string, v: number) => {
        storage?.set?.({ ...sizes(), [key]: v }, true)
        sendConfig()
    }
    // 5 초 뒤에 복사: 그 사이에 채팅 화면이나 프로필로 가서 그 화면의 칸을 담는다
    const copy = () => {
        toast('Go to the screen to check, copying in 5 seconds')
        setTimeout(copyNow, 5000)
    }
    const copyNow = async () => {
        try {
            const list = await native('scan')
            const st = await native('status').catch(() => ({}))
            const rn = Object.entries(rnStatus)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')
            Clipboard.setString(`Better Font Scale log\nStatus: ${JSON.stringify(st)}\n\nReact Native parts:\n${rn}\n\nText views (id | class | size | type | text):\n${list}`)
            toast('Copied')
        } catch (e: any) {
            toast(`Failed: ${e?.message ?? e}`)
        }
    }
    return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
            <AllInput value={s.all ?? 100} onSave={v => save('all', v)} />
            <Text variant="text-sm/medium" color="text-muted">
                Restart Discord after changing it.
            </Text>
            <Text variant="heading-md/bold">Each part</Text>
            <Text variant="text-sm/medium" color="text-muted">
                0 = default
            </Text>
            <Stack spacing={12}>
                {FIELDS.map(([key, label]) => (
                    <SizeInput key={key} label={label} value={s[key] ?? 0} onSave={v => save(key, v)} />
                ))}
            </Stack>
            <Button size="lg" variant="secondary" text="Copy log" onPress={copy} />
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: {} },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        patchRn(cleanup)
        sendConfig()
        // 저장된 설정을 읽어 오는 데 시간이 걸릴 수 있어서 조금 뒤에 한 번 더
        const again = [setTimeout(sendConfig, 1500), setTimeout(sendConfig, 5000)]
        cleanup(() => again.forEach(clearTimeout))
    },
    SettingsComponent: SettingsPage,
} as any)
