import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { useEffect, useState } from 'react'
import { AppState, ScrollView, View } from 'react-native'

/**
 * Voice Overlay: PC 의 음성 오버레이처럼, 음성 채널에 있는 사람들(프로필 사진, 이름, 말하면 초록 테두리)을
 * 게임 같은 다른 앱 위에 띄운다. 그리는 건 네이티브(안드로이드)가, 사람 목록은 여기(JS)서 보낸다.
 */

const NATIVE = 'yumistra.voice-overlay'
const S = () => Stores as any

interface Settings {
    enabled: boolean
    onlySpeaking: boolean
    hideInDiscord: boolean
    scale: number
    opacity: number
    x?: number
    y?: number
}
const DEFAULTS: Settings = { enabled: true, onlySpeaking: false, hideInDiscord: true, scale: 1, opacity: 1 }
let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
const native = (name: string, args: any[] = []) => Promise.resolve((callNativeMethod as any)(`${NATIVE}.${name}`, args))

function save(patch: Partial<Settings>) {
    storage?.set?.({ ...settings(), ...patch }, true)
    sendConfig()
}
function sendConfig() {
    const s = settings()
    native('config', [JSON.stringify(s)]).catch(() => {})
}

// ── 음성 채널 사람들 ─────────────────────────────────────────────
function avatarOf(userId: string, guildId?: string | null): string {
    try {
        const member = guildId ? S().GuildMemberStore?.getMember?.(guildId, userId) : undefined
        if (member?.avatar) return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.png?size=96`
        const u = S().UserStore?.getUser?.(userId)
        if (u?.avatar) return `https://cdn.discordapp.com/avatars/${userId}/${u.avatar}.png?size=96`
        return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`
    } catch {
        return ''
    }
}
function nameOf(userId: string, guildId?: string | null): string {
    try {
        const nick = guildId ? S().GuildMemberStore?.getNick?.(guildId, userId) : undefined
        const u = S().UserStore?.getUser?.(userId)
        return nick || u?.globalName || u?.global_name || u?.username || userId
    } catch {
        return userId
    }
}

function snapshot() {
    const channelId = S().SelectedChannelStore?.getVoiceChannelId?.()
    if (!channelId) return []
    const guildId = S().ChannelStore?.getChannel?.(channelId)?.guild_id ?? null
    const states = S().VoiceStateStore?.getVoiceStatesForChannel?.(channelId) ?? {}
    const list = (Array.isArray(states) ? states : Object.values(states)) as any[]
    return list
        .map(v => {
            const id = v?.userId ?? v?.user_id
            if (!id) return null
            return {
                id,
                name: nameOf(id, guildId),
                avatar: avatarOf(id, guildId),
                speaking: !!S().SpeakingStore?.isSpeaking?.(id),
                muted: !!(v.selfMute || v.mute || v.self_mute),
                deafened: !!(v.selfDeaf || v.deaf || v.self_deaf),
            }
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
}

let timer: any
let lastSent = ''
function push() {
    clearTimeout(timer)
    timer = setTimeout(() => {
        try {
            const json = JSON.stringify(snapshot())
            if (json === lastSent) return
            lastSent = json
            native('update', [json]).catch(() => {})
        } catch {}
    }, 60)
}

const toast = (text: string) => {
    try {
        ;(ToastActionCreators as any).open(`voice-overlay-${Date.now()}`, { text })
    } catch {}
}

// ── 설정 화면 ───────────────────────────────────────────────────
function SettingsPage() {
    storage?.use?.()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, Button, Text } = Design as any
    const s = settings()
    const [allowed, setAllowed] = useState<boolean | undefined>()
    useEffect(() => {
        const check = () =>
            native('canOverlay')
                .then(v => setAllowed(!!v))
                .catch(() => setAllowed(undefined))
        check()
        // 설정 화면에서 권한을 켜고 돌아오면 다시 확인
        const sub = AppState.addEventListener('change', st => st === 'active' && check())
        return () => sub.remove()
    }, [])
    const pick = (label: string, value: number, key: 'scale' | 'opacity', options: Array<[number, string]>) => (
        <View>
            <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 8 }}>
                {label}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {options.map(([v, t]) => (
                    <Button key={t} size="sm" text={t} variant={Math.abs(value - v) < 0.01 ? 'primary' : 'secondary'} onPress={() => save({ [key]: v } as any)} />
                ))}
            </View>
        </View>
    )
    return (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
            <Stack spacing={16}>
                <Text variant="text-sm/normal" color="text-muted">
                    When you are in a voice channel, the people in it show up over other apps, with a green ring on whoever is talking. Drag the overlay to move it.
                </Text>
                <TableRowGroup title="Display over other apps">
                    <TableRow
                        label={allowed ? 'Allowed' : allowed === false ? 'Not allowed yet' : 'Checking'}
                        subLabel={allowed ? 'The overlay shows over games and other apps' : 'Without it, the overlay only shows inside Discord'}
                        onPress={allowed ? undefined : () => native('requestOverlay').catch(() => toast('Could not open the settings'))}
                        arrow={!allowed}
                    />
                </TableRowGroup>
                <TableRowGroup>
                    <TableSwitchRow label="Show the overlay" value={s.enabled} onValueChange={(v: boolean) => save({ enabled: v })} />
                    <TableSwitchRow label="Only people talking" value={s.onlySpeaking} onValueChange={(v: boolean) => save({ onlySpeaking: v })} />
                    <TableSwitchRow label="Hide while Discord is open" value={s.hideInDiscord} onValueChange={(v: boolean) => save({ hideInDiscord: v })} />
                </TableRowGroup>
                {pick('Size', s.scale, 'scale', [
                    [0.75, 'Small'],
                    [1, 'Normal'],
                    [1.3, 'Large'],
                ])}
                {pick('Opacity', s.opacity, 'opacity', [
                    [0.5, '50%'],
                    [0.75, '75%'],
                    [1, '100%'],
                ])}
                <Button size="md" variant="secondary" text="Reset position" onPress={() => save({ x: 24, y: 200 })} />
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        sendConfig()
        const stores = ['SpeakingStore', 'VoiceStateStore', 'SelectedChannelStore', 'UserStore', 'GuildMemberStore']
        for (const name of stores) {
            const st = S()[name]
            if (!st?.addChangeListener) continue
            st.addChangeListener(push)
            cleanup(() => st.removeChangeListener?.(push))
        }
        push()
        // 끌어서 옮긴 위치를 저장해 둔다 (다음에 디스코드를 켜도 그 자리)
        const pos = setInterval(() => {
            native('position')
                .then((p: any) => {
                    if (!Array.isArray(p)) return
                    const s = settings()
                    if (p[0] !== s.x || p[1] !== s.y) storage?.set?.({ ...s, x: p[0], y: p[1] }, true)
                })
                .catch(() => {})
        }, 5000)
        cleanup(() => clearInterval(pos))
        cleanup(() => {
            clearTimeout(timer)
            native('update', ['[]']).catch(() => {})
        })
    },
    SettingsComponent: SettingsPage,
} as any)
