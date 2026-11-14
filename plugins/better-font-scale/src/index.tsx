import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { after } from '@valenced/patcher'
import { useState } from 'react'
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
    ['aboutMe', 'About Me'],
    ['gameStatus', 'Game Status'],
    ['profileStatus', 'Profile Status'],
    ['category', 'Channel Category Name'],
    ['channel', 'Channel Name'],
    ['voice', 'Voice Channel Name'],
    ['thread', 'Channel Thread Name'],
]

// ── React Native 로 그리는 곳: 그 화면 요소가 그린 결과에서 글자 요소를 찾아 크기를 바꾼다 ──
/** 경로, 종류, 바꿀 글 (없으면 그 요소 안의 글 전부) */
const RN_TARGETS: Array<{ path: string; key: string | ((props: any) => string); name?: (props: any) => string | undefined }> = [
    { path: 'modules/profile_customization/native/BioText.tsx', key: 'aboutMe' },
    { path: 'modules/user_profile/native/UserProfileCustomStatusBubble.tsx', key: 'profileStatus' },
    { path: 'modules/activity_status/native/ActivityStatusText.tsx', key: 'gameStatus' },
    { path: 'modules/channel_list_v2/native/items/RedesignCategory.tsx', key: 'category', name: p => p?.category?.name ?? p?.channel?.name },
    { path: 'modules/channel_list_v2/native/items/TextChannel.tsx', key: 'channel', name: p => p?.channel?.name },
    { path: 'modules/channel_list_v2/native/items/VoiceChannel.tsx', key: 'voice', name: p => p?.channel?.name },
    { path: 'modules/channel_list_v2/native/items/ThreadChannel.tsx', key: 'thread', name: p => p?.channel?.name ?? p?.thread?.name },
    // 채널 줄이 공통으로 쓰는 것: 채널 종류로 나눈다 (2 음성, 13 무대, 10~12 스레드)
    {
        path: 'modules/guild_sidebar/native/BaseChannelItem.tsx',
        key: p => ([2, 13].includes(p?.channel?.type) ? 'voice' : [10, 11, 12].includes(p?.channel?.type) ? 'thread' : 'channel'),
        name: p => p?.channel?.name,
    },
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

function patchRn(cleanup: (...f: any[]) => void) {
    for (const t of RN_TARGETS) {
        const short = t.path.split('/').pop()!
        rnStatus[short] = 'not loaded yet'
        let hits = 0
        cleanup(
            getModuleWithImportedPath(t.path, (mod: any) => {
                // 그냥 함수일 수도, memo, forwardRef 로 싸여 있을 수도 있다
                const spots: Array<[any, string]> = []
                for (const k of Object.keys(mod ?? {})) {
                    const v = mod[k]
                    if (k !== 'default' && !/^[A-Z]/.test(k)) continue
                    if (typeof v === 'function') spots.push([mod, k])
                    else if (typeof v?.type === 'function') spots.push([v, 'type'])
                    else if (typeof v?.render === 'function') spots.push([v, 'render'])
                }
                if (!spots.length) {
                    rnStatus[short] = `nothing to patch (${Object.keys(mod ?? {}).join(', ')})`
                    return
                }
                for (const [obj, key] of spots)
                    cleanup(
                        after(obj, key, (args: any[], out: any) => {
                            try {
                                const props = args?.[0]
                                const k = typeof t.key === 'function' ? t.key(props) : t.key
                                const size = sizes()[k]
                                if (!size) return out
                                const n = resize(out, size, t.name?.(props))
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

function SettingsPage() {
    storage?.use?.()
    const s = sizes()
    const { Stack, Text, Button } = Design as any
    const save = (key: string, v: number) => {
        storage?.set?.({ ...sizes(), [key]: v }, true)
        sendConfig()
    }
    const copy = async () => {
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
            <Text variant="text-sm/medium" color="text-muted">
                0 = default. Profiles and the channel list update the next time they show.
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
