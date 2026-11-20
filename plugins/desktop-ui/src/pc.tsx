import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Component, useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

/**
 * PC 처럼 다시 그린 부분들.
 *  - 채팅 위 헤더: "# 이름 | 주제" 한 줄 (PC 헤더)
 *  - 아래 내 정보 칸: 마이크, 헤드셋 버튼 (PC 왼쪽 아래 칸)
 * 하나라도 그리다 오류가 나면 디스코드 원래 것을 그린다.
 */

const S = () => Stores as any

// ── 공용 ────────────────────────────────────────────────────────────────
/** 오류가 나면 원래 것을 그린다 */
export class Guard extends Component<{ fallback: () => any; children?: any }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    componentDidCatch(e: any) {
        console.error('[Desktop UI]', e)
    }
    render() {
        return this.state.failed ? this.props.fallback() : this.props.children
    }
}

/**
 * 컴포넌트 내보내기를 바꾼다. memo 로 감싼 것이면 안쪽 함수를 바꾼다.
 * render(props, Original) 이 null 이 아닌 걸 주면 그걸, 아니면 원래 것을 그린다.
 */
export function replaceComponent(mod: any, key: string, enabled: () => boolean, render: (props: any, Original: any) => any): (() => void) | undefined {
    const target = mod?.[key]
    const holder = typeof target === 'function' ? mod : target && typeof target === 'object' && typeof target.type === 'function' ? target : undefined
    const prop = holder === mod ? key : 'type'
    if (!holder) return
    return instead(holder, prop, function (this: any, args: any[], orig: any) {
        if (!enabled()) return orig.apply(this, args)
        const props = args[0] ?? {}
        const Original = orig
        return (
            <Guard fallback={() => <Original {...props} />}>
                <Swap props={props} Original={Original} render={render} />
            </Guard>
        )
    })
}

function Swap({ props, Original, render }: { props: any; Original: any; render: (p: any, O: any) => any }) {
    const out = render(props, Original)
    return out ?? <Original {...props} />
}

/** 스토어가 바뀌면 다시 그린다 */
export function useStores(names: string[], read: () => any) {
    const [value, setValue] = useState(read)
    useEffect(() => {
        const update = () => setValue(read)
        const stores = names.map(n => S()[n]).filter(Boolean)
        stores.forEach(s => s.addChangeListener?.(update))
        update()
        return () => stores.forEach(s => s.removeChangeListener?.(update))
    }, [])
    return value
}

export function color(names: string[], fallback: string) {
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

function icon(names: string[]): any {
    for (const n of names) {
        try {
            const C = lookupGeneratedIconComponent(n as any)
            if (C) return C
        } catch {}
    }
}

function DIcon({ names, c, size = 20 }: { names: string[]; c: string; size?: number }) {
    const C = icon(names)
    return C ? <C size={size >= 24 ? 'md' : 'sm'} color={c} style={{ width: size, height: size }} /> : null
}

// ── 채팅 헤더 ───────────────────────────────────────────────────────────
export function channelIconNames(type: number | undefined): string[] {
    switch (type) {
        case 2:
        case 13:
            return ['VoiceNormalIcon']
        case 5:
            return ['AnnouncementsIcon', 'TextIcon']
        case 10:
        case 11:
        case 12:
            return ['ThreadIcon', 'TextIcon']
        case 15:
        case 16:
            return ['ForumIcon', 'TextIcon']
        default:
            return ['TextIcon']
    }
}

/** PC 헤더: 아이콘, 이름, 세로줄, 주제 */
export function PcHeader({ channelId, onPress }: { channelId?: string; onPress?: () => void }) {
    const channel = useStores(['ChannelStore'], () => (channelId ? S().ChannelStore?.getChannel?.(channelId) : undefined))
    if (!channel) return null
    const { Text } = Design as any
    const muted = color(['TEXT_MUTED', 'INTERACTIVE_NORMAL'], '#949ba4')
    const topic = typeof channel.topic === 'string' ? channel.topic.replace(/\s+/g, ' ').trim() : ''
    return (
        <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
            <DIcon names={channelIconNames(channel.type)} c={muted} size={20} />
            <View style={{ width: 6 }} />
            <Text variant="text-md/semibold" color="text-strong" numberOfLines={1} style={{ flexShrink: 0, maxWidth: '60%' }}>
                {channel.name ?? ''}
            </Text>
            {topic ? (
                <>
                    <View style={{ width: 1, height: 18, marginHorizontal: 10, backgroundColor: muted, opacity: 0.4 }} />
                    <Text variant="text-sm/normal" color="text-muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {topic}
                    </Text>
                </>
            ) : null}
        </Pressable>
    )
}

// ── 마이크, 헤드셋 ──────────────────────────────────────────────────────
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

export function toggleVoice(kind: 'mute' | 'deafen') {
    const m = find('toggleSelfMute', 'toggleSelfDeaf')
    if (kind === 'mute') m?.toggleSelfMute?.()
    else m?.toggleSelfDeaf?.()
}

function RoundButton({ names, onPress, active, label }: { names: string[]; onPress: () => void; active: boolean; label: string }) {
    const c = active ? color(['STATUS_DANGER', 'TEXT_DANGER'], '#f23f43') : color(['INTERACTIVE_NORMAL'], '#b5bac1')
    return (
        <Pressable
            onPress={onPress}
            accessibilityLabel={label}
            accessibilityRole="button"
            hitSlop={6}
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 4 }}
        >
            <DIcon names={names} c={c} size={20} />
        </Pressable>
    )
}

/** PC 왼쪽 아래처럼 마이크, 헤드셋 버튼 */
export function VoiceButtons() {
    const [mute, deaf] = useStores(['MediaEngineStore'], () => {
        const me = S().MediaEngineStore
        return [!!me?.isSelfMute?.(), !!me?.isSelfDeaf?.()]
    })
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <RoundButton
                names={mute ? ['MicrophoneSlashIcon', 'MicrophoneDenyIcon', 'MicrophoneIcon'] : ['MicrophoneIcon']}
                active={mute}
                label={mute ? 'Unmute' : 'Mute'}
                onPress={() => toggleVoice('mute')}
            />
            <RoundButton
                names={deaf ? ['HeadphonesSlashIcon', 'HeadphonesDenyIcon', 'HeadphonesIcon'] : ['HeadphonesIcon']}
                active={deaf}
                label={deaf ? 'Undeafen' : 'Deafen'}
                onPress={() => toggleVoice('deafen')}
            />
        </View>
    )
}
