import { memo, useCallback, useState } from 'react'
import { FlatList, Pressable, TextInput, View } from 'react-native'
import { acceptRequest, avatarUrl, channel, declineRequest, displayName, dmAvatar, dmIds, dmName, dmWith, lastMessage, relationships, S, sameList, sendFriendRequest, toast, unread, useStores, user } from '../data'
import { previewText } from '../markdown'
import { Avatar, Backdrop, Badge, Empty, Icon, Phone, PhoneTabs, T } from '../parts'
import { useSettings } from '../settings'
import { go, type HeartTab, isNarrow, setState, useUi } from '../state'
import { C, R, shadow } from '../theme'
import { Chat } from './Chat'
import { tr } from '../i18n'

/**
 * 하트챗 = DM. 왼쪽 휴대폰에 연락처(DM), 신청(친구 요청), 친구. 오른쪽에 말풍선 대화.
 */

const STATUS_COLOR: Record<string, string> = { online: C.green, idle: C.gold, dnd: C.red }

// ── 연락처 (DM) ─────────────────────────────────────────────────────────
const ContactRow = memo(function ContactRow({ id, selected }: { id: string; selected: boolean }) {
    // 이 줄에 필요한 것만 읽고, 바뀌었을 때만 다시 그린다
    const [name, avatar, preview, isUnread, mentions] = useStores(
        ['ChannelStore', 'UserStore', 'MessageStore', 'ReadStateStore'],
        () => {
            const ch = channel(id)
            const r = unread(id)
            return [dmName(ch), dmAvatar(ch), previewText(lastMessage(id)), r.unread, r.mentions] as const
        },
        [id],
        sameList,
    )
    const fg = selected ? C.white : C.ink
    return (
        <Pressable onPress={() => go.heart(id)} accessibilityRole="button" accessibilityLabel={name}>
            <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginVertical: 3, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 16, backgroundColor: selected ? C.blue : 'transparent' }, selected ? shadow(3) : null]}>
                <View>
                    <Avatar uri={avatar} size={52} />
                    <Badge unread={isUnread} mentions={mentions} style={{ position: 'absolute', top: -4, left: -4 }} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={17} color={fg} weight="800" lines={1}>
                        {name}
                    </T>
                    <T size={13} color={selected ? '#dfe7ff' : C.muted} weight="600" lines={1} style={{ marginTop: 3 }}>
                        {preview || ' '}
                    </T>
                </View>
                {selected ? <Icon names={['ArrowSmallUpIcon', 'ChevronSmallUpIcon']} color={C.white} size={22} /> : null}
            </View>
            {selected ? null : <View style={{ height: 1, marginHorizontal: 24, backgroundColor: C.line }} />}
        </Pressable>
    )
})

function Contacts({ selected }: { selected?: string }) {
    const ids = useStores(['PrivateChannelSortStore', 'ChannelStore'], dmIds, [], sameList)
    const renderItem = useCallback(({ item }: { item: string }) => <ContactRow id={item} selected={item === selected} />, [selected])
    if (!ids.length) return <EmptyList text="아직 대화가 없어요" />
    return <FlatList data={ids} extraData={selected} keyExtractor={id => id} renderItem={renderItem} initialNumToRender={12} windowSize={7} removeClippedSubviews />
}

// ── 신청 (친구 요청) ────────────────────────────────────────────────────
function SmallButton({ names, onPress, label, teal }: { names: string[]; onPress: () => void; label: string; teal?: boolean }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
            <View style={[{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: teal ? C.teal : C.white, borderWidth: teal ? 0 : 1.5, borderColor: C.line }, shadow(2)]}>
                <Icon names={names} color={teal ? C.white : C.ink} size={18} />
            </View>
        </Pressable>
    )
}

function PersonRow({ id, children, onPress }: { id: string; children?: any; onPress?: () => void }) {
    const [name, avatar, status] = useStores(['UserStore', 'PresenceStore'], () => [displayName(user(id)), avatarUrl(user(id)), S().PresenceStore?.getStatus?.(id) ?? 'offline'] as const, [id], sameList)
    const body = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View>
                <Avatar uri={avatar} size={48} />
                {STATUS_COLOR[status] ? <View style={{ position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: STATUS_COLOR[status], borderWidth: 2, borderColor: C.white }} /> : null}
            </View>
            <T size={16} weight="800" lines={1} style={{ flex: 1 }}>
                {name}
            </T>
            {children}
        </View>
    )
    return onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
            {body}
        </Pressable>
    ) : (
        body
    )
}

function Requests() {
    const ids = useStores(['RelationshipStore'], () => relationships().incoming, [], sameList)
    if (!ids.length) return <EmptyList text="받은 친구 신청이 없어요" />
    return (
        <FlatList
            data={ids}
            keyExtractor={id => id}
            renderItem={({ item }) => (
                <PersonRow id={item}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <SmallButton names={['CheckmarkLargeIcon', 'CheckmarkSmallIcon', 'CheckIcon']} label="Accept" teal onPress={() => acceptRequest(item)} />
                        <SmallButton names={['XLargeIcon', 'XSmallIcon', 'CloseIcon']} label="Decline" onPress={() => declineRequest(item)} />
                    </View>
                </PersonRow>
            )}
        />
    )
}

const STATUS_ORDER: Record<string, number> = { online: 0, idle: 1, dnd: 2 }
function Friends() {
    const ids = useStores(
        ['RelationshipStore', 'PresenceStore'],
        () => {
            const ps = S().PresenceStore
            const rank = (id: string) => STATUS_ORDER[ps?.getStatus?.(id)] ?? 3
            return relationships()
                .friends.map(id => [rank(id), displayName(user(id)).toLowerCase(), id] as const)
                .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
                .map(x => x[2])
        },
        [],
        sameList,
    )
    if (!ids.length)
        return (
            <View style={{ flex: 1 }}>
                <AddFriend />
                <EmptyList text="친구가 없어요" />
            </View>
        )
    const open = async (userId: string) => {
        const dm = await dmWith(userId)
        if (dm) setState({ heartTab: 'contacts', dmId: dm })
    }
    return (
        <FlatList
            data={ids}
            keyExtractor={id => id}
            ListHeaderComponent={<AddFriend />}
            renderItem={({ item }) => <PersonRow id={item} onPress={() => open(item)} />}
            initialNumToRender={14}
            windowSize={7}
            removeClippedSubviews
        />
    )
}

/** 사용자 이름으로 친구 신청 */
function AddFriend() {
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const send = async () => {
        if (!name.trim() || busy) return
        setBusy(true)
        const err = await sendFriendRequest(name)
        setBusy(false)
        toast(err ?? '친구 신청을 보냈어요')
        if (!err) setName('')
    }
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6, paddingLeft: 14, paddingRight: 4, height: 46, borderRadius: R.pill, backgroundColor: C.white, borderWidth: 1.5, borderColor: C.line }}>
            <TextInput value={name} onChangeText={setName} placeholder={tr('사용자 이름으로 친구 추가')} placeholderTextColor={C.muted} autoCapitalize="none" onSubmitEditing={send} style={{ flex: 1, fontSize: 14, color: C.ink, fontWeight: '600' }} />
            <Pressable onPress={send} accessibilityRole="button" accessibilityLabel="Add friend" disabled={busy}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
                    <Icon names={['UserPlusIcon', 'FriendsIcon']} color={C.white} size={18} />
                </View>
            </Pressable>
        </View>
    )
}

function EmptyList({ text }: { text: string }) {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <T size={14} color={C.muted}>
                {text}
            </T>
        </View>
    )
}

// ── 화면 ────────────────────────────────────────────────────────────────
function PowerButton() {
    return (
        <Pressable onPress={go.lobby} accessibilityRole="button" accessibilityLabel="Lobby" hitSlop={8} style={{ position: 'absolute', top: 18, right: 22 }}>
            <Icon names={['PowerIcon', 'XLargeIcon', 'CloseIcon']} color={C.white} size={34} />
        </Pressable>
    )
}

export function HeartScreen({ width }: { width: number }) {
    const s = useSettings()
    const dmId = useUi(st => st.dmId)
    const tab = useUi(st => st.heartTab)
    const requests = useStores(['RelationshipStore'], () => relationships().incoming.length, [])
    const anyUnread = useStores(['ReadStateStore', 'PrivateChannelSortStore'], () => dmIds().some(id => unread(id).unread), [])
    const narrow = isNarrow(width)
    const ch = channel(dmId)
    // 없는 채널이면 (막 만든 DM 이 아직 안 왔을 때 등) 연 것으로 치지 않는다
    const open = !!(dmId && ch)
    const showPhone = !narrow || !open
    const showChat = !narrow || open
    const phoneWidth = narrow ? width - 24 : Math.min(420, Math.max(330, width * 0.34))

    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background || s.character} blur={14} dim={0.42} />
            <View style={{ flex: 1, flexDirection: 'row', paddingTop: 12 }}>
                {showPhone ? (
                    <View style={{ width: phoneWidth, paddingLeft: narrow ? 12 : 48, paddingTop: narrow ? 56 : 40, marginBottom: -30 }}>
                        <Phone
                            title={tab === 'contacts' ? '연락처' : tab === 'requests' ? '신청' : '친구'}
                            style={{ flex: 1 }}
                            footer={
                                <PhoneTabs<HeartTab>
                                    value={tab}
                                    onChange={heartTab => setState({ heartTab })}
                                    tabs={[
                                        { key: 'contacts', label: '연락처', icon: ['ChatIcon', 'ChatSmileIcon'], dot: anyUnread },
                                        { key: 'requests', label: '신청', icon: ['UserPlusIcon', 'FriendsIcon'], dot: requests > 0 },
                                        { key: 'friends', label: '친구', icon: ['FriendsIcon', 'GroupIcon'] },
                                    ]}
                                />
                            }
                        >
                            {tab === 'contacts' ? <Contacts selected={dmId} /> : tab === 'requests' ? <Requests /> : <Friends />}
                        </Phone>
                    </View>
                ) : null}
                {showChat ? (
                    <View style={{ flex: 1, paddingLeft: narrow ? 0 : 24, paddingRight: narrow ? 0 : 60, paddingTop: narrow ? 50 : 40 }}>
                        {open ? (
                            <Chat
                                key={dmId}
                                channelId={dmId!}
                                head={{ avatar: dmAvatar(ch), title: dmName(ch), subtitle: ch.type === 3 ? `${(ch.recipients?.length ?? 0) + 1}명` : undefined, onPress: ch.type === 1 && ch.recipients?.[0] ? () => go.profile(ch.recipients[0]) : undefined }}
                                compact={narrow}
                                onList={narrow ? () => setState({ dmId: undefined }) : undefined}
                            />
                        ) : (
                            <Empty text="연락처를 선택해 대화를 시작하세요." />
                        )}
                    </View>
                ) : null}
            </View>
            <PowerButton />
        </View>
    )
}
