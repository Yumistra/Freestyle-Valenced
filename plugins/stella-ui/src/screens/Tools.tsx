import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, ScrollView, Share, TextInput, View } from 'react-native'
import { avatarUrl, channel, displayName, idTime, toast, user, useStores } from '../data'
import { formatTime } from '../markdown'
import { Avatar, Icon, T } from '../parts'
import { go } from '../state'
import { C, R, shadow } from '../theme'
import {
    createInvite,
    fetchPins,
    type Level,
    type Member,
    memberCount,
    memberList,
    notifyState,
    requestMembers,
    searchMessages,
    setChannelLevel,
    setChannelMuted,
    setGuildLevel,
    setGuildMuted,
    setPinned,
    setSuppress,
} from '../tools'
import { RichText } from './Rich'
import { tr } from '../i18n'

/**
 * 채팅 머리줄 "더보기"에서 여는 도구들. 채팅 위에 흰 판으로 뜬다.
 */

export type Tool = 'menu' | 'pins' | 'search' | 'members' | 'notify' | 'invite'

// ── 공용 부품 ───────────────────────────────────────────────────────────
export function Sheet({ title, onClose, onBack, children }: { title: string; onClose: () => void; onBack?: () => void; children: any }) {
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, padding: 10 }}>
            <View style={[{ flex: 1, borderRadius: R.panel, backgroundColor: C.panel, overflow: 'hidden' }, shadow(10)]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 54, borderBottomWidth: 1, borderBottomColor: C.line }}>
                    {onBack ? (
                        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Tools back" hitSlop={8}>
                            <Icon names={['ArrowLargeLeftIcon', 'ArrowLeftIcon', 'ChevronLargeLeftIcon']} color={C.navy} size={22} />
                        </Pressable>
                    ) : null}
                    <T size={17} weight="800" lines={1} style={{ flex: 1 }}>
                        {title}
                    </T>
                    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close tools" hitSlop={8}>
                        <Icon names={['XLargeIcon', 'XSmallIcon', 'CloseIcon']} color={C.navy} size={22} />
                    </Pressable>
                </View>
                {children}
            </View>
        </View>
    )
}

export function Chips<V extends string | number>({ options, value, onChange }: { options: [V, string][]; value: V | undefined; onChange: (v: V) => void }) {
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {options.map(([v, label]) => {
                const on = v === value
                return (
                    <Pressable key={String(v)} onPress={() => onChange(v)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }}>
                        <View style={{ height: 34, paddingHorizontal: 14, borderRadius: R.pill, justifyContent: 'center', backgroundColor: on ? C.navy : C.white, borderWidth: 1, borderColor: on ? C.navy : C.line }}>
                            <T size={13} weight="800" color={on ? C.white : C.ink}>
                                {label}
                            </T>
                        </View>
                    </Pressable>
                )
            })}
        </View>
    )
}

export function Toggle({ label, sub, value, onChange }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
        <Pressable onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight="700">
                        {label}
                    </T>
                    {sub ? (
                        <T size={12} color={C.muted} style={{ marginTop: 2 }}>
                            {sub}
                        </T>
                    ) : null}
                </View>
                <View style={{ width: 48, height: 28, borderRadius: 14, padding: 3, backgroundColor: value ? C.teal : C.line, alignItems: value ? 'flex-end' : 'flex-start' }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: C.white }} />
                </View>
            </View>
        </Pressable>
    )
}

export function Section({ title, children }: { title: string; children: any }) {
    return (
        <View style={[{ marginBottom: 12, padding: 14, borderRadius: 16, backgroundColor: C.white, gap: 10 }, shadow(2)]}>
            <T size={13} weight="800" color={C.muted}>
                {title}
            </T>
            {children}
        </View>
    )
}

export function Note({ text }: { text: string }) {
    return (
        <View style={{ padding: 24, alignItems: 'center' }}>
            <T size={14} color={C.muted} style={{ textAlign: 'center' }}>
                {text}
            </T>
        </View>
    )
}

export function SearchBox({ value, onChange, placeholder, onSubmit }: { value: string; onChange: (v: string) => void; placeholder: string; onSubmit?: () => void }) {
    return (
        <View style={{ margin: 12, marginBottom: 6, height: 42, borderRadius: R.pill, backgroundColor: C.white, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }}>
            <Icon names={['MagnifyingGlassIcon', 'SearchIcon']} color={C.muted} size={18} />
            <TextInput value={value} onChangeText={onChange} placeholder={tr(placeholder)} placeholderTextColor={C.muted} returnKeyType="search" onSubmitEditing={onSubmit} style={{ flex: 1, fontSize: 15, color: C.ink, paddingVertical: 0, fontWeight: '600' }} />
        </View>
    )
}

/** API 로 받은 메시지 한 장 (고정, 검색 결과) */
const MiniMessage = memo(function MiniMessage({ m, guildId, onPress, right }: { m: any; guildId?: string; onPress: () => void; right?: any }) {
    const author = user(m.author?.id) ?? m.author
    const ch = channel(m.channel_id)
    const files = (m.attachments ?? []).length
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`found ${m.id}`} style={({ pressed }) => [{ marginHorizontal: 12, marginVertical: 5, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
            <View style={[{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, backgroundColor: C.white }, shadow(2)]}>
                <Avatar uri={avatarUrl(author, 64, guildId)} size={36} ring="transparent" />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <T size={14} weight="800" lines={1} style={{ flexShrink: 1 }}>
                            {displayName(author, guildId)}
                        </T>
                        <T size={11} color={C.muted}>
                            {`${ch && guildId ? `#${ch.name}, ` : ''}${formatTime(idTime(m.id) / 1000, 'f')}`}
                        </T>
                    </View>
                    {m.content ? <RichText text={m.content} guildId={guildId} tone="dark" size={14} /> : null}
                    {files ? (
                        <T size={12} color={C.muted}>
                            {`파일 ${files}개`}
                        </T>
                    ) : null}
                </View>
                {right}
            </View>
        </Pressable>
    )
})

// ── 도구 고르기 ─────────────────────────────────────────────────────────
function ToolMenu({ guildId, onPick }: { guildId?: string; onPick: (t: Tool) => void }) {
    const items: [Tool, string, string[]][] = [
        ['pins', '고정 메시지', ['PinIcon', 'PinUprightIcon']],
        ['search', '메시지 검색', ['MagnifyingGlassIcon', 'SearchIcon']],
        ['members', '멤버', ['GroupIcon', 'UserIcon', 'FriendsIcon']],
        ['notify', '알림 설정', ['BellIcon', 'NotificationIcon']],
    ]
    if (guildId) items.push(['invite', '초대 링크', ['UserPlusIcon', 'LinkIcon']])
    return (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
            {items.map(([k, label, icon]) => (
                <Pressable key={k} onPress={() => onPick(k)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
                    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 56, paddingHorizontal: 16, borderRadius: 14, backgroundColor: C.white }, shadow(2)]}>
                        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center' }}>
                            <Icon names={icon} color={C.navy} size={18} />
                        </View>
                        <T size={15} weight="800" style={{ flex: 1 }}>
                            {label}
                        </T>
                        <Icon names={['ChevronLargeRightIcon', 'ArrowLargeRightIcon']} color={C.muted} size={18} />
                    </View>
                </Pressable>
            ))}
        </ScrollView>
    )
}

// ── 고정 메시지 ─────────────────────────────────────────────────────────
function PinsPanel({ channelId, guildId, onJump }: { channelId: string; guildId?: string; onJump: (m: any) => void }) {
    const [list, setList] = useState<any[] | null>(null)
    const [error, setError] = useState('')
    const load = useCallback(() => {
        fetchPins(channelId)
            .then(setList)
            .catch(e => setError(String(e?.body?.message ?? e?.message ?? e)))
    }, [channelId])
    useEffect(load, [load])
    if (error) return <Note text={`고정 메시지를 불러오지 못했어요: ${error}`} />
    if (!list) return <Note text="불러오는 중…" />
    return (
        <FlatList
            data={list}
            keyExtractor={m => m.id}
            renderItem={({ item }) => (
                <MiniMessage
                    m={item}
                    guildId={guildId}
                    onPress={() => onJump(item)}
                    right={
                        <Pressable
                            onPress={async () => {
                                if (await setPinned(channelId, item.id, false)) setList(l => (l ?? []).filter(x => x.id !== item.id))
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`unpin ${item.id}`}
                            hitSlop={6}
                        >
                            <Icon names={['PinIcon', 'XSmallIcon']} color={C.muted} size={18} />
                        </Pressable>
                    }
                />
            )}
            ListEmptyComponent={<Note text="고정된 메시지가 없어요" />}
            contentContainerStyle={{ paddingVertical: 8 }}
        />
    )
}

// ── 검색 ────────────────────────────────────────────────────────────────
function SearchPanel({ channelId, guildId, onJump }: { channelId: string; guildId?: string; onJump: (m: any) => void }) {
    const [query, setQuery] = useState('')
    const [everywhere, setEverywhere] = useState(false)
    const [list, setList] = useState<any[] | null>(null)
    const [total, setTotal] = useState(0)
    const [note, setNote] = useState('')
    const busy = useRef(false)
    const run = useCallback(
        async (offset = 0) => {
            const q = query.trim()
            if (!q || busy.current) return
            busy.current = true
            if (!offset) setList(null)
            setNote('')
            try {
                const r = await searchMessages({ guildId, channelId, query: q, everywhere, offset })
                if (r.indexing) setNote('디스코드가 아직 검색 준비 중이에요, 잠시 뒤에 다시 해 보세요')
                setTotal(r.total)
                setList(cur => (offset ? [...(cur ?? []), ...r.messages] : r.messages))
            } catch (e: any) {
                setNote(`검색하지 못했어요: ${e?.body?.message ?? e?.message ?? e}`)
                setList([])
            }
            busy.current = false
        },
        [query, everywhere, guildId, channelId],
    )
    useEffect(() => {
        if (query.trim()) run(0)
    }, [everywhere])
    return (
        <View style={{ flex: 1 }}>
            <SearchBox value={query} onChange={setQuery} placeholder="찾을 말" onSubmit={() => run(0)} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 6 }}>
                {guildId ? (
                    <Chips
                        options={[
                            [0, '이 채널'],
                            [1, '서버 전체'],
                        ]}
                        value={everywhere ? 1 : 0}
                        onChange={v => setEverywhere(v === 1)}
                    />
                ) : null}
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => run(0)} accessibilityRole="button" accessibilityLabel="찾기">
                    <View style={{ height: 34, paddingHorizontal: 16, borderRadius: R.pill, backgroundColor: C.teal, justifyContent: 'center' }}>
                        <T size={13} color={C.white} weight="800">
                            찾기
                        </T>
                    </View>
                </Pressable>
            </View>
            {note ? <Note text={note} /> : null}
            {list == null ? (
                query.trim() ? <Note text="찾는 중…" /> : <Note text="찾을 말을 쓰고 찾기를 누르세요" />
            ) : (
                <FlatList
                    data={list}
                    keyExtractor={(m, i) => `${m.id}${i}`}
                    renderItem={({ item }) => <MiniMessage m={item} guildId={guildId} onPress={() => onJump(item)} />}
                    ListHeaderComponent={
                        list.length ? (
                            <T size={12} color={C.muted} style={{ marginHorizontal: 14, marginBottom: 4 }}>
                                {`${total}개 찾음`}
                            </T>
                        ) : null
                    }
                    ListEmptyComponent={note ? null : <Note text="찾은 메시지가 없어요" />}
                    onEndReached={() => list.length < total && run(list.length)}
                    onEndReachedThreshold={0.5}
                    contentContainerStyle={{ paddingBottom: 12 }}
                />
            )}
        </View>
    )
}

// ── 멤버 ────────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = { online: C.green, idle: C.gold, dnd: C.red, streaming: '#8a5cf6' }
const sameMembers = (a: Member[], b: Member[]) => a.length === b.length && a.every((m, i) => m.id === b[i].id && m.status === b[i].status && m.name === b[i].name)

const MemberRow = memo(function MemberRow({ m, guildId }: { m: Member; guildId?: string }) {
    return (
        <Pressable onPress={() => go.profile(m.id, guildId)} accessibilityRole="button" accessibilityLabel={`member ${m.name}`} style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
                <View>
                    <Avatar uri={avatarUrl(user(m.id), 64, guildId)} size={38} ring="transparent" />
                    <View style={{ position: 'absolute', right: -1, bottom: -1, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: C.panel, backgroundColor: STATUS_COLOR[m.status] ?? C.muted }} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight="800" lines={1} color={m.color ?? C.ink}>
                        {m.name}
                    </T>
                    <T size={12} color={C.muted} lines={1}>
                        {m.role ? `${m.role}, ${m.username}` : m.username}
                    </T>
                </View>
            </View>
        </Pressable>
    )
})

function MembersPanel({ channelId, guildId }: { channelId: string; guildId?: string }) {
    const [query, setQuery] = useState('')
    const all = useStores(['GuildMemberStore', 'PresenceStore', 'UserStore'], () => memberList(guildId, channelId), [guildId, channelId], sameMembers)
    const count = memberCount(guildId, channelId)
    useEffect(() => {
        if (!guildId || !query.trim()) return
        const t = setTimeout(() => requestMembers(guildId, query.trim()), 300)
        return () => clearTimeout(t)
    }, [query, guildId])
    const q = query.trim().toLowerCase()
    const list = q ? all.filter(m => m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)) : all
    const online = list.filter(m => m.status !== 'offline' && m.status !== 'invisible').length
    return (
        <View style={{ flex: 1 }}>
            <SearchBox value={query} onChange={setQuery} placeholder="멤버 찾기" />
            <T size={12} color={C.muted} style={{ marginHorizontal: 16, marginBottom: 4 }}>
                {`온라인 ${online}명${count ? `, 전체 ${count}명` : ''}${guildId ? ', 불러온 멤버만 보여요' : ''}`}
            </T>
            <FlatList data={list} keyExtractor={m => m.id} renderItem={({ item }) => <MemberRow m={item} guildId={guildId} />} initialNumToRender={20} windowSize={7} ListEmptyComponent={<Note text="멤버가 없어요" />} keyboardShouldPersistTaps="handled" />
        </View>
    )
}

// ── 알림 설정 ───────────────────────────────────────────────────────────
const MUTE_FOR: [number, string][] = [
    [900, '15분'],
    [3600, '1시간'],
    [28800, '8시간'],
    [86400, '24시간'],
    [-1, '계속'],
]
const sameNotify = (a: any, b: any) => Object.keys(a).every(k => a[k] === b[k])

function NotifyPanel({ channelId, guildId }: { channelId: string; guildId?: string }) {
    const n = useStores(['UserGuildSettingsStore'], () => notifyState(guildId, channelId), [guildId, channelId], sameNotify)
    const [muteFor, setMuteFor] = useState(-1)
    const ch = channel(channelId)
    return (
        <ScrollView contentContainerStyle={{ padding: 12 }}>
            <Section title={guildId ? `#${ch?.name ?? ''} 채널` : '이 대화'}>
                <Toggle label="음소거" sub={n.channelMuted ? '알림과 안 읽음 표시가 꺼져 있어요' : undefined} value={n.channelMuted} onChange={v => setChannelMuted(guildId, channelId, v, muteFor)} />
                {!n.channelMuted ? <Chips options={MUTE_FOR} value={muteFor} onChange={setMuteFor} /> : null}
                {guildId ? (
                    <Chips<Level>
                        options={[
                            [3, '서버 설정 따름'],
                            [0, '모든 메시지'],
                            [1, '멘션만'],
                            [2, '알림 없음'],
                        ]}
                        value={n.channelLevel}
                        onChange={v => setChannelLevel(guildId, channelId, v)}
                    />
                ) : null}
            </Section>
            {guildId ? (
                <Section title="서버 전체">
                    <Chips<Level>
                        options={[
                            [0, '모든 메시지'],
                            [1, '멘션만'],
                            [2, '알림 없음'],
                        ]}
                        value={n.guildLevel}
                        onChange={v => setGuildLevel(guildId, v)}
                    />
                    <Toggle label="서버 음소거" value={n.guildMuted} onChange={v => setGuildMuted(guildId, v, muteFor)} />
                    <Toggle label="@everyone, @here 알림 끄기" value={n.suppressEveryone} onChange={v => setSuppress(guildId, 'suppress_everyone', v)} />
                    <Toggle label="역할 멘션 알림 끄기" value={n.suppressRoles} onChange={v => setSuppress(guildId, 'suppress_roles', v)} />
                </Section>
            ) : null}
        </ScrollView>
    )
}

// ── 초대 ────────────────────────────────────────────────────────────────
function InvitePanel({ channelId }: { channelId: string }) {
    const [age, setAge] = useState(604800)
    const [uses, setUses] = useState(0)
    const [link, setLink] = useState('')
    const [busy, setBusy] = useState(false)
    const make = async () => {
        setBusy(true)
        const url = await createInvite(channelId, age, uses)
        setBusy(false)
        if (url) setLink(url)
    }
    return (
        <ScrollView contentContainerStyle={{ padding: 12 }}>
            <Section title="기간">
                <Chips
                    options={[
                        [1800, '30분'],
                        [3600, '1시간'],
                        [21600, '6시간'],
                        [43200, '12시간'],
                        [86400, '1일'],
                        [604800, '7일'],
                        [0, '무제한'],
                    ]}
                    value={age}
                    onChange={setAge}
                />
            </Section>
            <Section title="쓸 수 있는 횟수">
                <Chips
                    options={[
                        [0, '무제한'],
                        [1, '1번'],
                        [5, '5번'],
                        [10, '10번'],
                        [25, '25번'],
                        [100, '100번'],
                    ]}
                    value={uses}
                    onChange={setUses}
                />
            </Section>
            <Pressable onPress={make} disabled={busy} accessibilityRole="button" accessibilityLabel="초대 링크 만들기" style={({ pressed }) => [{ opacity: busy ? 0.5 : pressed ? 0.85 : 1 }]}>
                <View style={[{ height: 48, borderRadius: 14, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                    <T size={15} color={C.white} weight="800">
                        {busy ? '만드는 중…' : '초대 링크 만들기'}
                    </T>
                </View>
            </Pressable>
            {link ? (
                <View style={[{ marginTop: 12, padding: 14, borderRadius: 16, backgroundColor: C.white, gap: 10 }, shadow(2)]}>
                    <T size={16} weight="800" color={C.blue}>
                        {link}
                    </T>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Chips<string>
                            options={[
                                ['copy', '복사'],
                                ['share', '공유'],
                            ]}
                            value={undefined}
                            onChange={v => {
                                if (v === 'copy') {
                                    try {
                                        Clipboard.setString(link)
                                        toast('초대 링크를 복사했어요')
                                    } catch {}
                                } else Share.share({ message: link }).catch(() => {})
                            }}
                        />
                    </View>
                </View>
            ) : null}
        </ScrollView>
    )
}

// ── 모아서 ──────────────────────────────────────────────────────────────
const TITLES: Record<Tool, string> = { menu: '더보기', pins: '고정 메시지', search: '메시지 검색', members: '멤버', notify: '알림 설정', invite: '초대 링크' }

export function ChatTools({ tool, channelId, guildId, onTool, onJump }: { tool: Tool; channelId: string; guildId?: string; onTool: (t: Tool | null) => void; onJump: (m: any) => void }) {
    return (
        <Sheet title={TITLES[tool]} onClose={() => onTool(null)} onBack={tool === 'menu' ? undefined : () => onTool('menu')}>
            {tool === 'menu' ? (
                <ToolMenu guildId={guildId} onPick={onTool} />
            ) : tool === 'pins' ? (
                <PinsPanel channelId={channelId} guildId={guildId} onJump={onJump} />
            ) : tool === 'search' ? (
                <SearchPanel channelId={channelId} guildId={guildId} onJump={onJump} />
            ) : tool === 'members' ? (
                <MembersPanel channelId={channelId} guildId={guildId} />
            ) : tool === 'notify' ? (
                <NotifyPanel channelId={channelId} guildId={guildId} />
            ) : (
                <InvitePanel channelId={channelId} />
            )}
        </Sheet>
    )
}
