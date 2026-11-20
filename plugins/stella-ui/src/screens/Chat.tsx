import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Keyboard, Linking, Pressable, View } from 'react-native'
import { ack, avatarUrl, channel as channelOf, rememberThread, deleteMessage, displayName, loadMessages, me, messageArray, messagesOf, roleColor, S, syncChannel, toast, toggleReaction, useStores } from '../data'
import { previewText } from '../markdown'
import { Avatar, Icon, PillButton, T } from '../parts'
import { go, useUi } from '../state'
import { C, R, shadow } from '../theme'
import { imageSources, openViewer, SmartImage } from '../viewer'
import { Components, EmbedCard, hasEmbedContent, Reactions, RichText } from './Rich'
import { Composer, type Mode } from './Composer'
import { StickerView } from './Sticker'
import { ChatTools, type Tool } from './Tools'
import { setPinned } from '../tools'

/**
 * 말풍선 채팅 (하트챗과 서버 채널이 같이 쓴다).
 * 상대는 왼쪽 흰 말풍선, 나는 오른쪽 파란 말풍선. 서버면 첫 말풍선 위에 이름(역할 색).
 * 꾹 누르면 반응, 답장, 복사, (내 것) 수정, 삭제.
 */

const GROUP_GAP = 5 * 60 * 1000
const SYSTEM_JOIN = 7
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🔥', '✅']

export interface Row {
    m: any
    mine: boolean
    /** 같은 사람이 이어서 보낸 첫 메시지 (이름, 프로필을 보여 준다) */
    head: boolean
}

const time = (m: any) => {
    const t = m?.timestamp
    const v = typeof t?.valueOf === 'function' ? Number(t.valueOf()) : Date.parse(t)
    return Number.isFinite(v) ? v : 0
}

const isSystem = (m: any) => m && m.type !== 0 && m.type !== 19

/** 시간 순 메시지를 아래가 최신인 거꾸로 목록 줄로 */
export function buildRows(list: any[], myId: string | undefined): Row[] {
    const rows: Row[] = []
    for (let i = 0; i < list.length; i++) {
        const m = list[i]
        const prev = list[i - 1]
        const head = !prev || prev.author?.id !== m.author?.id || time(m) - time(prev) > GROUP_GAP || isSystem(prev) || !!m.messageReference
        rows.push({ m, mine: !!myId && m.author?.id === myId, head })
    }
    return rows.reverse()
}

// ── 파일, 스티커 ────────────────────────────────────────────────────────
function Files({ m, mine }: { m: any; mine: boolean }) {
    const files: any[] = m.attachments ?? []
    const stickers: any[] = m.stickerItems ?? m.sticker_items ?? []
    if (!files.length && !stickers.length) return null
    return (
        <View style={{ gap: 6 }}>
            {files.map((f: any) => {
                const isImage = /^image\//.test(f.content_type ?? '') || (f.width && f.height)
                const url = f.proxy_url ?? f.url
                if (isImage && url) {
                    const w = Math.min(260, f.width ?? 260)
                    const h = f.width && f.height ? Math.round((w * f.height) / f.width) : 180
                    const sources = imageSources(f)
                    return (
                        <Pressable key={f.id ?? url} onPress={() => openViewer(sources, f.width, f.height, f.url)} accessibilityRole="imagebutton" accessibilityLabel={`image ${f.id ?? ''}`}>
                            <SmartImage sources={sources} style={{ width: w, height: Math.min(h, 340), borderRadius: 10, backgroundColor: C.blueSoft }} />
                        </Pressable>
                    )
                }
                return (
                    <Pressable key={f.id ?? url} onPress={() => url && Linking.openURL(f.url ?? url).catch(() => {})}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, backgroundColor: mine ? 'rgba(255,255,255,0.18)' : C.blueSoft }}>
                            <Icon names={['AttachmentIcon', 'PaperclipIcon', 'FileIcon']} color={mine ? C.white : C.navy} size={16} />
                            <T size={13} color={mine ? C.white : C.ink} style={{ flexShrink: 1 }}>
                                {f.filename ?? '파일'}
                            </T>
                        </View>
                    </Pressable>
                )
            })}
            {stickers.map((s: any) => (
                <StickerView key={s.id} s={s} mine={mine} />
            ))}
        </View>
    )
}

// ── 한 줄 ───────────────────────────────────────────────────────────────
/** 답장: 말풍선 맨 위 옅은 칸에 원래 메시지 (누르면 그 메시지로) */
function ReplyQuote({ m, guildId, mine, onJump, alone }: { m: any; guildId?: string; mine: boolean; onJump: (id: string) => void; alone?: boolean }) {
    const ref = m.messageReference ?? m.message_reference
    if (!ref?.message_id) return null
    const target = S().MessageStore?.getMessage?.(ref.channel_id ?? m.channel_id, ref.message_id)
    const onBlue = mine && !alone
    const name = target ? displayName(target.author, guildId) : ''
    const text = target ? previewText(target, guildId) || '[메시지]' : '원래 메시지를 불러오지 못했어요'
    return (
        <Pressable onPress={() => onJump(ref.message_id)} accessibilityRole="button" accessibilityLabel={`reply to ${ref.message_id}`} style={{ alignSelf: 'stretch' }}>
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10, backgroundColor: onBlue ? 'rgba(255,255,255,0.18)' : alone ? C.white : C.blueSoft, minWidth: 160 }}>
                {target ? <Avatar uri={avatarUrl(target.author, 48, guildId)} size={22} ring="transparent" /> : null}
                <View style={{ flexShrink: 1 }}>
                    {name ? (
                        <T size={12} color={onBlue ? C.white : (roleColor(guildId, target?.author?.id) ?? C.navy)} weight="800" lines={1}>
                            {name}
                        </T>
                    ) : null}
                    <T size={12} color={onBlue ? '#e6ecff' : C.muted} weight="600" lines={2}>
                        {text}
                    </T>
                </View>
            </View>
        </Pressable>
    )
}

/** 스레드 카드 (누르면 그 스레드로) */
function ThreadCard({ thread, guildId, parentId }: { thread: any; guildId?: string; parentId?: string }) {
    rememberThread(thread, parentId, guildId)
    const ch = channelOf(thread.id) ?? thread
    const count = ch.messageCount ?? ch.message_count
    return (
        <Pressable onPress={() => go.open({ ...ch, guild_id: ch.guild_id ?? guildId })} accessibilityRole="button" accessibilityLabel={`thread ${thread.id}`} style={{ alignSelf: 'stretch' }}>
            <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: C.white, maxWidth: 420 }, shadow(2)]}>
                <Icon names={['ThreadIcon', 'TextIcon']} color={C.navy} size={20} />
                <View style={{ flexShrink: 1 }}>
                    <T size={14} weight="800" lines={1}>
                        {ch.name ?? '스레드'}
                    </T>
                    {count != null ? (
                        <T size={12} color={C.muted} weight="700">
                            {`메시지 ${count}개`}
                        </T>
                    ) : null}
                </View>
                <Icon names={['ChevronLargeRightIcon', 'ArrowLargeRightIcon']} color={C.muted} size={16} />
            </View>
        </Pressable>
    )
}

const SYSTEM_THREAD_CREATED = 18

export const MessageRow = memo(function MessageRow({ row, guildId, showNames, onMenu, onJump, lit }: { row: Row; guildId?: string; showNames: boolean; onMenu: (m: any) => void; onJump: (id: string) => void; lit?: boolean }) {
    const { m, mine, head } = row
    if (m.type === SYSTEM_THREAD_CREATED) {
        // 스레드를 시작했다는 알림: 누가 시작했는지와 스레드 카드
        const ref = m.messageReference ?? m.message_reference
        const thread = m.thread ?? (ref?.channel_id ? { id: ref.channel_id, name: m.content } : undefined)
        return (
            <View style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 20, gap: 6 }}>
                <T size={12} color={C.white} weight="700">
                    {`${displayName(m.author, guildId)} 님이 스레드를 시작했어요`}
                </T>
                {thread ? <ThreadCard thread={thread} guildId={guildId} parentId={m.channel_id} /> : null}
            </View>
        )
    }
    if (isSystem(m)) {
        const text = m.type === SYSTEM_JOIN ? `${displayName(m.author, guildId)} 님이 들어왔어요` : previewText(m, guildId) || '시스템 메시지'
        return (
            <View style={{ alignItems: 'center', paddingVertical: 6, paddingHorizontal: 20 }}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.22)' }}>
                    <T size={12} color={C.white} weight="600">
                        {text}
                    </T>
                </View>
            </View>
        )
    }
    const embeds: any[] = (m.embeds ?? []).filter(hasEmbedContent)
    const components: any[] = m.components ?? []
    const hasText = !!m.content
    const hasFiles = !!(m.attachments?.length || m.stickerItems?.length || m.sticker_items?.length)
    const reply = !!(m.messageReference ?? m.message_reference)?.message_id
    // 글도 파일도 없으면 임베드, 컴포넌트를 말풍선 없이 카드로만
    const bubble = hasText || hasFiles
    const empty = !bubble && !embeds.length && !components.length
    const showProfile = () => m.author?.id && go.profile(m.author.id, guildId)
    const avatar = (
        <View style={{ width: 48 }}>
            {head ? (
                <Pressable onPress={showProfile} accessibilityRole="button" accessibilityLabel={`profile ${m.author?.id}`}>
                    <Avatar uri={avatarUrl(m.author, 96, guildId)} size={48} />
                </Pressable>
            ) : null}
        </View>
    )
    const pending = m.state === 'SENDING'
    const failed = m.state === 'SEND_FAILED'
    const edited = m.editedTimestamp || m.edited_timestamp
    const tone = mine ? 'light' : 'dark'
    const toggle = (r: any) => {
        if (!toggleReaction(m.channel_id, m.id, r.emoji ?? {}, !!r.me)) toast('반응을 바꾸지 못했어요')
    }
    return (
        <View style={{ paddingHorizontal: 12, paddingTop: head ? 10 : 3 }}>
            <View style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start', alignItems: 'flex-start', gap: 10 }}>
                {mine ? null : avatar}
                <View style={{ maxWidth: '78%', flexShrink: 1, alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
                    {head && showNames && !mine ? (
                        <Pressable onPress={showProfile} style={{ paddingHorizontal: 10, paddingVertical: 2, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.92)', marginLeft: 2 }}>
                            <T size={13} color={roleColor(guildId, m.author?.id) ?? C.navy} weight="800" lines={1}>
                                {displayName(m.author, guildId)}
                            </T>
                        </Pressable>
                    ) : null}
                    <Pressable onLongPress={() => onMenu(m)} delayLongPress={350} accessibilityLabel={`message ${m.id}`} style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 4, maxWidth: '100%' }}>
                        {bubble || empty ? (
                            <View
                                style={[
                                    {
                                        paddingHorizontal: 16,
                                        paddingVertical: 10,
                                        borderRadius: 18,
                                        borderTopLeftRadius: !mine && head ? 4 : 18,
                                        borderTopRightRadius: mine && head ? 4 : 18,
                                        backgroundColor: mine ? C.blue : C.white,
                                        opacity: pending ? 0.6 : 1,
                                        borderWidth: failed || lit ? 2 : 0,
                                        borderColor: failed ? C.red : C.teal,
                                        gap: 6,
                                        maxWidth: '100%',
                                    },
                                    shadow(2),
                                ]}
                            >
                                {reply ? <ReplyQuote m={m} guildId={guildId} mine={mine} onJump={onJump} /> : null}
                                {hasText ? <RichText text={m.content} guildId={guildId} tone={tone} /> : null}
                                <Files m={m} mine={mine} />
                                {empty ? (
                                    <T size={13} color={mine ? '#dfe7ff' : C.muted} weight="600">
                                        [표시할 수 없는 메시지]
                                    </T>
                                ) : null}
                                {edited ? (
                                    <T size={10} color={mine ? '#dfe7ff' : C.muted} weight="500" style={{ alignSelf: 'flex-end' }}>
                                        (수정됨)
                                    </T>
                                ) : null}
                            </View>
                        ) : null}
                        {reply && !bubble && !empty ? <ReplyQuote m={m} guildId={guildId} mine={mine} onJump={onJump} alone /> : null}
                        {m.thread ? <ThreadCard thread={m.thread} guildId={guildId} parentId={m.channel_id} /> : null}
                        {embeds.map((e, i) => (
                            <EmbedCard key={i} e={e} guildId={guildId} />
                        ))}
                        {components.length ? (
                            <View style={{ gap: 6, maxWidth: 440 }}>
                                <Components list={components} guildId={guildId} />
                            </View>
                        ) : null}
                    </Pressable>
                    <Reactions list={m.reactions} onToggle={toggle} />
                    {failed ? (
                        <T size={11} color={C.red} weight="700">
                            보내지 못했어요
                        </T>
                    ) : null}
                </View>
                {mine ? avatar : null}
            </View>
        </View>
    )
})

/** 화면에 잘못 나오는 메시지를 알려 줄 때 쓰는 정보 (글 내용 없이 모양만) */
export function messageInfo(m: any): string {
    const seen = new WeakSet()
    const shape = (v: any, depth: number): any => {
        if (v == null || typeof v !== 'object') return typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : v
        if (seen.has(v) || depth > 6) return '…'
        seen.add(v)
        if (Array.isArray(v)) return v.slice(0, 10).map(x => shape(x, depth + 1))
        const out: any = {}
        for (const k of Object.keys(v).slice(0, 40)) if (k !== 'author' && typeof v[k] !== 'function') out[k] = shape(v[k], depth + 1)
        return out
    }
    return JSON.stringify({ type: m.type, flags: m.flags, content: m.content, embeds: shape(m.embeds, 0), components: shape(m.components, 0), thread: shape(m.thread, 0), reference: shape(m.messageReference, 0) }, null, 1).slice(0, 6000)
}

// ── 꾹 누르기 메뉴 ──────────────────────────────────────────────────────

function MessageMenu({ m, guildId, onClose, onMode }: { m: any; guildId?: string; onClose: () => void; onMode: (mode: Mode) => void }) {
    const [confirmDelete, setConfirmDelete] = useState(false)
    const mine = m.author?.id === me()?.id
    const react = (name: string) => {
        const had = (m.reactions ?? []).some((r: any) => !r.emoji?.id && r.emoji?.name === name && r.me)
        if (!toggleReaction(m.channel_id, m.id, { name }, had)) toast('반응을 바꾸지 못했어요')
        onClose()
    }
    const item = (names: string[], label: string, onPress: () => void, danger?: boolean) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 50, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.white, borderWidth: 1, borderColor: C.line }}>
                <Icon names={names} color={danger ? C.red : C.navy} size={20} />
                <T size={15} color={danger ? C.red : C.ink} weight="800">
                    {label}
                </T>
            </View>
        </Pressable>
    )
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, justifyContent: 'flex-end' }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose} accessibilityLabel="Close message menu" />
            <View style={[{ margin: 12, padding: 14, gap: 8, borderRadius: R.panel, backgroundColor: C.panel }, shadow(10)]}>
                <T size={13} color={C.muted} lines={2}>
                    {`${displayName(m.author, guildId)}: ${previewText(m, guildId)}`}
                </T>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                    {QUICK.map(e => (
                        <Pressable key={e} onPress={() => react(e)} accessibilityRole="button" accessibilityLabel={`react ${e}`} hitSlop={4}>
                            <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line }}>
                                <T size={20}>{e}</T>
                            </View>
                        </Pressable>
                    ))}
                </View>
                {item(['ArrowAngleLeftUpIcon', 'ReplyIcon'], '답장', () => (onMode({ kind: 'reply', m }), onClose()))}
                {item(['BugIcon', 'CodeIcon', 'CopyIcon'], '메시지 정보 복사', () => {
                    try {
                        Clipboard.setString(messageInfo(m))
                        toast('메시지 정보를 복사했어요')
                    } catch {}
                    onClose()
                })}
                {m.content
                    ? item(['CopyIcon'], '글 복사', () => {
                          try {
                              Clipboard.setString(m.content)
                              toast('복사했어요')
                          } catch {}
                          onClose()
                      })
                    : null}
                {item(['PinIcon', 'PinUprightIcon'], m.pinned ? '고정 해제' : '고정', () => {
                    setPinned(m.channel_id, m.id, !m.pinned).then(ok => ok && toast(m.pinned ? '고정을 풀었어요' : '고정했어요'))
                    onClose()
                })}
                {mine && m.content ? item(['PencilIcon', 'EditIcon'], '수정', () => (onMode({ kind: 'edit', m }), onClose())) : null}
                {mine
                    ? item(['TrashIcon'], confirmDelete ? '정말 지울까요? 한 번 더 누르세요' : '삭제', () => {
                          if (!confirmDelete) return setConfirmDelete(true)
                          if (!deleteMessage(m.channel_id, m.id)) toast('지우지 못했어요')
                          onClose()
                      }, true)
                    : null}
            </View>
        </View>
    )
}

// ── 키보드 ──────────────────────────────────────────────────────────────
/**
 * 키보드에 가려지는 만큼만 띄운다.
 * 화면이 이미 키보드만큼 줄어드는 기기(대부분의 휴대폰)는 0, 줄지 않는 기기는 가려진 만큼.
 */
function useKeyboardPad(ref: { current: any }) {
    const [pad, setPad] = useState(0)
    const top = useRef<number | null>(null)
    const measure = useCallback(() => {
        const kb = top.current
        if (kb == null || !ref.current?.measureInWindow) return setPad(0)
        ref.current.measureInWindow((_x: number, y: number, _w: number, h: number) => {
            // 이 칸의 바닥이 키보드 위쪽보다 아래면 그만큼 가려진다 (안쪽 여백은 바깥 크기를 바꾸지 않는다)
            setPad(Math.max(0, Math.round(y + h - kb)))
        })
    }, [])
    useEffect(() => {
        const a = Keyboard.addListener('keyboardDidShow', (e: any) => {
            top.current = e?.endCoordinates?.screenY ?? null
            // 화면이 줄어드는 기기는 줄어든 다음에 잰다
            setTimeout(measure, 60)
        })
        const b = Keyboard.addListener('keyboardDidHide', () => {
            top.current = null
            setPad(0)
        })
        return () => {
            a.remove()
            b.remove()
        }
    }, [])
    return { pad, onLayout: () => top.current != null && measure() }
}

/** 여기부터 새 메시지 */
function NewDivider() {
    return (
        <View accessibilityLabel="new messages" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginVertical: 8 }}>
            <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: C.red }} />
            <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: R.pill, backgroundColor: C.red }}>
                <T size={11} color={C.white} weight="800">
                    새 메시지
                </T>
            </View>
        </View>
    )
}

// ── 머리줄 버튼 (좁으면 아이콘만) ───────────────────────────────────────
function HeadButton({ label, names, compact, onPress }: { label: string; names: string[]; compact: boolean; onPress: () => void }) {
    if (!compact) return <PillButton label={label} kind="white" small onPress={onPress} />
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
            <View style={[{ width: 38, height: 38, borderRadius: 19, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }, shadow(2)]}>
                <Icon names={names} color={C.navy} size={20} />
            </View>
        </Pressable>
    )
}

// ── 채팅 전체 ───────────────────────────────────────────────────────────
export interface ChatHead {
    avatar?: string
    title: string
    subtitle?: string
    icon?: string[]
    /** 머리줄 그림을 누르면 (DM 이면 상대 프로필) */
    onPress?: () => void
}

export function Chat({ channelId, guildId, head, compact = false, onList, top }: { channelId: string; guildId?: string; head: ChatHead; compact?: boolean; onList?: () => void; top?: any }) {
    const [tool, setTool] = useState<Tool | null>(null)
    const visible = useUi(s => s.visible)
    const list = useStores(['MessageStore'], () => messagesOf(channelId), [channelId])
    const myId = me()?.id
    const rows = useMemo(() => buildRows(messageArray(list), myId), [list, myId])
    // 읽음 표시하기 전에 처음 안 읽은 메시지를 기억해 둔다 ("새 메시지" 줄)
    const firstUnread = useMemo(() => {
        try {
            return S().ReadStateStore?.hasUnread?.(channelId) ? S().ReadStateStore?.getOldestUnreadMessageId?.(channelId) : undefined
        } catch {
            return undefined
        }
    }, [channelId])
    const [menu, setMenu] = useState<any>(null)
    const [mode, setMode] = useState<Mode>(null)
    const box = useRef<any>(null)
    const listRef = useRef<any>(null)
    const [lit, setLit] = useState<string | null>(null)
    const kb = useKeyboardPad(box)
    const rowsRef = useRef(rows)
    rowsRef.current = rows
    // 답장 칸을 누르면 원래 메시지로 가서 잠깐 테두리로 표시한다
    const jump = useCallback((id: string) => {
        const index = rowsRef.current.findIndex(r => r.m.id === id)
        if (index < 0) return toast('원래 메시지가 너무 위에 있어요')
        try {
            listRef.current?.scrollToIndex?.({ index, viewPosition: 0.5, animated: true })
        } catch {}
        setLit(id)
        setTimeout(() => setLit(cur => (cur === id ? null : cur)), 1600)
    }, [])

    useEffect(() => loadMessages(channelId), [channelId])
    // DM 도 디스코드 쪽에서 열어 둔다 (입력 중 알림 등이 오게)
    useEffect(() => {
        if (!guildId) syncChannel('@me', channelId)
    }, [guildId, channelId])
    // 보고 있는 동안 들어온 메시지는 읽음으로
    const newest = rows[0]?.m?.id
    useEffect(() => {
        if (visible) ack(channelId)
    }, [channelId, newest, visible])

    const older = useCallback(() => {
        const a = messageArray(messagesOf(channelId))
        if (a.length && messagesOf(channelId)?.hasMoreBefore !== false) loadMessages(channelId, a[0].id)
    }, [channelId])

    const renderItem = useCallback(
        ({ item }: { item: Row }) => (
            <>
                {item.m.id === firstUnread && !item.mine ? <NewDivider /> : null}
                <MessageRow row={item} guildId={guildId} showNames={!!guildId} onMenu={setMenu} onJump={jump} lit={item.m.id === lit} />
            </>
        ),
        [guildId, jump, lit, firstUnread],
    )
    const ch = channelOf(channelId)
    const placeholder = guildId ? `#${ch?.name ?? ''} 에 메시지 보내기` : `${head.title} 에게 메시지 보내기`

    return (
        <View ref={box} onLayout={kb.onLayout} style={{ flex: 1, paddingBottom: kb.pad }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 8 : 14, paddingHorizontal: compact ? 12 : 18, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.25)' }}>
                {head.avatar ? (
                    <Pressable onPress={head.onPress} disabled={!head.onPress} accessibilityRole="button" accessibilityLabel="chat profile">
                        <Avatar uri={head.avatar} size={compact ? 44 : 56} />
                    </Pressable>
                ) : (
                    <View style={{ width: compact ? 40 : 48, height: compact ? 40 : 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={head.icon ?? ['TextIcon']} color={C.navy} size={compact ? 22 : 26} />
                    </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={compact ? 18 : 22} color={C.white} weight="800" lines={1}>
                        {head.title}
                    </T>
                    {head.subtitle ? (
                        <T size={13} color="rgba(255,255,255,0.85)" weight="600" lines={compact ? 1 : 2} style={{ marginTop: 2 }}>
                            {head.subtitle}
                        </T>
                    ) : null}
                </View>
                <HeadButton label="더보기" names={['MoreHorizontalIcon', 'MoreVerticalIcon', 'SettingsIcon']} compact onPress={() => setTool('menu')} />
                {onList ? <HeadButton label="리스트" names={['ListBulletsIcon', 'ChannelListIcon', 'HamburgerIcon']} compact={compact} onPress={onList} /> : null}
            </View>
            {top}
            <FlatList
                ref={listRef}
                data={rows}
                extraData={lit}
                inverted
                onScrollToIndexFailed={(info: any) => {
                    // 아직 안 그린 줄이면 대충 그 근처로 간 다음 다시
                    listRef.current?.scrollToOffset?.({ offset: info.averageItemLength * info.index, animated: false })
                    setTimeout(() => {
                        try {
                            listRef.current?.scrollToIndex?.({ index: info.index, viewPosition: 0.5, animated: true })
                        } catch {}
                    }, 120)
                }}
                keyExtractor={r => r.m.id}
                renderItem={renderItem}
                onEndReached={older}
                onEndReachedThreshold={0.4}
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={9}
                removeClippedSubviews
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingVertical: 10 }}
                style={{ flex: 1 }}
            />
            <Composer channelId={channelId} placeholder={placeholder} mode={mode} onMode={setMode} guildId={guildId} />
            {tool ? (
                <ChatTools
                    tool={tool}
                    channelId={channelId}
                    guildId={guildId}
                    onTool={setTool}
                    onJump={m => {
                        setTool(null)
                        if (m.channel_id && m.channel_id !== channelId) {
                            const target = channelOf(m.channel_id)
                            if (target) go.open(target)
                            else toast('그 채널을 열 수 없어요')
                            return
                        }
                        jump(m.id)
                    }}
                />
            ) : null}
            {menu ? <MessageMenu m={menu} guildId={guildId} onClose={() => setMenu(null)} onMode={setMode} /> : null}
        </View>
    )
}
