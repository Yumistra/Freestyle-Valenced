import { memo, useCallback } from 'react'
import { FlatList, Image, Pressable, View } from 'react-native'
import { guild, guildBannerUrl, guildIconUrl, guildIds, guildUnread, sameList, useStores } from '../data'
import { Backdrop, Badge, Icon, NavButtons, Phone, PlaceChip, T } from '../parts'
import { useSettings } from '../settings'
import { back, go, isNarrow } from '../state'
import { C, cardColor, shadow } from '../theme'
import { Character } from './Lobby'

/**
 * 출발 = 서버 목록. 왼쪽에 캐릭터, 오른쪽 휴대폰 안에 서버 카드.
 */

const GuildCard = memo(function GuildCard({ id, width }: { id: string; width: number }) {
    const [name, banner, icon, isUnread, mentions] = useStores(
        ['GuildStore', 'GuildReadStateStore'],
        () => {
            const g = guild(id)
            const r = guildUnread(id)
            return [g?.name ?? '', guildBannerUrl(g), guildIconUrl(g, 128), r.unread, r.mentions] as const
        },
        [id],
        sameList,
    )
    const h = Math.round(width * 0.62)
    return (
        <Pressable onPress={() => go.guild(id)} accessibilityRole="button" accessibilityLabel={name} style={({ pressed }) => [{ margin: 6, transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
            <View style={[{ width, height: h, borderRadius: 14, overflow: 'hidden', backgroundColor: cardColor(id), borderWidth: 3, borderColor: C.white }, shadow(3)]}>
                {banner ? <Image source={{ uri: banner }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" /> : null}
                {!banner && icon ? <Image source={{ uri: icon }} style={{ position: 'absolute', right: -12, bottom: -12, width: h * 0.85, height: h * 0.85, borderRadius: h, opacity: 0.9 }} /> : null}
                {!banner && !icon ? (
                    <T size={h * 0.4} color="rgba(255,255,255,0.35)" weight="800" style={{ position: 'absolute', right: 10, bottom: 0 }}>
                        {name.slice(0, 1)}
                    </T>
                ) : null}
                <View style={{ position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14, backgroundColor: 'rgba(28,42,99,0.35)' }}>
                    <T size={15} color={C.white} weight="800" lines={1} style={{ textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 3 }}>
                        {name}
                    </T>
                </View>
                {banner && icon ? <Image source={{ uri: icon }} style={{ position: 'absolute', left: 8, bottom: 8, width: 30, height: 30, borderRadius: 10, borderWidth: 2, borderColor: C.white }} /> : null}
            </View>
            <Badge unread={isUnread} mentions={mentions} style={{ position: 'absolute', top: 0, right: 0 }} />
        </Pressable>
    )
})

export function DepartScreen({ width, height }: { width: number; height: number }) {
    const s = useSettings()
    const ids = useStores(['SortedGuildStore', 'GuildStore'], guildIds, [], sameList)
    const narrow = isNarrow(width)
    const phoneWidth = narrow ? width - 24 : Math.min(600, Math.max(380, width * 0.46))
    const cardWidth = Math.floor((phoneWidth - 18 - 24 - 24) / 2)
    const renderItem = useCallback(({ item }: { item: string }) => <GuildCard id={item} width={cardWidth} />, [cardWidth])

    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background} />
            {narrow ? null : (
                <View style={{ position: 'absolute', left: 0, bottom: 0, width: width - phoneWidth - 40, height: height * 0.96 }} pointerEvents="none">
                    <Character uri={s.character} />
                </View>
            )}
            <View style={{ position: 'absolute', top: 20, left: 24, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <NavButtons onBack={back} onHome={go.lobby} />
                {narrow ? null : <PlaceChip text="출발" />}
            </View>
            <View style={{ position: 'absolute', right: narrow ? 12 : 56, top: narrow ? 78 : 50, bottom: -30, width: phoneWidth }}>
                <Phone
                    style={{ flex: 1 }}
                    footer={
                        <View style={{ alignItems: 'center', paddingBottom: 40, paddingTop: 6 }}>
                            <Pressable onPress={go.lobby} accessibilityRole="button" accessibilityLabel="Lobby">
                                <View style={[{ width: 140, height: 44, borderRadius: 22, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                                    <Icon names={['HomeIcon']} color={C.navy} size={24} />
                                </View>
                            </Pressable>
                        </View>
                    }
                >
                    <View style={{ alignItems: 'center', marginTop: -30, marginBottom: 6 }} pointerEvents="none">
                        <Icon names={['StarIcon', 'SparklesIcon']} color={C.navy} size={28} />
                    </View>
                    {ids.length ? (
                        <FlatList
                            data={ids}
                            numColumns={2}
                            key={`cols-${cardWidth}`}
                            keyExtractor={id => id}
                            renderItem={renderItem}
                            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
                            initialNumToRender={8}
                            windowSize={7}
                            removeClippedSubviews
                        />
                    ) : (
                        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <T size={14} color={C.muted}>
                                들어간 서버가 없어요
                            </T>
                        </View>
                    )}
                </Phone>
            </View>
        </View>
    )
}
