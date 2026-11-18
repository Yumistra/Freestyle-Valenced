import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { bind, DEFAULTS, update, useSettings, type Settings } from './store'

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, TextInput } = Design as any
    const [name, setName] = useState(s.name)

    return (
        <Page>
            <Stack spacing={24}>
                <TextInput
                    label="Hidden channel name"
                    value={name}
                    placeholder={DEFAULTS.name}
                    onChange={(t: string) => {
                        setName(t)
                        update({ name: t.trim() || DEFAULTS.name })
                    }}
                    size="md"
                />
                <TableRadioGroup title="Show hidden channels as" defaultValue={s.showMode} onChange={(showMode: Settings['showMode']) => update({ showMode })}>
                    <TableRadioRow label="Plain, with Discord's lock icon" value="lock" />
                    <TableRadioRow label="Muted, with an eye icon on the right" value="muted" />
                </TableRadioGroup>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="EyeSlashIcon" />}
                        label="Hide unreads"
                        value={s.hideUnreads}
                        onValueChange={(hideUnreads: boolean) => update({ hideUnreads })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ShieldUserIcon" />}
                        label="Open allowed roles and users by default"
                        value={s.rolesOpen}
                        onValueChange={(rolesOpen: boolean) => update({ rolesOpen })}
                    />
                </TableRowGroup>
            </Stack>
        </Page>
    )
}
