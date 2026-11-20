import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Image, Keyboard, Linking, Pressable, Text, TextInput, View } from 'react-native'
import { ack, avatarUrl, channel as channelOf, displayName, emojiUrl, loadMessages, me, messageArray, messagesOf, parseContent, previewText, roleColor, S, sendMessage, useStores } from '../data'
import { Avatar, Icon, PillButton, T } from '../parts'
import { useUi } from '../state'
import { C, R, shadow } from '../theme'

/**
 * 말풍선 채팅 (하트챗과 서버 채널이 같이 쓴다).
 * 상대는 왼쪽 흰 말풍선, 나는 오른쪽 파란 말풍선. 서버면 첫 말풍선 위에 이름(역할 색).
 */

const GROUP_GAP = 5 * 60 * 1000
const SYSTEM_JOIN = 7

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

const isSystem = (m: any) => m && m.type !== 0 && m.type !== 19

// ── 글 ──────────────────────────────────────────────────────────────────
const MessageText = memo(function MessageText({ content, guildId, mine }: { content: string; guildId?: string; mine: boolean }) {
    const pieces = useMemo(() => parseContent(content, guildId), [content, guildId])
    const onlyEmoji = pieces.length > 0 && pieces.length <= 6 && pieces.every(p => p.t === 'emoji' || (p.t === 'text' && !p.v.trim()))
    const color = mine ? C.white : C.ink
    const big = onlyEmoji ? 40 : 20
    return (
        <Text style={{ fontSize: 15, lineHeight: 21, color, fontWeight: '600' }}>
            {pieces.map((p, i) => {
                switch (p.t) {
                    case 'mention':
                        return (
                            <Text key={i} style={{ color: mine ? '#dfe7ff' : C.blue, fontWeight: '800' }}>
                                {p.v}
                            </Text>
                        )
                    case 'link':
                        return (
                            <Text key={i} style={{ textDecorationLine: 'underline', color: mine ? '#e8eeff' : C.blue }} onPress={() => Linking.openURL(p.v).catch(() => {})}>
                                {p.v}
                            </Text>
                        )
                    case 'emoji':
                        return <Image key={i} source={{ uri: emojiUrl(p.id, p.animated, onlyEmoji ? 96 : 48) }} style={{ width: big, height: big }} />
                    default:
                        return p.v
                }
            })}
        </Text>
    )
})

// ── 파일, 임베드, 스티커 ────────────────────────────────────────────────
function Attachments({ m, mine }: { m: any; mine: boolean }) {
    const files: any[] = m.attachments ?? []
    const stickers: any[] = m.stickerItems ?? m.sticker_items ?? []
    const embeds: any[] = (m.embeds ?? []).filter((e: any) => e?.rawTitle || e?.title || e?.rawDescription || e?.description)
    if (!files.length && !stickers.length && !embeds.length) return null
    return (
        <View style={{ gap: 6, marginTop: m.content ? 6 : 0 }}>
            {files.map((f: any) => {
                const isImage = /^image\//.test(f.content_type ?? '') || (f.width && f.height)
                const url = f.proxy_url ?? f.url
                if (isImage && url) {
                    const w = Math.min(260, f.width ?? 260)
                    const h = f.width && f.height ? Math.round((w * f.height) / f.width) : 180
                    return (
                        <Pressable key={f.id ?? url} onPress={() => Linking.openURL(f.url ?? url).catch(() => {})}>
                            <Image source={{ uri: url }} style={{ width: w, height: Math.min(h, 340), borderRadius: 10, backgroundColor: C.blueSoft }} resizeMode="cover" />
                        </Pressable>
                    )
                }
                return (
                    <Pressable key={f.id ?? url} onPress={() => url && Linking.openURL(f.url ?? url).catch(() => {})}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8, backgroundColor: mine ? 'rgba(255,255,255,0.18)' : C.blueSoft }}>
                            <Icon names={['AttachmentIcon', 'PaperclipIcon', 'FileIcon']} color={mine ? C.white : C.navy} size={16} />
                            <T size={13} color={mine ? C.white : C.ink} lines={1} style={{ maxWidth: 220 }}>
                                {f.filename ?? '파일'}
                            </T>
                        </View>
                    </Pressable>
                )
            })}
            {stickers.map((s: any) =>
                s.format_type === 3 ? (
                    <T key={s.id} size={13} color={mine ? C.white : C.muted}>
                        {`[스티커] ${s.name ?? ''}`}
                    </T>
                ) : (
                    <Image key={s.id} source={{ uri: `https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}?size=160` }} style={{ width: 120, height: 120 }} />
                ),
            )}
            {embeds.slice(0, 2).map((e: any, i: number) => (
                <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: mine ? C.white : C.teal, paddingLeft: 8, maxWidth: 300 }}>
                    {e.rawTitle || e.title ? (
                        <T size={13} color={mine ? C.white : C.ink} weight="800" lines={2}>
                            {e.rawTitle ?? e.title}
                        </T>
                    ) : null}
                    {e.rawDescription || e.description ? (
                        <T size={13} color={mine ? '#e8eeff' : C.muted} weight="500" lines={4}>
                            {e.rawDescription ?? e.description}
                        </T>
                    ) : null}
                </View>
            ))}
        </View>
    )
}

// ── 한 줄 ───────────────────────────────────────────────────────────────
function Reply({ m, guildId, mine }: { m: any; guildId?: string; mine: boolean }) {
    const ref = m.messageReference ?? m.message_reference
    if (!ref?.message_id) return null
    const target = S().MessageStore?.getMessage?.(ref.channel_id ?? m.channel_id, ref.message_id)
    const text = target ? `${displayName(target.author, guildId)}: ${previewText(target, guildId)}` : '원래 메시지를 불러오지 못했어요'
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2, alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: 360 }}>
            <Icon names={['ArrowAngleRightUpIcon', 'ReplyIcon']} color="rgba(255,255,255,0.8)" size={14} />
            <T size={12} color="rgba(255,255,255,0.85)" weight="600" lines={1}>
                {text}
            </T>
        </View>
    )
}

export const MessageRow = memo(function MessageRow({ row, guildId, showNames }: { row: Row; guildId?: string; showNames: boolean }) {
    const { m, mine, head } = row
    if (isSystem(m)) {
        const text = m.type === SYSTEM_JOIN ? `${displayName(m.author, guildId)} 님이 들어왔어요` : previewText(m, guildId) || '시스템 메시지'
        return (
            <View style={{ alignItems: 'center', paddingVertical: 6 }}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.22)' }}>
                    <T size={12} color={C.white} weight="600" lines={2}>
                        {text}
                    </T>
                </View>
            </View>
        )
    }
    const avatar = <View style={{ width: 48 }}>{head ? <Avatar uri={avatarUrl(m.author, 96, guildId)} size={48} /> : null}</View>
    const pending = m.state === 'SENDING'
    const failed = m.state === 'SEND_FAILED'
    return (
        <View style={{ paddingHorizontal: 12, paddingTop: head ? 10 : 3 }}>
            <Reply m={m} guildId={guildId} mine={mine} />
            <View style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start', alignItems: 'flex-start', gap: 10 }}>
                {mine ? null : avatar}
                <View style={{ maxWidth: '72%', alignItems: mine ? 'flex-end' : 'flex-start' }}>
                    {head && showNames && !mine ? (
                        <T size={13} color={roleColor(guildId, m.author?.id) ?? C.white} weight="800" lines={1} style={{ marginBottom: 3, marginLeft: 4 }}>
                            {displayName(m.author, guildId)}
                        </T>
                    ) : null}
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
                                borderWidth: failed ? 1.5 : 0,
                                borderColor: C.red,
                            },
                            shadow(2),
                        ]}
                    >
                        {m.content ? <MessageText content={m.content} guildId={guildId} mine={mine} /> : null}
                        <Attachments m={m} mine={mine} />
                        {m.editedTimestamp || m.edited_timestamp ? (
                            <T size={10} color={mine ? '#dfe7ff' : C.muted} weight="500" style={{ marginTop: 2, alignSelf: 'flex-end' }}>
                                (수정됨)
                            </T>
                        ) : null}
                    </View>
                    {failed ? (
                        <T size={11} color={C.red} weight="700" style={{ marginTop: 2 }}>
                            보내지 못했어요
                        </T>
                    ) : null}
                </View>
                {mine ? avatar : null}
            </View>
        </View>
    )
})

// ── 키보드 높이 ─────────────────────────────────────────────────────────
function useKeyboard() {
    const [h, setH] = useState(0)
    useEffect(() => {
        const a = Keyboard.addListener('keyboardDidShow', (e: any) => setH(e?.endCoordinates?.height ?? 0))
        const b = Keyboard.addListener('keyboardDidHide', () => setH(0))
        return () => {
            a.remove()
            b.remove()
        }
    }, [])
    return h
}

// ── 입력창 ──────────────────────────────────────────────────────────────
function Composer({ channelId, placeholder }: { channelId: string; placeholder: string }) {
    const [text, setText] = useState('')
    const [failed, setFailed] = useState(false)
    useEffect(() => setText(''), [channelId])
    const send = () => {
        if (!text.trim()) return
        const ok = sendMessage(channelId, text)
        setFailed(!ok)
        if (ok) setText('')
    }
    const canSend = !!text.trim()
    return (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, paddingTop: 6 }}>
            {failed ? (
                <T size={12} color={C.red} weight="700" style={{ marginBottom: 4, marginLeft: 6 }}>
                    보내지 못했어요, 다시 눌러 주세요
                </T>
            ) : null}
            <View style={[{ flexDirection: 'row', alignItems: 'flex-end', borderRadius: 24, backgroundColor: C.white, paddingLeft: 18, paddingRight: 6, paddingVertical: 6 }, shadow(4)]}>
                <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={placeholder}
                    placeholderTextColor={C.muted}
                    multiline
                    style={{ flex: 1, maxHeight: 120, minHeight: 36, fontSize: 15, color: C.ink, paddingVertical: 6, fontWeight: '600' }}
                />
                <Pressable onPress={send} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" style={({ pressed }) => [{ opacity: canSend ? (pressed ? 0.8 : 1) : 0.45 }]}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={['SendMessageIcon', 'PaperPlaneIcon', 'ArrowSmallRightIcon']} color={C.white} size={20} />
                    </View>
                </Pressable>
            </View>
        </View>
    )
}

// ── 채팅 전체 ───────────────────────────────────────────────────────────
export interface ChatHead {
    avatar?: string
    title: string
    subtitle?: string
    icon?: string[]
}

export function Chat({ channelId, guildId, head, onList, onOpenNative }: { channelId: string; guildId?: string; head: ChatHead; onList?: () => void; onOpenNative?: () => void }) {
    const visible = useUi(s => s.visible)
    const list = useStores(['MessageStore'], () => messagesOf(channelId), [channelId])
    const myId = me()?.id
    const rows = useMemo(() => buildRows(messageArray(list), myId), [list, myId])
    const kb = useKeyboard()

    useEffect(() => loadMessages(channelId), [channelId])
    // 보고 있는 동안 들어온 메시지는 읽음으로
    const newest = rows[0]?.m?.id
    useEffect(() => {
        if (visible) ack(channelId)
    }, [channelId, newest, visible])

    const older = useCallback(() => {
        const a = messageArray(messagesOf(channelId))
        if (a.length && messagesOf(channelId)?.hasMoreBefore !== false) loadMessages(channelId, a[0].id)
    }, [channelId])

    const renderItem = useCallback(({ item }: { item: Row }) => <MessageRow row={item} guildId={guildId} showNames={!!guildId} />, [guildId])
    const ch = channelOf(channelId)
    const placeholder = guildId ? `#${ch?.name ?? ''} 에 메시지 보내기` : `${head.title} 에게 메시지 보내기`

    return (
        <View style={{ flex: 1, paddingBottom: kb }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.25)' }}>
                {head.avatar ? (
                    <Avatar uri={head.avatar} size={56} />
                ) : (
                    <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={head.icon ?? ['TextIcon']} color={C.navy} size={26} />
                    </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={22} color={C.white} weight="800" lines={1}>
                        {head.title}
                    </T>
                    {head.subtitle ? (
                        <T size={13} color="rgba(255,255,255,0.8)" weight="600" lines={1} style={{ marginTop: 2 }}>
                            {head.subtitle}
                        </T>
                    ) : null}
                </View>
                {onOpenNative ? <PillButton label="디스코드에서 열기" kind="white" small onPress={onOpenNative} /> : null}
                {onList ? <PillButton label="리스트" kind="white" small onPress={onList} /> : null}
            </View>
            <FlatList
                data={rows}
                inverted
                keyExtractor={r => r.m.id}
                renderItem={renderItem}
                onEndReached={older}
                onEndReachedThreshold={0.4}
                initialNumToRender={14}
                maxToRenderPerBatch={10}
                windowSize={9}
                removeClippedSubviews
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingVertical: 10 }}
                style={{ flex: 1 }}
            />
            <Composer channelId={channelId} placeholder={placeholder} />
        </View>
    )
}
