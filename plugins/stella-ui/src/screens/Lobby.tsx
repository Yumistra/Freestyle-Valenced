import { useEffect, useState } from 'react'
import { Image, Pressable, View } from 'react-native'
import { avatarUrl, count, displayName, dmIds, guildIds, guildUnread, me, onlineFriends, openNative, pickImage, relationships, toast, toggleVoice, unread, useStores, voiceSelf, sameList } from '../data'
import { Avatar, Backdrop, Dot, Icon, RoundButton, T } from '../parts'
import { save, useSettings } from '../settings'
import { go, setState, useUi } from '../state'
import { C, R, shadow } from '../theme'

/**
 * 로비. 가운데 캐릭터(직접 넣은 그림), 위에 내 정보와 숫자, 오른쪽에 동그란 버튼과 출발.
 */

// ── 캐릭터 ──────────────────────────────────────────────────────────────
/** 고른 그림. 없으면 내 프로필 그림을 큰 액자에 */
export function Character({ uri }: { uri?: string }) {
    const [failed, setFailed] = useState(false)
    useEffect(() => setFailed(false), [uri])
    if (uri && !failed) return <Image source={{ uri }} resizeMode="contain" onError={() => setFailed(true)} style={{ width: '100%', height: '100%' }} />
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <View style={[{ width: 250, height: 250, borderRadius: 125, backgroundColor: 'rgba(255,255,255,0.55)', alignItems: 'center', justifyContent: 'center' }, shadow(6)]}>
                <Avatar uri={avatarUrl(me(), 512)} size={220} />
            </View>
        </View>
    )
}

// ── 말풍선 ──────────────────────────────────────────────────────────────
export function greetings(custom: string, hour: number, unreadDms: number): string[] {
    const mine = custom
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    if (mine.length) return mine
    const time = hour < 5 ? '늦은 밤이에요, 너무 무리하지 마세요.' : hour < 11 ? '좋은 아침이에요, 오늘도 힘내요!' : hour < 14 ? '점심은 먹었어요?' : hour < 18 ? '오후도 힘내요.' : '오늘 하루는 어땠어요?'
    const lines = [time, '어디로 출발할까요?', '하트챗에 새 소식이 있는지 볼까요?']
    if (unreadDms > 0) lines.unshift(`안 읽은 대화가 ${unreadDms}개 있어요.`)
    return lines
}

function Speech({ lines, index }: { lines: string[]; index: number }) {
    const text = lines[index % lines.length]
    if (!text) return null
    return (
        <View style={[{ maxWidth: 280, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.95)' }, shadow(4)]}>
            <T size={15} weight="700">
                {text}
            </T>
        </View>
    )
}

// ── 위 왼쪽: 내 정보와 숫자 ─────────────────────────────────────────────
function Stat({ names, value, color }: { names: string[]; value: string; color: string }) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 }}>
            <Icon names={names} color={color} size={18} />
            <T size={15} weight="800">
                {value}
            </T>
        </View>
    )
}

function Profile() {
    const [name, avatar] = useStores(['UserStore'], () => [displayName(me()), avatarUrl(me(), 128)] as const, [], sameList)
    const friends = useStores(['PresenceStore', 'RelationshipStore'], onlineFriends, [])
    const mentions = useStores(['GuildReadStateStore'], () => guildIds().reduce((n, id) => n + guildUnread(id).mentions, 0), [])
    const dms = useStores(['ReadStateStore', 'PrivateChannelSortStore'], () => dmIds().filter(id => unread(id).unread).length, [])
    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ alignItems: 'center' }}>
                <View style={[{ width: 70, height: 70, borderRadius: 35, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: C.white }, shadow(4)]}>
                    <Avatar uri={avatar} size={58} />
                </View>
                <View style={{ width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderTopWidth: 12, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: C.white, marginTop: -2 }} />
            </View>
            <View style={{ marginLeft: -6, marginTop: 6 }}>
                <View style={[{ flexDirection: 'row', alignItems: 'center', height: 36, paddingLeft: 12, paddingRight: 6, borderTopRightRadius: 18, borderBottomRightRadius: 18, backgroundColor: 'rgba(255,255,255,0.92)' }, shadow(2)]}>
                    <Stat names={['FriendsIcon', 'GroupIcon']} value={count(friends)} color={C.green} />
                    <View style={{ width: 1, height: 18, backgroundColor: C.line }} />
                    <Stat names={['ChatIcon']} value={count(dms)} color={C.blue} />
                    <View style={{ width: 1, height: 18, backgroundColor: C.line }} />
                    <Stat names={['AtIcon', 'BellIcon']} value={count(mentions)} color={C.red} />
                </View>
                <T size={15} color={C.white} weight="800" lines={1} style={{ marginTop: 6, marginLeft: 10, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 }}>
                    {name}
                </T>
            </View>
        </View>
    )
}

// ── 위 오른쪽: 아이콘 줄과 메뉴 ─────────────────────────────────────────
/** 디스코드 원래 화면으로 */
export function leaveTo(where: Parameters<typeof openNative>[0]) {
    setState({ visible: false, menu: false })
    // 화면이 내려간 다음 연다
    setTimeout(() => {
        if (!openNative(where)) toast('그 화면을 열지 못했어요')
    }, 60)
}

function TopIcons() {
    const requests = useStores(['RelationshipStore'], () => relationships().incoming.length, [])
    const item = (names: string[], label: string, onPress: () => void, dot?: boolean) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={{ paddingHorizontal: 12 }}>
            <Icon names={names} color={C.navy} size={24} />
            {dot ? <Dot style={{ position: 'absolute', top: -4, right: 6 }} /> : null}
        </Pressable>
    )
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={[{ flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.92)', transform: [{ skewX: '-10deg' }] }, shadow(3)]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', transform: [{ skewX: '10deg' }] }}>
                    {item(['InboxIcon', 'EnvelopeIcon', 'BellIcon'], '알림', go.inbox)}
                    {item(['FriendsIcon', 'UserPlusIcon'], '친구', () => setState({ route: 'heart', heartTab: requests ? 'requests' : 'friends', dmId: undefined, menu: false }), requests > 0)}
                    {item(['ShopIcon', 'ShopSparkleIcon', 'GiftIcon'], '상점', () => leaveTo('shop'))}
                </View>
            </View>
            <Pressable onPress={() => setState({ menu: true })} accessibilityRole="button" accessibilityLabel="Menu" hitSlop={6}>
                <View style={[{ width: 48, height: 44, borderRadius: 8, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                    <Icon names={['HamburgerIcon', 'MenuIcon']} color={C.white} size={26} />
                </View>
            </Pressable>
        </View>
    )
}

// ── 아래 왼쪽: 마이크, 헤드셋, 디스코드로 ────────────────────────────────
function VoiceBar() {
    const [mute, deaf] = useStores(['MediaEngineStore'], () => {
        const v = voiceSelf()
        return [v.mute, v.deaf] as const
    }, [], sameList)
    const btn = (names: string[], label: string, on: boolean, onPress: () => void) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
            <View style={[{ width: 44, height: 44, borderRadius: 22, backgroundColor: on ? C.red : 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                <Icon names={names} color={on ? C.white : C.navy} size={22} />
            </View>
        </Pressable>
    )
    return (
        <View style={{ flexDirection: 'row', gap: 10 }}>
            {btn(mute ? ['MicrophoneSlashIcon', 'MicrophoneIcon'] : ['MicrophoneIcon'], mute ? 'Unmute' : 'Mute', mute, () => toggleVoice('mute'))}
            {btn(deaf ? ['HeadphonesSlashIcon', 'HeadphonesIcon'] : ['HeadphonesIcon'], deaf ? 'Undeafen' : 'Deafen', deaf, () => toggleVoice('deaf'))}
            {btn(['ScreenArrowIcon', 'DiscordIcon', 'ArrowLargeRightIcon'], 'Discord', false, () => setState({ visible: false }))}
        </View>
    )
}

// ── 메뉴 창 ─────────────────────────────────────────────────────────────
export async function chooseCharacter() {
    const uri = await pickImage()
    if (uri) {
        save({ character: uri })
        toast('캐릭터 그림을 바꿨어요')
    }
}

function MenuItem({ names, label, onPress }: { names: string[]; label: string; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ width: '48%', marginBottom: 10, opacity: pressed ? 0.8 : 1 }]}>
            <View style={[{ height: 52, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: C.white, borderWidth: 1.5, borderColor: C.line }, shadow(2)]}>
                <Icon names={names} color={C.navy} size={22} />
                <T size={15} weight="800" lines={1}>
                    {label}
                </T>
            </View>
        </Pressable>
    )
}

function Menu() {
    const open = useUi(s => s.menu)
    if (!open) return null
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, alignItems: 'flex-end' }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={() => setState({ menu: false })} accessibilityLabel="Close menu" />
            <View style={[{ width: 420, maxWidth: '92%', marginTop: 60, marginRight: 24, borderRadius: R.panel, backgroundColor: C.panel, overflow: 'hidden' }, shadow(10)]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, height: 48, backgroundColor: C.teal }}>
                    <T size={17} color={C.white} weight="800">
                        메뉴
                    </T>
                    <Pressable onPress={() => setState({ menu: false })} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
                        <Icon names={['XLargeIcon', 'CloseIcon']} color={C.white} size={22} />
                    </Pressable>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', padding: 16 }}>
                    <MenuItem names={['SettingsIcon']} label="설정" onPress={() => leaveTo('settings')} />
                    <MenuItem names={['InboxIcon', 'BellIcon']} label="알림" onPress={go.inbox} />
                    <MenuItem names={['QuestsIcon', 'TrophyIcon', 'GameControllerIcon']} label="퀘스트" onPress={() => leaveTo('quests')} />
                    <MenuItem names={['ShopIcon', 'GiftIcon']} label="상점" onPress={() => leaveTo('shop')} />
                    <MenuItem names={['ImageIcon', 'ImagePlusIcon']} label="캐릭터 그림" onPress={chooseCharacter} />
                    <MenuItem names={['ScreenArrowIcon', 'DiscordIcon']} label="디스코드 화면" onPress={() => setState({ visible: false, menu: false })} />
                </View>
            </View>
        </View>
    )
}

// ── 로비 ────────────────────────────────────────────────────────────────
export function LobbyScreen({ width, height }: { width: number; height: number }) {
    const s = useSettings()
    const unreadDms = useStores(['ReadStateStore', 'PrivateChannelSortStore'], () => dmIds().filter(id => unread(id).unread).length, [])
    const anyGuildUnread = useStores(['GuildReadStateStore'], () => guildIds().some(id => guildUnread(id).mentions > 0), [])
    const [lineIndex, setLineIndex] = useState(0)
    const lines = greetings(s.lines, new Date().getHours(), unreadDms)
    const narrow = width < 700
    const charW = narrow ? width : Math.min(width * 0.5, height * 0.95)

    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background} />
            <Pressable onPress={() => setLineIndex(i => i + 1)} accessibilityLabel="Character" style={{ position: 'absolute', bottom: 0, left: (width - charW) / 2, width: charW, height: height * (narrow ? 0.6 : 0.94) }}>
                <Character uri={s.character} />
            </Pressable>
            {narrow ? (
                // 좁은 화면: 위에서부터 차례로 쌓아서 겹치지 않게
                <View style={{ position: 'absolute', top: 18, left: 18, right: 18, gap: 14 }}>
                    <Profile />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                        <VoiceBar />
                        <TopIcons />
                    </View>
                    <View pointerEvents="none" style={{ alignSelf: 'flex-start' }}>
                        <Speech lines={lines} index={lineIndex} />
                    </View>
                </View>
            ) : (
                <>
                    <View style={{ position: 'absolute', left: width * 0.25, top: height * 0.36 }} pointerEvents="none">
                        <Speech lines={lines} index={lineIndex} />
                    </View>
                    <View style={{ position: 'absolute', top: 18, left: 18 }}>
                        <Profile />
                    </View>
                    <View style={{ position: 'absolute', top: 18, right: 18 }}>
                        <TopIcons />
                    </View>
                    <View style={{ position: 'absolute', left: 20, bottom: 24 }}>
                        <VoiceBar />
                    </View>
                </>
            )}
            <View style={{ position: 'absolute', right: 24, bottom: 24, alignItems: 'flex-end', gap: 16 }}>
                <View style={{ flexDirection: 'row', gap: 16 }}>
                    <RoundButton names={['QuestsIcon', 'TrophyIcon', 'GameControllerIcon']} label="임무" onPress={() => leaveTo('quests')} />
                    <RoundButton names={['ShopIcon', 'GiftIcon']} label="구매" onPress={() => leaveTo('shop')} />
                    <RoundButton names={['ChatIcon', 'ChatSmileIcon', 'HeartIcon']} label="하트챗" onPress={() => go.heart()} dot={unreadDms > 0} />
                </View>
                <Pressable onPress={go.depart} accessibilityRole="button" accessibilityLabel="출발" style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
                    <View style={[{ width: 230, height: 76, borderRadius: 38, backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 3, borderColor: C.white, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }, shadow(6)]}>
                        <Icon names={['CompassIcon', 'ServerIcon', 'GlobeEarthIcon']} color={C.navy} size={32} />
                        <T size={26} color={C.navy} weight="800">
                            출발
                        </T>
                        {anyGuildUnread ? <Dot style={{ position: 'absolute', top: 6, right: 18 }} /> : null}
                    </View>
                </Pressable>
            </View>
            <Menu />
        </View>
    )
}
