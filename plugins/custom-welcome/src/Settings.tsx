import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useState } from 'react'
import { Image } from 'react-native'
import { bind, settings, update, useSettings } from './store'

const stickerUrl = (id: string) => `https://media.discordapp.net/stickers/${id}.png?size=96`

function stickerName(id: string) {
    try {
        return String((Stores as any).StickersStore?.getStickerById?.(id)?.name ?? '') || `Sticker ${id}`
    } catch {
        return `Sticker ${id}`
    }
}

/** 붙여 넣은 글에서 스티커 ID 를 꺼낸다 (ID 그대로, 또는 스티커 링크) */
const stickerIdOf = (text: string) => /(\d{17,20})/.exec(text)?.[1]

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, Button, TextInput, Text } = Design as any
    const [msg, setMsg] = useState('')
    const [sid, setSid] = useState('')

    const addMessage = () => {
        const t = msg.trim()
        if (!t) return
        update({ messages: [...settings().messages, t] })
        setMsg('')
    }
    const addSticker = (id?: string) => {
        if (!id || settings().stickers.includes(id)) return
        update({ stickers: [...settings().stickers, id] })
        setSid('')
    }
    const thumb = (id: string) => <Image source={{ uri: stickerUrl(id) }} style={{ width: 40, height: 40 }} />

    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="HandRequestSpeakIcon" />}
                        label="Use my welcome"
                        subLabel="The Wave button sends a message and sticker below instead of Discord's own sticker."
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

                <TableRowGroup title={`Messages (${s.messages.length})`}>
                    {s.messages.length ? (
                        s.messages.map((m, i) => (
                            <TableRow
                                key={`${i}${m}`}
                                label={m}
                                trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => update({ messages: settings().messages.filter((_, j) => j !== i) })} />}
                            />
                        ))
                    ) : (
                        <TableRow label="No message" subLabel="Only the sticker is sent." />
                    )}
                </TableRowGroup>
                <Stack spacing={8}>
                    <TextInput label="Add a message" value={msg} placeholder="Welcome {mention}! 👋" onChange={setMsg} onSubmitEditing={addMessage} returnKeyType="done" />
                    <Text variant="text-xs/medium" color="text-muted">
                        {'{mention} pings them, {name} is their name, {server} and {channel} are where they joined. Paste a GIF link (Tenor, Giphy) to send a GIF. With several messages, one is picked at random.'}
                    </Text>
                    <Button text="Add message" variant="primary" size="md" disabled={!msg.trim()} onPress={addMessage} />
                </Stack>

                <TableRowGroup title={`Stickers (${s.stickers.length})`}>
                    {s.stickers.length ? (
                        s.stickers.map(id => (
                            <TableRow
                                key={id}
                                icon={thumb(id)}
                                label={stickerName(id)}
                                subLabel={id}
                                trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => update({ stickers: settings().stickers.filter(x => x !== id) })} />}
                            />
                        ))
                    ) : (
                        <TableRow label="No sticker" subLabel="Only the message is sent." />
                    )}
                </TableRowGroup>
                <Stack spacing={8}>
                    {s.lastSticker && !s.stickers.includes(s.lastSticker) ? (
                        <TableRowGroup>
                            <TableRow
                                icon={thumb(s.lastSticker)}
                                label={stickerName(s.lastSticker)}
                                subLabel="The last sticker you sent"
                                trailing={<Button size="sm" variant="primary" text="Add" onPress={() => addSticker(s.lastSticker)} />}
                            />
                        </TableRowGroup>
                    ) : (
                        <Text variant="text-xs/medium" color="text-muted">
                            Send any sticker in a chat, then come back here to add it with one tap.
                        </Text>
                    )}
                    <TextInput label="Or paste a sticker ID or link" value={sid} placeholder="123456789012345678" onChange={setSid} onSubmitEditing={() => addSticker(stickerIdOf(sid))} />
                    <Button text="Add sticker" variant="secondary" size="md" disabled={!stickerIdOf(sid)} onPress={() => addSticker(stickerIdOf(sid))} />
                </Stack>
                <Text variant="text-xs/medium" color="text-muted">
                    With nothing in both lists, Discord's own wave sticker is sent.
                </Text>
            </Stack>
        </Page>
    )
}
