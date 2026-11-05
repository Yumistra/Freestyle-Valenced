import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, TextInput as RNTextInput, View } from 'react-native'
import { removeOne } from './logger'
import { logs, seen, type Entry } from './store'

/**
 * 로그 보기: 채팅 메시지와 같은 모양(아바타, 이름, 시간, 내용)으로 보여 주고,
 * 누르면 설정을 닫고 그 메시지가 있는 곳으로 간다 (디스코드 transitionToMessage).
 */

const PAGE = 40

// ── 테마 색 (지금 디스코드 테마의 색 토큰을 읽는다. 라이트, 다크, 다른 테마 모두 맞게) ──────────
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

/** 색에 투명도를 덧씌운다 (#rgb, #rrggbb(aa), rgb(a)) */
function alpha(color: string, a: number) {
    let r = 0,
        g = 0,
        b = 0
    const h = /^#([0-9a-f]{3,8})$/i.exec(color)
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color)
    if (h) {
        let x = h[1]
        if (x.length <= 4) x = x.split('').map(c => c + c).join('')
        r = parseInt(x.slice(0, 2), 16)
        g = parseInt(x.slice(2, 4), 16)
        b = parseInt(x.slice(4, 6), 16)
    } else if (m) {
        r = +m[1]
        g = +m[2]
        b = +m[3]
    } else return color
    return `rgba(${r},${g},${b},${a})`
}

function palette() {
    const brand = tokenColor(['BACKGROUND_BRAND', 'BRAND_500', 'TEXT_BRAND'], '#5865f2')
    const danger = tokenColor(['TEXT_FEEDBACK_CRITICAL', 'TEXT_DANGER', 'STATUS_DANGER'], '#f23f43')
    const muted = tokenColor(['TEXT_MUTED'], '#949ba4')
    return {
        brand,
        brandSoft: alpha(brand, 0.22),
        danger,
        dangerSoft: alpha(danger, 0.1),
        text: tokenColor(['TEXT_DEFAULT', 'TEXT_NORMAL'], '#dbdee1'),
        header: tokenColor(['TEXT_STRONG', 'HEADER_PRIMARY', 'TEXT_DEFAULT'], '#f2f3f5'),
        muted,
        mutedSoft: alpha(muted, 0.1),
        border: alpha(muted, 0.3),
        input: tokenColor(['INPUT_BACKGROUND_DEFAULT', 'INPUT_BACKGROUND', 'BACKGROUND_TERTIARY', 'BACKGROUND_BASE_LOWEST'], alpha(muted, 0.14)),
        surface: tokenColor(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_FLOATING', 'BACKGROUND_SECONDARY'], alpha(muted, 0.1)),
        link: tokenColor(['TEXT_LINK'], '#00a8fc'),
        onBrand: tokenColor(['WHITE', 'TEXT_ON_BRAND'], '#ffffff'),
    }
}

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

/** <:이름:id> 같은 커스텀 이모지를 :이름: 으로 */
const emojis = (t: string) => t.replace(/<a?:(\w+):\d+>/g, ':$1:')

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
    const P = palette()
    // 삭제는 두 번 눌러야 한다 (첫 번째는 확인, 3초 안에 다시 누르면 지운다)
    const [armed, setArmed] = useState(false)
    const timer = useRef<any>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const del = () => {
        if (armed) {
            clearTimeout(timer.current)
            setArmed(false)
            onDelete()
            return
        }
        setArmed(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setArmed(false), 3000)
    }
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
                borderLeftColor: deleted ? P.danger : P.muted,
                backgroundColor: deleted ? P.dangerSoft : P.mutedSoft,
            }}
        >
            <Image source={{ uri: avatarUrl(a) }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} />
            <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Text variant="text-md/semibold" style={{ color: P.header }}>
                        {name}
                    </Text>
                    <Text variant="text-xs/medium" style={{ color: P.muted, marginLeft: 6 }}>
                        {when(sentAt(id))}
                    </Text>
                </View>
                {!deleted &&
                    (e.e ?? []).map((h, i) => (
                        <Text key={i} variant="text-md/normal" style={{ color: P.muted }}>
                            {emojis(h.t) || ' '}
                            <Text variant="text-xs/medium" style={{ color: P.muted }}>
                                {`  ${editedWord()} ${when(h.at)}`}
                            </Text>
                        </Text>
                    ))}
                <Text variant="text-md/normal" style={{ color: deleted ? P.danger : P.text }}>
                    {emojis(current) || (files ? '' : ' ')}
                    {!deleted && now?.editedTimestamp ? (
                        <Text variant="text-xs/medium" style={{ color: P.muted }}>
                            {`  ${editedWord()}`}
                        </Text>
                    ) : null}
                </Text>
                {files ? (
                    <Text variant="text-sm/medium" style={{ color: P.muted }}>
                        {`${files} attachment${files > 1 ? 's' : ''}`}
                    </Text>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <Text variant="text-xs/medium" style={{ color: P.muted, flex: 1 }}>
                        {[deleted ? `Deleted ${when(e.d!)}` : `Edited ${e.e?.length ?? 0} time(s)`, e.h ? "Hidden in chat" : "", where(e)].filter(Boolean).join(', ')}
                    </Text>
                    <Button text={armed ? 'Tap again to delete' : 'Delete log'} variant={armed ? 'destructive' : 'secondary'} size="sm" onPress={del} />
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
    const P = palette()
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
                borderColor: on ? P.brand : P.border,
                backgroundColor: on ? P.brandSoft : 'transparent',
            }}
        >
            {item.img ? <Image source={{ uri: item.img }} style={{ width: 22, height: 22, borderRadius: 11, marginRight: 6 }} /> : null}
            <Text variant="text-sm/medium" numberOfLines={1} style={{ color: P.text, maxWidth: 150 }}>
                {item.label}
            </Text>
            <Text variant="text-xs/semibold" style={{ color: P.muted, marginLeft: 6 }}>
                {item.n}
            </Text>
        </Pressable>
    )
}

function ChipRow({ title, items, selected, onToggle }: { title: string; items: Item[]; selected: string[]; onToggle(v: string): void }) {
    const { Text } = Design as any
    const P = palette()
    if (!items.length) return null
    return (
        <View style={{ marginTop: 10 }}>
            <Text variant="text-xs/bold" style={{ color: P.muted, marginBottom: 6, letterSpacing: 0.4 }}>
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

// ── 검색 (디스코드 검색처럼: 낱말, from:, in:, has:, is:) ──────────
const TOKEN = /^(from|in|has|is):(.*)$/i
function parseQuery(q: string) {
    const words: string[] = [],
        from: string[] = [],
        inn: string[] = [],
        has: string[] = [],
        is: string[] = []
    for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
        const m = TOKEN.exec(raw)
        if (!m || !m[2]) {
            words.push(raw.toLowerCase())
            continue
        }
        const v = m[2].toLowerCase()
        const k = m[1].toLowerCase()
        ;(k === 'from' ? from : k === 'in' ? inn : k === 'has' ? has : is).push(v)
    }
    return { words, from, inn, has, is }
}
const SEARCH_HINTS: Array<[string, string]> = [
    ['from:', 'from: user'],
    ['in:', 'in: channel'],
    ['has:', 'has: link, file'],
    ['is:', 'is: deleted, edited'],
]

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

export const LOGS_ROUTE = 'yumistra.message-logger.logs'

/** 설정 안의 새 화면 (위쪽 화살표, 뒤로 가기는 디스코드가 알아서) */
export function LogsScreen({ navigation }: { navigation?: any }) {
    useLayoutEffect(() => {
        try {
            navigation?.setOptions?.({ title: 'Logs' })
        } catch {}
    }, [])
    return <LogsView />
}

export function LogsView() {
    const { Text, Button } = Design as any
    const P = palette()
    const SearchIcon: any = lookupGeneratedIconComponent('MagnifyingGlassIcon' as any)
    const XIcon: any = lookupGeneratedIconComponent('XSmallIcon' as any) ?? lookupGeneratedIconComponent('CloseSmallIcon' as any)
    const input = useRef<any>(null)
    const [shown, setShown] = useState(PAGE)
    const [, force] = useState(0)
    let nav: any
    try {
        nav = (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
    const [f, setF] = useState<Filters>(EMPTY)
    const [showFilters, setShowFilters] = useState(false)
    const [q, setQ] = useState('')
    const [focused, setFocused] = useState(false)
    const anim = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const all = Object.entries(logs())
        .filter(([, e]) => e.d || e.e?.length)
        .sort((a, b) => (b[1].d ?? b[1].at) - (a[1].d ?? a[1].at))
        .map(([id, e]) => ({ id, e, k: facets(id, e) }))
    const guildName = (v: string) => {
        try {
            return v === DM ? 'DMs' : String((Stores as any).GuildStore?.getGuild?.(v)?.name ?? '')
        } catch {
            return ''
        }
    }
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
    const users = count(x => ((f.places.length && !f.places.includes(x.k.place)) || (f.channels.length && !f.channels.includes(x.k.channel)) ? '' : x.k.user))
        .slice(0, 40)
        .map(([v, n]): Item => {
            const k = all.find(x => x.k.user === v)?.k
            return { v, n, label: k?.userName || 'Unknown', img: k?.author ? avatarUrl(k.author) : undefined }
        })
    const kinds: Item[] = [
        { v: 'deleted', label: 'Deleted', n: all.filter(x => x.e.d).length },
        { v: 'edited', label: 'Edited', n: all.filter(x => !x.e.d).length },
    ]
    const pq = parseQuery(q)
    const textOf = (x: (typeof all)[number]) => {
        const now = (S.MessageStore?.getMessage?.(x.e.c, x.id) as any)?.content
        return [x.e.m?.content ?? now ?? '', ...(x.e.e ?? []).map(h => h.t)].join('\n').toLowerCase()
    }
    const searched = (x: (typeof all)[number]) => {
        const text = textOf(x)
        const name = `${x.k.userName} ${x.k.author?.username ?? ''}`.toLowerCase()
        const place = `${x.k.channelName} ${guildName(x.k.place)}`.toLowerCase()
        if (!pq.words.every(w => text.includes(w) || name.includes(w))) return false
        if (pq.from.length && !pq.from.some(v => name.includes(v))) return false
        if (pq.inn.length && !pq.inn.some(v => place.includes(v.replace(/^#/, '')))) return false
        for (const h of pq.has) {
            if (/^link/.test(h) && !/https?:\/\//.test(text)) return false
            if (/^(file|attachment|image|video)/.test(h) && !(x.e.m?.attachments ?? []).length) return false
        }
        for (const v of pq.is) {
            if (/^del/.test(v) && !x.e.d) return false
            if (/^edit/.test(v) && x.e.d) return false
        }
        return true
    }
    // 입력 중인 from: / in: 뒤에 맞는 사람, 채널 (누르면 필터로 들어간다)
    const lastTok = /(\S*)$/.exec(q)?.[1] ?? ''
    const tm = TOKEN.exec(lastTok)
    const kind = tm?.[1].toLowerCase()
    const sv = (tm?.[2] ?? '').toLowerCase().replace(/^#/, '')
    const suggestions: Array<{ key: string; label: string; sub?: string; img?: string; pick(): void }> = []
    const dropLast = () => setQ(q.slice(0, q.length - lastTok.length).replace(/\s+$/, '') + (q.length - lastTok.length > 0 ? ' ' : ''))
    if (kind === 'from')
        for (const u of users.filter(u => u.label.toLowerCase().includes(sv)).slice(0, 8))
            suggestions.push({ key: 'u' + u.v, label: u.label, sub: `${u.n} log(s)`, img: u.img, pick: () => (setF({ ...f, users: f.users.includes(u.v) ? f.users : [...f.users, u.v] }), (anim(), dropLast(), input.current?.focus?.())) })
    if (kind === 'in')
        for (const c of channels.filter(c => `${c.label} ${guildName(all.find(x => x.k.channel === c.v)?.k.place ?? '')}`.toLowerCase().includes(sv)).slice(0, 8)) {
            const g = guildName(all.find(x => x.k.channel === c.v)?.k.place ?? '')
            suggestions.push({ key: 'c' + c.v, label: c.label, sub: [g, `${c.n} log(s)`].filter(Boolean).join(', '), pick: () => (setF({ ...f, channels: f.channels.includes(c.v) ? f.channels : [...f.channels, c.v] }), (anim(), dropLast(), input.current?.focus?.())) })
        }
    if (kind === 'is')
        for (const k of kinds.filter(k => k.label.toLowerCase().includes(sv)))
            suggestions.push({ key: 'k' + k.v, label: k.label, sub: `${k.n} log(s)`, pick: () => (setF({ ...f, kinds: f.kinds.includes(k.v) ? f.kinds : [...f.kinds, k.v] }), (anim(), dropLast(), input.current?.focus?.())) })
    if (kind === 'has')
        for (const [v, l] of [
            ['link', 'Link'],
            ['file', 'File'],
        ].filter(([v]) => v.includes(sv)))
            suggestions.push({ key: 'h' + v, label: l, pick: () => setQ(q.slice(0, q.length - lastTok.length) + `has:${v} `) })
    const entries = all
        .filter(searched)
        .filter(x => !f.kinds.length || f.kinds.includes(x.e.d ? 'deleted' : 'edited'))
        .filter(x => !f.places.length || f.places.includes(x.k.place))
        .filter(x => !f.channels.length || f.channels.includes(x.k.channel))
        .filter(x => !f.users.length || f.users.includes(x.k.user))
        .map(x => [x.id, x.e] as [string, Entry])
    const active = f.kinds.length + f.places.length + f.channels.length + f.users.length
    // 필터 패널에서 고른 것도 검색창 안에 알약으로 보인다 (누르면 빠진다)
    const pills: Array<{ key: string; label: string; img?: string; drop(): void }> = [
        ...f.kinds.map(v => ({ key: 'k' + v, label: `is: ${kinds.find(k => k.v === v)?.label ?? v}`, drop: () => setF(o => ({ ...o, kinds: o.kinds.filter(x => x !== v) })) })),
        ...f.places.map(v => ({ key: 'p' + v, label: v === DM ? 'in: DMs' : `server: ${guildName(v) || 'Server'}`, img: places.find(x => x.v === v)?.img, drop: () => setF(o => ({ ...o, places: o.places.filter(x => x !== v), channels: [] })) })),
        ...f.channels.map(v => ({ key: 'c' + v, label: `in: ${all.find(x => x.k.channel === v)?.k.channelName ?? v}`, drop: () => setF(o => ({ ...o, channels: o.channels.filter(x => x !== v) })) })),
        ...f.users.map(v => {
            const k = all.find(x => x.k.user === v)?.k
            return { key: 'u' + v, label: `from: ${k?.userName || 'Unknown'}`, img: k?.author ? avatarUrl(k.author) : undefined, drop: () => setF(o => ({ ...o, users: o.users.filter(x => x !== v) })) }
        }),
    ]
    const showHints = focused && !kind
    const addPrefix = (prefix: string) => {
        anim()
        const base = q.slice(0, q.length - lastTok.length)
        setQ(base + prefix)
        setTimeout(() => input.current?.focus?.(), 0)
    }
    const open = (id: string, e: Entry) => {
        closeSettings(nav)
        setTimeout(() => {
            try {
                toMessage?.(e.c, id)
            } catch {}
        }, 350)
    }
    return (
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 12, paddingBottom: 48 }}>
            <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Pressable
                        onPress={() => input.current?.focus?.()}
                        style={{ flex: 1, minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingVertical: 4, paddingLeft: 10, paddingRight: 6, borderRadius: 12, backgroundColor: P.input, borderWidth: 1, borderColor: focused ? P.brand : 'transparent' }}
                    >
                        {SearchIcon ? <SearchIcon size="sm" color={P.muted} style={{ marginRight: 6 }} /> : null}
                        {pills.map(pl => (
                            <Pressable
                                key={pl.key}
                                onPress={() => (anim(), pl.drop())}
                                style={{ flexDirection: 'row', alignItems: 'center', height: 26, marginVertical: 3, marginRight: 6, paddingLeft: pl.img ? 3 : 10, paddingRight: 6, borderRadius: 13, backgroundColor: P.brandSoft }}
                            >
                                {pl.img ? <Image source={{ uri: pl.img }} style={{ width: 20, height: 20, borderRadius: 10, marginRight: 5 }} /> : null}
                                <Text variant="text-sm/medium" numberOfLines={1} style={{ color: P.text, maxWidth: 160 }}>
                                    {pl.label}
                                </Text>
                                {XIcon ? <XIcon size="xs" color={P.muted} style={{ marginLeft: 3 }} /> : <Text variant="text-sm/bold" style={{ color: P.muted, marginLeft: 4 }}>×</Text>}
                            </Pressable>
                        ))}
                        <RNTextInput
                            ref={input}
                            value={q}
                            placeholder={pills.length ? '' : 'Search logs'}
                            placeholderTextColor={P.muted}
                            onChangeText={(v: string) => setQ(v)}
                            onFocus={() => (anim(), setFocused(true))}
                            onBlur={() => (anim(), setFocused(false))}
                            onKeyPress={(ev: any) => {
                                // 빈 칸에서 지우기를 누르면 마지막 알약이 빠진다
                                if (ev?.nativeEvent?.key === 'Backspace' && !q && pills.length) {
                                    anim()
                                    pills[pills.length - 1].drop()
                                }
                            }}
                            autoCorrect={false}
                            autoCapitalize="none"
                            returnKeyType="search"
                            style={{ flexGrow: 1, minWidth: 90, paddingVertical: 6, fontSize: 16, color: P.text }}
                        />
                        {q || pills.length ? (
                            <Pressable onPress={() => (anim(), setQ(''), setF(EMPTY))} hitSlop={8} style={{ padding: 4 }}>
                                {XIcon ? <XIcon size="sm" color={P.muted} /> : <Text variant="text-md/bold" style={{ color: P.muted }}>×</Text>}
                            </Pressable>
                        ) : null}
                    </Pressable>
                    <Pressable
                        onPress={() => (anim(), setShowFilters(v => !v))}
                        hitSlop={8}
                        style={{ marginLeft: 8, width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: showFilters || active ? P.brandSoft : P.input }}
                    >
                        <TableRowAssetIcon name="FiltersHorizontalIcon" />
                        {active ? (
                            <View style={{ position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: P.brand, alignItems: 'center', justifyContent: 'center' }}>
                                <Text variant="text-xs/bold" style={{ color: P.onBrand }}>
                                    {String(active)}
                                </Text>
                            </View>
                        ) : null}
                    </Pressable>
                </View>
                {showHints ? (
                    <View style={{ marginTop: 8, borderRadius: 12, overflow: 'hidden', backgroundColor: P.surface }}>
                        {SEARCH_HINTS.map(([prefix, label]) => (
                            <Pressable key={prefix} onPress={() => addPrefix(prefix)} style={{ paddingVertical: 11, paddingHorizontal: 12 }}>
                                <Text variant="text-sm/medium" style={{ color: P.text }}>
                                    <Text variant="text-sm/semibold" style={{ color: P.text }}>
                                        {prefix}
                                    </Text>
                                    <Text variant="text-sm/medium" style={{ color: P.muted }}>
                                        {label.slice(prefix.length)}
                                    </Text>
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                ) : null}
                {suggestions.length ? (
                    <View style={{ marginTop: 8, borderRadius: 12, overflow: 'hidden', backgroundColor: P.surface }}>
                        {suggestions.map(sg => (
                            <Pressable key={sg.key} onPress={sg.pick} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12 }}>
                                {sg.img ? <Image source={{ uri: sg.img }} style={{ width: 28, height: 28, borderRadius: 14, marginRight: 10 }} /> : null}
                                <View style={{ flex: 1 }}>
                                    <Text variant="text-sm/semibold" numberOfLines={1} style={{ color: P.text }}>
                                        {sg.label}
                                    </Text>
                                    {sg.sub ? (
                                        <Text variant="text-xs/medium" numberOfLines={1} style={{ color: P.muted }}>
                                            {sg.sub}
                                        </Text>
                                    ) : null}
                                </View>
                            </Pressable>
                        ))}
                    </View>
                ) : null}
                {showFilters ? (
                    <View style={{ marginTop: 10, padding: 12, paddingTop: 2, borderRadius: 12, backgroundColor: P.surface }}>
                        <ChipRow title="Type" items={kinds} selected={f.kinds} onToggle={v => (anim(), setF({ ...f, kinds: toggle(f.kinds, v) }))} />
                        <ChipRow title="Server or DMs" items={places} selected={f.places} onToggle={v => (anim(), setF({ ...f, places: toggle(f.places, v), channels: [] }))} />
                        <ChipRow title="Channel" items={channels} selected={f.channels} onToggle={v => (anim(), setF({ ...f, channels: toggle(f.channels, v) }))} />
                        <ChipRow title="User" items={users} selected={f.users} onToggle={v => (anim(), setF({ ...f, users: toggle(f.users, v) }))} />
                        {active ? (
                            <Pressable onPress={() => (anim(), setF(EMPTY))} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                                <Text variant="text-sm/semibold" style={{ color: P.link }}>
                                    Clear filters
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}
                <Text variant="text-xs/medium" style={{ color: P.muted, marginTop: 10 }}>
                    {all.length ? `${entries.length} of ${all.length} log(s), tap a message to go to it` : 'No logs yet.'}
                    {all.length && !entries.length && (q.trim() || active) ? ', nothing matches' : ''}
                </Text>
            </View>
            {entries.slice(0, shown).map(([id, e]) => (
                <Row
                    key={id}
                    id={id}
                    e={e}
                    onOpen={() => open(id, e)}
                    onDelete={() => {
                        anim()
                        removeOne(id)
                        force(n => n + 1)
                    }}
                />
            ))}
            {entries.length > shown ? (
                <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
                    <Button text={`Show more (${entries.length - shown} left)`} variant="secondary" size="md" onPress={() => (anim(), setShown(n => n + PAGE))} />
                </View>
            ) : null}
        </ScrollView>
    )
}
