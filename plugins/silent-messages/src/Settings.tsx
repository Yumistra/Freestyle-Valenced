import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { labelOf } from './chat'
import { bind, settings, update, useSettings, type Settings } from './store'

const isId = (s: string) => /^\d{17,20}$/.test(s)

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, TextInput } = Design as any
    const [input, setInput] = useState('')
    const add = () => {
        const id = input.trim()
        if (!isId(id) || settings().silentList.includes(id)) return
        update({ silentList: [...settings().silentList, id] })
        setInput('')
    }

    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="BellSlashIcon" />}
                        label="Always send silently"
                        subLabel="All of your messages are sent without notifications."
                        value={s.alwaysSilent}
                        onValueChange={(alwaysSilent: boolean) => update({ alwaysSilent })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="Chat bar button" defaultValue={s.button} onChange={(button: Settings['button']) => update({ button })}>
                    <TableRadioRow label="Hidden" value="none" />
                    <TableRadioRow label="Left" subLabel="Next to the attachments button." value="left" />
                    <TableRadioRow label="Right" subLabel="Next to the emoji button." value="right" />
                </TableRadioGroup>
                <TableRowGroup title={`Silenced (${s.silentList.length})`}>
                    {s.silentList.length ? (
                        s.silentList.map(id => (
                            <TableRow
                                key={id}
                                label={labelOf(id)}
                                subLabel={id}
                                trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => update({ silentList: settings().silentList.filter(x => x !== id) })} />}
                            />
                        ))
                    ) : (
                        <TableRow label="Nothing yet" subLabel="Tap the bell in the chat bar to silence a chat." />
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
            </Stack>
        </Page>
    )
}
