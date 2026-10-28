import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { reloadApp } from '@valenced/modules/native/app'
import { useEffect, useState } from 'react'
import { ScrollView, Share, View } from 'react-native'
import {
    createBackup,
    dataCountOf,
    deleteBackupFiles,
    exportBackup,
    messageOf,
    parseBackup,
    restoreBackup,
    storeImportedFiles,
    summaryOf,
    type Backup,
    type RestoreOptions,
    type RestoreResult,
    DEV_MODE_NOTICE,
    hasInternalApi,
} from './backup'

const MAX_BACKUPS = 10
const D = () => Design as any

let seq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`plugin-backup-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const dateOf = (t: number) => new Date(t).toLocaleString()

interface Storage {
    backups: Backup[]
}

function useBackups(storage: any) {
    const [backups, setBackups] = useState<Backup[]>(() => (storage?.cache as Storage | undefined)?.backups ?? [])
    useEffect(() => {
        // 저장소가 아직 안 읽혔을 수도 있으니 한 번 읽어 온다
        storage
            ?.get?.()
            .then((c: Storage | undefined) => c?.backups && setBackups(c.backups))
            .catch(() => {})
    }, [])
    const save = async (next: Backup[]) => {
        setBackups(next)
        await storage.set({ backups: next }, true)
    }
    return [backups, save] as const
}

function confirm(title: string, body: string, actionText: string, action: () => void) {
    const { AlertModal, AlertActionButton, Text } = D()
    AlertActionCreators.openAlert(
        `plugin-backup-confirm-${seq++}`,
        <AlertModal
            title={title}
            content={<Text variant="text-md/normal">{body}</Text>}
            actions={
                <>
                    <AlertActionButton text={actionText} variant="primary" onPress={action} />
                    <AlertActionButton text="Cancel" variant="secondary" />
                </>
            }
        />,
    )
}

function describeResult(r: RestoreResult) {
    const lines = [
        `Installed ${r.installed.length} · Settings ${r.storage} · Files ${r.files} · Toggled ${r.toggled}`,
        ...r.failed.map(f => `Failed: ${f.id} (${f.reason})`),
        ...r.skipped.map(s => `Skipped: ${s.id} (${s.reason})`),
    ]
    return lines.join('\n')
}

function showRestoreDone(r: RestoreResult) {
    confirm('Restored', describeResult(r), 'Reload', () => reloadApp())
}

export default function SettingsPage({ api }: { api: any }) {
    const { Button, Stack, TableRow, TableRowGroup, TableSwitchRow, Text, TextArea, TextInput } = D()
    const [backups, saveBackups] = useBackups(api.jsonStorage)
    const [selected, setSelected] = useState<number | null>(null)
    const [busy, setBusy] = useState('')
    const [input, setInput] = useState('')
    const [opts, setOpts] = useState<RestoreOptions>({ repos: true, install: true, storage: true, files: true, enabled: true })

    const run = async (label: string, fn: () => Promise<void>) => {
        if (busy) return
        setBusy(label)
        try {
            await fn()
        } catch (e) {
            toast(messageOf(e))
        } finally {
            setBusy('')
        }
    }

    const addBackup = async (b: Backup) => {
        const all = [b, ...backups.filter(x => x.createdAt !== b.createdAt)]
        // 넘치는 오래된 백업은 복사해 둔 파일까지 지운다
        for (const old of all.slice(MAX_BACKUPS)) await deleteBackupFiles(old)
        await saveBackups(all.slice(0, MAX_BACKUPS))
    }

    const backupNow = () =>
        run('Backing up…', async () => {
            const b = await createBackup(text => text && setBusy(text))
            await addBackup(b)
            setSelected(0)
            toast(`Backed up: ${summaryOf(b)}`)
        })

    const importBackup = (text: string) =>
        run('Importing…', async () => {
            let raw = text.trim()
            if (!raw) throw new Error('Nothing to import')
            if (/^https?:\/\//i.test(raw)) {
                const res = await fetch(raw, { cache: 'no-store' } as any)
                if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
                raw = await res.text()
            }
            setBusy('Unpacking…')
            const b = await storeImportedFiles(parseBackup(raw))
            await addBackup(b)
            setSelected(0)
            setInput('')
            toast(`Imported: ${summaryOf(b)}`)
        })

    const restore = (b: Backup) =>
        confirm(
            'Restore this backup?',
            `${dateOf(b.createdAt)}\n${summaryOf(b)}`,
            'Restore',
            () =>
                run('Restoring…', async () => {
                    const r = await restoreBackup(b, opts, text => text && setBusy(text))
                    showRestoreDone(r)
                }),
        )

    const current = selected != null ? backups[selected] : undefined
    const exportThen = (b: Backup, label: string, fn: (json: string) => unknown) =>
        run(label, async () => {
            const { json, withFiles } = await exportBackup(b)
            await fn(json)
            if (!withFiles) toast('Files too large, copied settings only')
        })

    return (
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={24} style={{ padding: 16, paddingBottom: 48 }}>
                {!hasInternalApi() && (
                    <Text variant="text-sm/semibold" style={{ color: '#f23f43' }}>
                        {DEV_MODE_NOTICE}
                    </Text>
                )}
                <Button text={busy || 'Back up now'} variant="primary" size="md" disabled={!!busy} onPress={backupNow} />

                <TableRowGroup title="Backups">
                    {backups.length ? (
                        backups.map((b, i) => (
                            <TableRow
                                key={`${b.createdAt}-${i}`}
                                label={`${selected === i ? '● ' : ''}${dateOf(b.createdAt)}`}
                                subLabel={summaryOf(b)}
                                onPress={() => setSelected(selected === i ? null : i)}
                            />
                        ))
                    ) : (
                        <TableRow label="No backups" />
                    )}
                </TableRowGroup>

                {current && (
                    <Stack spacing={8}>
                        <TableRowGroup title="Restore">
                            {[
                                <TableSwitchRow key="repos" label="Repositories" value={opts.repos} onValueChange={(repos: boolean) => setOpts({ ...opts, repos })} />,
                                <TableSwitchRow key="install" label="Missing plugins" value={opts.install} onValueChange={(install: boolean) => setOpts({ ...opts, install })} />,
                                <TableSwitchRow key="storage" label="Settings" value={opts.storage} onValueChange={(storage: boolean) => setOpts({ ...opts, storage })} />,
                                <TableSwitchRow key="files" label="Files" value={opts.files} onValueChange={(files: boolean) => setOpts({ ...opts, files })} />,
                                <TableSwitchRow key="enabled" label="Enabled state" value={opts.enabled} onValueChange={(enabled: boolean) => setOpts({ ...opts, enabled })} />,
                            ]}
                        </TableRowGroup>
                        <Button text={busy || 'Restore'} variant="primary" size="md" disabled={!!busy} onPress={() => restore(current)} />
                        <Stack direction="horizontal" spacing={8}>
                            <View style={{ flex: 1 }}>
                                <Button
                                    text="Copy"
                                    variant="secondary"
                                    size="md"
                                    disabled={!!busy}
                                    onPress={() =>
                                        exportThen(current, 'Copying…', json => {
                                            Clipboard.setString(json)
                                            toast('Copied')
                                        })
                                    }
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Button
                                    text="Share"
                                    variant="secondary"
                                    size="md"
                                    disabled={!!busy}
                                    onPress={() => exportThen(current, 'Preparing…', json => Share.share({ title: 'Plugin Backup', message: json }).catch(() => {}))}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Button
                                    text="Delete"
                                    variant="destructive"
                                    size="md"
                                    onPress={() =>
                                        confirm('Delete this backup?', dateOf(current.createdAt), 'Delete', () => {
                                            setSelected(null)
                                            saveBackups(backups.filter(b => b !== current))
                                            deleteBackupFiles(current)
                                        })
                                    }
                                />
                            </View>
                        </Stack>
                        <TableRowGroup title="Contents">
                            {current.plugins
                                .filter(p => {
                                    // 내장 플러그인은 데이터가 있을 때만 (예: 테마 API의 state.json)
                                    const d = dataCountOf(current, p.id)
                                    return !p.internal || d.settings + d.files > 0
                                })
                                .map(p => {
                                    const d = dataCountOf(current, p.id)
                                    const extra = [d.settings && `${d.settings} settings`, d.files && `${d.files} files`].filter(Boolean).join(' · ')
                                    return (
                                        <TableRow
                                            key={p.id}
                                            label={`${p.enabled ? '' : '(off) '}${p.name} ${p.version}`}
                                            subLabel={`${extra ? `${extra} · ` : ''}${p.internal ? 'Built-in' : p.source?.repo ?? 'From file'}`}
                                            subLabelLineClamp={1}
                                        />
                                    )
                                })}
                        </TableRowGroup>
                    </Stack>
                )}

                <Stack spacing={8}>
                    {(TextArea ?? TextInput) && (
                        <>
                            {TextArea ? (
                                <TextArea label="Import" placeholder="Backup JSON or URL" value={input} onChange={setInput} size="md" />
                            ) : (
                                <TextInput label="Import" placeholder="Backup JSON or URL" value={input} onChange={setInput} multiline size="md" />
                            )}
                        </>
                    )}
                    <Stack direction="horizontal" spacing={8}>
                        <View style={{ flex: 1 }}>
                            <Button text="Import" variant="primary" size="md" disabled={!!busy || !input.trim()} onPress={() => importBackup(input)} />
                        </View>
                        <View style={{ flex: 1 }}>
                            <Button
                                text="Paste"
                                variant="secondary"
                                size="md"
                                disabled={!!busy}
                                onPress={() => Clipboard.getString().then((t: string) => importBackup(t ?? ''))}
                            />
                        </View>
                    </Stack>
                </Stack>
            </Stack>
        </ScrollView>
    )
}
