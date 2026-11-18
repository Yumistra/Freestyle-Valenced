import Page from '@valenced/components/Page'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { bind, DEFAULTS, update, useSettings } from './store'

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TextInput, Text } = Design as any
    const [name, setName] = useState(s.name)

    return (
        <Page>
            <Stack spacing={16}>
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
                <Text variant="text-sm/medium" color="text-muted">
                    Discord no longer sends the real name, topic or allowed roles of hidden channels. Only where they are, their type and who is in hidden voice channels are left.
                </Text>
            </Stack>
        </Page>
    )
}
