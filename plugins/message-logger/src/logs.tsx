import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { removeOne } from './logger'
import { logs, seen, type Entry } from './store'

/**
 * 로그 보기: 채팅 메시지와 같은 모양(아바타, 이름, 시간, 내용)으로 보여 주고,
 * 누르면 설정을 닫고 그 메시지가 있는 곳으로 간다 (디스코드 transitionToMessage).
 */

const PAGE = 40
const RED = '#f23f43'

/** 디스코드 이동 함수 (transitionToMessage(channelId, messageId)) */
let toMessage: ((channelId: string, messageId: string, opts?: any) => void) | undefined
export function bindNavigation(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(withProps('transitionToMessage') as any, (mod: any) => {
            if (typeof mod?.transitionToMessage === 'function') toMessage = mod.transitionToMessage.bind(mod)
        }) as any,
    )
}

function authorOf(id: string, e: Entry): any {
    const S: any = Stores
    return e.m?.author ?? S.MessageStore?.getMessage?.(e.c, id)?.author ?? (seen() as any)[id]?.m?.author
}

function avatarUrl(a: any) {
    if (a?.id && a.avatar) return `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.png?size=96`
    let n = 0
    try {
        n = Number((BigInt(a?.id ?? '0') >> BigInt(22)) % BigInt(6))
    } catch {}
    return `https://cdn.discordapp.com/embed/avatars/${n}.png`
}

/** 스노플레이크에서 보낸 시각 */
const sentAt = (id: string) => {
    try {
        return Number(BigInt(id) >> BigInt(22)) + 1420070400000
    } catch {
        return 0
    }
}

/** 디스코드 언어에 맞춘 "(수정됨)" */
function editedWord() {
    try {
        const l = String((Stores as any).LocaleStore?.locale ?? (Stores as any).UserSettingsStore?.locale ?? '')
        if (l.startsWith('ko')) return '(수정됨)'
        if (l.startsWith('ja')) return '(編集済)'
    } catch {}
    return '(edited)'
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : '')

function where(e: Entry) {
    try {
        const S: any = Stores
        const ch = S.ChannelStore?.getChannel?.(e.c)
        if (!ch) return ''
        const guild = e.g ? S.GuildStore?.getGuild?.(e.g)?.name : ''
        return ch.name ? `${guild ? `${guild}, ` : ''}#${ch.name}` : 'DM'
    } catch {
        return ''
    }
}

/** 설정 화면들을 닫는다 (안쪽 목록부터 맨 처음 화면까지) */
function closeSettings(nav: any) {
    let n = nav
    let guard = 0
    while (n && guard++ < 8) {
        try {
            if (n.canGoBack?.()) n.popToTop?.() ?? n.goBack?.()
        } catch {}
        n = n.getParent?.()
    }
}

function Row({ id, e, onOpen, onDelete }: { id: string; e: Entry; onOpen(): void; onDelete(): void; key?: string }) {
    const { Text, Button } = Design as any
    const S: any = Stores
    const a = authorOf(id, e)
    const name = a?.globalName ?? a?.global_name ?? a?.username ?? 'Unknown'
    const now = S.MessageStore?.getMessage?.(e.c, id)
    const current = e.d ? String(e.m?.content ?? now?.content ?? '') : String(now?.content ?? '')
    const files = (e.m?.attachments ?? now?.attachments ?? []).length
    const deleted = !!e.d
    return (
        <Pressable
            onPress={onOpen}
            style={{
                flexDirection: 'row',
                paddingVertical: 8,
                paddingHorizontal: 12,
                marginVertical: 2,
                borderLeftWidth: 2,
                borderLeftColor: deleted ? RED : 'rgba(148,155,164,0.9)',
                backgroundColor: deleted ? 'rgba(242,63,67,0.08)' : 'rgba(148,155,164,0.08)',
            }}
        >
            <Image source={{ uri: avatarUrl(a) }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} />
            <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Text variant="text-md/semibold" color="header-primary">
                        {name}
                    </Text>
                    <Text variant="text-xs/medium" color="text-muted" style={{ marginLeft: 6 }}>
                        {when(sentAt(id))}
                    </Text>
                </View>
                {!deleted &&
                    (e.e ?? []).map((h, i) => (
                        <Text key={i} variant="text-md/normal" color="text-muted" style={{ opacity: 0.75 }}>
                            {h.t || ' '}
                            <Text variant="text-xs/medium" color="text-muted">
                                {`  ${editedWord()} ${when(h.at)}`}
                            </Text>
                        </Text>
                    ))}
                <Text variant="text-md/normal" color={deleted ? undefined : 'text-normal'} style={deleted ? { color: RED } : undefined}>
                    {current || (files ? '' : ' ')}
                    {!deleted && now?.editedTimestamp ? (
                        <Text variant="text-xs/medium" color="text-muted">
                            {`  ${editedWord()}`}
                        </Text>
                    ) : null}
                </Text>
                {files ? (
                    <Text variant="text-sm/medium" color="text-muted">
                        {`${files} attachment${files > 1 ? 's' : ''}`}
                    </Text>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <Text variant="text-xs/medium" color="text-muted" style={{ flex: 1 }}>
                        {[deleted ? `Deleted ${when(e.d!)}` : `Edited ${e.e?.length ?? 0} time(s)`, e.h ? "Hidden in chat" : "", where(e)].filter(Boolean).join(', ')}
                    </Text>
                    <Button text="Delete log" variant="destructive" size="sm" onPress={onDelete} />
                </View>
            </View>
        </Pressable>
    )
}

// ── 필터 (디스코드 검색처럼 여러 개를 겹쳐 고른다: 같은 줄 안은 "또는", 줄끼리는 "그리고") ──────────
interface Filters {
    kinds: string[]
    places: string[]
    channels: string[]
    users: string[]
}
const EMPTY: Filters = { kinds: [], places: [], channels: [], users: [] }
const DM = 'dm'

interface Item {
    v: string
    label: string
    n: number
    img?: string
}

function Chip({ item, on, onPress }: { item: Item; on: boolean; onPress(): void; key?: string }) {
    const { Text } = Design as any
    return (
        <Pressable
            onPress={onPress}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: 32,
                paddingLeft: item.img ? 4 : 12,
                paddingRight: 10,
                borderRadius: 16,
                marginRight: 6,
                borderWidth: 1,
                borderColor: on ? '#5865f2' : 'rgba(148,155,164,0.28)',
                backgroundColor: on ? 'rgba(88,101,242,0.24)' : 'transparent',
            }}
        >
            {item.img ? <Image source={{ uri: item.img }} style={{ width: 22, height: 22, borderRadius: 11, marginRight: 6 }} /> : null}
            <Text variant="text-sm/medium" color="text-normal" numberOfLines={1} style={{ maxWidth: 150 }}>
                {item.label}
            </Text>
            <Text variant="text-xs/semibold" color="text-muted" style={{ marginLeft: 6 }}>
                {item.n}
            </Text>
        </Pressable>
    )
}

function ChipRow({ title, items, selected, onToggle }: { title: string; items: Item[]; selected: string[]; onToggle(v: string): void }) {
    const { Text } = Design as any
    if (!items.length) return null
    return (
        <View style={{ marginTop: 10 }}>
            <Text variant="text-xs/bold" color="text-muted" style={{ marginBottom: 6, letterSpacing: 0.4 }}>
                {title.toUpperCase()}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row' }}>
                    {items.map(item => (
                        <Chip key={item.v} item={item} on={selected.includes(item.v)} onPress={() => onToggle(item.v)} />
                    ))}
                </View>
            </ScrollView>
        </View>
    )
}

/** 로그 하나의 분류 (서버/DM, 채널, 보낸 사람) */
function facets(id: string, e: Entry) {
    const S: any = Stores
    const ch = (() => {
        try {
            return S.ChannelStore?.getChannel?.(e.c)
        } catch {
            return undefined
        }
    })()
    const guild = e.g ?? ch?.guild_id ?? undefined
    const a = authorOf(id, e)
    return { author: a, place: guild ? String(guild) : DM, channel: String(e.c), user: a?.id ? String(a.id) : '', userName: a?.globalName ?? a?.global_name ?? a?.username ?? '', channelName: ch?.name ? `#${ch.name}` : ch ? 'DM' : String(e.c) }
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

export function LogsView({ onBack }: { onBack(): void }) {
    const { Text, Button } = Design as any
    const [shown, setShown] = useState(PAGE)
    const [, force] = useState(0)
    let nav: any
    try {
        nav = (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
    const [f, setF] = useState<Filters>(EMPTY)
    const [showFilters, setShowFilters] = useState(false)
    const all = Object.entries(logs())
        .filter(([, e]) => e.d || e.e?.length)
        .sort((a, b) => (b[1].d ?? b[1].at) - (a[1].d ?? a[1].at))
        .map(([id, e]) => ({ id, e, k: facets(id, e) }))
    // 고를 수 있는 값 (지금 로그에 있는 것만, 많은 순)
    const S: any = Stores
    const count = (pick: (x: (typeof all)[number]) => string) => {
        const m = new Map<string, number>()
        for (const x of all) {
            const v = pick(x)
            if (v) m.set(v, (m.get(v) ?? 0) + 1)
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    const places = count(x => x.k.place).map(([v, n]): Item => {
        const g = v === DM ? undefined : S.GuildStore?.getGuild?.(v)
        return { v, n, label: v === DM ? 'DMs' : g?.name ?? 'Server', img: g?.icon ? `https://cdn.discordapp.com/icons/${v}/${g.icon}.png?size=64` : undefined }
    })
    const channels = count(x => (f.places.length && !f.places.includes(x.k.place) ? '' : x.k.channel)).map(([v, n]): Item => ({ v, n, label: all.find(x => x.k.channel === v)?.k.channelName ?? v }))
    const users = count(x => x.k.user)
        .slice(0, 40)
        .map(([v, n]): Item => {
            const k = all.find(x => x.k.user === v)?.k
            return { v, n, label: k?.userName || 'Unknown', img: k?.author ? avatarUrl(k.author) : undefined }
        })
    const kinds: Item[] = [
        { v: 'deleted', label: 'Deleted', n: all.filter(x => x.e.d).length },
        { v: 'edited', label: 'Edited', n: all.filter(x => !x.e.d).length },
    ]
    const entries = all
        .filter(x => !f.kinds.length || f.kinds.includes(x.e.d ? 'deleted' : 'edited'))
        .filter(x => !f.places.length || f.places.includes(x.k.place))
        .filter(x => !f.channels.length || f.channels.includes(x.k.channel))
        .filter(x => !f.users.length || f.users.includes(x.k.user))
        .map(x => [x.id, x.e] as [string, Entry])
    const active = f.kinds.length + f.places.length + f.channels.length + f.users.length
    const open = (id: string, e: Entry) => {
        closeSettings(nav)
        setTimeout(() => {
            try {
                toMessage?.(e.c, id)
            } catch {}
        }, 350)
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12, paddingBottom: 48 }}>
            <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row' }}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                        <Button text="Back" variant="secondary" size="sm" onPress={onBack} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Button text={`${showFilters ? 'Hide filters' : 'Filters'}${active ? ` (${active})` : ''}`} variant={active ? 'primary' : 'secondary'} size="sm" onPress={() => setShowFilters(v => !v)} />
                    </View>
                </View>
                {showFilters ? (
                    <View style={{ marginTop: 10, padding: 12, paddingTop: 2, borderRadius: 12, backgroundColor: 'rgba(148,155,164,0.08)' }}>
                        <ChipRow title="Type" items={kinds} selected={f.kinds} onToggle={v => setF({ ...f, kinds: toggle(f.kinds, v) })} />
                        <ChipRow title="Server or DMs" items={places} selected={f.places} onToggle={v => setF({ ...f, places: toggle(f.places, v), channels: [] })} />
                        <ChipRow title="Channel" items={channels} selected={f.channels} onToggle={v => setF({ ...f, channels: toggle(f.channels, v) })} />
                        <ChipRow title="User" items={users} selected={f.users} onToggle={v => setF({ ...f, users: toggle(f.users, v) })} />
                        {active ? (
                            <Pressable onPress={() => setF(EMPTY)} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                                <Text variant="text-sm/semibold" style={{ color: '#00a8fc' }}>
                                    Clear filters
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}
                <Text variant="text-xs/medium" color="text-muted" style={{ marginTop: 10 }}>
                    {all.length ? `${entries.length} of ${all.length} log(s), tap a message to go to it` : 'No logs yet.'}
                </Text>
            </View>
            {entries.slice(0, shown).map(([id, e]) => (
                <Row
                    key={id}
                    id={id}
                    e={e}
                    onOpen={() => open(id, e)}
                    onDelete={() => {
                        removeOne(id)
                        force(n => n + 1)
                    }}
                />
            ))}
            {entries.length > shown ? (
                <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
                    <Button text={`Show more (${entries.length - shown} left)`} variant="secondary" size="md" onPress={() => setShown(n => n + PAGE)} />
                </View>
            ) : null}
        </ScrollView>
    )
}
