import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { bind, setRule, settings, update, useSettings, type Kind, type Mode } from './store'
import { nameOf, status } from './watch'

const KINDS: Array<[Kind, string, string, string]> = [
    ['read', 'Token reads', 'A plugin asks Discord for your token.', 'KeyIcon'],
    ['send', 'Token sent outside Discord', 'Your token is in a request to a site that is not Discord.', 'GlobeEarthIcon'],
    ['copy', 'Token copied', 'Your token is put in the clipboard.', 'CopyIcon'],
    ['files', "Discord's app files", 'A plugin reads app storage, databases or cookies.', 'FolderIcon'],
    ['account', 'Login token changed', 'A plugin sets or removes your login token.', 'UserIcon'],
]
const LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l])) as Record<Kind, string>

const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return new Date(ms).toLocaleString()
}

export default function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) bind(api.jsonStorage)
    const s = useSettings()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow, Button } = Design as any
    const [confirmClear, setConfirmClear] = useState(false)
    const trust = (p: string) => update({ trusted: [...settings().trusted.filter(x => x !== p), p] })

    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup title="Status">
                    <TableRow
                        icon={<TableRowAssetIcon name={status.names ? 'ShieldIcon' : 'WarningIcon'} />}
                        label={status.names ? 'Watching' : "Can't tell plugins apart yet"}
                        subLabel={
                            status.names
                                ? `Plugin names show in alerts. Watching: ${status.patched.join(', ') || 'nothing yet'}, network, clipboard, app files.`
                                : 'Alerts for token reads start once Discord loads the token module. Sends, copies and file reads still show.'
                        }
                    />
                    <TableRow icon={<TableRowAssetIcon name="SettingsIcon" />} label="Rules on plugin settings" subLabel={status.screens ? `Shown on top of ${status.screens} plugin settings page(s).` : 'No plugin settings page found yet.'} />
                    <TableSwitchRow icon={<TableRowAssetIcon name="BellIcon" />} label="Show toasts" subLabel="Everything is still kept in the log below." value={s.toasts} onValueChange={(toasts: boolean) => update({ toasts })} />
                </TableRowGroup>
                {KINDS.map(([k, label, sub]) => (
                    <TableRadioGroup key={k} title={label} defaultValue={s.watch[k]} onChange={(v: Mode) => update({ watch: { ...settings().watch, [k]: v } })}>
                        <TableRadioRow label="Block" subLabel={`${sub} It is stopped, and a popup lets you allow it.`} value="block" />
                        <TableRadioRow label="Alert" subLabel="Let it happen, but tell me." value="alert" />
                        <TableRadioRow label="Off" subLabel="Don't watch this." value="off" />
                    </TableRadioGroup>
                ))}
                <TableRowGroup title={`Trusted plugins (${s.trusted.length})`}>
                    {s.trusted.length ? (
                        s.trusted.map(p => (
                            <TableRow key={p} label={nameOf(p)} subLabel={p} trailing={<Button size="sm" variant="secondary" text="Remove" onPress={() => update({ trusted: settings().trusted.filter(x => x !== p) })} />} />
                        ))
                    ) : (
                        <TableRow label="Nothing yet" subLabel="Trust a plugin from the log to allow everything it does, with no alerts." />
                    )}
                </TableRowGroup>
                <TableRowGroup title={`Per plugin rules (${Object.keys(s.rules).length})`}>
                    {Object.keys(s.rules).length ? (
                        Object.entries(s.rules).map(([p, r]) => (
                            <TableRow
                                key={p}
                                label={nameOf(p)}
                                subLabel={Object.entries(r)
                                    .map(([k, v]) => `${LABEL[k as Kind] ?? k}: ${v}`)
                                    .join(', ')}
                                trailing={<Button size="sm" variant="secondary" text="Reset" onPress={() => Object.keys(r).forEach(k => setRule(p, k as Kind, undefined))} />}
                            />
                        ))
                    ) : (
                        <TableRow label="Nothing yet" subLabel="Change these at the top of each plugin's settings, or tap Always allow in a popup." />
                    )}
                </TableRowGroup>
                <TableRowGroup title={`Log (${s.log.length})`}>
                    {s.log.length ? (
                        s.log.map((h, i) => (
                            <TableRow
                                key={`${h.p}|${h.k}|${h.d ?? ''}|${i}`}
                                label={`${h.b ? 'Blocked, ' : ''}${nameOf(h.p)}, ${LABEL[h.k] ?? h.k}`}
                                subLabel={[ago(h.at), h.n > 1 ? `${h.n} times` : '', h.d ?? ''].filter(Boolean).join(', ')}
                                trailing={h.p && !s.trusted.includes(h.p) ? <Button size="sm" variant="secondary" text="Trust" onPress={() => trust(h.p)} /> : undefined}
                            />
                        ))
                    ) : (
                        <TableRow label="Nothing yet" subLabel="No plugin has touched anything sensitive." />
                    )}
                </TableRowGroup>
                {s.log.length ? (
                    <Button
                        text={confirmClear ? 'Tap again to clear' : 'Clear log'}
                        variant={confirmClear ? 'destructive' : 'secondary'}
                        size="md"
                        onPress={() => {
                            if (!confirmClear) {
                                setConfirmClear(true)
                                setTimeout(() => setConfirmClear(false), 3000)
                                return
                            }
                            setConfirmClear(false)
                            update({ log: [] })
                        }}
                    />
                ) : null}
            </Stack>
        </Page>
    )
}
