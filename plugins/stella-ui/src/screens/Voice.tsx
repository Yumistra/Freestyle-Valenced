import { memo } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { avatarUrl, displayName, find, joinVoice, S, toast, toggleVoice, user, useStores, voiceSelf } from '../data'
import { Avatar, Icon, T } from '../parts'
import { setState } from '../state'
import { C, shadow } from '../theme'

/**
 * 음성 채널: 들어와 있는 사람(말하면 테두리), 들어가기/나가기, 마이크, 헤드셋.
 * 영상, 화면 공유는 디스코드 통화 화면에서 한다.
 */

interface Person {
    id: string
    mute: boolean
    deaf: boolean
    video: boolean
    stream: boolean
}

export function voicePeople(channelId: string): Person[] {
    try {
        const states = S().VoiceStateStore?.getVoiceStatesForChannel?.(channelId) ?? {}
        return Object.keys(states).map(id => {
            const v = states[id] ?? {}
            return { id: v.userId ?? id, mute: !!(v.selfMute || v.mute), deaf: !!(v.selfDeaf || v.deaf), video: !!v.selfVideo, stream: !!v.selfStream }
        })
    } catch {
        return []
    }
}

const samePeople = (a: Person[], b: Person[]) => a.length === b.length && a.every((p, i) => p.id === b[i].id && p.mute === b[i].mute && p.deaf === b[i].deaf && p.video === b[i].video && p.stream === b[i].stream)

const connectedTo = () => S().SelectedChannelStore?.getVoiceChannelId?.() as string | undefined

export function leaveVoice(): boolean {
    try {
        const m = find('selectVoiceChannel')
        if (typeof m?.selectVoiceChannel !== 'function') return false
        m.selectVoiceChannel(null)
        return true
    } catch {
        return false
    }
}

const PersonTile = memo(function PersonTile({ p, guildId }: { p: Person; guildId?: string }) {
    const speaking = useStores(['SpeakingStore'], () => !!S().SpeakingStore?.isSpeaking?.(p.id), [p.id])
    const u = user(p.id)
    return (
        <View style={{ width: 84, alignItems: 'center', gap: 4 }}>
            <View style={{ borderRadius: 34, borderWidth: 3, borderColor: speaking ? C.green : 'transparent' }}>
                <Avatar uri={avatarUrl(u, 96, guildId)} size={58} ring="transparent" />
                {p.mute || p.deaf ? (
                    <View style={{ position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={p.deaf ? ['HeadphonesSlashIcon', 'DeafenIcon'] : ['MicrophoneSlashIcon', 'MicrophoneMuteIcon']} color={C.white} size={13} />
                    </View>
                ) : null}
            </View>
            <T size={12} color={C.white} weight="800" lines={1}>
                {displayName(u, guildId)}
            </T>
            {p.video || p.stream ? (
                <T size={10} color={C.gold} weight="800">
                    {p.stream ? '방송 중' : '영상 켬'}
                </T>
            ) : null}
        </View>
    )
})

function CircleButton({ names, label, onPress, color = C.white, bg = 'rgba(255,255,255,0.18)' }: { names: string[]; label: string; onPress: () => void; color?: string; bg?: string }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ alignItems: 'center', gap: 4, transform: [{ scale: pressed ? 0.93 : 1 }] }]}>
            <View style={[{ width: 50, height: 50, borderRadius: 25, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }, shadow(2)]}>
                <Icon names={names} color={color} size={22} />
            </View>
            <T size={11} color={C.white} weight="700">
                {label}
            </T>
        </Pressable>
    )
}

/** 채팅 위에 붙는 음성 칸 */
export function VoicePanel({ channelId, guildId }: { channelId: string; guildId?: string }) {
    const people = useStores(['VoiceStateStore'], () => voicePeople(channelId), [channelId], samePeople)
    const here = useStores(['SelectedChannelStore', 'VoiceStateStore'], () => connectedTo() === channelId, [channelId])
    const self = useStores(['MediaEngineStore'], voiceSelf, [], (a, b) => a.mute === b.mute && a.deaf === b.deaf)
    return (
        <View style={{ marginHorizontal: 12, marginTop: 10, padding: 12, borderRadius: 18, backgroundColor: 'rgba(28,42,99,0.55)', gap: 12 }}>
            {people.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                    {people.map(p => (
                        <PersonTile key={p.id} p={p} guildId={guildId} />
                    ))}
                </ScrollView>
            ) : (
                <T size={13} color="rgba(255,255,255,0.85)" style={{ textAlign: 'center' }}>
                    아무도 없어요
                </T>
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 18, flexWrap: 'wrap' }}>
                {here ? (
                    <>
                        <CircleButton names={self.mute ? ['MicrophoneSlashIcon', 'MicrophoneMuteIcon'] : ['MicrophoneIcon']} label={self.mute ? '마이크 켜기' : '마이크 끄기'} onPress={() => toggleVoice('mute')} bg={self.mute ? C.red : undefined} />
                        <CircleButton names={self.deaf ? ['HeadphonesSlashIcon', 'DeafenIcon'] : ['HeadphonesIcon']} label={self.deaf ? '소리 켜기' : '소리 끄기'} onPress={() => toggleVoice('deaf')} bg={self.deaf ? C.red : undefined} />
                        <CircleButton names={['VideoIcon', 'ScreenArrowIcon']} label="영상, 화면" onPress={() => setState({ visible: false })} />
                        <CircleButton names={['PhoneHangUpIcon', 'PhoneCallIcon', 'XLargeIcon']} label="나가기" onPress={() => !leaveVoice() && toast('나가지 못했어요')} bg={C.red} />
                    </>
                ) : (
                    <Pressable onPress={() => toast(joinVoice(channelId) ? '들어가는 중' : '음성 채널에 들어가지 못했어요')} accessibilityRole="button" accessibilityLabel="음성 참가">
                        <View style={[{ height: 46, paddingHorizontal: 30, borderRadius: 23, backgroundColor: C.green, flexDirection: 'row', alignItems: 'center', gap: 8 }, shadow(3)]}>
                            <Icon names={['VoiceNormalIcon', 'PhoneCallIcon']} color={C.white} size={20} />
                            <T size={15} color={C.white} weight="800">
                                참가하기
                            </T>
                        </View>
                    </Pressable>
                )}
            </View>
        </View>
    )
}

