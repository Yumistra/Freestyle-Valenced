import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { LayoutAnimation } from 'react-native'
import { labelOf } from './chat'
import { bind, settings, update, useSettings, type Settings } from './store'

const isId = (s: string) => /^\d{17,20}$/.test(s)

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, TextInput, Text } = Design as any
    const [input, setInput] = useState('')
    const add = () => {
        const id = input.trim()
        if (!isId(id) || settings().list.includes(id)) return
        update({ list: [...settings().list, id] })
        setInput('')
    }

    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AtIcon" />}
                        label="Silent mentions everywhere"
                        subLabel="Otherwise only in the chats you turn it on for with the @ button"
                        value={s.always}
                        onValueChange={(always: boolean) => update({ always })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="Replies" defaultValue={s.replyPing} onChange={(replyPing: Settings['replyPing']) => update({ replyPing })}>
                    <TableRadioRow label="Keep Discord's reply ping" subLabel="The @ On or Off you pick when replying still decides" value="keep" />
                    <TableRadioRow label="Never ping when replying" value="off" />
                </TableRadioGroup>
                <TableRadioGroup title="Chat bar button" defaultValue={s.button} onChange={(button: Settings['button']) => update({ button })}>
                    <TableRadioRow label="Hidden" value="none" />
                    <TableRadioRow label="Left" value="left" />
                    <TableRadioRow label="Right" value="right" />
                </TableRadioGroup>
                <TableRowGroup title={`Silent mentions on (${s.list.length})`}>
                    {s.list.length ? (
                        s.list.map(id => (
                            <TableRow
                                key={id}
                                label={labelOf(id)}
                                subLabel={id}
                                trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => (LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut), update({ list: settings().list.filter(x => x !== id) }))} />}
                            />
                        ))
                    ) : (
                        <TableRow label="Nothing yet" />
                    )}
                </TableRowGroup>
                <Stack spacing={8}>
                    <TextInput
                        label="Add a user or channel ID"
                        value={input}
                        placeholder="123456789012345678"
                        keyboardType="numeric"
                        onChange={(t: string) => setInput(t.replace(/[^0-9]/g, ''))}
                        onSubmitEditing={add}
                        size="md"
                    />
                    <Button text="Add" variant="primary" size="md" disabled={!isId(input)} onPress={add} />
                </Stack>
                <Text variant="text-sm/medium" color="text-muted">
                    Mentions show up, but nobody gets notified. Works for user, role, @everyone and @here mentions.
                </Text>
            </Stack>
        </Page>
    )
}
