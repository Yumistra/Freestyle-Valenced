import { memo, useCallback, useEffect } from 'react'
import { FlatList, Image, Pressable, View } from 'react-native'
import { avatarUrl, channel, displayName, fetchMentions, guild, guildIconUrl, idTime, mentionList, relationships, useStores } from '../data'
import { formatTime } from '../markdown'
import { Avatar, Backdrop, Icon, NavButtons, PlaceChip, T } from '../parts'
import { useSettings } from '../settings'
import { back, go, isNarrow, setState } from '../state'
import { C, cardColor, shadow } from '../theme'
import { RichText } from './Rich'

/**
 * 알림함: 나를 멘션한 메시지와 친구 신청. 누르면 그 대화로 간다.
 */

const MentionCard = memo(function MentionCard({ m }: { m: any }) {
    const ch = channel(m.channel_id)
    const g = guild(ch?.guild_id ?? m.guild_id)
    const where = g ? `${g.name}, #${ch?.name ?? ''}` : ch?.name || displayName(m.author)
    const icon = g ? guildIconUrl(g, 64) : undefined
    return (
        <Pressable onPress={() => ch && go.open(ch)} accessibilityRole="button" accessibilityLabel={`mention ${m.id}`} style={({ pressed }) => [{ marginHorizontal: 12, marginVertical: 6, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
            <View style={[{ padding: 14, borderRadius: 16, backgroundColor: C.white, gap: 8 }, shadow(3)]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 22, height: 22, borderRadius: 7, overflow: 'hidden', backgroundColor: cardColor(g?.id) }}>{icon ? <Image source={{ uri: icon }} style={{ width: '100%', height: '100%' }} /> : null}</View>
                    <T size={12} color={C.muted} weight="700" lines={1} style={{ flex: 1 }}>
                        {where}
                    </T>
                    <T size={12} color={C.muted} weight="600">
                        {formatTime(idTime(m.id) / 1000, 'R')}
                    </T>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Avatar uri={avatarUrl(m.author, 64, ch?.guild_id)} size={36} ring="transparent" />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <T size={14} weight="800" lines={1}>
                            {displayName(m.author, ch?.guild_id)}
                        </T>
                        {m.content ? <RichText text={m.content} guildId={ch?.guild_id} tone="dark" size={14} /> : null}
                    </View>
                </View>
            </View>
        </Pressable>
    )
})

function RequestsCard({ n }: { n: number }) {
    if (!n) return null
    return (
        <Pressable onPress={() => setState({ route: 'heart', heartTab: 'requests', dmId: undefined })} accessibilityRole="button" accessibilityLabel="friend requests" style={{ marginHorizontal: 12, marginVertical: 6 }}>
            <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: C.teal }, shadow(3)]}>
                <Icon names={['UserPlusIcon', 'FriendsIcon']} color={C.white} size={22} />
                <T size={15} color={C.white} weight="800" style={{ flex: 1 }}>
                    {`친구 신청이 ${n}개 와 있어요`}
                </T>
                <Icon names={['ChevronLargeRightIcon', 'ArrowLargeRightIcon']} color={C.white} size={18} />
            </View>
        </Pressable>
    )
}

export function InboxScreen({ width }: { width: number }) {
    const s = useSettings()
    const mentions = useStores(['RecentMentionsStore'], mentionList, [])
    const requests = useStores(['RelationshipStore'], () => relationships().incoming.length, [])
    const narrow = isNarrow(width)
    useEffect(() => fetchMentions(), [])
    const more = useCallback(() => {
        const list = mentionList()
        const last = list[list.length - 1]
        if (last) fetchMentions(last.id)
    }, [])
    const renderItem = useCallback(({ item }: { item: any }) => <MentionCard m={item} />, [])
    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background || s.character} blur={14} dim={0.42} />
            <View style={{ position: 'absolute', top: 20, left: 24, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <NavButtons onBack={back} onHome={go.lobby} />
                <PlaceChip text="알림함" />
            </View>
            <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: narrow ? 0 : width * 0.18 }}>
                <FlatList
                    data={mentions}
                    keyExtractor={m => m.id}
                    renderItem={renderItem}
                    ListHeaderComponent={<RequestsCard n={requests} />}
                    ListEmptyComponent={
                        <View style={{ alignItems: 'center', padding: 32 }}>
                            <T size={15} color="rgba(255,255,255,0.85)">
                                새 알림이 없어요
                            </T>
                        </View>
                    }
                    onEndReached={more}
                    onEndReachedThreshold={0.4}
                    initialNumToRender={8}
                    windowSize={7}
                    removeClippedSubviews
                    contentContainerStyle={{ paddingBottom: 24 }}
                />
            </View>
        </View>
    )
}
