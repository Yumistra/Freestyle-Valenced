import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useRef, useState } from 'react'
import { Image, LayoutAnimation, Pressable, View } from 'react-native'
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

// ── 눌러서 추가하기 (서버, 채널, 사용자) ────────────────────────

type Tab = 'server' | 'channel' | 'user'
interface Item {
    id: string
    name: string
    sub?: string
    image?: string
    icon: string
    /** 채널 탭에서 서버를 고르는 줄 */
    open?: string
}

const S = () => Stores as any
const DM = 'dm'

function guildIcon(g: any): string | undefined {
    try {
        if (typeof g?.getIconURL === 'function') return g.getIconURL(64, false) ?? undefined
        if (g?.icon) return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
    } catch {}
}
function userAvatar(u: any): string | undefined {
    try {
        if (typeof u?.getAvatarURL === 'function') return u.getAvatarURL(undefined, 64, false) ?? undefined
        if (u?.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    } catch {}
}
const uname = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? u?.id

function servers(): Item[] {
    try {
        const all = S().GuildStore?.getGuilds?.() ?? {}
        const order: string[] = S().SortedGuildStore?.getFlattenedGuildIds?.() ?? Object.keys(all)
        return order.map(id => all[id]).filter(Boolean).map((g: any) => ({ id: g.id, name: g.name, image: guildIcon(g), icon: 'ServerIcon' }))
    } catch {
        return []
    }
}

function channelsOf(gid: string): Item[] {
    try {
        if (gid === DM) {
            const list: any[] = S().ChannelStore?.getSortedPrivateChannels?.() ?? []
            return list.map(c => {
                const u = c.recipients?.length === 1 ? S().UserStore?.getUser?.(c.recipients[0]) : undefined
                return { id: c.id, name: c.name || (u ? uname(u) : 'Group DM'), sub: u ? 'DM' : 'Group DM', image: u ? userAvatar(u) : undefined, icon: 'ChatIcon' }
            })
        }
        const sel: any[] = S().GuildChannelStore?.getChannels?.(gid)?.SELECTABLE ?? []
        let list = sel.map(x => x.channel ?? x).filter(Boolean)
        if (!list.length) {
            const m = S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {}
            list = Object.values(m).filter((c: any) => c && c.type !== 4)
        }
        const cats: Record<string, string> = {}
        try {
            const m = S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {}
            for (const c of Object.values(m) as any[]) if (c?.type === 4) cats[c.id] = c.name
        } catch {}
        return list.map((c: any) => ({ id: c.id, name: `#${c.name}`, sub: c.parent_id ? cats[c.parent_id] : undefined, icon: c.type === 2 || c.type === 13 ? 'VoiceNormalIcon' : 'TextIcon' }))
    } catch {
        return []
    }
}

function users(): Item[] {
    const ids = new Set<string>()
    try {
        for (const id of S().RelationshipStore?.getFriendIDs?.() ?? []) ids.add(String(id))
        for (const c of S().ChannelStore?.getSortedPrivateChannels?.() ?? []) for (const r of c.recipients ?? []) ids.add(String(r))
    } catch {}
    const out: Item[] = []
    for (const id of ids) {
        const u = S().UserStore?.getUser?.(id)
        if (!u) continue
        out.push({ id, name: uname(u), sub: u.username && u.username !== uname(u) ? `@${u.username}` : isFriendQuick(id) ? 'Friend' : undefined, image: userAvatar(u), icon: 'UserIcon' })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
}
const isFriendQuick = (id: string) => {
    try {
        return !!S().RelationshipStore?.isFriend?.(id)
    } catch {
        return false
    }
}

function Avatar({ item }: { item: Item }) {
    if (item.image) return <Image source={{ uri: item.image }} style={{ width: 32, height: 32, borderRadius: 16 }} />
    return <TableRowAssetIcon name={item.icon} />
}

const LIMIT = 60

function Picker({ list }: { list: 'allow' | 'block' }) {
    const { TableRow, TextInput, Button, Text } = Design as any
    const [tab, setTab] = useState<Tab>('server')
    const [server, setServer] = useState<string | undefined>()
    const [q, setQ] = useState('')
    const [, force] = useState(0)
    const items: Item[] = (() => {
        if (tab === 'server') return servers()
        if (tab === 'user') return users()
        if (!server) return [{ id: DM, name: 'Direct messages', icon: 'ChatIcon', open: DM } as Item, ...servers().map(g => ({ ...g, open: g.id, sub: 'Pick a channel' }))]
        return channelsOf(server)
    })()
    const query = q.trim().toLowerCase()
    const shown = (query ? items.filter(i => i.name.toLowerCase().includes(query) || (i.sub ?? '').toLowerCase().includes(query) || i.id === query) : items).slice(0, LIMIT)
    const Check = lookupGeneratedIconComponent('CheckmarkLargeIcon' as any) as any
    const accent = tokenColor(['TEXT_BRAND', 'BRAND_500'], '#5865f2')
    const toggle = (id: string) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        if ((settings()[list] ?? []).includes(id)) removeFrom(list, id)
        else addTo(list, id)
        force(n => n + 1)
    }
    const tabs: Array<[Tab, string]> = [
        ['server', 'Servers'],
        ['channel', 'Channels'],
        ['user', 'Users'],
    ]
    return (
        <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12 }}>
                {tabs.map(([t, label]) => (
                    <View key={t} style={{ flex: 1 }}>
                        <Button
                            text={label}
                            size="sm"
                            variant={tab === t ? 'primary' : 'secondary'}
                            onPress={() => {
                                setTab(t)
                                setServer(undefined)
                                setQ('')
                            }}
                        />
                    </View>
                ))}
            </View>
            <View style={{ paddingHorizontal: 12 }}>
                <TextInput value={q} placeholder="Search" onChange={setQ} isClearable />
            </View>
            {tab === 'channel' && server ? <TableRow label="All servers" icon={<TableRowAssetIcon name="ArrowLargeLeftIcon" />} onPress={() => (setServer(undefined), setQ(''))} /> : null}
            {shown.map(item => {
                const added = !item.open && (settings()[list] ?? []).includes(item.id)
                return (
                    <TableRow
                        key={`${tab}-${item.id}`}
                        icon={<Avatar item={item} />}
                        label={item.name}
                        subLabel={item.sub}
                        arrow={!!item.open}
                        trailing={added && Check ? <Check size="sm" color={accent} /> : undefined}
                        onPress={() => {
                            if (item.open) {
                                setServer(item.open)
                                setQ('')
                            } else toggle(item.id)
                        }}
                    />
                )
            })}
            {!shown.length ? (
                <View style={{ padding: 12 }}>
                    <Text variant="text-sm/normal" color="text-muted">
                        Nothing found
                    </Text>
                </View>
            ) : null}
            {items.length > LIMIT && !query ? (
                <View style={{ paddingHorizontal: 12 }}>
                    <Text variant="text-xs/normal" color="text-muted">{`Showing ${LIMIT} of ${items.length}, search to find more`}</Text>
                </View>
            ) : null}
        </View>
    )
}

function ListGroup({ list, title, hint, children }: { list: 'allow' | 'block'; title: string; hint: string; children?: any }) {
    const { TableRowGroup, TableRow, Button, Text } = Design as any
    const [open, setOpen] = useState(false)
    const ids = settings()[list] ?? []
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
                        subLabel={KIND_LABEL[kind]}
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
            <View style={{ padding: 12, gap: 8 }}>
                {!ids.length ? (
                    <Text variant="text-sm/normal" color="text-muted">
                        {hint}
                    </Text>
                ) : null}
                <Button
                    text={open ? 'Done' : 'Add'}
                    size="md"
                    variant={open ? 'primary' : 'secondary'}
                    onPress={() => {
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                        setOpen(o => !o)
                    }}
                />
            </View>
            {open ? <Picker list={list} /> : null}
        </TableRowGroup>
    )
}

export function FilterSettings({ set }: { set: (patch: any) => void }) {
    const { TableSwitchRow } = Design as any
    const s = settings()
    return (
        <>
            <ListGroup list="allow" title="Whitelist" hint="Always logged, even if blacklisted or not a friend.">
                <TableSwitchRow label="Only log the whitelist" value={s.allowOnly} onValueChange={(allowOnly: boolean) => set({ allowOnly })} />
                <TableSwitchRow label="Only log friends" subLabel="Messages from people who aren't your friends are not logged" value={s.friendsOnly} onValueChange={(friendsOnly: boolean) => set({ friendsOnly })} />
            </ListGroup>
            <ListGroup list="block" title="Blacklist" hint="Never logged. Long press a message to add its author." />
        </>
    )
}
