import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { instead } from '@valenced/patcher'
import { useState } from 'react'
import { Dimensions, useWindowDimensions, View } from 'react-native'

/**
 * Desktop UI: 화면 크기와 상관없이 PC 처럼 서버, 채널 목록을 채팅 옆에 늘 띄우고, 오른쪽에 멤버 목록 칸을 둔다.
 *
 * 디스코드 모바일은 창이 넓을 때(태블릿, 가로 화면)를 위한 배치를 이미 가지고 있다.
 * modules/chat/native/useChatLayout.tsx 가 창 크기로 정한다:
 *   - isChatBesideChannelList: 채팅을 채널 목록 옆에 둔다 (LARGE 이상)
 *   - isChatLockedOpen: 둘 다 늘 열어 둔다, 밀어서 숨기지 않는다 (XLARGE 이상)
 * 앱 곳곳(40곳쯤)이 이 값을 읽으니, 이 둘을 바꾸면 배치 전체가 바뀐다.
 * 채널 목록 너비는 modules/screen/native/drawer/useDrawerWidth.tsx (늘 열면 260dp 고정) 에서 정하는데,
 * 폰에서는 너무 넓어서 채팅이 좁아지므로 화면에 맞춰 바꾼다.
 * 멤버 목록: 채팅을 감싸는 SwipeForMemberListWrapper 옆에 디스코드의 멤버 목록(GuildChannelUserList)을 붙인다.
 */

const PATHS = {
    layout: 'modules/chat/native/useChatLayout.tsx',
    drawer: 'modules/screen/native/drawer/useDrawerWidth.tsx',
    chatWidth: 'modules/chat/native/useChatWidth.tsx',
    chatWrapper: 'modules/main_tabs_v2/native/channel/SwipeForMemberListWrapper.tsx',
    guildMembers: 'modules/main_tabs_v2/native/shared_components/user_list/GuildChannelUserList.tsx',
    privateMembers: 'modules/main_tabs_v2/native/shared_components/user_list/PrivateChannelUserList.tsx',
    threadMembers: 'modules/main_tabs_v2/native/shared_components/user_list/ThreadChannelUserList.tsx',
}

const THREADS = new Set([10, 11, 12])

// ── 설정 ────────────────────────────────────────────────────────────────
export interface Settings {
    /** 채널 목록을 늘 열어 둔다 (끄면 채팅 옆에 있지만 밀어서 숨길 수 있다) */
    lockOpen: boolean
    /** 채널 목록(서버 줄 포함) 너비, 0 이면 화면에 맞춰 */
    channelWidth: number
    /** 멤버 목록 칸: auto 는 채팅이 너무 좁아지면 접는다 */
    members: 'auto' | 'always' | 'off'
    /** 멤버 목록 너비, 0 이면 화면에 맞춰 */
    memberWidth: number
}
export const DEFAULTS: Settings = { lockOpen: true, channelWidth: 0, members: 'auto', memberWidth: 0 }

/** 자동일 때 채팅이 이보다 좁아지면 멤버 목록 칸을 숨긴다 */
export const MIN_CHAT = 220

/** 예전 설정(켜기, 끄기)도 받는다 */
const memberMode = (v: unknown): Settings['members'] => (v === false || v === 'off' ? 'off' : v === 'always' ? 'always' : 'auto')

let storage: any
export const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
const save = (patch: Partial<Settings>) => storage?.set?.({ ...settings(), ...patch }, true)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 화면 너비에 맞춘 너비들 */
export function widths(screen: number, s: Settings = settings()) {
    const channel = Math.round(s.channelWidth > 0 ? clamp(s.channelWidth, 120, screen - 120) : clamp(screen * 0.42, 180, 300))
    const wantMembers = Math.round(s.memberWidth > 0 ? clamp(s.memberWidth, 120, screen - 120) : clamp(screen * 0.26, 150, 240))
    const mode = memberMode(s.members)
    // 자동이면 채팅이 너무 좁아질 때 멤버 칸을 접는다. 늘 보이기여도 채팅은 120dp 는 남긴다
    const members = mode === 'off' ? 0 : mode === 'always' ? Math.max(0, Math.min(wantMembers, screen - channel - 120)) : screen - channel - wantMembers >= MIN_CHAT ? wantMembers : 0
    return { channel, members, chat: Math.max(0, screen - channel - members) }
}

const screenWidth = () => Dimensions.get('window')?.width ?? 0

// ── 패치 ────────────────────────────────────────────────────────────────
// 같은 값이면 같은 객체를 준다 (디스코드가 이걸 effect 의존값으로 쓰는 곳이 있다)
const LAYOUTS = {
    locked: Object.freeze({ isChatBesideChannelList: true, isChatLockedOpen: true }),
    swipe: Object.freeze({ isChatBesideChannelList: true, isChatLockedOpen: false }),
}
const layoutOf = () => (settings().lockOpen ? LAYOUTS.locked : LAYOUTS.swipe)

/** 현재 채널에 맞는 멤버 목록 */
let GuildMembers: any
let PrivateMembers: any
let ThreadMembers: any

function MemberColumn({ channelId, width }: { channelId?: string; width: number }) {
    const channel = channelId ? (Stores as any).ChannelStore?.getChannel?.(channelId) : undefined
    if (!channel || width <= 0) return null
    const body =
        THREADS.has(channel.type) && ThreadMembers ? (
            <ThreadMembers channelId={channel.id} guildId={channel.guild_id} disableBottomSafeZone />
        ) : channel.guild_id && GuildMembers ? (
            <GuildMembers channelId={channel.id} guildId={channel.guild_id} disableBottomSafeZone />
        ) : (channel.type === 3 || channel.isGroupDM?.()) && PrivateMembers ? (
            <PrivateMembers channelId={channel.id} disableBottomSafeZone />
        ) : null
    if (!body) return null
    return <View style={{ width, height: '100%' }}>{body}</View>
}

function useSettingsTick() {
    // 설정이 바뀌면 다시 그린다
    storage?.use?.()
}

/** 어느 패치가 붙었는지 (설정 화면에 보여 준다) */
export const status: Record<string, boolean> = {}

/** 모듈이 이미 불러와졌으면 바로, 아니면 불러와질 때 */
function onModule(cleanup: (f: any) => void, key: string, path: string, apply: (mod: any) => boolean | void) {
    status[key] = false
    const run = (mod: any) => {
        if (!mod || status[key]) return
        try {
            status[key] = apply(mod) !== false
        } catch (e) {
            console.error('[Desktop UI]', key, e)
        }
    }
    cleanup(
        getModuleWithImportedPath(path, (mod: any) => {
            if (mod) run(mod)
            else cleanup(waitForModuleWithImportedPath(path, run) as any)
        }) as any,
    )
}

export function start(cleanup: (f: any) => void) {
    // 배치: 채팅을 채널 목록 옆에, 늘 열어 둠
    onModule(cleanup, 'layout', PATHS.layout, (mod: any) => {
            if (typeof mod?.default === 'function')
                cleanup(
                    instead(mod, 'default', function (this: any, args: any[], orig: any) {
                        // 훅이라 원래 것도 늘 부른다
                        orig.apply(this, args)
                        useSettingsTick()
                        return layoutOf()
                    }),
                )
            if (typeof mod?.getChatLayout === 'function') cleanup(instead(mod, 'getChatLayout', () => layoutOf()))
            return typeof mod?.default === 'function' || typeof mod?.useDrawerWidth === 'function'
    })

    // 채널 목록 너비
    onModule(cleanup, 'drawer', PATHS.drawer, (mod: any) => {
            if (typeof mod?.useDrawerWidth === 'function')
                cleanup(
                    instead(mod, 'useDrawerWidth', function (this: any, args: any[], orig: any) {
                        orig.apply(this, args)
                        const { width } = useWindowDimensions()
                        useSettingsTick()
                        return widths(width).channel
                    }),
                )
            if (typeof mod?.getDrawerWidth === 'function') cleanup(instead(mod, 'getDrawerWidth', () => widths(screenWidth()).channel))
            return typeof mod?.default === 'function' || typeof mod?.useDrawerWidth === 'function'
    })

    // 채팅 너비: 멤버 칸만큼 줄인다 (사진, 영상 크기 계산에 쓰인다)
    onModule(cleanup, 'chatWidth', PATHS.chatWidth, (mod: any) => {
            if (typeof mod?.default === 'function')
                cleanup(
                    instead(mod, 'default', function (this: any, args: any[], orig: any) {
                        orig.apply(this, args)
                        const { width } = useWindowDimensions()
                        useSettingsTick()
                        return widths(width).chat
                    }),
                )
            if (typeof mod?.getChatWidth === 'function') cleanup(instead(mod, 'getChatWidth', () => widths(screenWidth()).chat))
            return typeof mod?.default === 'function' || typeof mod?.useDrawerWidth === 'function'
    })

    onModule(cleanup, 'guildMembers', PATHS.guildMembers, (mod: any) => {
            GuildMembers = mod?.default
            return !!GuildMembers
    })
    onModule(cleanup, 'privateMembers', PATHS.privateMembers, (mod: any) => {
            PrivateMembers = mod?.default
            return !!PrivateMembers
    })
    onModule(cleanup, 'threadMembers', PATHS.threadMembers, (mod: any) => {
            ThreadMembers = mod?.default
            return !!ThreadMembers
    })

    // 멤버 목록 칸: 채팅 감싸개 옆에 붙인다
    onModule(cleanup, 'chatWrapper', PATHS.chatWrapper, (mod: any) => {
            if (typeof mod?.default !== 'function') return false
            cleanup(
                instead(mod, 'default', function DesktopChat(this: any, args: any[], orig: any) {
                    // 이 함수가 컴포넌트로 불린다. 훅 순서는 늘 같다
                    const props = args[0]
                    const { width } = useWindowDimensions()
                    useSettingsTick()
                    const w = widths(width)
                    const Original = orig
                    return (
                        <View style={{ flex: 1, flexDirection: 'row' }}>
                            <View style={{ flex: 1 }}>
                                <Original {...props} />
                            </View>
                            <MemberColumn channelId={props?.channelId} width={w.members} />
                        </View>
                    )
                }),
            )
    })
}

// ── 설정 화면 ────────────────────────────────────────────────────────────
function NumberInput({ label, value, onSave }: { label: string; value: number; onSave: (v: number) => void }) {
    const { TextInput } = Design as any
    const [text, setText] = useState(value > 0 ? String(value) : '')
    return (
        <TextInput
            label={label}
            value={text}
            placeholder="Auto"
            keyboardType="number-pad"
            onChange={(t: string) => {
                const clean = t.replace(/[^0-9]/g, '')
                setText(clean)
                onSave(clean ? Number(clean) : 0)
            }}
            size="md"
        />
    )
}

export function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const s = settings()
    const { width } = useWindowDimensions()
    const w = widths(width, s)
    const { Stack, TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, Text } = Design as any
    return (
        <Page>
            <Stack spacing={16}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ChannelListIcon" />}
                        label="Always show channels"
                        subLabel="Off lets you swipe the channel list away"
                        value={s.lockOpen}
                        onValueChange={(lockOpen: boolean) => save({ lockOpen })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="Member list" defaultValue={memberMode(s.members)} onChange={(members: Settings['members']) => save({ members })}>
                    <TableRadioRow label="Auto" subLabel="Hidden when the chat would be too narrow" value="auto" />
                    <TableRadioRow label="Always" value="always" />
                    <TableRadioRow label="Off" value="off" />
                </TableRadioGroup>
                <NumberInput label="Channel list width" value={s.channelWidth} onSave={channelWidth => save({ channelWidth })} />
                <NumberInput label="Member list width" value={s.memberWidth} onSave={memberWidth => save({ memberWidth })} />
                <Text variant="text-sm/medium" color="text-muted">
                    {`Hooked: ${Object.entries(status)
                        .map(([k, ok]) => `${k} ${ok ? 'yes' : 'no'}`)
                        .join(', ')}`}
                </Text>
                <Text variant="text-sm/medium" color="text-muted">
                    {`Now: channels ${w.channel}, chat ${w.chat}, members ${w.members ? w.members : 'hidden, the chat would be too narrow'}`}
                </Text>
            </Stack>
        </Page>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        start(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
