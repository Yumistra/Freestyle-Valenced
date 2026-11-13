import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { callNativeMethod } from '@valenced/modules/native'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { instead } from '@valenced/patcher'
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
    /** 끌어서 옮기지 못하게 */
    locked: boolean
    /** 터치가 오버레이를 지나 아래 앱(게임)으로 간다 */
    passThrough: boolean
    /** 오버레이를 길게 누르면 */
    longPress: 'menu' | 'chat' | 'off'
    /** 채팅 버튼: 톡, 길게 누르기, 숨기기 */
    chatButton: 'tap' | 'long' | 'hidden'
    /** 디스코드가 직접 띄우는 오버레이를 막는다 */
    hideDiscordOverlay: boolean
    x?: number
    y?: number
}
const DEFAULTS: Settings = { enabled: true, onlySpeaking: false, hideInDiscord: true, scale: 1, opacity: 1, idleAlpha: 0.45, locked: false, passThrough: false, longPress: 'menu', chatButton: 'long', hideDiscordOverlay: false }
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
                live: !!(v.selfStream || v.self_stream),
            }
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
}

// ── 디스코드 안의 떠 있는 통화 창 (오른쪽 위 작은 타일) 숨기기 ─────────
const PIP_PATH = 'modules/voice_panel/native/pip/VoicePanelPIP.tsx'
let pipStatus = 'not found yet'
function patchCallTile(cleanup: (...f: any[]) => void) {
    cleanup(
        getModuleWithImportedPath(PIP_PATH, (mod: any) => {
            // 그냥 함수일 수도, memo/forwardRef 로 싸여 있을 수도 있다
            const targets: Array<[any, string]> = []
            // 화면 요소만 (대문자 이름이나 default). 도우미 함수는 건드리지 않는다
            const keys = Object.keys(mod ?? {}).filter(k => k === 'default' || /^[A-Z]/.test(k) || /^[A-Z]/.test(mod[k]?.name ?? ''))
            for (const key of keys) {
                const v = mod[key]
                if (typeof v === 'function') targets.push([mod, key])
                else if (v && typeof v === 'object') {
                    if (typeof v.type === 'function') targets.push([v, 'type'])
                    else if (typeof v.render === 'function') targets.push([v, 'render'])
                }
            }
            if (!targets.length) {
                pipStatus = `module found, nothing to patch (${Object.keys(mod ?? {}).join(', ')})`
                return
            }
            for (const [obj, key] of targets) {
                cleanup(
                    instead(obj, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const out = orig.apply(this, args)
                        // 훅 순서를 지키려고 원래 것은 그대로 부르고, 결과만 버린다
                        return settings().hideDiscordOverlay ? null : out
                    }),
                )
            }
            pipStatus = `patched ${targets.map(([o, k]) => (o === mod ? k : `${k}()`)).join(', ')}`
        }) as any,
    )
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
/** 테마 색 (토큰 이름 여러 개 중 있는 것) */
function color(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default ?? Tokens
        const theme = S().ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const c = t.colors?.[n] && t.internal?.resolveSemanticColor?.(theme, t.colors[n])
            if (typeof c === 'string') return c
        }
    } catch {}
    return fallback
}

/** 설정 칸을 묶는 카드 (디스코드 설정의 둥근 상자) */
function Card({ children }: { children: any }) {
    return (
        <View
            style={{
                borderRadius: 16,
                borderWidth: 1,
                borderColor: color(['BORDER_SUBTLE', 'BACKGROUND_MOD_SUBTLE'], '#ffffff14'),
                backgroundColor: color(['CARD_PRIMARY_BG', 'BACKGROUND_BASE_LOWER', 'BACKGROUND_SECONDARY'], '#0f1012'),
                padding: 16,
                gap: 18,
            }}
        >
            {children}
        </View>
    )
}

/** 퍼센트를 직접 쓰는 칸. 범위를 벗어나면 빨간 안내, 맞으면 바로 저장 */
function PercentInput({ label, description, value, min, max, onSave }: { label: string; description: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
    const { TextInput } = Design as any
    const [text, setText] = useState(String(Math.round(value * 100)))
    const n = Number(text)
    const bad = text.trim() === '' || !Number.isFinite(n) || n < min || n > max
    return (
        <TextInput
            label={label}
            description={description}
            value={text}
            keyboardType="numeric"
            placeholder={`${min} to ${max}`}
            errorMessage={bad ? `Enter a number from ${min} to ${max}.` : undefined}
            onChange={(v: string) => {
                const t = v.replace(/[^0-9]/g, '').slice(0, 3)
                setText(t)
                const x = Number(t)
                if (t && x >= min && x <= max) onSave(x / 100)
            }}
        />
    )
}

function SettingsPage() {
    storage?.use?.()
    const { TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, Text } = Design as any
    const choose = <T extends string>(title: string, value: T, options: Array<[T, string, string?]>, onChange: (v: T) => void) =>
        TableRadioGroup && TableRadioRow ? (
            <TableRadioGroup title={title} defaultValue={value} onChange={onChange}>
                {options.map(([v, label, sub]) => (
                    <TableRadioRow key={v} label={label} subLabel={sub} value={v} />
                ))}
            </TableRadioGroup>
        ) : (
            <TableRowGroup title={title}>
                {options.map(([v, label, sub]) => (
                    <TableRow key={v} label={`${v === value ? '✓ ' : ''}${label}`} subLabel={sub} onPress={() => onChange(v)} />
                ))}
            </TableRowGroup>
        )
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
    const heading = (t: string) => (
        <Text variant="heading-lg/bold" style={{ marginTop: 8 }}>
            {t}
        </Text>
    )
    const copyLog = async () => {
        try {
            const st = await native('status')
            const words = ['microphone', 'headphones', 'screen', 'phone', 'chat', 'send', 'xsmall']
            const found: string[] = []
            for (const w of words) found.push(`${w}: ${await native('findIcons', [w])}`)
            Clipboard.setString(`Voice Overlay log\nStatus: ${JSON.stringify(st)}\nCall tile: ${pipStatus}\n\nIcons:\n${found.join('\n')}`)
            toast('Copied')
        } catch (e: any) {
            toast(`Could not copy: ${e?.message ?? e}`)
        }
    }
    return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
            <Text variant="text-md/normal" color="text-muted">
                When you are in a voice channel, the people in it show up over other apps, with a green ring on whoever is talking and a red LIVE on whoever is streaming. Drag the overlay to move it, long press it for mute, deafen, Go Live and leave, and long press the chat button to chat. All of this can be changed under Touch.
            </Text>

            {heading('Permission')}
            <TableRowGroup>
                <TableRow
                    label={allowed ? 'Display over other apps, allowed' : allowed === false ? 'Display over other apps, not allowed' : 'Checking'}
                    subLabel={allowed ? 'The overlay shows over games and other apps.' : 'Tap to allow it. Without it, the overlay only shows inside Discord.'}
                    onPress={allowed ? undefined : () => native('requestOverlay').catch(() => toast('Could not open the settings'))}
                    arrow={!allowed}
                />
            </TableRowGroup>

            {heading('Overlay')}
            <TableRowGroup>
                <TableSwitchRow label="Show the overlay" subLabel="Only while you are in a voice channel." value={s.enabled} onValueChange={(v: boolean) => save({ enabled: v })} />
                <TableSwitchRow label="Only people talking" subLabel="The chat button stays, unless it is hidden." value={s.onlySpeaking} onValueChange={(v: boolean) => save({ onlySpeaking: v })} />
                <TableSwitchRow label="Hide while Discord is open" subLabel="Show it only over other apps." value={s.hideInDiscord} onValueChange={(v: boolean) => save({ hideInDiscord: v })} />
                <TableSwitchRow
                    label="Hide Discord's floating call"
                    subLabel="Hides the small call window Discord shows in the corner while you are in a voice channel, so only this overlay shows. Open the call from the voice channel or the panel at the bottom instead."
                    value={s.hideDiscordOverlay}
                    onValueChange={(v: boolean) => save({ hideDiscordOverlay: v })}
                />
            </TableRowGroup>

            {heading('Touch')}
            <TableRowGroup>
                <TableSwitchRow label="Lock position" subLabel="The overlay stays where it is and can't be dragged." value={s.locked} onValueChange={(v: boolean) => save({ locked: v })} />
                <TableSwitchRow
                    label="Touches go through"
                    subLabel="Taps on the overlay reach the app under it, so it never gets in the way of games. The overlay's buttons don't work while this is on, and Android keeps it at most 80% visible."
                    value={s.passThrough}
                    onValueChange={(v: boolean) => save({ passThrough: v })}
                />
            </TableRowGroup>
            {choose('Chat button', s.chatButton, [
                ['long', 'Long press to open', 'A quick tap does nothing, so it is hard to open by mistake.'],
                ['tap', 'Tap to open'],
                ['hidden', 'Hidden'],
            ], v => save({ chatButton: v }))}
            {choose('Long press the overlay', s.longPress, [
                ['menu', 'Menu', 'Mute, deafen, Go Live and leave.'],
                ['chat', 'Chat'],
                ['off', 'Nothing'],
            ], v => save({ longPress: v }))}

            {heading('Appearance')}
            <Text variant="text-md/normal" color="text-muted">
                Type a percent. Changes apply right away.
            </Text>
            <Card>
                <PercentInput label="Size" description="How big the overlay is, 50 to 200." value={s.scale} min={50} max={200} onSave={v => save({ scale: v })} />
                <PercentInput label="Opacity" description="How see-through the whole overlay is, 20 to 100." value={s.opacity} min={20} max={100} onSave={v => save({ opacity: v })} />
                <PercentInput label="People not talking" description="How faint people are while they are quiet, 10 to 100. Whoever talks is always fully shown." value={s.idleAlpha} min={10} max={100} onSave={v => save({ idleAlpha: v })} />
            </Card>

            {heading('More')}
            <View style={{ gap: 10 }}>
                <Button size="lg" variant="secondary" text="Reset position" onPress={() => save({ x: 24, y: 200 })} />
                <Button size="lg" variant="secondary" text="Copy log" onPress={copyLog} />
            </View>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        patchCallTile(cleanup)
        sendConfig()
        for (const name of ['MediaEngineStore', 'ApplicationStreamingStore']) {
            const st = S()[name]
            if (!st?.addChangeListener) continue
            st.addChangeListener(pushSelf)
            cleanup(() => st.removeChangeListener?.(pushSelf))
        }
        pushSelf()
        const stores = ['SpeakingStore', 'VoiceStateStore', 'SelectedChannelStore', 'UserStore', 'GuildMemberStore', 'ApplicationStreamingStore']
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
