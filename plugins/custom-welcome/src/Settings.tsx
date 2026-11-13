import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { palette } from './colors'
import { ExpressionGrid, stickerById, StickerView, usePacks } from './grid'
import { canPick, emojiText, gifText, openPicker } from './picker'
import { bind, settings, update, useSettings } from './store'


function stickerName(id: string) {
    return String(stickerById(id)?.name ?? '') || `Sticker ${id}`
}

/** 붙여 넣은 글에서 스티커 ID 를 꺼낸다 (ID 그대로, 또는 스티커 링크) */
const stickerIdOf = (text: string) => /(\d{17,20})/.exec(text)?.[1]

const anim = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)

/** 눌러서 펴고 접는 묶음 */
function Section({ title, sub, icon, open, onToggle, children }: { title: string; sub: string; icon: string; open: boolean; onToggle(): void; children?: any }) {
    const { TableRowGroup, TableRow } = Design as any
    return (
        <View>
            <TableRowGroup>
                <TableRow
                    icon={<TableRowAssetIcon name={icon} />}
                    label={title}
                    subLabel={sub}
                    trailing={<TableRowAssetIcon name={open ? 'ChevronSmallUpIcon' : 'ChevronSmallDownIcon'} />}
                    onPress={() => (anim(), onToggle())}
                />
            </TableRowGroup>
            {open ? <View style={{ marginTop: 12 }}>{children}</View> : null}
        </View>
    )
}

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    usePacks()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, TextInput, Text } = Design as any
    const [msg, setMsg] = useState('')
    const [sid, setSid] = useState('')
    const [openMsg, setOpenMsg] = useState(true)
    const [openSticker, setOpenSticker] = useState(false)
    const [emojiGrid, setEmojiGrid] = useState(false)
    const [stickerGrid, setStickerGrid] = useState(false)
    const pickable = canPick()
    // 고치는 목록: 서버용, 또는 (DM 용 따로일 때) DM 용
    const [target, setTarget] = useState<'server' | 'dm'>('server')
    const dmEdit = s.dm === 'own' && target === 'dm'
    const MK = dmEdit ? 'dmMessages' : 'messages'
    const SK = dmEdit ? 'dmStickers' : 'stickers'
    const messages: string[] = s[MK]
    const stickerIds: string[] = s[SK]

    const addMessage = (text = msg) => {
        const t = text.trim()
        if (!t) return
        anim()
        update({ [MK]: [...settings()[MK], t] } as any)
        setMsg('')
    }
    const addSticker = (id?: string) => {
        if (!id || settings()[SK].includes(id)) return
        anim()
        update({ [SK]: [...settings()[SK], id] } as any)
        setSid('')
    }
    // 고르기 창에서 이모지를 누르면 쓰고 있는 메시지 끝에 붙인다. GIF 는 링크를 붙인다
    const pickForMessage = () =>
        openPicker({
            emoji: e => setMsg(m => `${m}${emojiText(e)}`),
            gif: g => {
                const url = gifText(g)
                if (url) setMsg(m => (m.trim() ? `${m} ${url}` : url))
            },
            sticker: st => st?.id && addSticker(String(st.id)),
        })
    const pickSticker = () =>
        openPicker({
            sticker: st => st?.id && addSticker(String(st.id)),
            emoji: e => setMsg(m => `${m}${emojiText(e)}`),
        })
    const thumb = (id: string) => <StickerView sticker={stickerById(id) ?? { id }} size={40} />

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 64 }}>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="HandRequestSpeakIcon" />}
                        label="Use my welcome"
                        value={s.enabled}
                        onValueChange={(enabled: boolean) => update({ enabled })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AtIcon" />}
                        label="Ping them in the reply"
                        value={s.ping}
                        onValueChange={(ping: boolean) => update({ ping })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="LinkIcon" />}
                        label="Send locked stickers as links"
                        subLabel="When a sticker can't be sent here (no Nitro), send its image as a hidden link instead"
                        value={s.stickerLinks}
                        onValueChange={(stickerLinks: boolean) => update({ stickerLinks })}
                    />
                </TableRowGroup>

                <TableRadioGroup title="Message and sticker" defaultValue={s.mode} onChange={(mode: 'together' | 'separate') => update({ mode })}>
                    <TableRadioRow label="Together" value="together" />
                    <TableRadioRow label="One at random" value="separate" />
                </TableRadioGroup>

                <TableRadioGroup title="Wave button in DMs" defaultValue={s.dm} onChange={(dm: 'wave' | 'same' | 'own') => (anim(), update({ dm }), dm !== 'own' && setTarget('server'))}>
                    <TableRadioRow label="Discord's wave" subLabel="DMs send Discord's normal wave sticker" value="wave" />
                    <TableRadioRow label="Same as servers" subLabel="DMs send the messages and stickers below" value="same" />
                    <TableRadioRow label="Its own DM welcome" subLabel="DMs get their own messages and stickers" value="own" />
                </TableRadioGroup>

                {s.dm === 'own' ? (
                    <TableRadioGroup title="Editing" defaultValue={target} onChange={(t: 'server' | 'dm') => (anim(), setTarget(t))}>
                        <TableRadioRow label="Server welcome" value="server" />
                        <TableRadioRow label="DM welcome" value="dm" />
                    </TableRadioGroup>
                ) : null}

                <Section
                    title={dmEdit ? 'DM messages' : 'Messages'}
                    sub={messages.length ? `${messages.length} message(s)` : 'None'}
                    icon="ChatIcon"
                    open={openMsg}
                    onToggle={() => setOpenMsg(v => !v)}
                >
                    <Stack spacing={12}>
                        {messages.length ? (
                            <TableRowGroup>
                                {messages.map((m, i) => (
                                    <TableRow
                                        key={`${i}${m}`}
                                        label={m}
                                        trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => (anim(), update({ [MK]: settings()[MK].filter((_, j) => j !== i) } as any))} />}
                                    />
                                ))}
                            </TableRowGroup>
                        ) : null}
                        <TextInput label="New message" value={msg} placeholder={dmEdit ? 'Hey {name}! 👋' : 'Welcome {mention}! 👋'} onChange={setMsg} onSubmitEditing={() => addMessage()} returnKeyType="done" />
                        <View style={{ flexDirection: 'row' }}>
                            <View style={{ flex: 1, marginRight: 8 }}>
                                <Button text={emojiGrid ? 'Hide emojis' : 'Server emojis'} variant="secondary" size="md" onPress={() => (anim(), setEmojiGrid(v => !v))} />
                            </View>
                            {pickable ? (
                                <View style={{ flex: 1, marginRight: 8 }}>
                                    <Button text="Emoji or GIF" variant="secondary" size="md" onPress={pickForMessage} />
                                </View>
                            ) : null}
                            <View style={{ flex: 1 }}>
                                <Button text="Add" variant="primary" size="md" disabled={!msg.trim()} onPress={() => addMessage()} />
                            </View>
                        </View>
                        {emojiGrid ? <ExpressionGrid kind="emoji" onPick={e => setMsg(m => `${m}${emojiText(e)}`)} /> : null}
                        <Text variant="text-xs/medium" style={{ color: palette().muted }}>
                            {'{mention}, {name}, {server}, {channel}'}
                        </Text>
                    </Stack>
                </Section>

                <Section
                    title={dmEdit ? 'DM stickers' : 'Stickers'}
                    sub={stickerIds.length ? `${stickerIds.length} sticker(s)` : 'None'}
                    icon="StickerIcon"
                    open={openSticker}
                    onToggle={() => setOpenSticker(v => !v)}
                >
                    <Stack spacing={12}>
                        {stickerIds.length ? (
                            <TableRowGroup>
                                {stickerIds.map(id => (
                                    <TableRow
                                        key={id}
                                        icon={thumb(id)}
                                        label={stickerName(id)}
                                        trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => (anim(), update({ [SK]: settings()[SK].filter(x => x !== id) } as any))} />}
                                    />
                                ))}
                            </TableRowGroup>
                        ) : null}
                        <Button text={stickerGrid ? 'Hide stickers' : 'Pick a sticker'} variant="primary" size="md" onPress={() => (anim(), setStickerGrid(v => !v))} />
                        {stickerGrid ? <ExpressionGrid
                                kind="sticker"
                                chosen={stickerIds}
                                onPick={st => {
                                    const id = st?.id && String(st.id)
                                    if (!id) return
                                    // 이미 고른 것을 다시 누르면 뺀다
                                    if (settings()[SK].includes(id)) (anim(), update({ [SK]: settings()[SK].filter(x => x !== id) } as any))
                                    else addSticker(id)
                                }}
                            /> : null}
                        {pickable ? <Button text="Open Discord's picker" variant="secondary" size="md" onPress={pickSticker} /> : null}
                        <TextInput label="Or paste a sticker ID or link" value={sid} placeholder="123456789012345678" onChange={setSid} onSubmitEditing={() => addSticker(stickerIdOf(sid))} />
                        {stickerIdOf(sid) ? <Button text="Add this sticker" variant="secondary" size="md" onPress={() => addSticker(stickerIdOf(sid))} /> : null}
                    </Stack>
                </Section>

            </Stack>
        </ScrollView>
    )
}
