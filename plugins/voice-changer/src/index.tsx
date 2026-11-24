import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'

/**
 * Voice Changer (test): 음성 채널에서 내 마이크 소리를 바꾼다.
 * 소리를 바꾸는 건 네이티브(안드로이드)가 한다: 디스코드는 마이크를 안드로이드 AudioRecord 로 읽으므로
 * 읽은 직후의 소리를 그 자리에서 바꾼다. 여기(JS)는 고른 목소리를 저장하고 보낸다.
 */

const NATIVE = 'yumistra.voice-changer'
const native = (name: string, args: any[] = []) => Promise.resolve((callNativeMethod as any)(`${NATIVE}.${name}`, args))

const VOICES: Array<{ id: string; label: string; icon: string }> = [
    { id: 'off', label: 'Off (your normal voice)', icon: 'MicrophoneIcon' },
    { id: 'girl', label: 'Girl voice', icon: 'StarIcon' },
    { id: 'deep', label: 'Deep man voice', icon: 'ShieldIcon' },
    { id: 'baby', label: 'Baby voice', icon: 'HeartIcon' },
    { id: 'bad', label: 'BAD VOICE (loud, cheap mic)', icon: 'WarningIcon' },
]

let storage: any
const voice = (): string => storage?.cache?.voice ?? 'off'
const toast = (content: string) => (ToastActionCreators as any)?.open?.({ key: `vc-${Date.now()}`, content })
const send = () => native('set', [voice()]).catch(() => {})

function SettingsPage() {
    storage?.use?.()
    const { Text, Button, TableRowGroup, TableRow, TableRadioGroup, TableRadioRow } = Design as any
    const [st, setSt] = useState<any>({})
    useEffect(() => {
        let alive = true
        const tick = () =>
            native('status')
                .then(r => alive && setSt(typeof r === 'string' ? JSON.parse(r) : (r ?? {})))
                .catch(() => {})
        tick()
        const t = setInterval(tick, 1000)
        return () => {
            alive = false
            clearInterval(t)
        }
    }, [])
    const pick = (id: string) => {
        storage?.set?.({ ...(storage?.cache ?? {}), voice: id }, true)
        send()
    }
    const radio = TableRadioGroup && TableRadioRow
    return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
            {radio ? (
                <TableRadioGroup title="Voice" value={voice()} onChange={pick}>
                    {VOICES.map(v => (
                        <TableRadioRow key={v.id} label={v.label} value={v.id} />
                    ))}
                </TableRadioGroup>
            ) : (
                <TableRowGroup title="Voice">
                    {VOICES.map(v => (
                        <TableRow key={v.id} label={`${voice() === v.id ? '● ' : '○ '}${v.label}`} onPress={() => pick(v.id)} />
                    ))}
                </TableRowGroup>
            )}
            <View style={{ gap: 4 }}>
                <Text variant="heading-sm/bold">Test status</Text>
                <Text variant="text-sm/medium" color="text-muted">
                    {st.reads
                        ? `Mic is being changed: ${st.processed ?? 0} of ${st.reads} reads, ${st.rate ?? '?'} Hz, ${st.channels ?? '?'} ch, format ${st.format ?? '?'}`
                        : st.hooked
                          ? 'Ready. Join a voice channel and talk to test it.'
                          : 'The mic hook is not on.'}
                </Text>
                {st.error ? (
                    <Text variant="text-xs/medium" color="text-danger">
                        {String(st.error)}
                    </Text>
                ) : null}
            </View>
            <Button
                size="md"
                variant="secondary"
                text="Copy test log"
                onPress={() => {
                    Clipboard.setString(`Voice Changer ${voice()}\n${JSON.stringify(st, null, 1)}`)
                    toast('Copied')
                }}
            />
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: { voice: 'off' } },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        send()
        // 저장된 설정을 읽어 오는 데 시간이 걸릴 수 있어서 조금 뒤에 한 번 더
        const again = [1500, 5000].map(ms => setTimeout(send, ms))
        cleanup(() => again.forEach(clearTimeout), () => native('set', ['off']).catch(() => {}))
    },
    SettingsComponent: SettingsPage,
} as any)
