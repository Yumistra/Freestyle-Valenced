import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { useState } from 'react'
import { Image, LayoutAnimation, Pressable, TextInput as RNTextInput, View } from 'react-native'
import { ChipRow, dayMs, DM, palette, toggle, type Item } from './logs'

/**
 * 로그 보기의 태그 필터 (메시지 탭의 필터처럼).
 * 묶음(Group)마다 기록 하나가 가진 태그들을 돌려주고, 고른 태그로 거른다.
 * 같은 묶음 안은 "또는", 묶음끼리는 "그리고". 숫자는 다른 묶음에서 고른 것을 적용한 뒤의 개수.
 */
export interface Tag {
    v: string
    label: string
    img?: string
}
export interface Group<T> {
    key: string
    title: string
    /** 검색칸 알약 앞에 붙는 말 (예: "emoji") */
    pill: string
    of(x: T): Tag[]
}
export type Selected = Record<string, string[]>

const S = () => Stores as any
const DAY = 86400_000

// ── 여러 탭이 같이 쓰는 태그 ─────────────────────────────────────────────
/** 언제: 오늘, 어제, 최근 7일, 최근 30일, 그보다 전 (겹친다: 오늘은 최근 7일에도 든다) */
export function whenTags(t: number): Tag[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = today.getTime()
    const out: Tag[] = []
    if (t >= start) out.push({ v: 'today', label: 'Today' })
    else if (t >= start - DAY) out.push({ v: 'yesterday', label: 'Yesterday' })
    if (t >= start - 6 * DAY) out.push({ v: '7d', label: 'Last 7 days' })
    if (t >= start - 29 * DAY) out.push({ v: '30d', label: 'Last 30 days' })
    else out.push({ v: 'older', label: 'Older' })
    // 시간대: 새벽, 아침, 오후, 저녁
    const h = new Date(t).getHours()
    out.push(h < 6 ? { v: 'night', label: 'Night (0-6)' } : h < 12 ? { v: 'morning', label: 'Morning (6-12)' } : h < 18 ? { v: 'afternoon', label: 'Afternoon (12-18)' } : { v: 'evening', label: 'Evening (18-24)' })
    return out
}

/** 서버 또는 DM */
export function placeTag(c: string, g?: string): Tag[] {
    let guild = g
    try {
        guild = guild ?? S().ChannelStore?.getChannel?.(c)?.guild_id ?? undefined
    } catch {}
    if (!guild) return [{ v: DM, label: 'DMs' }]
    let gs: any
    try {
        gs = S().GuildStore?.getGuild?.(guild)
    } catch {}
    return [{ v: String(guild), label: gs?.name ?? 'Server', img: gs?.icon ? `https://cdn.discordapp.com/icons/${guild}/${gs.icon}.png?size=64` : undefined }]
}

/** 채널 */
export function channelTag(c: string, fallback?: string): Tag[] {
    let ch: any
    try {
        ch = S().ChannelStore?.getChannel?.(c)
    } catch {}
    const label = ch?.name ? `#${ch.name}` : ch ? 'DM' : fallback ? `#${fallback}` : c
    return [{ v: String(c), label }]
}

/** 사람 (이름, 아바타) */
export function userTag(id: string | undefined, u: any): Tag[] {
    if (!id) return []
    const name = u?.globalName ?? u?.global_name ?? u?.username ?? 'Unknown'
    const img = u?.avatar ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.png?size=64` : undefined
    return [{ v: String(id), label: name, img }]
}

/** 친구, 차단, 봇 등 관계 */
export function relationTags(id: string | undefined, u: any): Tag[] {
    if (!id) return []
    const out: Tag[] = []
    try {
        const R = S().RelationshipStore
        if (R?.isFriend?.(id)) out.push({ v: 'friend', label: 'Friends' })
        else out.push({ v: 'notfriend', label: 'Not friends' })
        if (R?.isBlocked?.(id)) out.push({ v: 'blocked', label: 'Blocked' })
    } catch {}
    if (u?.bot) out.push({ v: 'bot', label: 'Bots' })
    try {
        if (String(S().UserStore?.getCurrentUser?.()?.id) === String(id)) out.push({ v: 'me', label: 'Me' })
    } catch {}
    return out
}

// ── 거르기 ──────────────────────────────────────────────────────────────
function has<T>(x: T, g: Group<T>, picked: string[]) {
    if (!picked?.length) return true
    const tags = g.of(x)
    return tags.some(t => picked.includes(t.v))
}

export function dateOk(t: number, from?: string, to?: string) {
    const a = dayMs(from)
    const b = dayMs(to, true)
    return (a === undefined || t >= a) && (b === undefined || t < b)
}

/** 고른 태그로 거른다 (skip 묶음은 빼고) */
export function applyTags<T>(items: T[], groups: Group<T>[], sel: Selected, skip?: string) {
    const on = groups.filter(g => g.key !== skip && sel[g.key]?.length)
    if (!on.length) return items
    return items.filter(x => on.every(g => has(x, g, sel[g.key])))
}

/** 묶음 하나의 고를 수 있는 태그와 개수 (다른 묶음에서 고른 것을 적용한 뒤, 많은 순. 고른 건 0개여도 남긴다) */
export function tagCounts<T>(items: T[], groups: Group<T>[], sel: Selected, key: string, limit = 60): Item[] {
    const g = groups.find(x => x.key === key)
    if (!g) return []
    const pool = applyTags(items, groups, sel, key)
    const m = new Map<string, Item>()
    for (const x of pool)
        for (const t of g.of(x)) {
            const it = m.get(t.v)
            if (it) it.n++
            else m.set(t.v, { v: t.v, label: t.label, img: t.img, n: 1 })
        }
    for (const v of sel[key] ?? []) if (!m.has(v)) m.set(v, { v, label: labelOf(items, g, v), n: 0 })
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, limit)
}

function labelOf<T>(items: T[], g: Group<T>, v: string) {
    for (const x of items) {
        const t = g.of(x).find(t => t.v === v)
        if (t) return t.label
    }
    return v
}

export const selectedCount = (sel: Selected) => Object.values(sel).reduce((n, l) => n + (l?.length ?? 0), 0)

// ── 화면 ────────────────────────────────────────────────────────────────
/** 검색칸: 고른 태그가 알약으로 들어가고 (누르면 빠진다), 오른쪽에 필터 버튼 (고른 수) */
export function TagSearchBox<T>({ value, onChange, placeholder, items, groups, sel, setSel, open, setOpen, dates }: { value: string; onChange(v: string): void; placeholder: string; items: T[]; groups: Group<T>[]; sel: Selected; setSel(s: Selected): void; open: boolean; setOpen(v: boolean): void; dates: number }) {
    const { Text } = Design as any
    const P = palette()
    const SearchIcon: any = lookupGeneratedIconComponent('MagnifyingGlassIcon' as any)
    const XIcon: any = lookupGeneratedIconComponent('XSmallIcon' as any) ?? lookupGeneratedIconComponent('CloseSmallIcon' as any)
    const [focused, setFocused] = useState(false)
    const anim = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const pills: Array<{ key: string; label: string; img?: string; drop(): void }> = []
    for (const g of groups)
        for (const v of sel[g.key] ?? []) {
            let tag: Tag | undefined
            for (const x of items) {
                tag = g.of(x).find(t => t.v === v)
                if (tag) break
            }
            pills.push({ key: g.key + v, label: `${g.pill}: ${tag?.label ?? v}`, img: tag?.img, drop: () => setSel({ ...sel, [g.key]: (sel[g.key] ?? []).filter(x => x !== v) }) })
        }
    const active = selectedCount(sel) + dates
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1, minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingVertical: 4, paddingLeft: 10, paddingRight: 6, borderRadius: 12, backgroundColor: P.input, borderWidth: 1, borderColor: focused ? P.brand : 'transparent' }}>
                {SearchIcon ? <SearchIcon size="sm" color={P.muted} style={{ marginRight: 6 }} /> : null}
                {pills.map(pl => (
                    <Pressable key={pl.key} onPress={() => (anim(), pl.drop())} style={{ flexDirection: 'row', alignItems: 'center', height: 26, marginVertical: 3, marginRight: 6, paddingLeft: pl.img ? 3 : 10, paddingRight: 6, borderRadius: 13, backgroundColor: P.brandSoft }}>
                        {pl.img ? <Image source={{ uri: pl.img }} style={{ width: 20, height: 20, borderRadius: 10, marginRight: 5 }} /> : null}
                        <Text variant="text-sm/medium" numberOfLines={1} style={{ color: P.text, maxWidth: 160 }}>
                            {pl.label}
                        </Text>
                        {XIcon ? <XIcon size="xs" color={P.muted} style={{ marginLeft: 3 }} /> : <Text variant="text-sm/bold" style={{ color: P.muted, marginLeft: 4 }}>×</Text>}
                    </Pressable>
                ))}
                <RNTextInput
                    value={value}
                    placeholder={pills.length ? '' : placeholder}
                    placeholderTextColor={P.muted}
                    onChangeText={onChange}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onKeyPress={(ev: any) => {
                        if (ev?.nativeEvent?.key === 'Backspace' && !value && pills.length) {
                            anim()
                            pills[pills.length - 1].drop()
                        }
                    }}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    style={{ flexGrow: 1, minWidth: 90, paddingVertical: 6, fontSize: 16, color: P.text }}
                />
                {value || pills.length ? (
                    <Pressable onPress={() => (anim(), onChange(''), setSel({}))} hitSlop={8} style={{ padding: 4 }}>
                        {XIcon ? <XIcon size="sm" color={P.muted} /> : <Text variant="text-md/bold" style={{ color: P.muted }}>×</Text>}
                    </Pressable>
                ) : null}
            </View>
            <Pressable accessibilityLabel="filters" onPress={() => (anim(), setOpen(!open))} hitSlop={8} style={{ marginLeft: 8, width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: open || active ? P.brandSoft : P.input }}>
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
    )
}

/** 필터 판: 묶음마다 태그 줄, 그 아래 날짜 */
export function TagPanel<T>({ items, groups, sel, setSel, from, to, setDates }: { items: T[]; groups: Group<T>[]; sel: Selected; setSel(s: Selected): void; from?: string; to?: string; setDates(from?: string, to?: string): void }) {
    const { Text } = Design as any
    const P = palette()
    const anim = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    const active = selectedCount(sel) + (from ? 1 : 0) + (to ? 1 : 0)
    return (
        <View style={{ marginTop: 10, padding: 12, paddingTop: 2, borderRadius: 12, backgroundColor: P.surface }}>
            {groups.map(g => (
                <ChipRow key={g.key} title={g.title} items={tagCounts(items, groups, sel, g.key)} selected={sel[g.key] ?? []} onToggle={v => (anim(), setSel({ ...sel, [g.key]: toggle(sel[g.key] ?? [], v) }))} />
            ))}
            <Text variant="text-xs/bold" style={{ color: P.muted, marginTop: 10, marginBottom: 6, letterSpacing: 0.4 }}>
                DATE
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['from', 'to'] as const).map(k => {
                    const v = k === 'from' ? from : to
                    return (
                        <RNTextInput
                            key={k}
                            value={v ?? ''}
                            onChangeText={(x: string) => (k === 'from' ? setDates(x, to) : setDates(from, x))}
                            placeholder={k === 'from' ? 'From YYYY-MM-DD' : 'To YYYY-MM-DD'}
                            placeholderTextColor={P.muted}
                            keyboardType="numbers-and-punctuation"
                            style={{ flex: 1, height: 38, borderRadius: 10, paddingHorizontal: 10, backgroundColor: P.input, color: P.text, borderWidth: 1, borderColor: v && dayMs(v) === undefined ? P.danger : 'transparent' }}
                        />
                    )
                })}
            </View>
            {active ? (
                <Pressable onPress={() => (anim(), setSel({}), setDates(undefined, undefined))} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
                    <Text variant="text-sm/semibold" style={{ color: P.link }}>
                        Clear filters
                    </Text>
                </Pressable>
            ) : null}
        </View>
    )
}
