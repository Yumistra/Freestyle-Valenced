import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { useEffect, useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, TextInput as RNTextInput, View } from 'react-native'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { removeEvent } from './events'
import { clearKind } from './logger'
import { avatarUrl, goToMessage, palette, where } from './logs'
import { events, logs, onChange, save, seen, type Event } from './store'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { when } from './time'

/** 로그 보기의 다른 탭: 반응, 채널, 프로필, 통계 */
export type Tab = 'messages' | 'reactions' | 'channels' | 'profiles' | 'stats'
export const TABS: [Tab, string][] = [
    ['messages', 'Messages'],
    ['reactions', 'Reactions'],
    ['channels', 'Channels'],
    ['profiles', 'Profiles'],
    ['stats', 'Stats'],
]

const S = () => Stores as any
const PAGE = 50

function userOf(id: string, fallback?: any) {
    try {
        return S().UserStore?.getUser?.(id) ?? fallback
    } catch {
        return fallback
    }
}
/**
 * 디스코드가 모르는 사용자 (서버 멤버 목록에 안 불러온 사람)는 프로필을 한 번 받아 온다.
 * 한 사람당 한 번, 1초 간격으로만. 받아 오면 다시 그린다.
 */
const asked = new Set<string>()
const queue: string[] = []
let pumping = false
function fetchUser(id: string) {
    if (!id || asked.has(id)) return
    asked.add(id)
    queue.push(id)
    if (pumping) return
    pumping = true
    const next = () => {
        const u = queue.shift()
        if (!u) {
            pumping = false
            return
        }
        try {
            const A = (lookupModule(withProps('fetchProfile') as any) as any)?.[0]
            const r = A?.fetchProfile?.(u)
            Promise.resolve(r)
                .catch(() => {})
                .then(() => save())
        } catch {}
        setTimeout(next, 1000)
    }
    next()
}

/** 사용자: 디스코드가 아는 모습, 없으면 기록할 때 남긴 모습. 둘 다 없으면 받아 온다 */
function userOrSnap(id: string, snap?: any) {
    const u = userOf(id)
    if (u) return u
    if (!snap?.username) fetchUser(id)
    return snap ?? { id }
}
const nameOf = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? 'Unknown'
const emojiText = (em: { id?: string; name: string }) => (em.id ? `:${em.name}:` : em.name)
const emojiUrl = (em: { id?: string; animated?: boolean }) => (em.id ? `https://cdn.discordapp.com/emojis/${em.id}.webp?size=48${em.animated ? '&animated=true' : ''}` : undefined)

function useNav() {
    try {
        return (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
}

function useLogsVersion() {
    const [, force] = useState(0)
    useEffect(() => onChange(() => force(n => n + 1)) as any, [])
}

/** 두 번 눌러 지우기 */
export function DeleteButton({ onDelete, text = 'Delete', armedText = 'Tap again to delete', disabled }: { onDelete: () => void; text?: string; armedText?: string; disabled?: boolean }) {
    const { Button } = Design as any
    const [armed, setArmed] = useState(false)
    useEffect(() => {
        if (!armed) return
        const t = setTimeout(() => setArmed(false), 3000)
        return () => clearTimeout(t)
    }, [armed])
    return <Button text={armed ? armedText : text} variant={armed ? 'destructive' : 'secondary'} size="sm" disabled={disabled} onPress={() => (armed ? (setArmed(false), onDelete()) : setArmed(true))} />
}

function Card({ children, onPress, label }: { children: any; onPress?: () => void; label?: string; key?: string }) {
    const P = palette()
    return (
        <Pressable accessibilityLabel={label} onPress={onPress} style={{ marginHorizontal: 12, marginVertical: 4, padding: 12, borderRadius: 12, backgroundColor: P.surface, gap: 6 }}>
            {children}
        </Pressable>
    )
}

function Empty({ text }: { text: string }) {
    const { Text } = Design as any
    const P = palette()
    return (
        <Text variant="text-sm/medium" style={{ color: P.muted, textAlign: 'center', padding: 24 }}>
            {text}
        </Text>
    )
}

function Head({ u, title, sub }: { u: any; title: string; sub: string }) {
    const { Text } = Design as any
    const P = palette()
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Image source={{ uri: avatarUrl(u) }} style={{ width: 32, height: 32, borderRadius: 16 }} />
            <View style={{ flex: 1 }}>
                <Text variant="text-md/semibold" style={{ color: P.header }} numberOfLines={2}>
                    {title}
                </Text>
                <Text variant="text-xs/medium" style={{ color: P.muted }} numberOfLines={1}>
                    {sub}
                </Text>
            </View>
        </View>
    )
}

/** 찾기 칸 (메시지 탭과 같은 모양) */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
    const { Text } = Design as any
    const P = palette()
    const SearchIcon: any = lookupGeneratedIconComponent('MagnifyingGlassIcon' as any)
    const XIcon: any = lookupGeneratedIconComponent('XSmallIcon' as any) ?? lookupGeneratedIconComponent('CloseSmallIcon' as any)
    const [focused, setFocused] = useState(false)
    return (
        <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 6, borderRadius: 12, backgroundColor: P.input, borderWidth: 1, borderColor: focused ? P.brand : 'transparent' }}>
            {SearchIcon ? <SearchIcon size="sm" color={P.muted} style={{ marginRight: 6 }} /> : null}
            <RNTextInput
                value={value}
                placeholder={placeholder}
                placeholderTextColor={P.muted}
                onChangeText={onChange}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                style={{ flex: 1, paddingVertical: 8, fontSize: 16, color: P.text }}
            />
            {value ? (
                <Pressable onPress={() => onChange('')} hitSlop={8} style={{ padding: 4 }}>
                    {XIcon ? <XIcon size="sm" color={P.muted} /> : <Text variant="text-md/bold" style={{ color: P.muted }}>×</Text>}
                </Pressable>
            ) : null}
        </View>
    )
}

/** 찾는 말이 모두 들어 있는지 (띄어쓰기로 나눈 말마다, 대소문자 무시) */
export function matches(q: string, ...texts: Array<string | undefined | null | false>) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return true
    const hay = texts.filter(Boolean).join('\n').toLowerCase()
    return words.every(w => hay.includes(w))
}

/**
 * 탭 하나의 목록: 위에 찾기 칸, 개수, "모두 지우기" (두 번 눌러야 지운다), 아래에 카드들.
 * text(e) 는 찾을 때 볼 글자들 (이름, 이모지, 채널, 내용 등)
 */
function List({ items, render, empty, kind, noun, search, text }: { items: Event[]; render: (e: Event) => any; empty: string; kind: 'r' | 'c' | 'p'; noun: string; search: string; text: (e: Event) => Array<string | undefined | null | false> }) {
    const { Button, Text } = Design as any
    const P = palette()
    const [shown, setShown] = useState(PAGE)
    const [q, setQ] = useState('')
    if (!items.length) return <Empty text={empty} />
    const found = q.trim() ? items.filter(e => matches(q, ...text(e))) : items
    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 8, paddingBottom: 48 }}>
            <View style={{ paddingHorizontal: 12, paddingBottom: 4, gap: 8 }}>
                <SearchBox value={q} onChange={v => (setQ(v), setShown(PAGE))} placeholder={search} />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text variant="text-xs/medium" style={{ color: P.muted, flex: 1 }}>
                        {q.trim() ? `${found.length} of ${items.length} ${noun}${found.length ? '' : ', nothing matches'}` : `${items.length} ${noun}`}
                    </Text>
                    <DeleteButton text="Delete all" armedText={`Delete all ${items.length}?`} onDelete={() => (LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut), clearKind(kind))} />
                </View>
            </View>
            {found.slice(0, shown).map(render)}
            {found.length > shown ? (
                <View style={{ padding: 12 }}>
                    <Button text={`Show more (${found.length - shown} left)`} variant="secondary" size="md" onPress={() => setShown(n => n + PAGE)} />
                </View>
            ) : null}
        </ScrollView>
    )
}

function del(id: string) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    removeEvent(id)
}

// ── 반응 ────────────────────────────────────────────────────────────────
function Reactions() {
    const { Text } = Design as any
    const nav = useNav()
    const items = events()
        .filter(e => e.k === 'r')
        .reverse()
    const open = (c: string, m: string, g?: string) => goToMessage(nav, c, m, g)
    return (
        <List
            items={items}
            kind="r"
            noun="removed reaction(s)"
            search="Search by name, emoji or channel"
            text={e => {
                if (e.k !== 'r') return []
                const u = e.u ? userOf(e.u, e.un) : undefined
                return [e.u ? nameOf(u) : 'everyone', u?.username, e.un?.username, e.un?.global_name, e.em.name, emojiText(e.em), where(e)]
            }}
            empty="No removed reactions yet."
            render={e => {
                if (e.k !== 'r') return null
                const u = e.u ? userOrSnap(e.u, e.un) : undefined
                const img = emojiUrl(e.em)
                return (
                    <Card key={e.id} label={`reaction ${e.id}`} onPress={() => open(e.c, e.m, e.g)}>
                        <Head u={u} title={`${e.u ? nameOf(u) : 'Everyone'} removed ${emojiText(e.em)}`} sub={[where(e), when(e.at)].filter(Boolean).join(', ')} />
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            {img ? <Image source={{ uri: img }} style={{ width: 28, height: 28 }} /> : <Text variant="text-lg/normal">{e.em.name}</Text>}
                            <DeleteButton onDelete={() => del(e.id)} />
                        </View>
                    </Card>
                )
            }}
        />
    )
}

// ── 채널 ────────────────────────────────────────────────────────────────
const THREAD_TYPES = new Set([10, 11, 12])

function ChannelCard({ e }: { e: Extract<Event, { k: 'c' }>; key?: string }) {
    const { Text } = Design as any
    const P = palette()
    const [open, setOpen] = useState(false)
    const guild = e.g ? S().GuildStore?.getGuild?.(e.g)?.name : ''
    return (
        <Card label={`channel ${e.id}`} onPress={() => (LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut), setOpen(v => !v))}>
            <Text variant="text-md/semibold" style={{ color: P.header }}>
                {`${THREAD_TYPES.has(e.type) ? 'Thread' : 'Channel'} #${e.name || e.c} deleted`}
            </Text>
            <Text variant="text-xs/medium" style={{ color: P.muted }}>
                {[guild, when(e.at), `${e.msgs.length} message(s) kept`].filter(Boolean).join(', ')}
            </Text>
            {open
                ? e.msgs.map((m: any) => (
                      <Text key={m.id} variant="text-sm/normal" style={{ color: P.text }}>
                          <Text variant="text-sm/semibold" style={{ color: P.header }}>
                              {`${nameOf(m.author)}: `}
                          </Text>
                          {m.content || (m.attachments ? `[${m.attachments} attachment(s)]` : '')}
                      </Text>
                  ))
                : null}
            <View style={{ alignItems: 'flex-end' }}>
                <DeleteButton onDelete={() => del(e.id)} />
            </View>
        </Card>
    )
}

function Channels() {
    const items = events()
        .filter(e => e.k === 'c')
        .reverse()
    return (
        <List
            items={items}
            kind="c"
            noun="deleted channel(s)"
            search="Search by channel, server or message"
            text={e => {
                if (e.k !== 'c') return []
                const guild = e.g ? S().GuildStore?.getGuild?.(e.g)?.name : ''
                return [e.name, e.c, guild, ...e.msgs.map((m: any) => `${nameOf(m.author)} ${m.content ?? ''}`)]
            }}
            empty="No deleted channels or threads yet."
            render={e => (e.k === 'c' ? <ChannelCard key={e.id} e={e} /> : null)}
        />
    )
}

// ── 프로필 ──────────────────────────────────────────────────────────────
const FIELD: Record<string, string> = { username: 'username', name: 'display name', avatar: 'avatar', status: 'status' }

function Profiles() {
    const { Text } = Design as any
    const P = palette()
    const items = events()
        .filter(e => e.k === 'p')
        .reverse()
    return (
        <List
            items={items}
            kind="p"
            noun="profile change(s)"
            search="Search by name or what changed"
            text={e => {
                if (e.k !== 'p') return []
                const u = userOf(e.u)
                return [nameOf(u), u?.username, FIELD[e.field] ?? e.field, e.field === 'avatar' ? '' : e.from, e.field === 'avatar' ? '' : e.to]
            }}
            empty="No profile changes yet. Friends and people you DM are watched."
            render={e => {
                if (e.k !== 'p') return null
                const u = userOrSnap(e.u)
                const pic = (hash: string) => (hash ? `https://cdn.discordapp.com/avatars/${e.u}/${hash}.png?size=96` : avatarUrl({ id: e.u }))
                return (
                    <Card key={e.id} label={`profile ${e.id}`}>
                        <Head u={u} title={`${nameOf(u)} changed ${FIELD[e.field] ?? e.field}`} sub={when(e.at)} />
                        {e.field === 'avatar' ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                <Image source={{ uri: pic(e.from) }} style={{ width: 56, height: 56, borderRadius: 28 }} />
                                <Text variant="text-md/bold" style={{ color: P.muted }}>
                                    →
                                </Text>
                                <Image source={{ uri: pic(e.to) }} style={{ width: 56, height: 56, borderRadius: 28 }} />
                            </View>
                        ) : (
                            <Text variant="text-md/normal" style={{ color: P.text }}>
                                <Text variant="text-md/normal" style={{ color: P.danger, textDecorationLine: 'line-through' }}>
                                    {e.from || '(none)'}
                                </Text>
                                {'  →  '}
                                <Text variant="text-md/normal" style={{ color: P.add }}>
                                    {e.to || '(none)'}
                                </Text>
                            </Text>
                        )}
                        <View style={{ alignItems: 'flex-end' }}>
                            <DeleteButton onDelete={() => del(e.id)} />
                        </View>
                    </Card>
                )
            }}
        />
    )
}

// ── 통계 ────────────────────────────────────────────────────────────────
export function stats() {
    const deleters = new Map<string, number>()
    const editors = new Map<string, number>()
    const names = new Map<string, any>()
    let deleted = 0
    let edited = 0
    const days: number[] = new Array(7).fill(0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (const [id, e] of Object.entries(logs())) {
        const a = e.m?.author ?? S().MessageStore?.getMessage?.(e.c, id)?.author ?? (seen() as any)[id]?.m?.author
        const uid: string | undefined = a?.id ? String(a.id) : undefined
        if (uid) names.set(uid, userOf(uid, a))
        if (e.d) {
            deleted++
            if (uid) deleters.set(uid, (deleters.get(uid) ?? 0) + 1)
        } else if (e.e?.length) {
            edited++
            if (uid) editors.set(uid, (editors.get(uid) ?? 0) + e.e.length)
        }
        const t = e.d ?? e.at
        const ago = Math.floor((today.getTime() + 86400000 - t) / 86400000)
        if (ago >= 0 && ago < 7) days[6 - ago]++
    }
    const top = (m: Map<string, number>) =>
        [...m.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([id, n]) => ({ id, n, u: names.get(id) ?? userOf(id, { id }) }))
    const ev = events()
    return { deleted, edited, reactions: ev.filter(e => e.k === 'r').length, channels: ev.filter(e => e.k === 'c').length, profiles: ev.filter(e => e.k === 'p').length, deleters: top(deleters), editors: top(editors), days }
}

function Stats() {
    const { Text } = Design as any
    const P = palette()
    const s = stats()
    const max = Math.max(1, ...s.days)
    const labels = s.days.map((_, i) => {
        const d = new Date(Date.now() - (6 - i) * 86400000)
        return `${d.getMonth() + 1}/${d.getDate()}`
    })
    const Ranking = ({ title, list, unit }: { title: string; list: ReturnType<typeof stats>['deleters']; unit: string }) => (
        <Card>
            <Text variant="text-sm/bold" style={{ color: P.muted }}>
                {title}
            </Text>
            {list.length ? (
                list.map((x, i) => (
                    <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <Text variant="text-md/bold" style={{ color: P.muted, width: 18 }}>
                            {String(i + 1)}
                        </Text>
                        <Image source={{ uri: avatarUrl(x.u) }} style={{ width: 28, height: 28, borderRadius: 14 }} />
                        <Text variant="text-md/semibold" style={{ color: P.header, flex: 1 }} numberOfLines={1}>
                            {nameOf(x.u)}
                        </Text>
                        <Text variant="text-sm/semibold" style={{ color: P.text }}>
                            {`${x.n} ${unit}`}
                        </Text>
                    </View>
                ))
            ) : (
                <Text variant="text-sm/medium" style={{ color: P.muted }}>
                    Nothing yet
                </Text>
            )}
        </Card>
    )
    return (
        <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingBottom: 48 }}>
            <Card>
                <Text variant="text-sm/bold" style={{ color: P.muted }}>
                    TOTAL
                </Text>
                <Text variant="text-md/semibold" style={{ color: P.text }}>
                    {`${s.deleted} deleted, ${s.edited} edited, ${s.reactions} reactions removed, ${s.channels} channels deleted, ${s.profiles} profile changes`}
                </Text>
            </Card>
            <Card>
                <Text variant="text-sm/bold" style={{ color: P.muted }}>
                    LAST 7 DAYS
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 110, gap: 6 }}>
                    {s.days.map((n, i) => (
                        <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: 110 }}>
                            <Text variant="text-xs/semibold" style={{ color: P.text }}>
                                {String(n)}
                            </Text>
                            <View style={{ width: '70%', height: Math.max(2, Math.round((n / max) * 76)), borderRadius: 4, backgroundColor: P.brand }} />
                            <Text variant="text-xs/medium" style={{ color: P.muted }}>
                                {labels[i]}
                            </Text>
                        </View>
                    ))}
                </View>
            </Card>
            <Ranking title="MOST DELETED" list={s.deleters} unit="deleted" />
            <Ranking title="MOST EDITED" list={s.editors} unit="edits" />
        </ScrollView>
    )
}

export function MoreTab({ tab }: { tab: Tab }) {
    useLogsVersion()
    switch (tab) {
        case 'reactions':
            return <Reactions />
        case 'channels':
            return <Channels />
        case 'profiles':
            return <Profiles />
        default:
            return <Stats />
    }
}
