import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
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
    /** 말하지 않는 사람의 투명도 */
    idleAlpha: number
    x?: number
    y?: number
}
const DEFAULTS: Settings = { enabled: true, onlySpeaking: false, hideInDiscord: true, scale: 1, opacity: 1, idleAlpha: 0.45 }
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

// ── 오버레이에서 온 일: 나가기, 간이 채팅 ─────────────────────────
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}
const myId = () => {
    try {
        return S().UserStore?.getCurrentUser?.()?.id
    } catch {}
}
/** 오늘이면 시간만, 아니면 날짜도 */
function timeText(t: number) {
    const d = new Date(t)
    const now = new Date()
    const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString()} ${hm}`
}

let chatOn = false
let chatChannel: string | undefined
let chatTimer: any
let lastChat = ''

/** 간이 채팅에 보낼 최근 메시지 (음성 채널의 채팅) */
function pushChat() {
    clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
        if (!chatOn || !chatChannel) return
        try {
            const ch = S().ChannelStore?.getChannel?.(chatChannel)
            const guildId = ch?.guild_id ?? null
            const msgs = S().MessageStore?.getMessages?.(chatChannel)
            const arr: any[] = msgs?.toArray?.() ?? msgs?._array ?? []
            const list = arr.slice(-40)
            // 디스코드처럼: 같은 사람이 7분 안에 이어 쓰면 이름과 사진 없이 내용만
            const messages = list.map((m, i) => {
                const prev = list[i - 1]
                const t = Number(m.timestamp?.valueOf?.() ?? Date.parse(m.timestamp)) || Date.now()
                const pt = prev ? Number(prev.timestamp?.valueOf?.() ?? Date.parse(prev.timestamp)) || 0 : 0
                const head = !prev || prev.author?.id !== m.author?.id || t - pt > 7 * 60000 || !!m.messageReference
                let color = ''
                try {
                    color = (guildId && S().GuildMemberStore?.getMember?.(guildId, m.author?.id)?.colorString) || ''
                } catch {}
                return {
                    author: nameOf(m.author?.id, guildId),
                    color,
                    avatar: avatarOf(m.author?.id, guildId),
                    time: timeText(t),
                    content: (m.content || (m.attachments?.length ? `[${m.attachments.map((a: any) => a.filename).join(', ')}]` : m.stickerItems?.length || m.sticker_items?.length ? '[Sticker]' : m.embeds?.length ? '[Embed]' : '')).slice(0, 800),
                    head,
                }
            })
            const json = JSON.stringify({ title: ch?.name ?? 'Voice chat', messages })
            if (json === lastChat) return
            lastChat = json
            native('chat', [json]).catch(() => {})
        } catch {}
    }, 120)
}

function openChat() {
    chatOn = true
    chatChannel = S().SelectedChannelStore?.getVoiceChannelId?.()
    lastChat = ''
    // 아직 안 받은 채널이면 최근 메시지를 받아 온다
    try {
        const msgs = S().MessageStore?.getMessages?.(chatChannel)
        if (chatChannel && !(msgs?.length ?? msgs?._array?.length)) find('fetchMessages', 'sendMessage')?.fetchMessages?.({ channelId: chatChannel, limit: 30 })
    } catch {}
    pushChat()
}

function send(text: string) {
    const channelId = chatChannel ?? S().SelectedChannelStore?.getVoiceChannelId?.()
    const actions = find('sendMessage', 'receiveMessage')
    if (!channelId || !actions) return toast('Could not send the message')
    try {
        actions.sendMessage(channelId, { content: text, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] }, undefined, {})
    } catch {
        toast('Could not send the message')
    }
}

function leave() {
    try {
        const v = find('selectVoiceChannel', 'disconnect') ?? find('selectVoiceChannel')
        if (typeof v?.disconnect === 'function') v.disconnect()
        else v?.selectVoiceChannel?.(null)
    } catch {
        toast('Could not leave the voice channel')
    }
}

/** 마이크, 헤드셋 끄기 */
function toggle(kind: 'mute' | 'deafen') {
    try {
        const m = find('toggleSelfMute', 'toggleSelfDeaf')
        if (kind === 'mute') m.toggleSelfMute()
        else m.toggleSelfDeaf()
    } catch {
        toast(kind === 'mute' ? 'Could not change the microphone' : 'Could not change the headset')
    }
}

/** 방송(화면 공유) 켜기, 끄기 */
function stream() {
    try {
        const st = S().ApplicationStreamingStore
        const mine = st?.getCurrentUserActiveStream?.()
        const m = find('stopStream', 'startStream') ?? find('stopStream')
        if (mine) {
            const key = mine.streamKey ?? `${mine.streamType}:${mine.guildId}:${mine.channelId}:${mine.ownerId}`
            if (typeof m?.stopStream === 'function') return m.stopStream(key)
        } else {
            const channelId = S().SelectedChannelStore?.getVoiceChannelId?.()
            const guildId = S().ChannelStore?.getChannel?.(channelId)?.guild_id ?? null
            if (typeof m?.startStream === 'function') return m.startStream(guildId, channelId, {})
        }
        toast('Go Live is not available here')
    } catch (e: any) {
        toast(`Go Live failed: ${e?.message ?? e}`)
    }
}

/** 내 상태를 오버레이 메뉴에 알린다 */
let lastSelf = ''
function pushSelf() {
    try {
        const me = S().MediaEngineStore
        const st = [!!me?.isSelfMute?.(), !!me?.isSelfDeaf?.(), !!S().ApplicationStreamingStore?.getCurrentUserActiveStream?.()]
        const k = st.join()
        if (k === lastSelf) return
        lastSelf = k
        native('self', st).catch(() => {})
    } catch {}
}

async function takeEvents() {
    let list: any[] = []
    try {
        list = JSON.parse(String(await native('events')))
    } catch {
        return
    }
    for (const e of list) {
        if (e?.type === 'leave' || (e?.type === 'action' && e.name === 'leave')) leave()
        else if (e?.type === 'action' && (e.name === 'mute' || e.name === 'deafen')) toggle(e.name)
        else if (e?.type === 'action' && e.name === 'stream') stream()
        else if (e?.type === 'chatOpen') openChat()
        else if (e?.type === 'chatClose') chatOn = false
        else if (e?.type === 'send' && typeof e.text === 'string') send(e.text)
    }
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
    const pick = (label: string, value: number, key: 'scale' | 'opacity' | 'idleAlpha', options: Array<[number, string]>) => (
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
                {pick('People not talking', s.idleAlpha, 'idleAlpha' as any, [
                    [0.25, '25%'],
                    [0.45, '45%'],
                    [0.7, '70%'],
                    [1, '100%'],
                ])}
                {pick('Opacity', s.opacity, 'opacity', [
                    [0.5, '50%'],
                    [0.75, '75%'],
                    [1, '100%'],
                ])}
                <Button size="md" variant="secondary" text="Reset position" onPress={() => save({ x: 24, y: 200 })} />
                <Button
                    size="md"
                    variant="secondary"
                    text="Copy log"
                    onPress={async () => {
                        try {
                            const st = await native('status')
                            const words = ['microphone', 'mic', 'headphone', 'headset', 'deafen', 'screen', 'stream', 'hangup', 'disconnect', 'chat', 'send', 'close']
                            const found: string[] = []
                            for (const w of words) found.push(`${w}: ${await native('findIcons', [w])}`)
                            Clipboard.setString(`Voice Overlay log\nStatus: ${JSON.stringify(st)}\n\nIcons:\n${found.join('\n')}`)
                            toast('Copied')
                        } catch (e: any) {
                            toast(`Could not copy: ${e?.message ?? e}`)
                        }
                    }}
                />
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        sendConfig()
        for (const name of ['MediaEngineStore', 'ApplicationStreamingStore']) {
            const st = S()[name]
            if (!st?.addChangeListener) continue
            st.addChangeListener(pushSelf)
            cleanup(() => st.removeChangeListener?.(pushSelf))
        }
        pushSelf()
        const stores = ['SpeakingStore', 'VoiceStateStore', 'SelectedChannelStore', 'UserStore', 'GuildMemberStore']
        for (const name of stores) {
            const st = S()[name]
            if (!st?.addChangeListener) continue
            st.addChangeListener(push)
            cleanup(() => st.removeChangeListener?.(push))
        }
        push()
        // 간이 채팅은 메시지가 바뀔 때마다
        const ms = S().MessageStore
        if (ms?.addChangeListener) {
            ms.addChangeListener(pushChat)
            cleanup(() => ms.removeChangeListener?.(pushChat))
        }
        // 오버레이에서 온 일 (음성 채널에 있을 때만 자주 본다)
        const ev = setInterval(() => {
            if (chatOn || S().SelectedChannelStore?.getVoiceChannelId?.()) takeEvents()
        }, 250)
        cleanup(() => clearInterval(ev))
        // 음성 채널을 나가면 채팅 창도 닫는다
        const sel = S().SelectedChannelStore
        const onSel = () => {
            if (chatOn && !sel?.getVoiceChannelId?.()) {
                chatOn = false
                native('closeChat').catch(() => {})
            }
        }
        sel?.addChangeListener?.(onSel)
        cleanup(() => sel?.removeChangeListener?.(onSel))
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
