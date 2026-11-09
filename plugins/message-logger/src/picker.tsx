import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Image, LayoutAnimation, ScrollView, View } from 'react-native'
import { addTo, removeFrom } from './filters'
import { onChange, settings } from './store'

/**
 * 화이트리스트, 블랙리스트에 눌러서 넣는 화면.
 *  - 첫 화면: 다이렉트 메시지와 서버 목록
 *  - 서버를 누르면: 서버 통째로 넣기 + 탭(채널, 멤버)
 *  - 다이렉트 메시지를 누르면: 탭(친구, DM)
 * 각 화면은 설정 안의 새 화면(route)으로 열린다.
 */

export const PICKER_ROUTE = 'yumistra.message-logger.picker'
type List = 'allow' | 'block'
interface Params {
    list: List
    /** 서버 id, 또는 'dm' */
    place?: string
}
interface Item {
    id: string
    name: string
    sub?: string
    image?: string
    icon: string
}

const S = () => Stores as any
const DM = 'dm'
const LIMIT = 80

function tokenColor(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default
        const theme = S().ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}

const uname = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? u?.id
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

function servers(): Item[] {
    try {
        const all = S().GuildStore?.getGuilds?.() ?? {}
        const order: string[] = S().SortedGuildStore?.getFlattenedGuildIds?.() ?? Object.keys(all)
        return order
            .map(id => all[id])
            .filter(Boolean)
            .map((g: any) => ({ id: g.id, name: g.name, image: guildIcon(g), icon: 'ServerIcon' }))
    } catch {
        return []
    }
}

function channels(gid: string): Item[] {
    try {
        const all = S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {}
        const list = Object.values(all) as any[]
        const cats: Record<string, any> = {}
        for (const c of list) if (c?.type === 4) cats[c.id] = c
        const pos = (c: any) => [c.parent_id ? (cats[c.parent_id]?.position ?? 0) : -1, c.type === 2 || c.type === 13 ? 1 : 0, c.position ?? 0]
        return list
            .filter(c => c && c.type !== 4)
            .sort((a, b) => {
                const x = pos(a)
                const y = pos(b)
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
            })
            .map(c => ({ id: c.id, name: c.name, sub: c.parent_id ? cats[c.parent_id]?.name : undefined, icon: c.type === 2 || c.type === 13 ? 'VoiceNormalIcon' : c.type === 15 ? 'ForumIcon' : 'TextIcon' }))
    } catch {
        return []
    }
}

function userItem(id: string, sub?: string): Item | undefined {
    const u = S().UserStore?.getUser?.(id)
    if (!u) return
    return { id, name: uname(u), sub: sub ?? (u.username && u.username !== uname(u) ? `@${u.username}` : undefined), image: userAvatar(u), icon: 'UserIcon' }
}

/** 이 서버에서 앱이 알고 있는 멤버 (디스코드가 받아 둔 만큼) */
function members(gid: string): Item[] {
    try {
        const ids: string[] = S().GuildMemberStore?.getMemberIds?.(gid) ?? []
        return ids
            .map(id => {
                const m = S().GuildMemberStore?.getMember?.(gid, id)
                const it = userItem(id)
                if (it && m?.nick) it.sub = it.name
                if (it && m?.nick) it.name = m.nick
                return it
            })
            .filter(Boolean)
            .sort((a: any, b: any) => a.name.localeCompare(b.name)) as Item[]
    } catch {
        return []
    }
}

function friends(): Item[] {
    try {
        const ids: string[] = S().RelationshipStore?.getFriendIDs?.() ?? []
        return ids
            .map(id => userItem(String(id)))
            .filter(Boolean)
            .sort((a: any, b: any) => a.name.localeCompare(b.name)) as Item[]
    } catch {
        return []
    }
}

function dms(): Item[] {
    try {
        const list: any[] = S().ChannelStore?.getSortedPrivateChannels?.() ?? []
        return list.map(c => {
            const u = c.recipients?.length === 1 ? S().UserStore?.getUser?.(c.recipients[0]) : undefined
            return { id: c.id, name: c.name || (u ? uname(u) : 'Group DM'), sub: u ? 'DM' : 'Group DM', image: u ? userAvatar(u) : undefined, icon: 'ChatIcon' }
        })
    } catch {
        return []
    }
}

function Avatar({ item }: { item: Item }) {
    if (item.image) return <Image source={{ uri: item.image }} style={{ width: 32, height: 32, borderRadius: 16 }} />
    return <TableRowAssetIcon name={item.icon} />
}

function useToggle(list: List) {
    const [, force] = useState(0)
    // 다른 화면에서 바꿔도 체크 표시가 맞게
    useEffect(() => onChange(() => force(n => n + 1)) as any, [])
    const has = (id: string) => (settings()[list] ?? []).includes(id)
    const toggle = (id: string) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        if (has(id)) removeFrom(list, id)
        else addTo(list, id)
        force(n => n + 1)
    }
    return { has, toggle }
}

function Check({ on }: { on: boolean }) {
    const Icon = lookupGeneratedIconComponent('CheckmarkLargeIcon' as any) as any
    if (!on || !Icon) return null
    return <Icon size="sm" color={tokenColor(['TEXT_BRAND', 'BRAND_500'], '#5865f2')} />
}

/** 검색 + 고르는 목록 */
function ItemList({ items, list, empty, onQuery }: { items: Item[]; list: List; empty?: string; key?: string; onQuery?: (q: string) => void }) {
    const { TableRowGroup, TableRow, TextInput, Text } = Design as any
    const [q, setQ] = useState('')
    const { has, toggle } = useToggle(list)
    const query = q.trim().toLowerCase()
    useEffect(() => onQuery?.(query), [query])
    const filtered = query ? items.filter(i => i.name.toLowerCase().includes(query) || (i.sub ?? '').toLowerCase().includes(query) || i.id === query) : items
    // 전부 보여 주되, 한꺼번에 그리면 느려서 조금씩 이어 그린다
    const [count, setCount] = useState(LIMIT)
    useEffect(() => setCount(LIMIT), [query, items])
    useEffect(() => {
        if (count >= filtered.length) return
        const t = setTimeout(() => setCount(c => c + LIMIT), 16)
        return () => clearTimeout(t)
    }, [count, filtered.length])
    const shown = filtered.slice(0, count)
    return (
        <View style={{ gap: 12 }}>
            <TextInput value={q} placeholder="Search" onChange={setQ} isClearable />
            {shown.length ? (
                <TableRowGroup>
                    {shown.map(item => (
                        <TableRow key={item.id} icon={<Avatar item={item} />} label={item.name} subLabel={item.sub} trailing={<Check on={has(item.id)} />} onPress={() => toggle(item.id)} />
                    ))}
                </TableRowGroup>
            ) : (
                <Text variant="text-sm/normal" color="text-muted">
                    {query ? 'Nothing found' : (empty ?? 'Nothing here')}
                </Text>
            )}
        </View>
    )
}

/**
 * 서버 멤버: 디스코드는 처음에 일부(봇, 나, 멤버 목록에서 본 사람)만 받아 둔다.
 * 그래서 탭을 열거나 검색할 때 디스코드에 멤버를 더 달라고 요청하고, 받는 대로 목록을 다시 그린다.
 */
let memberActions: any
function requestMembers(gid: string, query: string) {
    try {
        memberActions ??= (lookupModule(withProps('requestMembers', 'requestMembersById') as any) as any)?.[0]
        memberActions?.requestMembers?.([gid], query, 100)
    } catch {}
}

function MembersTab({ gid, list }: { gid: string; list: List }) {
    const [ver, setVer] = useState(0)
    useEffect(() => {
        const store = S().GuildMemberStore
        const f = () => setVer(v => v + 1)
        store?.addChangeListener?.(f)
        requestMembers(gid, '')
        return () => store?.removeChangeListener?.(f)
    }, [gid])
    const items = useMemo(() => members(gid), [gid, ver])
    const timer = useState<{ t?: any }>({})[0]
    return (
        <ItemList
            items={items}
            list={list}
            empty="Loading members…"
            onQuery={q => {
                clearTimeout(timer.t)
                if (q) timer.t = setTimeout(() => requestMembers(gid, q), 350)
            }}
        />
    )
}

/** 이미지의 Tabs (Design.Tabs + useSegmentedControlState) 로 나눈 화면 */
function TabbedLists({ tabs, list }: { tabs: Array<{ id: string; label: string; items: () => Item[]; empty?: string; render?: () => any }>; list: List }) {
    const { Tabs, useSegmentedControlState } = Design as any
    const [index, setIndex] = useState(0)
    const items = useMemo(() => tabs.map(t => ({ id: t.id, label: t.label })), [tabs.map(t => t.id).join()])
    const state = useSegmentedControlState?.({ items, pageWidth: 0, defaultIndex: 0, onSetActiveIndex: setIndex, onPageChange: setIndex })
    const cur = tabs[index] ?? tabs[0]
    const data = useMemo(() => cur.items(), [cur.id])
    return (
        <View style={{ gap: 12 }}>
            {Tabs && state ? <Tabs state={state} grow /> : null}
            {cur.render ? cur.render() : <ItemList key={cur.id} items={data} list={list} empty={cur.empty} />}
        </View>
    )
}

function PickerScreen({ navigation, route }: any) {
    const { TableRowGroup, TableRow, TableSwitchRow } = Design as any
    const params: Params = route?.params ?? { list: 'block' }
    const { list, place } = params
    const { has, toggle } = useToggle(list)
    const listName = list === 'allow' ? 'whitelist' : 'blacklist'
    const guild = place && place !== DM ? S().GuildStore?.getGuild?.(place) : undefined
    useLayoutEffect(() => {
        navigation?.setOptions?.({ title: place === DM ? 'Direct messages' : guild ? guild.name : `Add to ${listName}` })
    }, [])
    const open = (p: string) => navigation?.push?.(PICKER_ROUTE, { list, place: p })
    let body: any
    if (!place) {
        // 첫 화면: DM + 서버 목록. 누르면 안으로
        const all = servers()
        body = (
            <>
                <TableRowGroup>
                    <TableRow icon={<TableRowAssetIcon name="ChatIcon" />} label="Direct messages" subLabel="Friends and DMs" arrow onPress={() => open(DM)} />
                </TableRowGroup>
                <TableRowGroup title="Servers">
                    {all.map(g => (
                        <TableRow key={g.id} icon={<Avatar item={g} />} label={g.name} trailing={has(g.id) ? <Check on /> : undefined} arrow onPress={() => open(g.id)} />
                    ))}
                </TableRowGroup>
            </>
        )
    } else if (place === DM) {
        body = (
            <TabbedLists
                list={list}
                tabs={[
                    { id: 'friends', label: 'Friends', items: friends, empty: 'No friends' },
                    { id: 'dms', label: 'DMs', items: dms, empty: 'No DMs' },
                ]}
            />
        )
    } else {
        body = (
            <>
                <TableRowGroup>
                    <TableSwitchRow icon={<Avatar item={{ id: place, name: '', image: guildIcon(guild), icon: 'ServerIcon' }} />} label="Whole server" subLabel={`Every channel and member here goes in the ${listName}`} value={has(place)} onValueChange={() => toggle(place)} />
                </TableRowGroup>
                <TabbedLists
                    list={list}
                    tabs={[
                        { id: 'channels', label: 'Channels', items: () => channels(place), empty: 'No channels' },
                        { id: 'members', label: 'Members', items: () => [], render: () => <MembersTab gid={place} list={list} /> },
                    ]}
                />
            </>
        )
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }} keyboardShouldPersistTaps="handled">
            {body}
        </ScrollView>
    )
}

/** 설정 안에 고르는 화면을 하나 등록한다 (목록에는 안 보인다) */
export function registerPicker(cleanup: (...f: any[]) => void) {
    try {
        cleanup(
            registerSettingsItem(PICKER_ROUTE, {
                parent: null,
                unsearchable: true,
                type: 'route',
                useTitle: () => 'Add',
                screen: { route: PICKER_ROUTE, getComponent: () => PickerScreen },
            } as any),
            () => refreshSettings(),
        )
        refreshSettings()
    } catch {}
}

/** 설정 화면에서 고르는 화면 열기 */
export function useOpenPicker() {
    let navigation: any
    try {
        navigation = (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
    return (list: List) => {
        try {
            navigation?.push?.(PICKER_ROUTE, { list })
        } catch {
            try {
                navigation?.navigate?.(PICKER_ROUTE, { list })
            } catch {}
        }
    }
}
