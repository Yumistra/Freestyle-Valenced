import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Constants } from '@valenced/discord/common/constants'
import { Dispatcher } from '@valenced/discord/common/flux'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { refreshSettings, registerSettingsItem } from '@valenced/discord/modules/settings'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { FlatList, Image, LayoutAnimation, View } from 'react-native'
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

/** 내가 볼 수 있는 채널인지 (다른 플러그인이 숨은 채널을 보여 줘도 빼게) */
function canView(c: any): boolean {
    try {
        if (!c || /^_+hidden_+$/i.test(String(c.name ?? ''))) return false
        const P: any = (Constants as any)?.Permissions
        const view = P?.VIEW_CHANNEL ?? 1024n
        const ps = S().PermissionStore
        if (typeof ps?.can === 'function') return !!ps.can(view, c)
    } catch {}
    return true
}

function channels(gid: string): Item[] {
    try {
        const all = S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {}
        const list = Object.values(all) as any[]
        const cats: Record<string, any> = {}
        for (const c of list) if (c?.type === 4) cats[c.id] = c
        const pos = (c: any) => [c.parent_id ? (cats[c.parent_id]?.position ?? 0) : -1, c.type === 2 || c.type === 13 ? 1 : 0, c.position ?? 0]
        return list
            .filter(c => c && c.type !== 4 && canView(c))
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
        const set = new Set<string>((S().GuildMemberStore?.getMemberIds?.(gid) ?? []).map(String))
        // 멤버 목록으로 받은 사람들 (멤버 목록 저장소에만 들어가는 경우도 있어서)
        try {
            const cid = listChannel(gid)
            const rows: any[] = (cid && S().ChannelMemberStore?.getProps?.(gid, cid)?.rows) || []
            for (const r of rows) {
                const id = r?.userId ?? r?.user?.id ?? r?.member?.userId
                if (id) set.add(String(id))
            }
        } catch {}
        const ids = [...set]
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

// ── 멤버 전부 받기 ──────────────────────────────────────────────
/**
 * 디스코드 앱은 서버 멤버를 처음부터 다 받아 두지 않는다 (봇, 나, 최근에 본 사람 정도).
 * 오른쪽 멤버 목록이 하는 것처럼, 한 채널의 멤버 목록을 100명씩 구간으로 차례로 구독해서 받는다.
 * (아주 큰 서버는 디스코드가 오프라인 멤버를 멤버 목록에 넣지 않아서, 그 사람들은 검색으로 찾는다)
 */
const find = (...props: string[]) => {
    try {
        return (lookupModule(withProps(...(props as [string])) as any) as any)?.[0]
    } catch {}
}
let memberActions: any
let subscriptions: any
function requestMembers(gid: string, query: string) {
    try {
        memberActions ??= find('requestMembers', 'requestMembersById')
        memberActions?.requestMembers?.([gid], query, 100)
    } catch {}
}

/** 멤버 목록에 쓸 채널: 시스템, 규칙 채널, 아니면 맨 위 글 채널 */
function listChannel(gid: string): string | undefined {
    try {
        const g = S().GuildStore?.getGuild?.(gid)
        const all = Object.values(S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {}) as any[]
        const text = all.filter(c => c?.type === 0 && canView(c)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        const ok = (id?: string) => (id && text.some(c => c.id === id) ? id : undefined)
        return ok(g?.systemChannelId) ?? ok(g?.rulesChannelId) ?? text[0]?.id
    } catch {}
}

function memberCount(gid: string): number {
    try {
        const n = S().GuildMemberCountStore?.getMemberCount?.(gid) ?? S().GuildStore?.getGuild?.(gid)?.memberCount
        if (typeof n === 'number' && n > 0) return n
    } catch {}
    return 1000
}

/** 구간을 차례로 구독한다. 멈추는 함수를 돌려준다 */
function loadAllMembers(gid: string, onStep: (done: number, total: number) => void): () => void {
    let stopped = false
    requestMembers(gid, '')
    subscriptions ??= find('subscribeChannel', 'subscribeMembers') ?? find('subscribeChannel')
    const cid = listChannel(gid)
    const total = memberCount(gid)
    if (!cid) {
        onStep(total, total)
        return () => {}
    }
    let i = 1
    const step = () => {
        if (stopped) return
        // 디스코드는 한 번에 구간 3개까지: 처음 100명 + 다음 두 구간
        const ranges: number[][] = [[0, 99]]
        for (const k of [i, i + 1]) if (k * 100 < total) ranges.push([k * 100, k * 100 + 99])
        // 오른쪽 멤버 목록과 같은 요청 (디스코드가 받아서 서버에 구독을 보낸다)
        try {
            ;(Dispatcher as any).dispatch({ type: 'GUILD_SUBSCRIPTIONS_CHANNEL', guildId: gid, channelId: cid, ranges })
        } catch {
            try {
                subscriptions?.subscribeChannel?.(gid, cid, ranges)
            } catch {}
        }
        onStep(Math.min(total, (i + 2) * 100), total)
        i += 2
        if (i * 100 < total) setTimeout(step, 450)
    }
    step()
    return () => {
        stopped = true
    }
}

// ── 화면 ────────────────────────────────────────────────────────

interface TabDef {
    id: string
    label: string
    items: () => Item[]
    empty: string
}

function PickerScreen({ navigation, route }: any) {
    const { TableRow, TableSwitchRow, TextInput, Text, Tabs, useSegmentedControlState } = Design as any
    const params: Params = route?.params ?? { list: 'block' }
    const { list, place } = params
    const { has, toggle } = useToggle(list)
    const listName = list === 'allow' ? 'whitelist' : 'blacklist'
    const guild = place && place !== DM ? S().GuildStore?.getGuild?.(place) : undefined
    useLayoutEffect(() => {
        navigation?.setOptions?.({ title: place === DM ? 'Direct messages' : guild ? guild.name : `Add to ${listName}` })
    }, [])
    const open = (p: string) => navigation?.push?.(PICKER_ROUTE, { list, place: p })

    const tabs: TabDef[] = useMemo(() => {
        if (place === DM)
            return [
                { id: 'friends', label: 'Friends', items: friends, empty: 'No friends' },
                { id: 'dms', label: 'DMs', items: dms, empty: 'No DMs' },
            ]
        if (place)
            return [
                { id: 'channels', label: 'Channels', items: () => channels(place), empty: 'No channels' },
                { id: 'members', label: 'Members', items: () => members(place), empty: 'Loading members…' },
            ]
        return []
    }, [place])
    const [tab, setTab] = useState(0)
    const tabItems = useMemo(() => tabs.map(t => ({ id: t.id, label: t.label })), [tabs])
    const tabState = tabs.length ? useSegmentedControlState?.({ items: tabItems, pageWidth: 0, defaultIndex: 0, onSetActiveIndex: setTab, onPageChange: setTab }) : undefined
    const cur = tabs[tab]
    const [q, setQ] = useState('')
    const query = q.trim().toLowerCase()

    // 디스코드 쪽이 바뀌면(멤버를 받으면 등) 다시 그린다. 너무 자주 그리지 않게 묶는다
    const [ver, setVer] = useState(0)
    useEffect(() => {
        let t: any
        const bump = () => {
            if (t) return
            t = setTimeout(() => {
                t = undefined
                setVer(v => v + 1)
            }, 250)
        }
        const stores = [S().GuildMemberStore, S().ChannelMemberStore, S().RelationshipStore, S().ChannelStore].filter(Boolean)
        for (const st of stores) st.addChangeListener?.(bump)
        return () => {
            clearTimeout(t)
            for (const st of stores) st.removeChangeListener?.(bump)
        }
    }, [])

    // 멤버 탭: 전부 받기
    const [progress, setProgress] = useState<[number, number] | undefined>()
    const isMembers = !!guild && cur?.id === 'members'
    useEffect(() => {
        if (!isMembers || !place) return
        return loadAllMembers(place, (d, t) => setProgress([d, t]))
    }, [isMembers, place])
    // 검색하면 그 이름으로도 찾아 달라고 한다
    useEffect(() => {
        if (!isMembers || !place || !query) return
        const t = setTimeout(() => requestMembers(place, query), 350)
        return () => clearTimeout(t)
    }, [isMembers, place, query])

    type Row = Item & { open?: string }
    const all: Row[] = useMemo(() => {
        if (!place) return [{ id: DM, name: 'Direct messages', sub: 'Friends and DMs', icon: 'ChatIcon', open: DM }, ...servers().map(g => ({ ...g, open: g.id }))]
        return cur ? cur.items() : []
    }, [place, cur?.id, ver])
    const shown = useMemo(() => (query ? all.filter(i => i.name.toLowerCase().includes(query) || (i.sub ?? '').toLowerCase().includes(query) || i.id === query) : all), [all, query])

    const header = (
        <View style={{ gap: 12, marginBottom: 12 }}>
            {guild ? (
                <View style={{ borderRadius: 16, overflow: 'hidden' }}>
                    <TableSwitchRow
                        icon={<Avatar item={{ id: place!, name: '', image: guildIcon(guild), icon: 'ServerIcon' }} />}
                        label="Whole server"
                        subLabel={`Every channel and member here goes in the ${listName}`}
                        value={has(place!)}
                        onValueChange={() => toggle(place!)}
                        start
                        end
                    />
                </View>
            ) : null}
            {Tabs && tabState ? <Tabs state={tabState} grow /> : null}
            <TextInput value={q} placeholder="Search" onChange={setQ} isClearable />
            {isMembers && progress && progress[0] < progress[1] ? <Text variant="text-xs/normal" color="text-muted">{`Loading members, ${shown.length} so far`}</Text> : null}
        </View>
    )

    return (
        <FlatList
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
            data={shown}
            keyExtractor={(i: Row) => i.id}
            ListHeaderComponent={header}
            ListEmptyComponent={
                <Text variant="text-sm/normal" color="text-muted">
                    {query ? 'Nothing found' : (cur?.empty ?? 'Nothing here')}
                </Text>
            }
            renderItem={({ item, index }: { item: Row; index: number }) => (
                <TableRow
                    icon={<Avatar item={item} />}
                    label={item.name}
                    subLabel={item.sub}
                    arrow={!!item.open}
                    trailing={<Check on={has(item.id)} />}
                    onPress={() => (item.open ? open(item.open) : toggle(item.id))}
                    start={index === 0}
                    end={index === shown.length - 1}
                />
            )}
            extraData={[settings()[list]?.length, ver]}
            initialNumToRender={20}
            maxToRenderPerBatch={30}
            windowSize={11}
            removeClippedSubviews
            keyboardShouldPersistTaps="handled"
        />
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
