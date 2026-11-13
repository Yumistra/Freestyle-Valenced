import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { bind, update, useSettings, type Settings } from './store'

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, Text } = Design as any

    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AtIcon" />}
                        label="Silent mentions"
                        subLabel="Mentions in your messages show up, but nobody gets notified"
                        value={s.on}
                        onValueChange={(on: boolean) => update({ on })}
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
                <Text variant="text-sm/medium" color="text-muted">
                    Works for user, role, @everyone and @here mentions. Mentions added by editing a message never notify anyone anyway.
                </Text>
            </Stack>
        </Page>
    )
}
