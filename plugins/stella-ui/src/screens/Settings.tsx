import { useCallback, useEffect, useState } from 'react'
import { FlatList, Image, Pressable, ScrollView, TextInput, View } from 'react-native'
import {
    blockedIds,
    type AppToken,
    type Connection,
    fetchApps,
    fetchConnections,
    fetchMyProfile,
    fetchSessions,
    logoutSession,
    readSetting,
    removeApp,
    removeConnection,
    type Session,
    setCustomStatus,
    showConnection,
    STATUSES,
    toDataUrl,
    TOGGLES,
    unblock,
    updateMe,
    updateProfile,
    writeSetting,
} from '../account'
import { avatarUrl, displayName, me, pickImage, toast, user, useStores } from '../data'
import { formatTime } from '../markdown'
import { Avatar, Icon, T } from '../parts'
import { save, useSettings } from '../settings'
import { go, isNarrow } from '../state'
import { C, R, shadow } from '../theme'
import { Frame, leaveTo } from './Frame'
import { chooseCharacter } from './Lobby'
import { Chips, Note, Section, Toggle } from './Tools'
import { tr } from '../i18n'

/**
 * 설정: 디스코드 설정을 Stella 판으로. 비밀번호, 이메일, 2단계 인증, 결제처럼 보안 확인이 필요한 것만 디스코드 설정을 연다.
 */

type Page = 'account' | 'profile' | 'status' | 'chat' | 'blocked' | 'connections' | 'devices' | 'apps' | 'stella' | 'discord'

const PAGES: [Page, string, string[]][] = [
    ['account', '내 계정', ['UserCircleIcon', 'UserIcon']],
    ['profile', '프로필', ['IdIcon', 'UserSquareIcon', 'UserIcon']],
    ['status', '상태', ['CircleIcon', 'StatusIcon', 'MoonIcon']],
    ['chat', '채팅, 알림', ['ChatIcon', 'BellIcon']],
    ['blocked', '차단한 사람', ['DenyIcon', 'BlockIcon', 'XLargeIcon']],
    ['connections', '연결된 계정', ['LinkIcon', 'PuzzlePieceIcon']],
    ['devices', '기기', ['MobilePhoneIcon', 'ScreenIcon']],
    ['apps', '승인한 앱', ['AppsIcon', 'RobotIcon', 'PuzzlePieceIcon']],
    ['stella', 'Stella 화면', ['StarIcon', 'ImageIcon']],
    ['discord', '디스코드 설정 (결제, 보안)', ['SettingsIcon']],
]

// ── 부품 ────────────────────────────────────────────────────────────────
function Field({ label, value, onChange, multiline, placeholder, max }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; placeholder?: string; max?: number }) {
    return (
        <View style={{ gap: 4 }}>
            <T size={12} weight="800" color={C.muted}>
                {label}
            </T>
            <TextInput
                value={value}
                onChangeText={onChange}
                placeholder={tr(placeholder ?? label)}
                placeholderTextColor={C.muted}
                multiline={multiline}
                maxLength={max}
                style={{ minHeight: multiline ? 90 : 44, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.ink, fontWeight: '600', textAlignVertical: multiline ? 'top' : 'center' }}
            />
        </View>
    )
}

function Button({ label, onPress, kind = 'teal', disabled }: { label: string; onPress: () => void; kind?: 'teal' | 'white' | 'red'; disabled?: boolean }) {
    const bg = kind === 'teal' ? C.teal : kind === 'red' ? C.red : C.white
    return (
        <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}>
            <View style={[{ minHeight: 40, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: bg, borderWidth: kind === 'white' ? 1 : 0, borderColor: C.line }, shadow(1)]}>
                <T size={14} weight="800" color={kind === 'white' ? C.ink : C.white}>
                    {label}
                </T>
            </View>
        </Pressable>
    )
}

function Row({ label, value, action, onPress }: { label: string; value?: string; action?: string; onPress?: () => void }) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
                <T size={12} weight="800" color={C.muted}>
                    {label}
                </T>
                {value ? (
                    <T size={15} weight="700" lines={2}>
                        {value}
                    </T>
                ) : null}
            </View>
            {action && onPress ? <Button label={action} kind="white" onPress={onPress} /> : null}
        </View>
    )
}

const security = () => leaveTo('settings')

// ── 내 계정 ─────────────────────────────────────────────────────────────
function AccountPage() {
    const u = useStores(['UserStore'], me, [])
    const [name, setName] = useState(u?.globalName ?? u?.global_name ?? '')
    if (!u) return <Note text="계정 정보를 찾지 못했어요" />
    const mask = (e?: string) => (e ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '없음')
    return (
        <>
            <Section title="내 계정">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Avatar uri={avatarUrl(u, 128)} size={64} ring={C.teal} />
                    <View style={{ flex: 1 }}>
                        <T size={18} weight="800">
                            {displayName(u)}
                        </T>
                        <T size={13} color={C.muted}>
                            {u.username}
                        </T>
                    </View>
                </View>
                <Field label="표시 이름" value={name} onChange={setName} max={32} />
                <Button label="표시 이름 저장" onPress={async () => (await updateMe({ global_name: name.trim() || null })) && toast('표시 이름을 바꿨어요')} />
            </Section>
            <Section title="보안 (디스코드 화면에서 확인)">
                <Row label="사용자 이름" value={u.username} action="바꾸기" onPress={security} />
                <Row label="이메일" value={mask(u.email)} action="바꾸기" onPress={security} />
                <Row label="전화번호" value={u.phone ? '등록됨' : '없음'} action="바꾸기" onPress={security} />
                <Row label="비밀번호" action="바꾸기" onPress={security} />
                <Row label="2단계 인증" value={u.mfaEnabled ? '켜짐' : '꺼짐'} action="설정" onPress={security} />
                <Row label="로그아웃, 계정 삭제" action="열기" onPress={security} />
            </Section>
        </>
    )
}

// ── 프로필 ──────────────────────────────────────────────────────────────
function ProfilePage() {
    const u = me()
    const [bio, setBio] = useState('')
    const [pronouns, setPronouns] = useState('')
    const [ready, setReady] = useState(false)
    useEffect(() => {
        if (u?.id)
            fetchMyProfile(u.id).then(p => {
                setBio(p.bio)
                setPronouns(p.pronouns)
                setReady(true)
            })
    }, [])
    const picture = async (key: 'avatar' | 'banner') => {
        const uri = await pickImage()
        if (!uri) return
        const data = await toDataUrl(uri)
        if (data && (await updateMe({ [key]: data }))) toast(key === 'avatar' ? '아바타를 바꿨어요' : '배너를 바꿨어요')
    }
    return (
        <>
            <Section title="그림">
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <Button label="아바타 바꾸기" onPress={() => picture('avatar')} />
                    <Button label="배너 바꾸기 (Nitro)" kind="white" onPress={() => picture('banner')} />
                    <Button label="아바타 꾸미기" kind="white" onPress={go.shop} />
                </View>
            </Section>
            <Section title="소개">
                {ready ? (
                    <>
                        <Field label="대명사" value={pronouns} onChange={setPronouns} max={40} />
                        <Field label="자기소개" value={bio} onChange={setBio} multiline max={190} />
                        <Button label="저장" onPress={async () => (await updateProfile({ bio, pronouns })) && toast('프로필을 저장했어요')} />
                    </>
                ) : (
                    <T size={13} color={C.muted}>
                        불러오는 중…
                    </T>
                )}
            </Section>
            <Section title="미리보기">
                <Button label="내 프로필 보기" kind="white" onPress={() => u && go.profile(u.id)} />
            </Section>
        </>
    )
}

// ── 상태 ────────────────────────────────────────────────────────────────
function StatusPage() {
    const status = useStores(['UserSettingsProtoStore', 'PresenceStore'], () => readSetting('StatusSetting') ?? 'online', [])
    const custom = readSetting('CustomStatusSetting')
    const [text, setText] = useState(custom?.text ?? '')
    const [hours, setHours] = useState(0)
    return (
        <>
            <Section title="온라인 상태">
                {STATUSES.map(([k, label, color]) => (
                    <Pressable key={k} onPress={() => writeSetting('StatusSetting', k)} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected: status === k }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 46, paddingHorizontal: 12, borderRadius: 12, backgroundColor: status === k ? C.blueSoft : 'transparent' }}>
                            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: color }} />
                            <T size={15} weight="800" style={{ flex: 1 }}>
                                {label}
                            </T>
                            {status === k ? <Icon names={['CheckmarkLargeIcon', 'CheckmarkSmallIcon']} color={C.navy} size={18} /> : null}
                        </View>
                    </Pressable>
                ))}
            </Section>
            <Section title="상태 메시지">
                <Field label="상태 메시지" value={text} onChange={setText} max={128} placeholder="지금 뭐 하고 있어요?" />
                <Chips
                    options={[
                        [0, '계속'],
                        [1, '1시간'],
                        [4, '4시간'],
                        [24, '오늘 하루'],
                    ]}
                    value={hours}
                    onChange={setHours}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button label="저장" onPress={() => setCustomStatus(text, hours) && toast('상태 메시지를 바꿨어요')} />
                    <Button
                        label="지우기"
                        kind="white"
                        onPress={() => {
                            setText('')
                            setCustomStatus('', 0)
                        }}
                    />
                </View>
            </Section>
        </>
    )
}

// ── 채팅, 알림 ──────────────────────────────────────────────────────────
function ChatPage() {
    const values = useStores(['UserSettingsProtoStore'], () => TOGGLES.map(([k]) => readSetting(k)), [], (a, b) => a.every((v, i) => v === b[i]))
    const shown = TOGGLES.map(([k, label], i) => [k, label, values[i]] as const).filter(([, , v]) => typeof v === 'boolean')
    return (
        <Section title="채팅, 알림">
            {shown.length ? shown.map(([k, label, v]) => <Toggle key={k} label={label} value={v as boolean} onChange={x => writeSetting(k, x)} />) : <T color={C.muted}>바꿀 수 있는 설정을 찾지 못했어요</T>}
            <Button label="휴대폰 알림, 소리 등 더 보기" kind="white" onPress={security} />
        </Section>
    )
}

// ── 목록 화면들 ─────────────────────────────────────────────────────────
function useLoad<T>(load: () => Promise<T>) {
    const [data, setData] = useState<T | null>(null)
    const [error, setError] = useState('')
    const reload = useCallback(() => {
        load()
            .then(setData)
            .catch(e => setError(String(e?.body?.message ?? e?.message ?? e)))
    }, [])
    useEffect(reload, [reload])
    return { data, error, reload, setData }
}

function BlockedPage() {
    const ids = useStores(['RelationshipStore'], blockedIds, [], (a, b) => a.join() === b.join())
    return (
        <Section title={`차단한 사람 ${ids.length}명`}>
            {ids.length ? (
                ids.map(id => (
                    <View key={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Avatar uri={avatarUrl(user(id), 64)} size={36} ring="transparent" />
                        <T size={15} weight="800" lines={1} style={{ flex: 1 }}>
                            {displayName(user(id))}
                        </T>
                        <Button label="차단 풀기" kind="white" onPress={async () => (await unblock(id)) && toast('차단을 풀었어요')} />
                    </View>
                ))
            ) : (
                <T color={C.muted}>차단한 사람이 없어요</T>
            )}
        </Section>
    )
}

function ConnectionsPage() {
    const { data, error, setData } = useLoad(fetchConnections)
    if (error) return <Note text={`불러오지 못했어요: ${error}`} />
    if (!data) return <Note text="불러오는 중…" />
    return (
        <Section title="연결된 계정">
            {data.length ? (
                data.map((c: Connection) => (
                    <View key={`${c.type}${c.id}`} style={{ gap: 6, paddingVertical: 4 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <View style={{ flex: 1 }}>
                                <T size={12} weight="800" color={C.muted}>
                                    {c.type}
                                </T>
                                <T size={15} weight="800">
                                    {c.name}
                                </T>
                            </View>
                            <Button label="연결 끊기" kind="white" onPress={async () => (await removeConnection(c)) && setData(d => (d ?? []).filter(x => x !== c))} />
                        </View>
                        <Toggle label="프로필에 보이기" value={c.visible} onChange={async v => (await showConnection(c, v)) && setData(d => (d ?? []).map(x => (x === c ? { ...x, visible: v } : x)))} />
                    </View>
                ))
            ) : (
                <T color={C.muted}>연결된 계정이 없어요</T>
            )}
            <Button label="새 계정 연결 (디스코드 화면)" kind="white" onPress={security} />
        </Section>
    )
}

function DevicesPage() {
    const { data, error, setData } = useLoad(fetchSessions)
    if (error) return <Note text={`불러오지 못했어요: ${error}`} />
    if (!data) return <Note text="불러오는 중…" />
    return (
        <Section title="로그인한 기기">
            {data.map((s: Session) => (
                <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
                    <View style={{ flex: 1 }}>
                        <T size={15} weight="800">
                            {[s.os, s.platform].filter(Boolean).join(', ') || '알 수 없는 기기'}
                        </T>
                        <T size={12} color={C.muted}>
                            {[s.location, s.lastUsed ? formatTime(s.lastUsed / 1000, 'R') : ''].filter(Boolean).join(', ')}
                        </T>
                    </View>
                    <Button label="로그아웃" kind="white" onPress={async () => (await logoutSession(s.id)) && setData(d => (d ?? []).filter(x => x !== s))} />
                </View>
            ))}
            {!data.length ? <T color={C.muted}>다른 기기가 없어요</T> : null}
        </Section>
    )
}

function AppsPage() {
    const { data, error, setData } = useLoad(fetchApps)
    if (error) return <Note text={`불러오지 못했어요: ${error}`} />
    if (!data) return <Note text="불러오는 중…" />
    return (
        <Section title="승인한 앱">
            {data.map((a: AppToken) => (
                <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
                    <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: C.blueSoft, overflow: 'hidden' }}>{a.icon ? <Image source={{ uri: a.icon }} style={{ width: 36, height: 36 }} /> : null}</View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <T size={15} weight="800" lines={1}>
                            {a.name}
                        </T>
                        <T size={11} color={C.muted} lines={2}>
                            {a.scopes.join(', ')}
                        </T>
                    </View>
                    <Button label="끊기" kind="white" onPress={async () => (await removeApp(a.id)) && setData(d => (d ?? []).filter(x => x !== a))} />
                </View>
            ))}
            {!data.length ? <T color={C.muted}>승인한 앱이 없어요</T> : null}
        </Section>
    )
}

function StellaPage() {
    const s = useSettings()
    const [lines, setLines] = useState(s.lines)
    return (
        <>
            <Section title="그림">
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <Button label="캐릭터 그림 고르기" onPress={chooseCharacter} />
                    <Button
                        label="배경 고르기"
                        kind="white"
                        onPress={async () => {
                            const uri = await pickImage()
                            if (uri) save({ background: uri })
                        }}
                    />
                    {s.character || s.background ? <Button label="기본 그림으로" kind="white" onPress={() => save({ character: '', background: '' })} /> : null}
                </View>
            </Section>
            <Section title="캐릭터 말풍선">
                <Field label="한 줄에 하나, 비우면 기본 인사" value={lines} onChange={setLines} multiline />
                <Button label="저장" onPress={() => (save({ lines }), toast('말풍선을 저장했어요'))} />
            </Section>
            <Section title="시작">
                <Toggle label="디스코드를 켜면 로비부터" value={s.openOnStart} onChange={openOnStart => save({ openOnStart })} />
            </Section>
        </>
    )
}

function PageBody({ page }: { page: Page }) {
    switch (page) {
        case 'account':
            return <AccountPage />
        case 'profile':
            return <ProfilePage />
        case 'status':
            return <StatusPage />
        case 'chat':
            return <ChatPage />
        case 'blocked':
            return <BlockedPage />
        case 'connections':
            return <ConnectionsPage />
        case 'devices':
            return <DevicesPage />
        case 'apps':
            return <AppsPage />
        case 'stella':
            return <StellaPage />
        default:
            return (
                <Section title="디스코드 설정">
                    <T size={14} color={C.muted}>
                        Nitro, 결제, 구독, 비밀번호, 2단계 인증처럼 보안 확인이나 결제가 필요한 설정은 디스코드 설정 화면에서 바꿔요.
                    </T>
                    <Button label="디스코드 설정 열기" onPress={security} />
                </Section>
            )
    }
}

function PageList({ page, onPick }: { page?: Page; onPick: (p: Page) => void }) {
    return (
        <FlatList
            data={PAGES}
            keyExtractor={p => p[0]}
            renderItem={({ item: [k, label, icon] }) => (
                <Pressable onPress={() => onPick(k)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ marginHorizontal: 12, marginVertical: 4, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
                    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 14, borderRadius: 14, backgroundColor: page === k ? C.blue : 'rgba(255,255,255,0.92)' }, shadow(2)]}>
                        <Icon names={icon} color={page === k ? C.white : C.navy} size={20} />
                        <T size={15} weight="800" color={page === k ? C.white : C.ink} style={{ flex: 1 }} lines={1}>
                            {label}
                        </T>
                    </View>
                </Pressable>
            )}
            contentContainerStyle={{ paddingBottom: 24 }}
        />
    )
}

export function SettingsScreen({ width }: { width: number }) {
    const narrow = isNarrow(width)
    const [page, setPage] = useState<Page | undefined>(narrow ? undefined : 'account')
    const body = page ? (
        <ScrollView key={page} contentContainerStyle={{ padding: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            {narrow ? (
                <Pressable onPress={() => setPage(undefined)} accessibilityRole="button" accessibilityLabel="Settings list" style={{ marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', height: 34, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.92)' }}>
                        <Icon names={['ArrowLargeLeftIcon', 'ArrowLeftIcon']} color={C.navy} size={16} />
                        <T size={13} weight="800">
                            설정 목록
                        </T>
                    </View>
                </Pressable>
            ) : null}
            <PageBody page={page} />
        </ScrollView>
    ) : null
    return (
        <Frame title="설정" width={width}>
            {narrow ? (
                (body ?? <PageList onPick={setPage} />)
            ) : (
                <View style={{ flex: 1, flexDirection: 'row' }}>
                    <View style={{ width: Math.min(320, width * 0.3) }}>
                        <PageList page={page} onPick={setPage} />
                    </View>
                    <View style={{ flex: 1 }}>{body}</View>
                </View>
            )}
        </Frame>
    )
}
