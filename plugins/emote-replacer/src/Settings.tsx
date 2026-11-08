import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useRef, useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { toast } from './picker'
import { status } from './status'
import { update, useSettings } from './store'

/** 두 번 눌러 지우기 */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
    const { Text } = Design as any
    const [armed, setArmed] = useState(false)
    const timer = useRef<any>()
    useEffect(() => () => clearTimeout(timer.current), [])
    const Trash = lookupGeneratedIconComponent('TrashIcon' as any) as any
    return (
        <Pressable
            hitSlop={8}
            accessibilityLabel={armed ? 'Tap again to remove' : 'Remove'}
            onPress={() => {
                if (!armed) {
                    setArmed(true)
                    clearTimeout(timer.current)
                    timer.current = setTimeout(() => setArmed(false), 3000)
                    return
                }
                clearTimeout(timer.current)
                onDelete()
            }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
            {armed ? (
                <Text variant="text-sm/semibold" color="text-danger">
                    Tap again
                </Text>
            ) : Trash ? (
                <Trash size="sm" />
            ) : (
                <Text variant="text-sm/semibold">×</Text>
            )}
        </Pressable>
    )
}

const SIZES = [32, 48, 64, 96, 128]

export default function SettingsPage() {
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TextInput, Button, Text } = Design as any
    const s = useSettings()
    const [, tick] = useState(0)
    const [name, setName] = useState('')
    const [url, setUrl] = useState('')
    const customs = Object.entries(s.customEmotes)
    const addCustom = () => {
        const n = name.trim().replace(/^[^\w]+/, '')
        const u = url.trim()
        if (!/^[\w-]{2,}$/.test(n) || !/^https?:\/\/\S+$/i.test(u)) return toast('Use a name with letters, numbers, - or _, and an https link')
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        update({ customEmotes: { ...s.customEmotes, [n]: u } })
        setName('')
        setUrl('')
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={24}>
                <TableRowGroup title="Sending">
                    <TableRow label="/replacer" subLabel="Use /replacer emoji: style: to send an emote, up to 3 styles" />
                    <TableSwitchRow label="Type ;name" subLabel="Also replace ;name written in your messages" value={s.typing} onValueChange={(typing: boolean) => update({ typing })} />
                    {s.typing ? (
                    <View style={{ padding: 12 }}>
                        <TextInput label="Prefix" value={s.prefix} placeholder=";" onChange={(prefix: string) => update({ prefix: prefix.replace(/\s/g, '').slice(0, 3) })} description={`Type ${s.prefix || ';'}name to send an emote.`} />
                    </View>
                    ) : null}
                    {s.typing ? <TableSwitchRow label="Require prefix" subLabel="Off, plain emote names are replaced too" value={s.requirePrefix} onValueChange={(requirePrefix: boolean) => update({ requirePrefix })} /> : null}
                    {s.typing ? <TableSwitchRow label="Suggestions" subLabel="Shows matching emotes and effects above the chat bar while you type" value={s.suggestions} onValueChange={(suggestions: boolean) => update({ suggestions })} /> : null}
                    <TableSwitchRow label="Send plain emotes as files" subLabel="Off, plain emotes go as small image links. Emotes with effects are always sent as files" value={s.plainAsFile} onValueChange={(plainAsFile: boolean) => update({ plainAsFile })} />
                    <TableSwitchRow icon={<TableRowAssetIcon name="ReactionIcon" />} label="Emote button" subLabel="Adds a button to the chat bar to search and add emotes" value={s.button} onValueChange={(button: boolean) => update({ button })} />
                </TableRowGroup>

                <TableRowGroup title="Status">
                    <TableRow label="Chat bar" subLabel={status.contextBar} />
                </TableRowGroup>

                <TableRowGroup title="Without Nitro">
                    <TableSwitchRow label="Locked emojis as images" subLabel="Animated and other server emojis are sent as images" value={s.lockedEmojis} onValueChange={(lockedEmojis: boolean) => update({ lockedEmojis })} />
                    <TableSwitchRow label="Locked stickers as images" subLabel="Stickers you can't send here are sent as images" value={s.lockedStickers} onValueChange={(lockedStickers: boolean) => update({ lockedStickers })} />
                    <View style={{ padding: 12, gap: 8 }}>
                        <Text variant="text-sm/medium" color="text-muted">
                            Image size, {s.emoteSize}px
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                            {SIZES.map(n => (
                                <Button key={n} size="sm" variant={s.emoteSize === n ? 'primary' : 'secondary'} text={String(n)} onPress={() => update({ emoteSize: n })} />
                            ))}
                        </View>
                    </View>
                </TableRowGroup>

                <TableRowGroup title="Custom emotes">
                    {customs.map(([n, u]) => (
                        <TableRow
                            key={n}
                            icon={<Image source={{ uri: u }} style={{ width: 24, height: 24 }} resizeMode="contain" />}
                            label={`${s.prefix}${n}`}
                            subLabel={u}
                            trailing={
                                <DeleteButton
                                    onDelete={() => {
                                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                                        const next = { ...s.customEmotes }
                                        delete next[n]
                                        update({ customEmotes: next })
                                    }}
                                />
                            }
                        />
                    ))}
                    <View style={{ padding: 12 }}>
                        <Stack spacing={8}>
                            <TextInput value={name} placeholder="Name" onChange={setName} />
                            <TextInput value={url} placeholder="Image link, https://..." onChange={setUrl} autoCapitalize="none" />
                            <Button text="Add" size="md" variant="secondary" disabled={!name.trim() || !url.trim()} onPress={addCustom} />
                        </Stack>
                    </View>
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}
