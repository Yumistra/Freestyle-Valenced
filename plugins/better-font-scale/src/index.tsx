import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
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
]

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
            Clipboard.setString(`Better Font Scale log\nStatus: ${JSON.stringify(st)}\n\nText views (id | class | size | type | text):\n${list}`)
            toast('Copied')
        } catch (e: any) {
            toast(`Failed: ${e?.message ?? e}`)
        }
    }
    return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
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
        sendConfig()
        // 저장된 설정을 읽어 오는 데 시간이 걸릴 수 있어서 조금 뒤에 한 번 더
        const again = [setTimeout(sendConfig, 1500), setTimeout(sendConfig, 5000)]
        cleanup(() => again.forEach(clearTimeout))
    },
    SettingsComponent: SettingsPage,
} as any)
