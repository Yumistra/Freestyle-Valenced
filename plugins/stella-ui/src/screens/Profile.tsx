import { useEffect } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { avatarUrl, displayName, dmWith, fetchProfile, me, memberRoles, profileOf, relationships, S, sameList, sendFriendRequest, toast, useStores, user } from '../data'
import { Avatar, Icon, PillButton, T } from '../parts'
import { setState, useUi } from '../state'
import { C, R, shadow } from '../theme'
import { RichText } from './Rich'

/**
 * 프로필 창: 배너, 프로필 그림, 이름, 소개, 역할, 버튼(메시지, 친구 신청).
 */

const STATUS: Record<string, [string, string]> = { online: [C.green, '온라인'], idle: [C.gold, '자리 비움'], dnd: [C.red, '방해 금지'], offline: [C.muted, '오프라인'] }

export function ProfileCard() {
    const target = useUi(s => s.profile)
    if (!target) return null
    return <ProfileBody key={`${target.userId}|${target.guildId ?? ''}`} userId={target.userId} guildId={target.guildId} />
}

function ProfileBody({ userId, guildId }: { userId: string; guildId?: string }) {
    useEffect(() => fetchProfile(userId, guildId), [userId, guildId])
    const u = useStores(['UserStore'], () => user(userId), [userId])
    const p = useStores(['UserProfileStore'], () => profileOf(userId, guildId), [userId, guildId], (a, b) => a.bio === b.bio && a.banner === b.banner && a.pronouns === b.pronouns && a.mutualGuilds === b.mutualGuilds)
    const roles = useStores(['GuildMemberStore'], () => memberRoles(guildId, userId), [userId, guildId], (a, b) => sameList(a.map(r => r.id), b.map(r => r.id)))
    const status = useStores(['PresenceStore'], () => S().PresenceStore?.getStatus?.(userId) ?? 'offline', [userId])
    const isFriend = useStores(['RelationshipStore'], () => relationships().friends.includes(userId), [userId])
    const self = me()?.id === userId
    const close = () => setState({ profile: undefined })
    const message = async () => {
        const dm = await dmWith(userId)
        if (!dm) return toast('대화를 열지 못했어요')
        setState({ profile: undefined, route: 'heart', heartTab: 'contacts', dmId: dm, menu: false })
    }
    const addFriend = async () => {
        const err = await sendFriendRequest(u?.username ?? '')
        toast(err ?? '친구 신청을 보냈어요')
    }
    const [dot, label] = STATUS[status] ?? STATUS.offline
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={close} accessibilityLabel="Close profile" />
            <View style={[{ width: '100%', maxWidth: 420, maxHeight: '92%', borderRadius: R.panel, backgroundColor: C.panel, overflow: 'hidden' }, shadow(12)]}>
                <View style={{ height: 120, backgroundColor: p.accent ?? C.blue }}>
                    {p.banner ? <Image source={{ uri: p.banner }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
                    <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={{ position: 'absolute', top: 10, right: 12 }}>
                        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(28,42,99,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                            <Icon names={['XLargeIcon', 'CloseIcon']} color={C.white} size={18} />
                        </View>
                    </Pressable>
                </View>
                <View style={{ marginTop: -46, paddingHorizontal: 18 }}>
                    <View>
                        <Avatar uri={avatarUrl(u, 256, guildId)} size={92} ring={C.panel} />
                        <View style={{ position: 'absolute', left: 66, top: 66, width: 22, height: 22, borderRadius: 11, backgroundColor: dot, borderWidth: 4, borderColor: C.panel }} />
                    </View>
                </View>
                <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 10, gap: 12 }}>
                    <View>
                        <T size={22} weight="800">
                            {displayName(u, guildId)}
                        </T>
                        <T size={14} color={C.muted} weight="600">
                            {[u?.username, p.pronouns, label].filter(Boolean).join(', ')}
                        </T>
                    </View>
                    {!self ? (
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <PillButton label="메시지" onPress={message} />
                            {!isFriend ? <PillButton label="친구 신청" kind="white" onPress={addFriend} /> : null}
                        </View>
                    ) : null}
                    {p.bio ? (
                        <View style={{ padding: 12, borderRadius: 14, backgroundColor: C.white, gap: 4 }}>
                            <T size={12} color={C.muted} weight="800">
                                소개
                            </T>
                            <RichText text={p.bio} guildId={guildId} tone="dark" size={14} />
                        </View>
                    ) : null}
                    {roles.length ? (
                        <View style={{ padding: 12, borderRadius: 14, backgroundColor: C.white, gap: 8 }}>
                            <T size={12} color={C.muted} weight="800">
                                역할
                            </T>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                                {roles.map(r => (
                                    <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 26, borderRadius: R.pill, backgroundColor: C.blueSoft }}>
                                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: r.color ?? C.muted }} />
                                        <T size={12} weight="700">
                                            {r.name}
                                        </T>
                                    </View>
                                ))}
                            </View>
                        </View>
                    ) : null}
                    {p.mutualGuilds ? (
                        <T size={13} color={C.muted} weight="700">
                            {`같이 있는 서버 ${p.mutualGuilds}개`}
                        </T>
                    ) : null}
                </ScrollView>
            </View>
        </View>
    )
}
