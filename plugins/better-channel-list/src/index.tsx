import { Tokens } from '@valenced/discord/common/tokens'
import { Dispatcher } from '@valenced/discord/common/flux'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { cloneElement, Component, forwardRef, useEffect, useState } from 'react'
import { LayoutAnimation, Pressable, ScrollView, Text, View } from 'react-native'
import { activePosts, channelEmoji, ChannelTypes, EmojiTile, extraHeight, redesignTree, SIZES, status as rstatus } from './redesign'
import { patchSheet } from './sheet'
import { bind, DEFAULTS, settings, update, useSettings } from './store'

/**
 * Better Channel List (BetterDiscord BetterChannelList 를 옮긴 것).
 * 서버 채널 목록의 채널 이름 아래에 마지막 메시지를 보여 준다.
 *  - 서버를 열면 게이트웨이에 채널마다 마지막 메시지를 달라고 한다 (requestLastMessages, 디스코드도 쓰는 것)
 *  - 받은 메시지(MESSAGE_PREVIEWS_LOADED)를 메시지 저장소에 넣는다 (원래 플러그인과 같은 방법)
 *  - 채널 줄(guild_sidebar/native/ChannelItem)의 subtitle 칸에 그린다
 * 원래 플러그인의 "새 모바일 디자인"은 폰 디스코드에 이미 있어서 뺐다.
 */

const S = () => Stores as any

/** 설정 화면 Status */
const status = { variant: '', names: 'Not found yet', split: 'Not found yet', hook: 'Not found yet', rows: 0, withMessage: 0, asked: 0, received: 0, lastError: '' }
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

// ── 마지막 메시지 받아 오기 ────────────────────────────────────────────────
function socket(): any {
    return S().GatewayConnectionStore?.getSocket?.() ?? find('getSocket')?.getSocket?.()
}

function selectable(guildId: string): string[] {
    try {
        const ids = S().GuildChannelStore?.getSelectableChannelIds?.(guildId) ?? find('getSelectableChannelIds')?.getSelectableChannelIds?.(guildId)
        return Array.isArray(ids) ? ids : []
    } catch {
        return []
    }
}

const asked = new Map<string, number>()
function request(guildId: string | null | undefined, channelIds?: string[], force = false) {
    if (!guildId || !settings().lastMessage) return
    // 같은 서버를 짧은 사이에 여러 번 묻지 않는다
    const last = asked.get(guildId) ?? 0
    if (!force && !channelIds && Date.now() - last < 60_000) return
    const ids = channelIds ?? selectable(guildId)
    if (!ids.length) return
    try {
        const sock = socket()
        if (typeof sock?.requestLastMessages !== 'function') status.lastError = 'No gateway socket'
        sock?.requestLastMessages?.(guildId, ids)
        status.asked++
        if (!channelIds) asked.set(guildId, Date.now())
    } catch (e: any) {
        status.lastError = String(e?.message ?? e)
    }
}

/** 채널 목록을 다시 그리게 한다 (마지막 메시지가 바뀌었을 때) */
let redrawTimer: any
function redraw() {
    clearTimeout(redrawTimer)
    redrawTimer = setTimeout(() => {
        try {
            const store = S().ChannelListStore ?? find('getGuild', 'getGuildWithoutChangingCommunityRows')
            store?.emitChange?.()
        } catch {}
    }, 150)
}

function onPreviews({ messages }: any) {
    if (!Array.isArray(messages)) return
    status.received += messages.length
    for (const m of messages) {
        try {
            if (!m?.channel_id || S().MessageStore?.getMessage?.(m.channel_id, m.id)) continue
            Dispatcher.dispatch({ type: 'LOAD_MESSAGES_SUCCESS', channelId: m.channel_id, hasMoreAfter: false, hasMoreBefore: true, isAfter: true, isBefore: false, isStale: true, limit: 1, messages: [m] } as any)
        } catch {}
    }
    redraw()
}

// ── 미리보기 글 만들기 ─────────────────────────────────────────────────────
function nameOf(userId: string, guildId?: string, fallback?: any) {
    try {
        const nick = guildId ? S().GuildMemberStore?.getNick?.(guildId, userId) : undefined
        const u = S().UserStore?.getUser?.(userId) ?? fallback
        return nick ?? u?.globalName ?? u?.global_name ?? u?.username ?? 'Someone'
    } catch {
        return 'Someone'
    }
}

/** 그라데이션 역할 색 (primary, secondary, tertiary) */
function roleColors(userId: string, guildId?: string): string[] | undefined {
    try {
        const cs = guildId ? S().GuildMemberStore?.getMember?.(guildId, userId)?.colorStrings : undefined
        const list = [cs?.primaryColor, cs?.secondaryColor, cs?.tertiaryColor].filter((x: any) => typeof x === 'string' && x) as string[]
        return list.length > 1 ? list : undefined
    } catch {}
}

function colorOf(userId: string, guildId?: string): string | undefined {
    try {
        const mem = guildId ? S().GuildMemberStore?.getMember?.(guildId, userId) : undefined
        return mem?.colorString || mem?.colorStrings?.primaryColor || undefined
    } catch {}
}

function plain(m: any, guildId?: string): string {
    let text = String(m?.content ?? '')
    text = text
        .replace(/<@!?(\d+)>/g, (_, id) => `@${nameOf(id, guildId)}`)
        .replace(/<@&(\d+)>/g, (_, id) => {
            try {
                const r = S().GuildRoleStore?.getRole?.(guildId, id) ?? S().GuildStore?.getGuild?.(guildId)?.roles?.[id]
                return `@${r?.name ?? 'role'}`
            } catch {
                return '@role'
            }
        })
        .replace(/<#(\d+)>/g, (_, id) => `#${S().ChannelStore?.getChannel?.(id)?.name ?? 'channel'}`)
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
        .replace(/<t:(\d+)(?::\w)?>/g, (_, t) => new Date(Number(t) * 1000).toLocaleString())
        .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒')
        .replace(/[*_~`>#]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (text) return (m?.embeds ?? []).length || (m?.components ?? []).length ? `${text}, Embed` : text
    const files = m?.attachments ?? []
    if (files.length) {
        const first = files[0]
        const kind = String(first?.content_type ?? first?.contentType ?? '')
        if (kind.startsWith('image/')) return files.length > 1 ? `${files.length} images` : 'Image'
        if (kind.startsWith('video/')) return 'Video'
        return first?.filename ?? 'Attachment'
    }
    const stickers = m?.stickerItems ?? m?.sticker_items ?? m?.stickers ?? []
    if (stickers.length) return `Sticker, ${stickers[0]?.name ?? ''}`.replace(/, $/, '')
    if ((m?.embeds ?? []).length) return 'Embed'
    // 컴포넌트로 만든 메시지 (봇 카드 등)
    if ((m?.components ?? []).length) return 'Embed'
    if (m?.poll) return 'Poll'
    return ''
}

const SYSTEM: Record<number, string> = { 6: 'pinned a message', 7: 'joined the server', 8: 'boosted the server', 18: 'started a thread' }

// ── 채널 목록 (channel_list_v2/native/renderRedesignChannelListItem) ─────
/**
 * 채널 줄은 renderChannelListItem({ guildChannels, section, row, ... }) 이 그리고,
 * 줄 높이는 getChannelListItemSize({ guildChannels, section, row, ... }) 가 정한다.
 * 둘 다 guildChannels.getChannelFromSectionRow(section, row).channel 의 subtitle 이 있으면
 * 이름 아래에 한 줄을 더 그리고 그만큼 높게 잡는다. 그래서 그 자리에 마지막 메시지를 넣는다.
 */
const TEXTUAL = new Set([0, 5, 10, 11, 12])

/** 표시 이름 스타일 (폰 디스코드는 글꼴과 색을 쓴다) */
const hexOf = (c: any): string | undefined => (typeof c === 'number' ? `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}` : typeof c === 'string' && c ? (c.startsWith('#') ? c : `#${c}`) : undefined)

function mix(a: string, b: string, t: number) {
    const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
    const [x, y] = [p(a), p(b)]
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** 글자마다 색을 조금씩 바꿔 그라데이션처럼 (진짜 그라데이션을 못 그릴 때) */
function CharGradient({ text, colors, style }: { text: string; colors: string[]; style: any }) {
    const chars = [...text]
    if (colors.length < 2 || chars.length < 2) return <Text style={{ ...style, color: colors[0] }}>{text}</Text>
    const seg = colors.length - 1
    return (
        <Text style={style}>
            {chars.map((ch, i) => {
                const t = (i / (chars.length - 1)) * seg
                const k = Math.min(seg - 1, Math.floor(t))
                return (
                    <Text key={i} style={{ color: mix(colors[k], colors[k + 1], t - k) }}>
                        {ch}
                    </Text>
                )
            })}
        </Text>
    )
}

/**
 * 진짜 그라데이션: 이름 글자 모양(MaskedView) 안에 LinearGradient 를 칠한다.
 * 글 줄 안에 끼워 넣는 작은 View 라서, 글자 크기를 칸 글자와 맞춰 준다.
 * 그리다 오류가 나면 글자마다 색 방식으로 바꾼다.
 */
const NAME_TEXT = { fontSize: 14, lineHeight: 18 }

class Boundary extends Component<{ fallback: any; children: any }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    componentDidCatch(e: any) {
        status.lastError = `Gradient, ${e?.message ?? e}`
    }
    render() {
        return this.state.failed ? this.props.fallback : this.props.children
    }
}

function Gradient({ text, colors, style }: { text: string; colors: string[]; style: any }) {
    const masked = find('MaskedView')?.MaskedView
    const gradient = find('LinearGradient', 'LinearGradientNativeComponent')?.LinearGradient
    const fallback = <CharGradient text={text} colors={colors} style={style} />
    // 글 줄 안에서는 항상 글자마다 색 (진짜 그라데이션은 SplitName 이 줄을 나눠 그린다)
    if (true || !masked || !gradient || colors.length < 2) return fallback
    const M = masked
    const G = gradient
    const textStyle = { ...NAME_TEXT, ...style }
    return (
        <Boundary fallback={fallback}>
            <View style={{ marginBottom: -4 }}>
                <M maskElement={<Text style={textStyle}>{text}</Text>}>
                    <G colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                        <Text style={{ ...textStyle, opacity: 0 }}>{text}</Text>
                    </G>
                </M>
            </View>
        </Boundary>
    )
}

function nameStyle(userId: string, guildId: string | undefined, fallback: any): { fontFamily?: string; color?: string; colors?: string[]; styled?: boolean } {
    const out: { fontFamily?: string; color?: string; colors?: string[]; styled?: boolean } = {}
    try {
        const user = S().UserStore?.getUser?.(userId) ?? fallback
        if (!user) return out
        const fontId = find('getDisplayNameFontIdForMobileUser')?.getDisplayNameFontIdForMobileUser?.(user, guildId)
        const family = fontId != null ? find('DISPLAY_NAME_STYLES_FONT_FAMILY_MAP')?.DISPLAY_NAME_STYLES_FONT_FAMILY_MAP?.[fontId] : undefined
        if (typeof family === 'string') out.fontFamily = family
        const styles = (guildId ? S().GuildMemberStore?.getMember?.(guildId, userId)?.displayNameStyles : undefined) ?? user.displayNameStyles ?? user.display_name_styles
        const list = (Array.isArray(styles?.colors) ? styles.colors : []).map(hexOf).filter(Boolean) as string[]
        if (list.length) out.color = list[0]
        if (list.length > 1) out.colors = list
        if (list.length || out.fontFamily) out.styled = true
    } catch {}
    return out
}

interface Preview {
    /** 바뀌었는지 비교용 */
    key: string
    node: any
    /** 이름과 나머지 글을 따로 그릴 때 쓰는 값 (진짜 그라데이션) */
    split?: { name: string; colors: string[]; style: any; rest: string; userId?: string; guildId?: string; real?: boolean; color?: string }
}

/**
 * 진짜 그라데이션을 글 줄 안에 끼우면 자리가 어긋나서, 줄을 둘로 나눠 그린다.
 * 왼쪽은 그라데이션 이름(View), 오른쪽은 디스코드가 그리는 원래 글 줄(": 메시지").
 * 글자 크기는 디스코드 글 줄의 variant 를 그대로 쓴다.
 */
function textColor() {
    try {
        const t: any = (Tokens as any).default
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of ['TEXT_DEFAULT', 'TEXT_NORMAL', 'HEADER_PRIMARY']) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return undefined
}

/**
 * 디스코드 이름 컴포넌트는 채팅 크기로 그려서, 그린 크기를 재고 메시지 한 줄 높이에 맞게 줄인다.
 * 재기 전에는 안 보이게 둔다.
 */
function FitName({ lineHeight, children }: { lineHeight: number; children: any }) {
    const [m, setM] = useState<{ w: number; h: number } | null>(null)
    const k = m && m.h > 0 ? Math.min(1, lineHeight / m.h) : 1
    const w = m ? m.w * k : 0
    return (
        <View style={{ width: w, height: lineHeight, overflow: 'hidden', flexShrink: 0 }}>
            {/* 넓은 칸 안에 두어 이름이 줄바꿈 없이 원래 크기로 그려지게 한다 */}
            <View style={{ position: 'absolute', left: 0, top: 0, width: 2000, flexDirection: 'row', alignItems: 'flex-start' }}>
                <View
                    onLayout={(e: any) => {
                        const { width, height } = e.nativeEvent.layout
                        if (!m || Math.abs(m.w - width) > 0.5 || Math.abs(m.h - height) > 0.5) setM({ w: width, h: height })
                    }}
                    style={{
                        opacity: m ? 1 : 0,
                        // 가운데 기준으로 줄어드니 왼쪽 위로 다시 옮긴다
                        transform: m ? [{ translateX: -(m.w * (1 - k)) / 2 }, { translateY: -(m.h * (1 - k)) / 2 + (lineHeight - m.h * k) / 2 }, { scale: k }] : [],
                    }}
                >
                    {children}
                </View>
            </View>
        </View>
    )
}

function SplitName({ name, colors, style, variant, userId, guildId, real, color }: { name: string; colors: string[]; style: any; variant?: string; userId?: string; guildId?: string; real?: boolean; color?: string }) {
    const UWE = usernameWithEffects
    if (real && UWE) {
        const v = variant ?? 'text-sm/medium'
        const ts = find('TextStyleSheet')?.TextStyleSheet?.[v]
        const fontSize = ts?.fontSize ?? 14
        const lineHeight = ts?.lineHeight ?? 18
        status.variant = `${v} ${fontSize}/${lineHeight}`
        // 글자 크기는 메시지 줄과 같게, 효과가 줄 높이를 조금 넘어도 자르지 않는다
        return (
            <View style={{ justifyContent: 'center', flexShrink: 0 }}>
                <Boundary fallback={<Text style={{ fontSize, color: color ?? textColor() }}>{name}</Text>}>
                    <UWE userId={userId} guildId={guildId} userName={name} variant={v} style={{ fontSize, ...(color ? { color } : null) }} lineClamp={1} effectDisplayType={1} />
                </Boundary>
            </View>
        )
    }
    const { Text: DText } = Design as any
    const M = find('MaskedView')?.MaskedView
    const G = find('LinearGradient', 'LinearGradientNativeComponent')?.LinearGradient
    const label = (extra?: any) => (
        <DText variant={variant ?? 'text-sm/medium'} color="text-default" lineClamp={1} maxFontSizeMultiplier={1.75} style={{ ...style, ...extra }}>
            {name}
        </DText>
    )
    const fallback = (
        <DText variant={variant ?? 'text-sm/medium'} lineClamp={1} maxFontSizeMultiplier={1.75}>
            <CharGradient text={name} colors={colors} style={style} />
        </DText>
    )
    if (!M || !G) return fallback
    return (
        <Boundary fallback={fallback}>
            <M maskElement={label()}>
                <G colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                    {label({ opacity: 0 })}
                </G>
            </M>
        </Boundary>
    )
}

/** 디스코드의 표시 이름 스타일 컴포넌트 (글꼴, 그라데이션, 네온 같은 효과를 진짜와 똑같이) */
let usernameWithEffects: any

/** 원래 TextChannel 대신 그리는 컴포넌트 (같은 원래 컴포넌트에는 같은 것을 써서 다시 만들어지지 않게) */
const wrappers = new WeakMap<any, any>()

/** 그린 결과에서 subtitle 글 줄(Text)을 찾아 이름과 글로 나눈다 */
function splitTree(node: any, sub: any, depth = 0): any {
    if (!node || typeof node !== 'object' || depth > 12) return node
    if (Array.isArray(node)) {
        let changed = false
        const out = node.map(n => {
            const r = splitTree(n, sub, depth + 1)
            if (r !== n) changed = true
            return r
        })
        return changed ? out : node
    }
    const props = node.props
    if (!props) return node
    if (props.children === sub.text) {
        const sp = sub.split
        const rest = String(sp.rest).replace(/^\s+/, '')
        status.split = 'Working'
        return (
            <View key={node.key ?? undefined} style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
                <SplitName name={sp.name} colors={sp.colors} style={sp.style} variant={props.variant} userId={sp.userId} guildId={sp.guildId} real={sp.real} color={sp.color} />
                {/^\s/.test(sp.rest) ? <Text> </Text> : null}
                {cloneElement(node, { style: [props.style, { flexShrink: 1 }] }, rest)}
            </View>
        )
    }
    if (props.children == null) return node
    const kids = splitTree(props.children, sub, depth + 1)
    return kids === props.children ? node : cloneElement(node, undefined, ...(Array.isArray(kids) ? kids : [kids]))
}

function wrapperFor(type: any) {
    let w = wrappers.get(type)
    if (w) return w
    const MEMO = Symbol.for('react.memo')
    const FORWARD = Symbol.for('react.forward_ref')
    const inner = type?.$$typeof === MEMO ? type.type : type
    // forwardRef 컴포넌트는 ref 를 그대로 넘긴다
    const isForward = inner?.$$typeof === FORWARD
    const render = isForward ? inner.render : inner
    if (typeof render !== 'function') return
    const body = function BetterChannelRow(props: any, ref?: any) {
        let out = isForward ? render(props, ref) : render(props)
        const sub = props?.subtitle
        if (sub?.split)
            try {
                const r = splitTree(out, sub)
                if (r === out) status.split = 'Message line not found'
                out = r
            } catch (e: any) {
                status.lastError = `Split, ${e?.message ?? e}`
            }
        try {
            out = redesignTree(out, props?.channel, !!props?.muted, (el: any) => {
                const iw = wrapperFor(el.type)
                return iw ? { ...el, type: iw } : el
            })
        } catch (e: any) {
            status.lastError = `Redesign, ${e?.message ?? e}`
        }
        return out
    }
    w = isForward ? forwardRef(body as any) : body
    wrappers.set(type, w)
    return w
}

/** renderChannelListItem 이 돌려준 것에서 우리 subtitle 을 받는 채널 컴포넌트를 바꿔 끼운다 */
function wrapRow(el: any, depth = 0): any {
    if (!el || typeof el !== 'object' || depth > 4) return el
    if (Array.isArray(el)) return el.map(e => wrapRow(e, depth + 1))
    const props = el.props
    if (!props) return el
    if ((props.subtitle?.split || (settings().redesign && props.channel)) && el.type && typeof el.type !== 'string') {
        const w = wrapperFor(el.type)
        if (props.channel?.type === 2 || props.channel?.type === 13) rstatus.voice = (rstatus.voice + ` row${w ? '' : ' (cannot wrap)'}`).slice(-160)
        if (w) {
            if (props.subtitle?.split && status.split === 'Not found yet') status.split = 'Hooked'
            return { ...el, type: w }
        }
    }
    if (props.children == null || typeof props.children !== 'object') return el
    const kids = wrapRow(props.children, depth + 1)
    return kids === props.children ? el : { ...el, props: { ...props, children: kids } }
}

function preview(channel: any): Preview | undefined {
    const s = settings()
    if (!s.lastMessage) return
    let m: any
    try {
        const list = S().MessageStore?.getMessages?.(channel.id)
        m = list?.last?.() ?? list?._array?.[list._array.length - 1]
    } catch {}
    if (!m) return
    const authorId = m.author?.id
    try {
        if (authorId && S().RelationshipStore?.isBlocked?.(authorId)) return { key: 'blocked', node: 'Blocked message' }
    } catch {}
    const system = SYSTEM[m.type]
    const body = system ?? plain(m, channel.guild_id)
    if (!body) return
    const name = s.showAuthor && authorId ? nameOf(authorId, channel.guild_id, m.author) : ''
    if (!name) return { key: body, node: body }
    // 이름은 서버 별명, 역할 색으로 굵게 (메시지의 이름처럼)
    const styled = s.nameStyle ? nameStyle(authorId, channel.guild_id, m.author) : {}
    const color = styled.color ?? (s.roleColor ? colorOf(authorId, channel.guild_id) : undefined)
    const colors = styled.color ? styled.colors : s.roleColor ? roleColors(authorId, channel.guild_id) : undefined
    const rest = system ? ` ${body}` : `: ${body}`
    const base = styled.fontFamily ? { fontFamily: styled.fontFamily } : { fontWeight: '700' as const }
    return {
        key: `${name}|${color}|${colors?.join(',')}|${styled.fontFamily}|${rest}|${!!usernameWithEffects}`,
        // 표시 이름 스타일이 있으면 디스코드가 DM 목록에서 쓰는 이름 컴포넌트(UsernameWithEffects)로 똑같이 그린다
        // 이름은 언제나 디스코드 이름 컴포넌트로 (스타일이 없는 사람은 역할 색으로)
        split: s.nameStyle && usernameWithEffects ? { name, colors: [], style: {}, rest, userId: authorId, guildId: channel.guild_id, real: true, color: !nameStyle(authorId, channel.guild_id, m.author).styled && s.roleColor ? colorOf(authorId, channel.guild_id) : undefined } : undefined,
        node: (
            <>
                <Text style={{ fontWeight: '700', ...(s.roleColor && colorOf(authorId, channel.guild_id) ? { color: colorOf(authorId, channel.guild_id) } : null) }}>{name}</Text>
                {rest}
            </>
        ),
    }
}

/** 우리가 subtitle 을 넣은 채널 줄 (끄면 다시 뺀다) */
const touched = new Set<any>()

/**
 * 채널 줄 정보에 subtitle 을 바로 넣는다.
 * (guildChannels 를 감싸서 바꾸면 디스코드 TextChannel 이 원래 객체를 다시 찾다가 멈춰서, 객체를 그대로 두고 값만 넣는다)
 */
function fillPreviews(args: any[]) {
    const p = args[0]
    const gc = p?.guildChannels
    if (!gc || typeof gc.getChannelFromSectionRow !== 'function') return
    let res: any
    try {
        // 채널이 아닌 칸(서버 버튼 등)은 오류를 내서 넘긴다
        res = gc.getChannelFromSectionRow(p.section, p.row)
    } catch {
        return
    }
    const ch = res?.channel
    const rec = ch?.record
    const forum = rec?.type === ChannelTypes.FORUM || rec?.type === ChannelTypes.MEDIA
    if (!ch || !rec || (!TEXTUAL.has(rec.type) && !forum)) return
    const ours = touched.has(ch)
    // 디스코드가 원래 넣은 subtitle 은 건드리지 않는다
    if (!ours && ch.subtitle != null) return
    const s = settings()
    let pv: Preview | undefined
    if (forum) {
        // 원래 플러그인처럼 Medium 일 때 포럼 아래에 열린 글 수
        const n = s.redesign && s.iconSize === 'medium' ? activePosts(rec) : 0
        if (n > 0) pv = { key: `posts|${n}`, node: `${n} active ${n === 1 ? 'post' : 'posts'}` }
    } else pv = s.lastMessage ? preview(rec) : undefined
    try {
        if (pv) {
            // subtitle 은 글이 아니라 { type, text } 꼴이다 (getChannelSubtitleData). 'voice' 꼴이 text 를 한 줄로 그대로 보여 준다
            if (ch.subtitle?.key !== pv.key) Object.defineProperty(ch, 'subtitle', { value: { type: 'voice', text: pv.node, key: pv.key, split: pv.split }, writable: true, configurable: true, enumerable: true })
            touched.add(ch)
            status.withMessage++
        } else if (ours) {
            delete ch.subtitle
            if (ch.subtitle !== undefined) ch.subtitle = undefined
            touched.delete(ch)
        }
    } catch (e: any) {
        status.lastError = String(e?.message ?? e)
    }
}

function patchChannelList(cleanup: (...f: any[]) => void) {
    status.hook = 'Looking for the channel list'
    cleanup(
        getModuleWithImportedPath('modules/channel_list_v2/native/renderRedesignChannelListItem.tsx', (mod: any) => {
            let n = 0
            for (const key of ['renderChannelListItem', 'getChannelListItemSize'])
                if (typeof mod?.[key] === 'function') {
                    cleanup(
                        instead(mod, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                            if (key === 'renderChannelListItem') status.rows++
                            try {
                                fillPreviews(args)
                            } catch (e: any) {
                                status.lastError = String(e?.message ?? e)
                            }
                            const out = orig.apply(this, args)
                            if (key === 'getChannelListItemSize') {
                                if (typeof out !== 'number' || out <= 0 || !settings().redesign) return out
                                try {
                                    const p = args[0]
                                    const rec = p?.guildChannels?.getChannelFromSectionRow?.(p.section, p.row)?.channel?.record
                                    return extraHeight(rec, out)
                                } catch {
                                    return out
                                }
                            }
                            try {
                                return wrapRow(out)
                            } catch (e: any) {
                                status.lastError = `Split, ${e?.message ?? e}`
                                return out
                            }
                        }),
                    )
                    n++
                }
            status.hook = n === 2 ? 'Hooked' : `Hooked ${n} of 2`
        }) as any,
    )
}

function SettingsPage() {
    const { Stack, TableRowGroup, TableSwitchRow, TableRow, TableRadioGroup, TableRadioRow } = Design as any
    const s = useSettings()
    const [, tick] = useState(0)
    useEffect(() => {
        const t = setInterval(() => tick(n => n + 1), 1000)
        return () => clearInterval(t)
    }, [])
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Channel list">
                    <TableSwitchRow label="Last message" subLabel="Shows the most recent message under each channel" value={s.lastMessage} onValueChange={(lastMessage: boolean) => update({ lastMessage })} />
                    <TableSwitchRow label="Show author" subLabel="Shows who sent it before the message" value={s.showAuthor} onValueChange={(showAuthor: boolean) => update({ showAuthor })} />
                    <TableSwitchRow label="Name style" subLabel="Draws names with Discord's own name style, font, colors and effects" value={s.nameStyle} onValueChange={(nameStyle: boolean) => update({ nameStyle })} />
                    <TableSwitchRow label="Role color" subLabel="Paints the author's name in their role color" value={s.roleColor} onValueChange={(roleColor: boolean) => update({ roleColor })} />
                </TableRowGroup>
                <TableRowGroup title="Redesign">
                    <TableSwitchRow label="Emoji icons" subLabel="Shows each channel's emoji in a colored square instead of the channel icon" value={s.redesign} onValueChange={(redesign: boolean) => update({ redesign })} />
                    <TableSwitchRow label="Guess emojis" subLabel="Channels without a Discord emoji get one from their name, like 💬 for general or 🤖 for bots" value={s.autoEmoji} disabled={!s.redesign} onValueChange={(autoEmoji: boolean) => (update({ autoEmoji }), redraw())} />
                </TableRowGroup>
                <TableRadioGroup title="Icon size" value={s.iconSize} onChange={(iconSize: any) => update({ iconSize })}>
                    {(['medium', 'small', 'tiny'] as const).map(k => (
                        <TableRadioRow key={k} label={k[0].toUpperCase() + k.slice(1)} subLabel={k === 'medium' ? 'Also shows active posts under forums' : undefined} value={k} disabled={!s.redesign} />
                    ))}
                </TableRadioGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        // 1.0.10 에서 기본으로 켜졌던 진짜 그라데이션은 이름이 겹치거나 안 보여서 한 번 끈다
        // 1.0.12 부터 줄을 나눠 그려서 다시 켠다 (한 번만)
        if (!settings().splitReset) update({ realGradient: true, gradientReset: true, splitReset: true })
        const subs: Array<[string, (e: any) => void]> = [
            ['MESSAGE_PREVIEWS_LOADED', onPreviews],
            ['MESSAGE_CREATE', (e: any) => e?.guildId && e.guildId === S().SelectedGuildStore?.getGuildId?.() && redraw()],
            ['MESSAGE_UPDATE', (e: any) => e?.guildId && e.guildId === S().SelectedGuildStore?.getGuildId?.() && redraw()],
            ['CHANNEL_SELECT', (e: any) => request(e?.guildId)],
            ['CHANNEL_UPDATES', (e: any) => e?.channels?.some?.((c: any) => c?.guild_id === S().SelectedGuildStore?.getGuildId?.()) && request(S().SelectedGuildStore?.getGuildId?.(), undefined, true)],
            ['GUILD_MEMBER_UPDATE', (e: any) => e?.user?.id === S().UserStore?.getCurrentUser?.()?.id && request(e?.guildId, undefined, true)],
            [
                'MESSAGE_DELETE',
                (e: any) => {
                    const g = S().ChannelStore?.getChannel?.(e?.channelId)?.guild_id
                    if (g && g === S().SelectedGuildStore?.getGuildId?.()) request(g, [e.channelId])
                },
            ],
        ]
        for (const [type, fn] of subs) {
            (Dispatcher as any).subscribe(type, fn)
            cleanup(() => (Dispatcher as any).unsubscribe(type, fn))
        }
        // 서버를 바꾸면 그 서버 채널들의 마지막 메시지를 받아 온다
        const guildStore = S().SelectedGuildStore
        const onGuild = () => request(guildStore?.getGuildId?.())
        guildStore?.addChangeListener?.(onGuild)
        cleanup(() => guildStore?.removeChangeListener?.(onGuild))
        onGuild()

        patchChannelList(cleanup)
        patchSheet(cleanup, redraw)
        cleanup(
            getModuleWithImportedPath('modules/display_name_styles/native/UsernameWithEffects.tsx', (mod: any) => {
                usernameWithEffects = mod?.default ?? mod
                status.names = usernameWithEffects ? 'Found' : 'Not found'
                redraw()
            }) as any,
        )
        cleanup(() => {
            for (const ch of touched)
                try {
                    delete ch.subtitle
                } catch {}
            touched.clear()
        })
    },
    SettingsComponent: SettingsPage,
} as any)
