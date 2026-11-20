import { memo, useCallback } from 'react'
import { FlatList, Image, Pressable, View } from 'react-native'
import { channel, guild, guildIconUrl, guildSections, joinVoice, openChannelNative, sameList, toast, unread, useStores, voiceCount, VOICELIKE, type Section } from '../data'
import { Backdrop, Badge, Empty, Icon, NavButtons, PlaceChip, T } from '../parts'
import { useSettings } from '../settings'
import { back, go, isNarrow, setState, useUi } from '../state'
import { C, cardColor } from '../theme'
import { Chat } from './Chat'

/**
 * 서버 채널. 왼쪽 흐린 칸에 채널 작은 카드(카테고리별), 오른쪽에 말풍선 채팅.
 */

export function channelIcon(type: number | undefined): string[] {
    switch (type) {
        case 2:
            return ['VoiceNormalIcon']
        case 13:
            return ['StageIcon', 'VoiceNormalIcon']
        case 5:
            return ['AnnouncementsIcon', 'TextIcon']
        case 15:
            return ['ForumIcon', 'TextIcon']
        case 16:
            return ['ImageIcon', 'ForumIcon']
        default:
            return ['TextIcon']
    }
}

/** 이 화면에서 바로 대화할 수 있는 채널 (포럼, 미디어는 디스코드로 넘긴다) */
export const chatsHere = (type: number | undefined) => type === 0 || type === 5

/** 채널 카드를 눌렀을 때 */
export function pressChannel(ch: any) {
    if (!ch) return
    if (VOICELIKE.has(ch.type)) {
        toast(joinVoice(ch.id) ? `${ch.name} 에 들어가는 중` : '음성 채널에 들어가지 못했어요')
        return
    }
    if (chatsHere(ch.type)) {
        go.channel(ch.id)
        return
    }
    // 포럼, 미디어 채널은 디스코드 화면에서 연다
    if (openChannelNative(ch)) setState({ visible: false })
    else toast('이 채널은 열 수 없어요')
}

const ChannelCard = memo(function ChannelCard({ id, width, selected }: { id: string; width: number; selected: boolean }) {
    const [name, type, isUnread, mentions, people] = useStores(
        ['ChannelStore', 'ReadStateStore', 'VoiceStateStore'],
        () => {
            const ch = channel(id)
            const r = unread(id)
            return [ch?.name ?? '', ch?.type, r.unread, r.mentions, VOICELIKE.has(ch?.type) ? voiceCount(id) : 0] as const
        },
        [id],
        sameList,
    )
    const fg = selected ? C.white : isUnread ? C.ink : C.muted
    return (
        <Pressable onPress={() => pressChannel(channel(id))} accessibilityRole="button" accessibilityLabel={name} style={({ pressed }) => [{ margin: 4, transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
            <View style={{ width, height: 48, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, backgroundColor: selected ? C.blue : 'rgba(255,255,255,0.88)' }}>
                <Icon names={channelIcon(type)} color={selected ? C.white : C.navy} size={18} />
                <T size={14} color={fg} weight={isUnread || selected ? '800' : '600'} lines={1} style={{ flex: 1 }}>
                    {name}
                </T>
                {people ? (
                    <T size={12} color={selected ? C.white : C.tealDeep} weight="800">
                        {people}
                    </T>
                ) : null}
            </View>
            <Badge unread={false} mentions={mentions} style={{ position: 'absolute', top: -2, right: -2 }} />
        </Pressable>
    )
})

const SectionBlock = memo(function SectionBlock({ section, cardWidth, selected }: { section: Section; cardWidth: number; selected?: string }) {
    return (
        <View style={{ marginBottom: 10 }}>
            {section.name ? (
                <T size={13} color="rgba(255,255,255,0.85)" weight="800" lines={1} style={{ marginLeft: 8, marginBottom: 4, marginTop: 6 }}>
                    {section.name.toUpperCase()}
                </T>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {section.channels.map(ch => (
                    <ChannelCard key={ch.id} id={ch.id} width={cardWidth} selected={ch.id === selected} />
                ))}
            </View>
        </View>
    )
})

const sameSections = (a: Section[], b: Section[]) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.name === b[i].name && sameList(s.channels.map(c => c.id), b[i].channels.map(c => c.id)))

function ChannelPanel({ guildId, width, selected }: { guildId: string; width: number; selected?: string }) {
    const sections = useStores(['GuildChannelStore', 'ChannelStore'], () => guildSections(guildId), [guildId], sameSections)
    const [name, icon] = useStores(['GuildStore'], () => [guild(guildId)?.name ?? '', guildIconUrl(guild(guildId), 96)] as const, [guildId], sameList)
    const cardWidth = Math.floor((width - 32 - 16) / 2)
    const renderItem = useCallback(({ item }: { item: Section }) => <SectionBlock section={item} cardWidth={cardWidth} selected={selected} />, [cardWidth, selected])
    return (
        <View style={{ width, flex: 1, backgroundColor: 'rgba(20,32,74,0.35)', borderTopRightRadius: 28 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12 }}>
                <View style={{ width: 52, height: 52, borderRadius: 16, overflow: 'hidden', backgroundColor: cardColor(guildId), borderWidth: 2, borderColor: C.white }}>
                    {icon ? <Image source={{ uri: icon }} style={{ width: '100%', height: '100%' }} /> : null}
                </View>
                <T size={20} color={C.white} weight="800" lines={2} style={{ flex: 1 }}>
                    {name}
                </T>
            </View>
            {sections.length ? (
                <FlatList data={sections} extraData={selected} keyExtractor={s => s.id} renderItem={renderItem} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }} initialNumToRender={6} windowSize={7} />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={14} color="rgba(255,255,255,0.8)">
                        볼 수 있는 채널이 없어요
                    </T>
                </View>
            )}
        </View>
    )
}

export function GuildScreen({ width }: { width: number }) {
    const s = useSettings()
    const guildId = useUi(st => st.guildId)
    const channelId = useUi(st => st.channelId)
    const narrow = isNarrow(width)
    if (!guildId) return null
    const ch = channel(channelId)
    const open = !!(channelId && ch)
    const panelWidth = narrow ? width : Math.min(440, Math.max(320, width * 0.34))
    const showPanel = !narrow || !open
    const showChat = !narrow || open

    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background || s.character} blur={14} dim={0.42} />
            <View style={{ position: 'absolute', top: 20, left: 24, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <NavButtons onBack={back} onHome={go.lobby} />
                <PlaceChip text={guild(guildId)?.name ?? ''} />
            </View>
            <View style={{ flex: 1, flexDirection: 'row', paddingTop: 80 }}>
                {showPanel ? <ChannelPanel key={guildId} guildId={guildId} width={panelWidth} selected={channelId} /> : null}
                {showChat ? (
                    <View style={{ flex: 1, paddingLeft: narrow ? 0 : 16, paddingRight: narrow ? 0 : 40 }}>
                        {open ? (
                            <Chat
                                key={channelId}
                                channelId={channelId!}
                                guildId={guildId}
                                head={{ title: ch.name ?? '', subtitle: ch.topic ? String(ch.topic).replace(/\s+/g, ' ') : undefined, icon: channelIcon(ch.type) }}
                                onList={narrow ? () => setState({ channelId: undefined }) : undefined}
                                onOpenNative={() => openChannelNative(ch) && setState({ visible: false })}
                            />
                        ) : (
                            <Empty text="채널을 선택하세요." />
                        )}
                    </View>
                ) : null}
            </View>
        </View>
    )
}
