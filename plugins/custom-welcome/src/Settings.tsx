import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { AlertActionCreators } from '@valenced/discord/actions'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
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

/**
 * DM 첫 화면 "손 흔들기" 버튼과 똑같이 웨이브 스티커를 sendStickers 로 보낸다 (마지막으로 연 채널에).
 * Custom Welcome 이 잘 가로채면 설정한 글이나 스티커가 가고, 아니면 디스코드 기본 웨이브가 간다.
 */
function tryWave() {
    const { AlertModal, AlertActionButton } = Design as any
    const S: any = Stores
    let channelId: string | undefined
    let where = ''
    try {
        channelId = S.SelectedChannelStore?.getChannelId?.() ?? S.SelectedChannelStore?.getMostRecentSelectedTextChannelId?.()
        const ch = channelId ? S.ChannelStore?.getChannel?.(channelId) : undefined
        const dm = ch?.recipients?.length ? S.UserStore?.getUser?.(ch.recipients[0]) : undefined
        where = ch?.name ? `#${ch.name}` : dm ? `your DM with ${dm.globalName ?? dm.username}` : ch ? 'that chat' : ''
    } catch {}
    const show = (content: string, actions: any) => AlertActionCreators.openAlert('custom-welcome-try', <AlertModal title="Try the wave button" content={content} actions={actions} />)
    if (!channelId || !where) return show('Open a chat first, then come back here.', <AlertActionButton text="OK" variant="primary" />)
    show(
        `This sends a real message in ${where}, the same way the DM "Wave" button does.`,
        <>
            <AlertActionButton
                text="Send"
                variant="primary"
                onPress={() => {
                    try {
                        const mod: any = (lookupModule(withProps('sendStickers', 'sendMessage') as any) as any)?.[0]
                        mod?.sendStickers?.(channelId, ['749054660769218631'], '', { location: 'SEND_WAVE' })
                    } catch {}
                }}
            />
            <AlertActionButton text="Cancel" variant="secondary" />
        </>,
    )
}

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
                </TableRowGroup>

                <TableRadioGroup title="Message and sticker" defaultValue={s.mode} onChange={(mode: 'together' | 'separate') => update({ mode })}>
                    <TableRadioRow label="Together" value="together" />
                    <TableRadioRow label="One at random" value="separate" />
                </TableRadioGroup>

                <TableRowGroup>
                    <TableRow
                        icon={<TableRowAssetIcon name="HandRequestSpeakIcon" />}
                        label="Try the wave button"
                        trailing={<Button size="sm" variant="secondary" text="Try" onPress={tryWave} />}
                    />
                </TableRowGroup>

                <Section
                    title="Messages"
                    sub={s.messages.length ? `${s.messages.length} message(s)` : 'None'}
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
                        <Text variant="text-xs/medium" style={{ color: palette().muted }}>
                            {'{mention}, {name}, {server}, {channel}'}
                        </Text>
                    </Stack>
                </Section>

                <Section
                    title="Stickers"
                    sub={s.stickers.length ? `${s.stickers.length} sticker(s)` : 'None'}
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
                        {stickerGrid ? <ExpressionGrid
                                kind="sticker"
                                chosen={s.stickers}
                                onPick={st => {
                                    const id = st?.id && String(st.id)
                                    if (!id) return
                                    // 이미 고른 것을 다시 누르면 뺀다
                                    if (settings().stickers.includes(id)) (anim(), update({ stickers: settings().stickers.filter(x => x !== id) }))
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
