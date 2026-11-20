import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Image, Keyboard, Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native'
import { applySuggestion, CATEGORY_LABEL, emojiText, type Emoji, type Gif, gifs, guildEmojis, guildStickers, draftOf, onDraft, pickFiles, type Picked, setDraft, sendWith, stopTyping, suggestions, typing, typingNames, typingText, UNICODE_CATEGORIES, unicodeEmojis } from '../compose'
import { displayName, editMessage, emojiUrl, guildIconUrl, guild, sameList, toast, useStores } from '../data'
import { Icon, T } from '../parts'
import { C, R, shadow } from '../theme'
import { StickerView } from './Sticker'

/**
 * 입력창: 글, 파일 붙이기, 이모지·스티커·GIF 고르기, @ # : 자동완성, 입력 중 표시.
 */

export type Mode = { kind: 'reply' | 'edit'; m: any } | null
type Panel = 'emoji' | 'sticker' | 'gif' | null

const MAX_FILES = 10
const PANEL_H = 290

// ── 작은 부품 ───────────────────────────────────────────────────────────
function RoundIcon({ names, label, onPress, active, color = C.navy }: { names: string[]; label: string; onPress: () => void; active?: boolean; color?: string }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4} style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}>
            <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? C.blueSoft : 'transparent' }}>
                <Icon names={names} color={color} size={22} />
            </View>
        </Pressable>
    )
}

function Chip({ label, on, onPress, icon }: { label: string; on: boolean; onPress: () => void; icon?: string }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: icon ? 6 : 12, borderRadius: R.pill, backgroundColor: on ? C.navy : C.white, borderWidth: 1, borderColor: on ? C.navy : C.line }}>
                {icon ? <Image source={{ uri: icon }} style={{ width: 20, height: 20, borderRadius: 10 }} /> : null}
                <T size={12} weight="800" color={on ? C.white : C.ink} lines={1} style={icon ? { maxWidth: 90, paddingRight: 4 } : undefined}>
                    {label}
                </T>
            </View>
        </Pressable>
    )
}

function ChipRow({ children }: { children: any }) {
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingHorizontal: 10, paddingVertical: 8 }} style={{ flexGrow: 0 }}>
            {children}
        </ScrollView>
    )
}

// ── 이모지 ──────────────────────────────────────────────────────────────
function EmojiCell({ e, onPick }: { e: Emoji; onPick: (e: Emoji) => void }) {
    return (
        <Pressable onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`emoji ${e.name}`} style={({ pressed }) => [{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: pressed ? C.blueSoft : 'transparent' }]}>
            {e.id ? <Image source={{ uri: emojiUrl(e.id, !!e.animated, 64) }} style={{ width: 32, height: 32 }} resizeMode="contain" /> : <T size={26}>{e.surrogates}</T>}
        </Pressable>
    )
}

function EmojiPanel({ onPick }: { onPick: (e: Emoji) => void }) {
    const servers = useStores(['EmojiStore', 'GuildStore'], guildEmojis, [], (a, b) => sameList(a.map(g => g.guildId + g.emojis.length), b.map(g => g.guildId + g.emojis.length)))
    const [tab, setTab] = useState<string>(UNICODE_CATEGORIES[0])
    const list: Emoji[] = useMemo(() => {
        const g = servers.find(s => s.guildId === tab)
        return g ? g.emojis : unicodeEmojis(tab)
    }, [tab, servers])
    return (
        <View style={{ flex: 1 }}>
            <ChipRow>
                {UNICODE_CATEGORIES.map(c => (
                    <Chip key={c} label={CATEGORY_LABEL[c]} on={tab === c} onPress={() => setTab(c)} />
                ))}
                {servers.map(s => (
                    <Chip key={s.guildId} label={s.name} icon={guildIconUrl(guild(s.guildId), 64)} on={tab === s.guildId} onPress={() => setTab(s.guildId)} />
                ))}
            </ChipRow>
            <FlatList
                key={tab}
                data={list}
                numColumns={7}
                keyExtractor={(e, i) => e.id ?? `${e.name}${i}`}
                renderItem={({ item }) => <EmojiCell e={item} onPick={onPick} />}
                initialNumToRender={49}
                windowSize={5}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
                ListEmptyComponent={<Nothing text="이모지가 없어요" />}
            />
        </View>
    )
}

// ── 스티커 ──────────────────────────────────────────────────────────────
function StickerPanel({ onPick }: { onPick: (s: any) => void }) {
    const servers = useStores(['StickersStore', 'GuildStore'], guildStickers, [], (a, b) => sameList(a.map(g => g.guildId + g.stickers.length), b.map(g => g.guildId + g.stickers.length)))
    const [tab, setTab] = useState<string | undefined>(undefined)
    const current = servers.find(s => s.guildId === tab) ?? servers[0]
    if (!current) return <Nothing text="쓸 수 있는 스티커가 없어요" />
    return (
        <View style={{ flex: 1 }}>
            <ChipRow>
                {servers.map(s => (
                    <Chip key={s.guildId} label={s.name} icon={guildIconUrl(guild(s.guildId), 64)} on={current.guildId === s.guildId} onPress={() => setTab(s.guildId)} />
                ))}
            </ChipRow>
            <FlatList
                key={current.guildId}
                data={current.stickers}
                numColumns={4}
                keyExtractor={s => s.id}
                renderItem={({ item }) => (
                    <Pressable onPress={() => onPick(item)} accessibilityRole="button" accessibilityLabel={`sticker ${item.name}`} style={({ pressed }) => [{ padding: 6, borderRadius: 12, backgroundColor: pressed ? C.blueSoft : 'transparent' }]}>
                        <StickerView s={item} size={68} animated={false} />
                    </Pressable>
                )}
                initialNumToRender={16}
                windowSize={5}
                contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
            />
        </View>
    )
}

// ── GIF ─────────────────────────────────────────────────────────────────
function GifPanel({ onPick, width }: { onPick: (g: Gif) => void; width: number }) {
    const [query, setQuery] = useState('')
    const [list, setList] = useState<Gif[] | null>(null)
    useEffect(() => {
        let live = true
        setList(null)
        const t = setTimeout(() => gifs(query).then(r => live && setList(r)), query ? 400 : 0)
        return () => {
            live = false
            clearTimeout(t)
        }
    }, [query])
    const col = Math.floor((width - 36) / 2)
    return (
        <View style={{ flex: 1 }}>
            <View style={{ margin: 10, marginBottom: 6, height: 38, borderRadius: R.pill, backgroundColor: C.white, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 6 }}>
                <Icon names={['MagnifyingGlassIcon', 'SearchIcon']} color={C.muted} size={18} />
                <TextInput value={query} onChangeText={setQuery} placeholder="GIF 찾기" placeholderTextColor={C.muted} style={{ flex: 1, fontSize: 14, color: C.ink, paddingVertical: 0, fontWeight: '600' }} />
            </View>
            {list == null ? (
                <Nothing text="불러오는 중…" />
            ) : (
                <FlatList
                    key="gifs"
                    data={list}
                    numColumns={2}
                    keyExtractor={(g, i) => `${g.url}${i}`}
                    renderItem={({ item }) => (
                        <Pressable onPress={() => onPick(item)} accessibilityRole="button" accessibilityLabel={`gif ${item.url}`} style={{ padding: 4 }}>
                            <Image source={{ uri: item.src }} style={{ width: col, height: Math.min(220, Math.round((col * item.height) / item.width)), borderRadius: 10, backgroundColor: C.blueSoft }} />
                        </Pressable>
                    )}
                    initialNumToRender={8}
                    windowSize={5}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
                    ListEmptyComponent={<Nothing text="GIF 를 찾지 못했어요" />}
                />
            )}
        </View>
    )
}

function Nothing({ text }: { text: string }) {
    return (
        <View style={{ padding: 24, alignItems: 'center' }}>
            <T size={13} color={C.muted}>
                {text}
            </T>
        </View>
    )
}

function PickerPanel({ panel, onPanel, onEmoji, onSticker, onGif, width }: { panel: Exclude<Panel, null>; onPanel: (p: Panel) => void; onEmoji: (e: Emoji) => void; onSticker: (s: any) => void; onGif: (g: Gif) => void; width: number }) {
    const tabs: [Exclude<Panel, null>, string][] = [
        ['emoji', '이모지'],
        ['sticker', '스티커'],
        ['gif', 'GIF'],
    ]
    return (
        <View style={[{ height: PANEL_H, marginBottom: 8, borderRadius: 20, backgroundColor: C.panel, overflow: 'hidden' }, shadow(6)]}>
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.line }}>
                {tabs.map(([k, label]) => (
                    <Pressable key={k} onPress={() => onPanel(k)} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: panel === k }} style={{ flex: 1 }}>
                        <View style={{ height: 40, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: panel === k ? C.teal : 'transparent' }}>
                            <T size={14} weight="800" color={panel === k ? C.navy : C.muted}>
                                {label}
                            </T>
                        </View>
                    </Pressable>
                ))}
            </View>
            {panel === 'emoji' ? <EmojiPanel onPick={onEmoji} /> : panel === 'sticker' ? <StickerPanel onPick={onSticker} /> : <GifPanel onPick={onGif} width={width} />}
        </View>
    )
}

// ── 붙인 파일 ───────────────────────────────────────────────────────────
function FileStrip({ files, onRemove }: { files: Picked[]; onRemove: (i: number) => void }) {
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 6, paddingBottom: 8 }} style={{ flexGrow: 0 }}>
            {files.map((f, i) => (
                <View key={f.uri + i} style={[{ width: 72, height: 72, borderRadius: 12, backgroundColor: C.white, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, shadow(3)]}>
                    {/^image\//.test(f.type) ? (
                        <Image source={{ uri: f.uri }} style={{ width: 72, height: 72 }} />
                    ) : (
                        <View style={{ alignItems: 'center', gap: 2, padding: 4 }}>
                            <Icon names={/^video\//.test(f.type) ? ['VideoIcon', 'FilmIcon', 'AttachmentIcon'] : ['AttachmentIcon', 'PaperclipIcon', 'FileIcon']} color={C.navy} size={22} />
                            <T size={10} lines={2} color={C.ink}>
                                {f.name}
                            </T>
                        </View>
                    )}
                    <Pressable onPress={() => onRemove(i)} accessibilityRole="button" accessibilityLabel={`remove ${f.name}`} hitSlop={6} style={{ position: 'absolute', top: 3, right: 3 }}>
                        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.shade, alignItems: 'center', justifyContent: 'center' }}>
                            <Icon names={['XSmallIcon', 'XLargeIcon', 'CloseIcon']} color={C.white} size={12} />
                        </View>
                    </Pressable>
                </View>
            ))}
        </ScrollView>
    )
}

// ── 자동완성 ────────────────────────────────────────────────────────────
function SuggestList({ items, onPick }: { items: ReturnType<typeof suggestions>; onPick: (i: number) => void }) {
    return (
        <View style={[{ marginBottom: 8, borderRadius: 16, backgroundColor: C.white, overflow: 'hidden', maxHeight: 240 }, shadow(6)]}>
            <ScrollView keyboardShouldPersistTaps="always">
                {items.map((s, i) => (
                    <Pressable key={s.key} onPress={() => onPick(i)} accessibilityRole="button" accessibilityLabel={`suggest ${s.label}`} style={({ pressed }) => [{ backgroundColor: pressed ? C.blueSoft : C.white }]}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 12, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
                            {s.avatar ? (
                                <Image source={{ uri: s.avatar }} style={{ width: 28, height: 28, borderRadius: 14 }} />
                            ) : s.emoji ? (
                                s.emoji.id ? <Image source={{ uri: emojiUrl(s.emoji.id, !!s.emoji.animated, 48) }} style={{ width: 26, height: 26 }} /> : <T size={22}>{s.emoji.surrogates}</T>
                            ) : (
                                <Icon names={['TextIcon']} color={C.navy} size={20} />
                            )}
                            <T size={14} weight="800" lines={1} style={{ flexShrink: 1 }}>
                                {s.label}
                            </T>
                            {s.sub ? (
                                <T size={12} color={C.muted} lines={1} style={{ flexShrink: 1 }}>
                                    {s.sub}
                                </T>
                            ) : null}
                        </View>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    )
}

// ── 입력창 ──────────────────────────────────────────────────────────────
export function Composer({ channelId, placeholder, mode, onMode, guildId }: { channelId: string; placeholder: string; mode: Mode; onMode: (m: Mode) => void; guildId?: string }) {
    // 글과 파일은 채널별로 밖에 둔다 (사진 고르는 창을 다녀오면 이 화면이 새로 그려질 수 있다)
    const [, redraw] = useState(0)
    useEffect(() => onDraft(() => redraw(n => n + 1)) as any, [])
    const { text, files } = draftOf(channelId)
    const setText = (v: string | ((t: string) => string)) => setDraft(channelId, { text: typeof v === 'function' ? v(draftOf(channelId).text) : v })
    const setFiles = (v: Picked[] | ((f: Picked[]) => Picked[])) => setDraft(channelId, { files: typeof v === 'function' ? v(draftOf(channelId).files) : v })
    const [failed, setFailed] = useState(false)
    const [panel, setPanel] = useState<Panel>(null)
    const input = useRef<any>(null)
    const { width } = useWindowDimensions()
    const typers = useStores(['TypingStore'], () => typingNames(channelId), [channelId], sameList)
    const editing = mode?.kind === 'edit'

    useEffect(() => {
        setPanel(null)
        return () => stopTyping(channelId)
    }, [channelId])
    useEffect(() => {
        if (editing) {
            setText(mode!.m.content ?? '')
            setFiles([])
        }
    }, [mode])

    const items = useMemo(() => (panel ? [] : suggestions(channelId, text)), [channelId, text, panel])
    const reply = mode?.kind === 'reply' ? mode.m : undefined
    const done = () => {
        setText('')
        setFiles([])
        setFailed(false)
        onMode(null)
        stopTyping(channelId)
    }

    const send = () => {
        if (!text.trim() && !files.length) return
        const ok = editing ? editMessage(channelId, mode!.m.id, text) : sendWith(channelId, text, { reply, files })
        setFailed(!ok)
        if (ok) done()
    }
    const sendSticker = (s: any) => {
        if (!sendWith(channelId, '', { reply, stickerIds: [s.id] })) return toast('스티커를 보내지 못했어요')
        setPanel(null)
        onMode(null)
    }
    const sendGif = (g: Gif) => {
        if (!sendWith(channelId, g.url, { reply })) return toast('GIF 를 보내지 못했어요')
        setPanel(null)
        onMode(null)
    }
    const addEmoji = (e: Emoji) => setText(t => `${t}${t && !/\s$/.test(t) && e.id ? ' ' : ''}${emojiText(e)}`)
    const attach = async () => {
        setPanel(null)
        const picked = await pickFiles()
        if (!picked.length) return
        setFiles(cur => {
            const next = [...cur, ...picked]
            if (next.length > MAX_FILES) toast(`파일은 ${MAX_FILES}개까지 보낼 수 있어요`)
            return next.slice(0, MAX_FILES)
        })
    }
    const togglePanel = (p: Exclude<Panel, null>) => {
        if (panel === p) {
            setPanel(null)
            input.current?.focus?.()
            return
        }
        Keyboard.dismiss()
        setPanel(p)
    }

    const canSend = !!text.trim() || files.length > 0
    const typingLine = typingText(typers)
    return (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, paddingTop: 4 }}>
            {typingLine ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginLeft: 6, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill, backgroundColor: 'rgba(28,42,99,0.7)', maxWidth: '90%' }}>
                    <Icon names={['PencilIcon', 'EditIcon']} color={C.white} size={12} />
                    <T size={12} color={C.white} weight="700" lines={1} style={{ flexShrink: 1 }}>
                        {typingLine}
                    </T>
                </View>
            ) : null}
            {items.length ? <SuggestList items={items} onPick={i => setText(applySuggestion(text, items[i]))} /> : null}
            {panel ? <PickerPanel panel={panel} onPanel={setPanel} onEmoji={addEmoji} onSticker={sendSticker} onGif={sendGif} width={Math.min(width, 900) - 28} /> : null}
            {mode ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, marginHorizontal: 6, paddingHorizontal: 12, height: 32, borderRadius: R.pill, backgroundColor: 'rgba(255,255,255,0.9)' }}>
                    <Icon names={editing ? ['PencilIcon', 'EditIcon'] : ['ArrowAngleLeftUpIcon', 'ReplyIcon']} color={C.navy} size={16} />
                    <T size={13} weight="700" lines={1} style={{ flex: 1 }}>
                        {editing ? '메시지 수정 중' : `${displayName(mode.m.author, guildId)} 에게 답장`}
                    </T>
                    <Pressable
                        onPress={() => {
                            onMode(null)
                            if (editing) setText('')
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                        hitSlop={8}
                    >
                        <Icon names={['XSmallIcon', 'XLargeIcon', 'CloseIcon']} color={C.navy} size={16} />
                    </Pressable>
                </View>
            ) : null}
            {files.length ? <FileStrip files={files} onRemove={i => setFiles(cur => cur.filter((_, j) => j !== i))} /> : null}
            {failed ? (
                <T size={12} color={C.red} weight="700" style={{ marginBottom: 4, marginLeft: 6 }}>
                    보내지 못했어요, 다시 눌러 주세요
                </T>
            ) : null}
            <View style={[{ flexDirection: 'row', alignItems: 'flex-end', borderRadius: 24, backgroundColor: C.white, paddingLeft: 4, paddingRight: 6, paddingVertical: 6 }, shadow(4)]}>
                {editing ? <View style={{ width: 12 }} /> : <RoundIcon names={['CirclePlusIcon', 'PlusLargeIcon', 'PlusSmallIcon']} label="Attach" onPress={attach} />}
                <TextInput
                    ref={input}
                    value={text}
                    onChangeText={t => {
                        setText(t)
                        if (t.trim() && !editing) typing(channelId)
                    }}
                    onFocus={() => setPanel(null)}
                    placeholder={placeholder}
                    placeholderTextColor={C.muted}
                    multiline
                    style={{ flex: 1, maxHeight: 120, minHeight: 36, fontSize: 15, color: C.ink, paddingVertical: 6, paddingHorizontal: 6, fontWeight: '600' }}
                />
                <RoundIcon names={['ReactionIcon', 'EmojiSmileIcon', 'SmileIcon']} label="Emoji" active={!!panel} onPress={() => togglePanel(panel ?? 'emoji')} />
                <Pressable onPress={send} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" style={({ pressed }) => [{ marginLeft: 4, opacity: canSend ? (pressed ? 0.8 : 1) : 0.45 }]}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon names={editing ? ['CheckmarkLargeIcon', 'CheckmarkSmallIcon'] : ['SendMessageIcon', 'PaperPlaneIcon', 'ArrowSmallRightIcon']} color={C.white} size={20} />
                    </View>
                </Pressable>
            </View>
        </View>
    )
}
