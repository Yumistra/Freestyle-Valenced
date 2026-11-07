import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useRef, useState } from 'react'
import { LayoutAnimation, Pressable, View } from 'react-native'
import { addTo, KIND_LABEL, kindOf, nameOf, removeFrom } from './filters'
import { settings } from './store'

function tokenColor(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}

const ICON: Record<string, string> = { user: 'UserIcon', channel: 'TextIcon', server: 'ServerIcon', unknown: 'IdIcon' }

/** 두 번 눌러 지우기 (처음 누르면 빨갛게, 3초 안에 한 번 더) */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
    const { Text } = Design as any
    const [armed, setArmed] = useState(false)
    const timer = useRef<any>()
    useEffect(() => () => clearTimeout(timer.current), [])
    const Trash = lookupGeneratedIconComponent('TrashIcon' as any) as any
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={armed ? 'Tap again to remove' : 'Remove'}
            hitSlop={8}
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
            ) : null}
            {Trash ? <Trash size="sm" color={armed ? tokenColor(['TEXT_DANGER', 'STATUS_DANGER'], '#da373c') : tokenColor(['INTERACTIVE_TEXT_DEFAULT', 'INTERACTIVE_NORMAL'], '#b5bac1')} /> : null}
        </Pressable>
    )
}

function ListGroup({ list, title, hint, children }: { list: 'allow' | 'block'; title: string; hint: string; children?: any }) {
    const { TableRowGroup, TableRow, TextInput, Button, Stack } = Design as any
    const [text, setText] = useState('')
    const [error, setError] = useState('')
    const ids = settings()[list] ?? []
    const add = () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        const parts = text.split(/[\s,]+/).filter(Boolean)
        const bad = parts.filter(p => !addTo(list, p))
        setError(bad.length ? `Not an ID, ${bad.join(', ')}` : '')
        setText(bad.join(' '))
    }
    return (
        <TableRowGroup title={title}>
            {children}
            {ids.map(id => {
                const kind = kindOf(id)
                return (
                    <TableRow
                        key={id}
                        icon={<TableRowAssetIcon name={ICON[kind]} />}
                        label={nameOf(id)}
                        subLabel={`${KIND_LABEL[kind]}, ${id}`}
                        trailing={
                            <DeleteButton
                                onDelete={() => {
                                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                                    removeFrom(list, id)
                                }}
                            />
                        }
                    />
                )
            })}
            <View style={{ padding: 12 }}>
                <Stack spacing={8}>
                    <TextInput value={text} placeholder="User, channel or server ID" onChange={(v: string) => setText(v.replace(/[^\d\s,]/g, ''))} keyboardType="number-pad" errorMessage={error || undefined} description={hint} />
                    <Button text="Add" size="md" variant="secondary" disabled={!text.trim()} onPress={add} />
                </Stack>
            </View>
        </TableRowGroup>
    )
}

export function FilterSettings({ set }: { set: (patch: any) => void }) {
    const { TableSwitchRow } = Design as any
    const s = settings()
    return (
        <>
            <ListGroup list="allow" title="Whitelist" hint="Always logged, even if blacklisted.">
                <TableSwitchRow label="Only log the whitelist" value={s.allowOnly} onValueChange={(allowOnly: boolean) => set({ allowOnly })} />
            </ListGroup>
            <ListGroup list="block" title="Blacklist" hint="Never logged. Long press a message to add its author." />
        </>
    )
}
