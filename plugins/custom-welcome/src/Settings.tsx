import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { ExpressionGrid, stickerImage } from './grid'
import { canPick, emojiText, gifText, openPicker } from './picker'
import { bind, settings, update, useSettings } from './store'

function stickerUrl(id: string) {
    let format: number | undefined
    try {
        format = (Stores as any).StickersStore?.getStickerById?.(id)?.format_type
    } catch {}
    return stickerImage({ id, format_type: format })
}

function stickerName(id: string) {
    try {
        return String((Stores as any).StickersStore?.getStickerById?.(id)?.name ?? '') || `Sticker ${id}`
    } catch {
        return `Sticker ${id}`
    }
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
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, Button, TextInput, Text } = Design as any
    const [msg, setMsg] = useState('')
    const [sid, setSid] = useState('')
    const [openMsg, setOpenMsg] = useState(true)
    const [openSticker, setOpenSticker] = useState(false)
    const [emojiGrid, setEmojiGrid] = useState(false)
    const [stickerGrid, setStickerGrid] = useState(false)
    const pickable = canPick()

    const addMessage = (text = msg) => {
        const t = text.trim()
        if (!t) return
        anim()
        update({ messages: [...settings().messages, t] })
        setMsg('')
    }
    const addSticker = (id?: string) => {
        if (!id || settings().stickers.includes(id)) return
        anim()
        update({ stickers: [...settings().stickers, id] })
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
    const thumb = (id: string) => <Image source={{ uri: stickerUrl(id) }} style={{ width: 40, height: 40 }} />

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 64 }}>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="HandRequestSpeakIcon" />}
                        label="Use my welcome"
                        subLabel="The Wave button sends your message and sticker instead of Discord's own sticker."
                        value={s.enabled}
                        onValueChange={(enabled: boolean) => update({ enabled })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AtIcon" />}
                        label="Ping them in the reply"
                        subLabel="Off: the reply itself does not notify them, but {mention} in the message still does."
                        value={s.ping}
                        onValueChange={(ping: boolean) => update({ ping })}
                    />
                </TableRowGroup>

                <Section
                    title="Messages"
                    sub={s.messages.length ? `${s.messages.length} message(s), one is picked at random` : 'No message, only the sticker is sent'}
                    icon="ChatIcon"
                    open={openMsg}
                    onToggle={() => setOpenMsg(v => !v)}
                >
                    <Stack spacing={12}>
                        {s.messages.length ? (
                            <TableRowGroup>
                                {s.messages.map((m, i) => (
                                    <TableRow
                                        key={`${i}${m}`}
                                        label={m}
                                        trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => (anim(), update({ messages: settings().messages.filter((_, j) => j !== i) }))} />}
                                    />
                                ))}
                            </TableRowGroup>
                        ) : null}
                        <TextInput label="New message" value={msg} placeholder="Welcome {mention}! 👋" onChange={setMsg} onSubmitEditing={() => addMessage()} returnKeyType="done" />
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
                        <Text variant="text-xs/medium" color="text-muted">
                            {'{mention} pings them, {name} is their name, {server} and {channel} are where they joined. Keyboard emojis work as they are, server emojis from other servers need Nitro. Paste a GIF link (Tenor, Giphy) to send a GIF.'}
                        </Text>
                    </Stack>
                </Section>

                <Section
                    title="Stickers"
                    sub={s.stickers.length ? `${s.stickers.length} sticker(s), one is picked at random` : 'No sticker, only the message is sent'}
                    icon="StickerIcon"
                    open={openSticker}
                    onToggle={() => setOpenSticker(v => !v)}
                >
                    <Stack spacing={12}>
                        {s.stickers.length ? (
                            <TableRowGroup>
                                {s.stickers.map(id => (
                                    <TableRow
                                        key={id}
                                        icon={thumb(id)}
                                        label={stickerName(id)}
                                        trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => (anim(), update({ stickers: settings().stickers.filter(x => x !== id) }))} />}
                                    />
                                ))}
                            </TableRowGroup>
                        ) : null}
                        <Button text={stickerGrid ? 'Hide stickers' : 'Pick a sticker'} variant="primary" size="md" onPress={() => (anim(), setStickerGrid(v => !v))} />
                        {stickerGrid ? <ExpressionGrid kind="sticker" chosen={s.stickers} onPick={st => st?.id && addSticker(String(st.id))} /> : null}
                        {pickable ? <Button text="Open Discord's picker" variant="secondary" size="md" onPress={pickSticker} /> : null}
                        <TextInput label="Or paste a sticker ID or link" value={sid} placeholder="123456789012345678" onChange={setSid} onSubmitEditing={() => addSticker(stickerIdOf(sid))} />
                        {stickerIdOf(sid) ? <Button text="Add this sticker" variant="secondary" size="md" onPress={() => addSticker(stickerIdOf(sid))} /> : null}
                        <Text variant="text-xs/medium" color="text-muted">
                            Stickers from other servers need Nitro to send.
                        </Text>
                    </Stack>
                </Section>

                <Text variant="text-xs/medium" color="text-muted">
                    With nothing in both lists, Discord's own wave sticker is sent.
                </Text>
            </Stack>
        </ScrollView>
    )
}
