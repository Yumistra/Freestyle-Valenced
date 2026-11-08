import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { cloneElement } from 'react'
import { Image, Text, View } from 'react-native'
import { EMOJI_COLORS } from './colors'
import { settings } from './store'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'

/** 디스코드에 들어 있는 아이콘 (못 찾으면 undefined) */
const icon = (name: string): any => {
    try {
        return (lookupGeneratedIconComponent(name as any) as any) ?? find(name)?.[name]
    } catch {
        return find(name)?.[name]
    }
}

/**
 * 원래 플러그인의 "Redesign" 부분.
 *  - 채널 아이콘(#) 자리에 채널 이모지를 색 바탕 칸으로 (크기 Medium, Small, Tiny)
 *  - 채널 이모지는 디스코드가 정한 것(iconEmoji), 직접 바꾼 것이 있으면 그것, 없으면 🌐
 *  - 음성 채널은 오른쪽에 사람 수/최대 인원 (인원 제한이 있을 때)
 *  - 채널 이름 옆에 제한된 채널, 연령 제한 채널 표시
 *  - Medium 일 때 포럼 채널 아래에 열린 글 수
 */

const S = () => Stores as any
const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

export const ChannelTypes = { TEXT: 0, VOICE: 2, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15, MEDIA: 16 }
const ICON_TYPES = new Set([0, 2, 5, 13, 15, 16])

export const SIZES = {
    medium: { box: 42, emoji: 20, radius: 21 },
    small: { box: 32, emoji: 16, radius: 16 },
    tiny: { box: 20, emoji: 14, radius: 10 },
} as const

export const status = { icons: 0, badges: 0, nameIcons: 0, voice: '', error: '', fromDiscord: new Set<string>() }

const typeName = (t: any): string => (typeof t === 'string' ? t : t?.displayName ?? t?.name ?? t?.type?.displayName ?? t?.type?.name ?? t?.render?.name ?? (t?.$$typeof ? String(t.$$typeof.description ?? '?') : '?'))
const rootName = (n: any): string => (Array.isArray(n) ? `[${n.length}]` : n && typeof n === 'object' ? typeName(n.type) : String(n))

export interface ChannelEmoji {
    name: string
    id?: string
}

export function channelEmoji(channel: any): ChannelEmoji {
    const own = settings().icons?.[channel?.id]
    if (own) {
        // 서버 이모지는 <:이름:ID> 로 저장한다
        const m = /^<a?:([^:]*):(\d+)>$/.exec(own)
        return m ? { name: m[1], id: m[2] } : { name: own }
    }
    const e = channel?.iconEmoji ?? channel?.icon_emoji
    if (e?.name || e?.id) {
        status.fromDiscord.add(channel.id)
        return { name: e.name ?? '', id: e.id ?? undefined }
    }
    if (settings().autoEmoji !== false) {
        const guess = guessEmoji(channel)
        if (guess) return { name: guess }
    }
    return { name: '🌐' }
}

/** 채널 이름 안의 첫 이모지 */
// 휴대폰 JS 엔진이 \p{...} 를 모르면 이모지 범위로 대신한다
const EMOJI_RE: RegExp = (() => {
    try {
        return new RegExp('(\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*|[\\u{1F1E6}-\\u{1F1FF}]{2})', 'u')
    } catch {}
    try {
        return new RegExp('((?:[\\u{1F300}-\\u{1FAFF}]|[\\u{2600}-\\u{27BF}])(?:\\uFE0F|\\u200D(?:[\\u{1F300}-\\u{1FAFF}]|[\\u{2600}-\\u{27BF}]))*|[\\u{1F1E6}-\\u{1F1FF}]{2})', 'u')
    } catch {
        return /(?!)/
    }
})()

/** 이름에 들어 있는 낱말로 고르는 이모지 (디스코드가 정한 이모지가 없는 채널용) */
const KEYWORDS: Array<[RegExp, string]> = [
    [/rule|규칙/, '📜'],
    [/announce|news|update|공지|소식/, '📢'],
    [/welcome|hello|intro|환영|인사/, '👋'],
    [/role|역할/, '🏷️'],
    [/faq|question|help|support|ask|질문|도움/, '❓'],
    [/general|chat|lounge|talk|main|일반|잡담|채팅/, '💬'],
    [/off[-_ ]?topic|random|misc/, '🎲'],
    [/meme|funny|shitpost|밈/, '😂'],
    [/media|image|pic|photo|art|gallery|사진|그림|짤/, '🖼️'],
    [/video|clip|영상/, '🎬'],
    [/music|song|playlist|음악|노래/, '🎵'],
    [/game|gaming|play|게임/, '🎮'],
    [/bot|command|cmd|봇|명령/, '🤖'],
    [/dev|code|coding|program|github|git|개발|코딩/, '💻'],
    [/plugin|addon|extension|mod|플러그인/, '🧩'],
    [/theme|design|style|테마|디자인/, '🎨'],
    [/request|suggest|idea|feedback|요청|건의|제안/, '💡'],
    [/bug|issue|report|버그|신고/, '🐛'],
    [/log|audit|기록/, '📋'],
    [/staff|mod|admin|관리/, '🛡️'],
    [/event|giveaway|이벤트/, '🎉'],
    [/partner|파트너/, '🤝'],
    [/link|resource|repo|자료/, '🔗'],
    [/stream|live|방송/, '📺'],
    [/afk|sleep|잠수/, '💤'],
    [/pet|animal|cat|dog|동물/, '🐾'],
    [/food|cook|음식/, '🍔'],
    [/vent|serious/, '🫂'],
    [/nsfw/, '🔞'],
]

export function guessEmoji(channel: any): string | undefined {
    const name = String(channel?.name ?? '')
    const m = EMOJI_RE.exec(name)
    if (m) return m[1]
    const low = name.toLowerCase()
    for (const [re, emoji] of KEYWORDS) if (re.test(low)) return emoji
    if (channel?.type === 2) return '🔊'
    if (channel?.type === 13) return '🎙️'
    if (channel?.type === 15 || channel?.type === 16) return '🗂️'
}

function isDark() {
    try {
        const t = S().ThemeStore?.theme
        return t !== 'light'
    } catch {
        return true
    }
}

/** #RRGGBB 에 투명도 붙이기 (원래 플러그인처럼 어두운 테마 0.2, 밝은 테마 0.16) */
function withAlpha(hex: string, a: number) {
    return hex + Math.round(a * 255).toString(16).padStart(2, '0')
}

export function EmojiTile({ channel, size, emoji, muted }: { channel?: any; size?: keyof typeof SIZES; emoji?: ChannelEmoji; muted?: boolean }) {
    const sz = SIZES[size ?? settings().iconSize] ?? SIZES.medium
    const e = emoji ?? channelEmoji(channel)
    const bg = withAlpha(EMOJI_COLORS[e.name] ?? '#607D8B', isDark() ? 0.2 : 0.16)
    return (
        <View style={{ width: sz.box, height: sz.box, borderRadius: sz.radius, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginRight: 10, opacity: muted ? 0.3 : 1 }}>
            {e.id ? (
                <Image source={{ uri: `https://cdn.discordapp.com/emojis/${e.id}.png?size=64` }} style={{ width: sz.emoji, height: sz.emoji }} resizeMode="contain" />
            ) : (
                <Text allowFontScaling={false} style={{ fontSize: sz.emoji, lineHeight: Math.round(sz.emoji * 1.25), textAlign: 'center' }}>
                    {e.name}
                </Text>
            )}
        </View>
    )
}

/** @everyone 이 채널을 못 보거나(음성은 못 들어가거나) 막혀 있으면 "제한된 채널" */
export function isLimited(channel: any): boolean {
    try {
        const ow = channel?.permissionOverwrites?.[channel.guild_id]
        if (!ow?.deny) return false
        const deny = BigInt(String(ow.deny))
        const VIEW = BigInt(1024)
        const CONNECT = BigInt(1048576)
        const zero = BigInt(0)
        if ((deny & VIEW) !== zero) return true
        if ((channel.type === ChannelTypes.VOICE || channel.type === ChannelTypes.STAGE) && (deny & CONNECT) !== zero) return true
    } catch {}
    return false
}

function isNSFW(channel: any) {
    try {
        return typeof channel?.isNSFW === 'function' ? !!channel.isNSFW() : !!channel?.nsfw
    } catch {
        return false
    }
}

function mutedColor() {
    try {
        const t: any = Tokens?.default
        const theme = S().ThemeStore?.theme ?? 'dark'
        for (const n of ['INTERACTIVE_MUTED', 'TEXT_MUTED', 'CHANNEL_ICON']) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return '#80848e'
}

function SmallIcon({ name }: { name: string }) {
    const Icon = icon(name)
    if (!Icon) return null
    return (
        <View style={{ marginLeft: 3, flexShrink: 0 }}>
            <Icon size="xs" color={mutedColor()} />
        </View>
    )
}

function NameIcons({ channel, locked }: { channel: any; locked?: boolean }) {
    const limited = !locked && isLimited(channel)
    const nsfw = isNSFW(channel)
    if (!limited && !nsfw) return null
    return (
        <>
            {limited ? <SmallIcon name="LockIcon" /> : null}
            {nsfw ? <SmallIcon name="WarningIcon" /> : null}
        </>
    )
}

function voiceCount(channel: any): number {
    try {
        const sorted = S().SortedVoiceStateStore?.getVoiceStatesForChannel?.(channel)
        if (Array.isArray(sorted)) return sorted.length
    } catch {}
    try {
        const states = S().VoiceStateStore?.getVoiceStatesForChannel?.(channel.id)
        if (states) return Object.keys(states).length
    } catch {}
    return 0
}

function VoiceBadge({ channel }: { channel: any }) {
    const limit = channel?.userLimit ?? channel?.user_limit ?? 0
    const hasLimit = limit > 0 && limit !== 10000
    const pad = (n: number) => String(n).padStart(2, '0')
    const color = textColor()
    const stage = channel?.type === ChannelTypes.STAGE
    const locked = isLimited(channel)
    const iconName = locked ? 'LockIcon' : stage ? 'StageIcon' : 'VoiceNormalIcon'
    const Icon = icon(iconName)
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 6, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 100, backgroundColor: badgeColor(), flexShrink: 0 }}>
            {Icon ? <Icon size="xs" color={color} /> : null}
            {hasLimit && !locked ? <Text style={{ color, fontSize: 12, fontWeight: '500', fontFamily: 'monospace' }}>{`${pad(voiceCount(channel))}/${pad(limit)}`}</Text> : null}
        </View>
    )
}

function token(names: string[], fallback: string) {
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
const textColor = () => token(['TEXT_DEFAULT', 'TEXT_NORMAL'], '#dbdee1')
const badgeColor = () => token(['BACKGROUND_SECONDARY_ALT', 'BACKGROUND_MOD_SUBTLE', 'BACKGROUND_TERTIARY'], '#232428')

const NAME_MARK = '__bclName'

/** 이 노드 안에 채널 이름 글이 있는지 */
function hasName(node: any, name: string, depth = 0): boolean {
    if (!node || typeof node !== 'object' || depth > 10) return false
    if (Array.isArray(node)) return node.some(n => hasName(n, name, depth + 1))
    const c = node.props?.children
    if (c === name || node.props?.[NAME_MARK]) return true
    return c != null && typeof c === 'object' && hasName(c, name, depth + 1)
}

/**
 * 채널 줄 컴포넌트가 그린 것을 고친다.
 * 채널 이름 글이 들어 있는 칸(이름 칸) 바로 앞이 디스코드 채널 아이콘이라, 그것을 이모지 칸으로 바꾸고
 * 같은 가로 줄 끝에 음성 인원 칸을, 채널 이름 뒤에 제한, 연령 제한 아이콘을 단다.
 */
export function redesignTree(out: any, channel: any, muted?: boolean, wrap?: (el: any) => any): any {
    const s = settings()
    if (!s.redesign || !channel || !ICON_TYPES.has(channel.type)) return out
    const name = channel.name
    if (typeof name !== 'string' || !name) return out
    const voice = channel.type === ChannelTypes.VOICE || channel.type === ChannelTypes.STAGE
    let iconDone = false
    let nameDone = false

    const walk = (node: any, depth: number): any => {
        if (!node || typeof node !== 'object' || depth > 14) return node
        if (Array.isArray(node)) {
            // 안쪽부터 고친다 (가장 안쪽의 "아이콘, 이름 칸" 줄을 찾도록)
            let changed = false
            let list = node.map(n => {
                const r = walk(n, depth + 1)
                if (r !== n) changed = true
                return r
            })
            // 이름 칸 바로 앞 칸(아이콘)을 바꾼다. 이름 칸이 맨 앞이면 이 줄이 아니다
            if (!iconDone) {
                const i = list.findIndex(n => hasName(n, name))
                if (i > 0 && list[i - 1] && typeof list[i - 1] === 'object' && !hasName(list[i - 1], name)) {
                    iconDone = true
                    changed = true
                    status.icons++
                    list = [...list]
                    list[i - 1] = <EmojiTile key="bcl-icon" channel={channel} muted={muted} />
                    if (voice) {
                        status.badges++
                        list.push(<VoiceBadge key="bcl-voice-badge" channel={channel} />)
                    }
                }
            }
            return changed ? list : node
        }
        const props = node.props
        if (!props) return node
        // 음성 채널 줄(BaseChannelItem)은 아이콘과 이름을 icon, name 으로 받는다
        if (!iconDone && props.icon && typeof props.icon === 'object' && props.name && typeof props.name === 'object') {
            iconDone = true
            status.icons++
            const patch: any = { icon: <EmojiTile channel={channel} muted={muted} /> }
            if (voice) {
                status.badges++
                patch.channelInfo = (
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {props.channelInfo ?? null}
                        <VoiceBadge channel={channel} />
                    </View>
                )
            }
            if (isLimited(channel) || isNSFW(channel)) {
                status.nameIcons++
                patch.name = (
                    <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, flexShrink: 1 }}>
                        <View style={{ flexShrink: 1, minWidth: 0 }}>{props.name}</View>
                        <NameIcons channel={channel} />
                    </View>
                )
            }
            return cloneElement(node, patch)
        }
        const textName = props.children === name || (Array.isArray(props.children) && props.children.length === 1 && props.children[0] === name)
        if (!nameDone && textName) {
            nameDone = true
            const limited = isLimited(channel)
            const nsfw = isNSFW(channel)
            if (!limited && !nsfw) return node
            status.nameIcons++
            // 이름 글과 디스코드 아이콘을 가로로 놓는다.
            // 원래 이름 글은 flex: 1 이라 그대로 두면 폭이 0 이 되어서, 글 길이만큼만 차지하게 바꾼다
            return (
                <View key={node.key ?? 'bcl-name'} {...{ [NAME_MARK]: true }} style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', minWidth: 0 }}>
                    {cloneElement(node, { experimental_useNativeText: false, style: [props.style, { flex: 0, flexGrow: 0, flexShrink: 1, flexBasis: 'auto' }] })}
                    <NameIcons channel={channel} />
                </View>
            )
        }
        const c = props.children
        if (c == null || typeof c !== 'object') return node
        // 자식이 하나일 때도 배열처럼 다뤄 아이콘 자리를 찾는다
        const kids = walk(Array.isArray(c) ? c : [c], depth + 1)
        if (kids === c || (!Array.isArray(c) && Array.isArray(kids) && kids.length === 1 && kids[0] === c)) return node
        return cloneElement(node, undefined, ...(Array.isArray(kids) ? kids : [kids]))
    }
    /**
     * 아이콘과 이름을 못 찾았으면 (음성 채널처럼) 안쪽 컴포넌트가 그리는 것이라,
     * 같은 채널을 받는 안쪽 컴포넌트를 찾아 그것도 감싸서 거기서 다시 고친다
     */
    const deeper = (node: any, depth: number): any => {
        if (!node || typeof node !== 'object' || depth > 14) return node
        if (Array.isArray(node)) {
            let changed = false
            const list = node.map(n => {
                const r = deeper(n, depth + 1)
                if (r !== n) changed = true
                return r
            })
            return changed ? list : node
        }
        const props = node.props
        if (!props) return node
        if (typeof node.type !== 'string' && node.type && props.channel?.id === channel.id) {
            const w = wrap?.(node)
            trace(`inner ${typeName(node.type)}${w && w !== node ? '' : ' (cannot wrap)'}`)
            if (w && w !== node) {
                iconDone = true
                return w
            }
        }
        const c = props.children
        if (c == null || typeof c !== 'object') return node
        const kids = deeper(c, depth + 1)
        return kids === c ? node : cloneElement(node, undefined, ...(Array.isArray(kids) ? kids : [kids]))
    }
    const trace = voice ? (msg: string) => (status.voice = (status.voice + ' ' + msg).slice(-160)) : () => {}
    try {
        trace(`root ${rootName(out)}`)
        const r = walk(out, 0)
        if (iconDone) {
            trace('icon ok')
            return r
        }
        if (!wrap) return r
        const d = deeper(r, 0)
        trace(iconDone ? 'wrapped inner' : 'no inner')
        return d
    } catch (e: any) {
        status.error = String(e?.message ?? e)
        trace(`error ${status.error}`)
        return out
    }
}

/** 이모지 칸이 들어가도록 줄 높이를 늘린다 (원래 플러그인처럼) */
export function extraHeight(channel: any, base: number): number {
    const s = settings()
    if (!s.redesign || !channel || !ICON_TYPES.has(channel.type)) return base
    const sz = SIZES[s.iconSize] ?? SIZES.medium
    // 줄 안쪽 위아래 여백 8 + 바깥 여백
    return Math.max(base, sz.box + 16 + 4)
}

export function activePosts(channel: any): number {
    try {
        const t = S().ActiveThreadsStore?.getThreadsForParent?.(channel.guild_id, channel.id)
        return t ? Object.keys(t).length : 0
    } catch {
        return 0
    }
}
