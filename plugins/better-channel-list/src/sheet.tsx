import { ActionSheetActionCreators, AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Dimensions, FlatList, Image, Pressable, ScrollView, Text as RNText, View } from 'react-native'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { EMOJI_COLORS } from './colors'
import { EmojiTile } from './redesign'
import { settings, update } from './store'

/**
 * 채널을 꾹 누르면 나오는 창(ChannelLongPressActionSheet) 맨 위에 "Emoji" 줄을 넣는다.
 * 누르면 이모지 고르기 창(플러그인 창)이 열리고, 고른 이모지가 그 채널의 아이콘이 된다 (나만 보인다).
 * 바꾼 채널이면 "Reset emoji" 줄도 넣는다.
 */

const SHEET = 'modules/channel/native/ChannelLongPressActionSheet.tsx'

const firstFn = (m: any, name: string) => (typeof m?.[name] === 'function' ? m[name] : typeof m?.default === 'function' ? m.default : undefined)

function bindOne(cleanup: (...f: any[]) => void, path: string, set: (m: any) => void) {
    cleanup(
        getModuleWithImportedPath(path, (m: any) => {
            if (m) set(m)
            else cleanup(waitForModuleWithImportedPath(path, (x: any) => set(x)) as any)
        }) as any,
    )
}

/** 고른 이모지 → 저장할 글 (유니코드는 그대로, 서버 이모지는 <:이름:ID>) */
function emojiValue(e: any): string | undefined {
    if (!e) return
    if (e.id && /^\d+$/.test(String(e.id))) return `<${e.animated ? 'a' : ''}:${e.name ?? 'emoji'}:${e.id}>`
    return e.surrogates ?? e.optionallyDiverseSequence ?? undefined
}

let seq = 0
function toast(text: string) {
    try {
        ;(ToastActionCreators as any).open(`bcl-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const UNICODE = Object.keys(EMOJI_COLORS)

/** 이모지 고르기 창의 한 칸 */
type Cell = { key: string; value: string; id?: string; text?: string }
/** 목록의 한 줄: 묶음 제목이거나 이모지 한 줄 */
type Row = { key: string; header?: string; cells?: Cell[] }
/** 아래 바의 버튼 하나 (서버 아이콘 또는 기본 이모지 종류) */
type Tab = { key: string; label: string; icon?: string; emoji?: string; row: number }

const SHEET_KEY = 'bcl-emoji-sheet'
const COLS = 8
const HEADER_H = 34

/** 기본 이모지 종류 (유니코드 순서에서 시작하는 자리) */
const CATEGORIES: Array<[string, string, string]> = [
    ['People', '😀', '😀'],
    ['Nature', '🐵', '🐶'],
    ['Food', '🍇', '🍔'],
    ['Travel', '🌍', '🚗'],
    ['Activities', '🎃', '⚽'],
    ['Objects', '👓', '💡'],
    ['Symbols', '🏧', '❤️'],
    ['Flags', '🏁', '🏳️'],
]

/** 서버와 이모지 목록은 창을 열 때마다 새로 만들지 않고 한 번 만들어 둔다 */
let unicodeSections: Array<[string, string, Cell[]]> | undefined
function unicode() {
    if (unicodeSections) return unicodeSections
    const keys = Object.keys(EMOJI_COLORS)
    const starts = CATEGORIES.map(([, first]) => keys.indexOf(first))
    unicodeSections = CATEGORIES.map(([name, , icon], i) => {
        const from = Math.max(0, starts[i])
        const to = i + 1 < starts.length && starts[i + 1] > from ? starts[i + 1] : keys.length
        return [name, icon, keys.slice(from, to).map(u => ({ key: u, value: u }))] as [string, string, Cell[]]
    }).filter(s => s[2].length)
    return unicodeSections
}

function guildSections(firstGuild?: string): Array<{ id: string; name: string; icon?: string; cells: Cell[] }> {
    const out: Array<{ id: string; name: string; icon?: string; cells: Cell[] }> = []
    try {
        const S: any = Stores
        let ids: string[] = S.SortedGuildStore?.getFlattenedGuildIds?.() ?? Object.keys(S.GuildStore?.getGuilds?.() ?? {})
        if (firstGuild) ids = [firstGuild, ...ids.filter(i => i !== firstGuild)]
        for (const id of ids) {
            const g = S.GuildStore?.getGuild?.(id)
            const cells: Cell[] = []
            for (const e of S.EmojiStore?.getGuildEmoji?.(id) ?? []) if (e?.id && e.available !== false) cells.push({ key: e.id, id: e.id, text: String(e.name), value: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` })
            if (!cells.length) continue
            out.push({ id, name: g?.name ?? 'Server', icon: g?.icon ? `https://cdn.discordapp.com/icons/${id}/${g.icon}.png?size=64` : undefined, cells })
        }
    } catch {}
    return out
}

function chunk(cells: Cell[], prefix: string): Row[] {
    const rows: Row[] = []
    for (let i = 0; i < cells.length; i += COLS) rows.push({ key: `${prefix}-${i}`, cells: cells.slice(i, i + COLS) })
    return rows
}

/**
 * 이모지 한 줄. 칸마다 누르는 부품을 두면 무거워서, 줄 전체를 한 번에 받고 누른 x 위치로 칸을 고른다.
 * 기본 이모지는 글자 하나씩, 서버 이모지는 그림 하나씩만 그린다.
 */
const EmojiRow = memo(function EmojiRow({ row, size, onPick }: { row: Row; size: number; onPick: (v: string) => void }) {
    const { Text } = Design as any
    if (row.header)
        return (
            <View style={{ height: HEADER_H, justifyContent: 'flex-end', paddingBottom: 6, paddingHorizontal: 4 }}>
                <Text variant="text-xs/semibold" color="text-muted" lineClamp={1}>
                    {row.header.toUpperCase()}
                </Text>
            </View>
        )
    const cells = row.cells!
    const img = Math.round(size * 0.66)
    return (
        <Pressable
            onPress={(e: any) => {
                const i = Math.floor((e?.nativeEvent?.locationX ?? 0) / size)
                const c = cells[i]
                if (c) onPick(c.value)
            }}
            style={{ flexDirection: 'row', height: size }}
        >
            {cells.map(c =>
                c.id ? (
                    <View key={c.key} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
                        <Image source={{ uri: `https://cdn.discordapp.com/emojis/${c.id}.png?size=48` }} style={{ width: img, height: img }} resizeMode="contain" fadeDuration={0} />
                    </View>
                ) : (
                    <RNText key={c.key} allowFontScaling={false} style={{ width: size, height: size, fontSize: size * 0.56, lineHeight: size, textAlign: 'center' }}>
                        {c.value}
                    </RNText>
                ),
            )}
        </Pressable>
    )
})

/** 아래 바 (디스코드 이모지 창처럼 서버 목록). 한 눈에 다 보이게 여러 줄로 놓고, 누르면 그 서버 이모지만 보여 준다 */
const TabBar = memo(function TabBar({ tabs, active, onJump }: { tabs: Tab[]; active: number; onJump: (i: number) => void }) {
    const { Text } = Design as any
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: 'rgba(128,128,128,0.25)' }}>
            {tabs.map((t, i) => (
                <Pressable key={t.key} accessibilityLabel={t.label} onPress={() => onJump(i)} style={{ width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: i === active ? 'rgba(128,128,128,0.3)' : 'transparent' }}>
                    {t.icon ? (
                        <Image source={{ uri: t.icon }} style={{ width: 26, height: 26, borderRadius: 13 }} fadeDuration={0} />
                    ) : t.emoji ? (
                        <RNText allowFontScaling={false} style={{ fontSize: 20 }}>
                            {t.emoji}
                        </RNText>
                    ) : (
                        <Text variant="text-xs/bold">{t.label.slice(0, 2)}</Text>
                    )}
                </Pressable>
            ))}
        </View>
    )
})

/**
 * 이모지 고르기 창 (아래에서 올라오는 창, 뒤는 어둡게 깔린다).
 * 디스코드 이모지 창처럼 서버별로 묶고, 아래 바에서 서버나 이모지 종류를 누르면 그곳으로 간다.
 * 글칸에는 폰 이모지 자판으로 넣거나 붙여 넣을 수 있고, 영어로 치면 서버 이모지를 찾는다.
 */
function EmojiSheet({ channel }: { channel: any }) {
    const { ActionSheet, TextInput, Button, Text } = Design as any
    const [text, setText] = useState('')
    const listRef = useRef<any>(null)
    const width = Dimensions.get('window').width
    const size = Math.floor((width - 24) / COLS)

    const guilds = useMemo(() => guildSections(channel?.guild_id), [])
    // 줄 목록과 아래 바 버튼, 각 줄의 위치 (줄 높이가 정해져 있어 바로 그 자리로 갈 수 있다)
    // 아래 바 버튼 하나에 그 서버(또는 기본 이모지 종류)의 줄들. 고른 것 하나만 목록에 그린다
    const { tabs, pages } = useMemo(() => {
        const tabs: Tab[] = []
        const pages: Row[][] = []
        for (const g of guilds) {
            tabs.push({ key: g.id, label: g.name, icon: g.icon, row: 0 })
            pages.push([{ key: `h-${g.id}`, header: g.name }, ...chunk(g.cells, g.id)])
        }
        for (const [name, icon, cells] of unicode()) {
            tabs.push({ key: `u-${name}`, label: name, emoji: icon, row: 0 })
            pages.push([{ key: `h-${name}`, header: name }, ...chunk(cells, name)])
        }
        return { tabs, pages }
    }, [guilds, size])
    // 처음에는 이 채널 서버 (서버 이모지가 없으면 첫 칸)
    const [tab, setTab] = useState(0)
    const rows = pages[tab] ?? []

    const q = text.trim().toLowerCase()
    const typed = !!q && !/^[a-z0-9_ ]+$/i.test(q)
    const searchRows = useMemo(() => {
        if (!q || typed) return undefined
        const hits: Cell[] = []
        for (const g of guilds) for (const c of g.cells) if (c.text!.toLowerCase().includes(q)) hits.push(c)
        return chunk(hits.slice(0, 400), 's')
    }, [q, typed, guilds])

    const pick = useCallback((v: string) => {
        setIcon(channel.id, v)
        try {
            ;(ActionSheetActionCreators as any).hideActionSheet(SHEET_KEY)
        } catch {}
    }, [])

    const data = searchRows ?? rows
    const layout = useCallback(
        (_: any, index: number) => {
            if (searchRows) return { length: size, offset: size * index, index }
            // 맨 위 한 줄만 제목
            return index === 0 ? { length: HEADER_H, offset: 0, index } : { length: size, offset: HEADER_H + size * (index - 1), index }
        },
        [searchRows, size],
    )
    const jump = useCallback((i: number) => {
        setText('')
        setTab(i)
        try {
            listRef.current?.scrollToOffset?.({ offset: 0, animated: false })
        } catch {}
    }, [])
    const renderItem = useCallback(({ item }: { item: Row }) => <EmojiRow row={item} size={size} onPick={pick} />, [size, pick])
    const keyOf = useCallback((r: Row) => r.key, [])

    const BottomSheet = (Design as any).BottomSheet ?? findProp('BottomSheet', 'BottomSheetTitleHeader')
    const List = findProp('BottomSheetFlatList') ?? FlatList
    const header = (
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 10 }}>
            <Text variant="heading-lg/bold">{`Emoji for #${channel?.name ?? ''}`}</Text>
            <TextInput value={text} placeholder="Type an emoji, or search server emojis" onChange={setText} isClearable />
            {typed ? <Button text={`Use ${text.trim()}`} variant="primary" size="md" onPress={() => pick(text.trim())} /> : null}
            {settings().icons?.[channel?.id] ? <Button text="Reset to default" variant="secondary" size="md" onPress={() => (setIcon(channel.id, null), (ActionSheetActionCreators as any).hideActionSheet(SHEET_KEY))} /> : null}
        </View>
    )
    const bar = searchRows ? null : <TabBar tabs={tabs} active={tab} onJump={jump} />
    const list = (
        <List
            ref={listRef}
            data={data}
            keyExtractor={keyOf}
            getItemLayout={layout}
            renderItem={renderItem}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 }}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={12}
            maxToRenderPerBatch={6}
            updateCellsBatchingPeriod={40}
            windowSize={3}
            removeClippedSubviews
            ListEmptyComponent={
                <Text variant="text-sm/medium" color="text-muted" style={{ padding: 16, textAlign: 'center' }}>
                    No server emojis found
                </Text>
            }
        />
    )
    const body = (
        <View style={{ flex: 1, height: BottomSheet ? undefined : Math.round(Dimensions.get('window').height * 0.7) }}>
            {list}
            {bar}
        </View>
    )
    if (BottomSheet)
        return (
            <BottomSheet startExpanded header={header}>
                {body}
            </BottomSheet>
        )
    return ActionSheet ? (
        <ActionSheet>
            {header}
            {body}
        </ActionSheet>
    ) : (
        <View>
            {header}
            {body}
        </View>
    )
}

/** 이름으로 내보낸 것 하나 찾기 */
function findProp(name: string, ...with_: string[]): any {
    try {
        return (lookupModule(withProps(name, ...with_) as any) as any)?.[0]?.[name]
    } catch {}
}

function openSheet(channel: any) {
    try {
        ;(ActionSheetActionCreators as any).openLazy(Promise.resolve({ default: EmojiSheet }), SHEET_KEY, { channel })
        return true
    } catch {
        return false
    }
}

let redrawList = () => {}

function setIcon(channelId: string, value: string | null) {
    const icons = { ...(settings().icons ?? {}) }
    if (value) icons[channelId] = value
    else delete icons[channelId]
    update({ icons })
    redrawList()
}

/** 창 닫기 (onClose 가 없을 때) */
function hideSheet() {
    try {
        ;(ActionSheetActionCreators as any).hideActionSheet()
    } catch {}
}

const nameOf = (t: any): string => t?.name || t?.displayName || t?.type?.name || t?.type?.displayName || t?.render?.name || ''
/** 줄 묶음(ActionSheetRow.Group) 인지 */
function isGroup(n: any) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false
    const G = (Design as any).ActionSheetRow?.Group
    return (G && n.type === G) || /ActionSheetRowGroup$/.test(nameOf(n.type))
}
const flat = (c: any): any[] => (Array.isArray(c) ? c.flatMap(flat) : [c])

/** 창 안의 ActionSheet(showGradient 를 받는 것) 맨 앞에 우리 줄 묶음을 넣는다 */
function addRows(node: any, channel: any, close: () => void, depth = 0): any {
    if (!node || typeof node !== 'object' || depth > 10) return node
    if (Array.isArray(node)) {
        let changed = false
        const out = node.map(n => {
            const r = addRows(n, channel, close, depth + 1)
            if (r !== n) changed = true
            return r
        })
        return changed ? out : node
    }
    const props = node.props
    if (!props) return node
    if ((props.showGradient !== undefined && 'header' in props) || flat(props.children).some(isGroup)) {
        const { ActionSheetRow } = Design as any
        if (!ActionSheetRow?.Group) return node
        const Reaction: any = lookupGeneratedIconComponent('ReactionIcon' as any) ?? lookupGeneratedIconComponent('EmojiSmileIcon' as any)
        const Trash: any = lookupGeneratedIconComponent('RefreshIcon' as any) ?? lookupGeneratedIconComponent('TrashIcon' as any)
        const changed = !!settings().icons?.[channel.id]
        const pick = () => {
            close()
            try {
                ;(ActionSheetActionCreators as any).hideActionSheet(`ChannelLongPress-${channel.id}`)
            } catch {}
            // 창이 닫힌 뒤에 이모지 창을 연다
            setTimeout(() => {
                if (!openSheet(channel)) toast('Could not open the emoji picker')
            }, 350)
        }
        const group = (
            <ActionSheetRow.Group key="bcl-emoji" hasIcons>
                <ActionSheetRow
                    label="Emoji"
                    subLabel="Only you see this"
                    icon={<EmojiTile channel={channel} size="tiny" />}
                    trailing={Reaction ? <ActionSheetRow.Icon IconComponent={Reaction} /> : undefined}
                    onPress={pick}
                />
                {changed ? (
                    <ActionSheetRow
                        label="Reset emoji"
                        icon={Trash ? <ActionSheetRow.Icon IconComponent={Trash} /> : undefined}
                        onPress={() => {
                            setIcon(channel.id, null)
                            close()
                        }}
                    />
                ) : null}
            </ActionSheetRow.Group>
        )
        const kids = Array.isArray(props.children) ? props.children : [props.children]
        if (kids.some((k: any) => k?.key === 'bcl-emoji')) return node
        return { ...node, props: { ...props, children: [group, ...kids] } }
    }
    if (props.children == null || typeof props.children !== 'object') return node
    const kids = addRows(props.children, channel, close, depth + 1)
    return kids === props.children ? node : { ...node, props: { ...props, children: kids } }
}

const wrapped = new WeakMap<any, any>()
function wrapInner(type: any, channel: any, close: () => void) {
    const MEMO = Symbol.for('react.memo')
    const render = type?.$$typeof === MEMO ? type.type : type
    if (typeof render !== 'function') return
    let w = wrapped.get(type)
    if (!w) {
        w = function BetterChannelSheet(props: any) {
            const out = render(props)
            if (!settings().redesign) return out
            try {
                const ch = props?.channel ?? channel
                return addRows(out, ch, typeof props?.onClose === 'function' ? () => props.onClose() : close)
            } catch {
                return out
            }
        }
        wrapped.set(type, w)
    }
    return w
}

export function patchSheet(cleanup: (...f: any[]) => void, redraw: () => void) {
    redrawList = redraw
    const patched = new WeakSet<any>()
    const render = (args: any[], orig: (...a: any[]) => any, self: unknown) => {
        const out = orig.apply(self, args)
        const p = args[0]
        const channel = p?.channel ?? (p?.channelId ? (Stores as any).ChannelStore?.getChannel?.(p.channelId) : undefined)
        if (!channel || !settings().redesign) return out
        const close = () => {
            try {
                if (typeof p?.onClose === 'function') p.onClose()
                else hideSheet()
            } catch {}
        }
        try {
            const direct = addRows(out, channel, close)
            if (direct !== out) return direct
            // 바깥 컴포넌트가 안쪽 컴포넌트 하나만 돌려주면 그 안쪽을 감싼다
            if (out?.type && typeof out.type !== 'string') {
                const w = wrapInner(out.type, channel, close)
                if (w) return { ...out, type: w }
            }
        } catch {}
        return out
    }
    /** 창 모듈의 default 를 고친다. 고칠 수 없는 모듈이면 고친 사본을 돌려준다 */
    const patchMod = (mod: any) => {
        if (!mod || typeof mod.default !== 'function' || patched.has(mod)) return mod
        try {
            cleanup(instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                return render(args, orig, this)
            }))
            patched.add(mod)
            return mod
        } catch {
            const Original = mod.default
            return { ...mod, default: (props: any) => render([props], Original, undefined) }
        }
    }
    // 디스코드는 창을 ActionSheetActionCreators.openLazy(모듈 Promise, 이름, props) 로 연다
    try {
        cleanup(
            instead(ActionSheetActionCreators as any, 'openLazy', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                try {
                    const [sheet, key] = args
                    if (typeof key === 'string' && /ChannelLongPress/i.test(key) && typeof sheet?.then === 'function') args[0] = sheet.then((m: any) => patchMod(m))
                } catch {}
                return orig.apply(this, args)
            }),
        )
    } catch {}
    bindOne(cleanup, SHEET, (mod: any) => void patchMod(mod))
}
