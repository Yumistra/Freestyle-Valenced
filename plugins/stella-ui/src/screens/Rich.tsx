import { memo, useMemo, useState } from 'react'
import { Image, Linking, Pressable, Text, View } from 'react-native'
import { emojiUrl } from '../data'
import { type Block, blocks, type Inline, onlyEmoji } from '../markdown'
import { Icon, T } from '../parts'
import { C, R } from '../theme'

/**
 * 꾸민 글, 임베드, 봇의 새 메시지 형식(컴포넌트 v2), 반응을 그린다.
 * tone: 'light' 는 파란 말풍선 위(흰 글자), 'dark' 는 흰 바탕 위(남색 글자).
 */

export type Tone = 'light' | 'dark'
const ink = (tone: Tone) => (tone === 'light' ? C.white : C.ink)
const soft = (tone: Tone) => (tone === 'light' ? '#dfe7ff' : C.muted)
const linkColor = (tone: Tone) => (tone === 'light' ? '#eef2ff' : C.blue)
const MONO = 'monospace'

/** 바깥 글 상자. 안드로이드가 굵은 글자 폭을 잘못 재서 끝 글자가 잘리는 것을 막는다 */
export const P = (props: any) => <Text textBreakStrategy="simple" {...props} />

const open = (url?: string) => {
    if (url) Linking.openURL(url).catch(() => {})
}

// ── 한 줄 안 ────────────────────────────────────────────────────────────
function Spoiler({ children, tone }: { children: any; tone: Tone }) {
    const [shown, setShown] = useState(false)
    return (
        <Text onPress={() => setShown(true)} style={shown ? { backgroundColor: tone === 'light' ? 'rgba(255,255,255,0.18)' : C.blueSoft } : { backgroundColor: C.navyDeep, color: C.navyDeep }}>
            {children}
        </Text>
    )
}

function Nodes({ nodes, tone, big }: { nodes: Inline[]; tone: Tone; big?: boolean }): any {
    return nodes.map((n, i) => {
        switch (n.t) {
            case 'text':
                return n.v
            case 'b':
                return (
                    <Text key={i} style={{ fontWeight: '800' }}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Text>
                )
            case 'i':
                return (
                    <Text key={i} style={{ fontStyle: 'italic' }}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Text>
                )
            case 'u':
                return (
                    <Text key={i} style={{ textDecorationLine: 'underline' }}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Text>
                )
            case 's':
                return (
                    <Text key={i} style={{ textDecorationLine: 'line-through' }}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Text>
                )
            case 'spoiler':
                return (
                    <Spoiler key={i} tone={tone}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Spoiler>
                )
            case 'code':
                return (
                    <Text key={i} style={{ fontFamily: MONO, backgroundColor: tone === 'light' ? 'rgba(255,255,255,0.18)' : C.blueSoft, fontSize: 13 }}>
                        {` ${n.v} `}
                    </Text>
                )
            case 'mention':
            case 'time':
                return (
                    <Text key={i} style={{ color: tone === 'light' ? C.white : C.blue, fontWeight: '800', backgroundColor: tone === 'light' ? 'rgba(255,255,255,0.16)' : 'rgba(74,111,216,0.12)' }}>
                        {n.v}
                    </Text>
                )
            case 'emoji':
                return <Image key={i} source={{ uri: big ? emojiUrl(n.id, n.animated, 96) : n.url }} style={{ width: big ? 44 : 20, height: big ? 44 : 20 }} />
            case 'link':
                return (
                    <Text key={i} style={{ color: linkColor(tone), textDecorationLine: 'underline' }} onPress={() => open(n.url)}>
                        <Nodes nodes={n.c} tone={tone} />
                    </Text>
                )
        }
    })
}

// ── 블록 ────────────────────────────────────────────────────────────────
function BlockView({ b, tone, size, big }: { b: Block; tone: Tone; size: number; big?: boolean }): any {
    const base = { fontSize: size, lineHeight: Math.round(size * 1.4), color: ink(tone), fontWeight: '600' as const }
    switch (b.t) {
        case 'p':
            return (
                <P style={base}>
                    <Nodes nodes={b.c} tone={tone} big={big} />
                </P>
            )
        case 'h': {
            const s = b.level === 1 ? size + 7 : b.level === 2 ? size + 4 : size + 2
            return (
                <P style={{ ...base, fontSize: s, lineHeight: Math.round(s * 1.3), fontWeight: '800', marginTop: 2 }}>
                    <Nodes nodes={b.c} tone={tone} />
                </P>
            )
        }
        case 'sub':
            return (
                <P style={{ ...base, fontSize: size - 3, color: soft(tone), lineHeight: Math.round((size - 3) * 1.4) }}>
                    <Nodes nodes={b.c} tone={tone} />
                </P>
            )
        case 'li':
            return (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    <P style={base}>•</P>
                    <P style={{ ...base, flex: 1 }}>
                        <Nodes nodes={b.c} tone={tone} />
                    </P>
                </View>
            )
        case 'quote':
            return (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ width: 3, borderRadius: 2, backgroundColor: tone === 'light' ? 'rgba(255,255,255,0.6)' : C.line }} />
                    <View style={{ flex: 1, gap: 2 }}>
                        {b.c.map((x, i) => (
                            <BlockView key={i} b={x} tone={tone} size={size} />
                        ))}
                    </View>
                </View>
            )
        case 'codeblock':
            return (
                <View style={{ borderRadius: 8, padding: 8, backgroundColor: tone === 'light' ? 'rgba(0,0,0,0.18)' : C.blueSoft }}>
                    <P style={{ fontFamily: MONO, fontSize: size - 2, color: ink(tone) }}>{b.v}</P>
                </View>
            )
    }
}

/** 꾸민 글 (메시지, 임베드 설명, 필드 값 등) */
export const RichText = memo(function RichText({ text, guildId, tone, size = 15 }: { text: string; guildId?: string; tone: Tone; size?: number }) {
    const parsed = useMemo(() => blocks(text, guildId), [text, guildId])
    if (!parsed.length) return null
    const big = onlyEmoji(parsed)
    return (
        <View style={{ gap: 3 }}>
            {parsed.map((b, i) => (
                <BlockView key={i} b={b} tone={tone} size={size} big={big} />
            ))}
        </View>
    )
})

// ── 공용: 그림 ──────────────────────────────────────────────────────────
export const mediaUrl = (m: any): string | undefined => m?.proxyURL ?? m?.proxyUrl ?? m?.proxy_url ?? m?.url ?? undefined

function Picture({ media, maxWidth = 300, maxHeight = 320, onPress }: { media: any; maxWidth?: number; maxHeight?: number; onPress?: () => void }) {
    const uri = mediaUrl(media)
    if (!uri) return null
    const w0 = Number(media.width) || maxWidth
    const h0 = Number(media.height) || Math.round(maxWidth * 0.6)
    const scale = Math.min(1, maxWidth / w0, maxHeight / h0)
    const style = { width: Math.round(w0 * scale), height: Math.round(h0 * scale), borderRadius: 10, backgroundColor: C.blueSoft }
    return (
        <Pressable onPress={onPress ?? (() => open(media.url ?? uri))}>
            <Image source={{ uri }} style={style} resizeMode="cover" />
        </Pressable>
    )
}

// ── 임베드 ──────────────────────────────────────────────────────────────
export function embedColor(e: any): string | undefined {
    const c = e?.color
    if (typeof c === 'number' && Number.isFinite(c)) return `#${c.toString(16).padStart(6, '0')}`
    if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) return c.startsWith('#') ? c : `#${c}`
}

const field = (f: any, raw: string, plain: string) => f?.[raw] ?? f?.[plain] ?? ''

/** 보여 줄 게 있는 임베드인지 */
export function hasEmbedContent(e: any): boolean {
    return !!(e && (e.rawTitle || e.title || e.rawDescription || e.description || e.author?.name || e.fields?.length || mediaUrl(e.image) || mediaUrl(e.thumbnail) || e.footer?.text))
}

export const EmbedCard = memo(function EmbedCard({ e, guildId }: { e: any; guildId?: string }) {
    const title = field(e, 'rawTitle', 'title')
    const desc = field(e, 'rawDescription', 'description')
    const fields: any[] = e.fields ?? []
    const thumb = e.thumbnail
    const image = e.image
    // 그림 하나만 있는 링크(이미지, GIF, 영상)는 그림만
    const mediaOnly = (e.type === 'image' || e.type === 'gifv') && !title && !desc
    if (mediaOnly) return <Picture media={image ?? thumb} />
    const video = e.type === 'video'
    const footer = e.footer?.text
    const time = e.timestamp ? new Date(e.timestamp) : undefined
    const bar = embedColor(e) ?? C.teal
    const rows: any[][] = []
    for (const f of fields) {
        const last = rows[rows.length - 1]
        if (f.inline && last && last.length < 3 && last[0].inline) last.push(f)
        else rows.push([f])
    }
    return (
        <View style={{ flexDirection: 'row', borderRadius: 12, overflow: 'hidden', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, maxWidth: 440 }}>
            <View style={{ width: 4, backgroundColor: bar }} />
            <View style={{ flexShrink: 1, padding: 10, gap: 6 }}>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                    <View style={{ flexShrink: 1, gap: 4 }}>
                        {e.provider?.name ? (
                            <T size={12} color={C.muted} weight="600">
                                {e.provider.name}
                            </T>
                        ) : null}
                        {e.author?.name ? (
                            <Pressable onPress={() => open(e.author.url)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                {e.author.iconProxyURL || e.author.proxy_icon_url || e.author.iconURL || e.author.icon_url ? (
                                    <Image source={{ uri: e.author.iconProxyURL ?? e.author.proxy_icon_url ?? e.author.iconURL ?? e.author.icon_url }} style={{ width: 20, height: 20, borderRadius: 10 }} />
                                ) : null}
                                <T size={13} weight="800">
                                    {e.author.name}
                                </T>
                            </Pressable>
                        ) : null}
                        {title ? (
                            <P onPress={e.url ? () => open(e.url) : undefined} style={{ fontSize: 15, fontWeight: '800', color: e.url ? C.blue : C.ink }}>
                                {title}
                            </P>
                        ) : null}
                        {desc ? <RichText text={desc} guildId={guildId} tone="dark" size={14} /> : null}
                    </View>
                    {thumb && !video && mediaUrl(thumb) ? <Picture media={thumb} maxWidth={72} maxHeight={72} /> : null}
                </View>
                {rows.map((row, i) => (
                    <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
                        {row.map((f, j) => (
                            <View key={j} style={{ flex: 1, minWidth: 0, gap: 2 }}>
                                <RichText text={field(f, 'rawName', 'name')} guildId={guildId} tone="dark" size={13} />
                                <RichText text={field(f, 'rawValue', 'value')} guildId={guildId} tone="dark" size={13} />
                            </View>
                        ))}
                    </View>
                ))}
                {image ? <Picture media={image} /> : null}
                {video && thumb ? (
                    <View>
                        <Picture media={thumb} onPress={() => open(e.url ?? e.video?.url)} />
                        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
                            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(28,42,99,0.7)', alignItems: 'center', justifyContent: 'center' }}>
                                <Icon names={['PlayIcon']} color={C.white} size={24} />
                            </View>
                        </View>
                    </View>
                ) : null}
                {footer || time ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {e.footer?.iconProxyURL || e.footer?.proxy_icon_url ? <Image source={{ uri: e.footer.iconProxyURL ?? e.footer.proxy_icon_url }} style={{ width: 16, height: 16, borderRadius: 8 }} /> : null}
                        <T size={12} color={C.muted} weight="600" style={{ flexShrink: 1 }}>
                            {[footer, time && Number.isFinite(time.getTime()) ? `${time.getFullYear()}. ${time.getMonth() + 1}. ${time.getDate()}.` : ''].filter(Boolean).join(', ')}
                        </T>
                    </View>
                ) : null}
            </View>
        </View>
    )
})

// ── 컴포넌트 v2 ─────────────────────────────────────────────────────────
function ButtonPill({ c }: { c: any }) {
    const label = c.label ?? c.emoji?.name ?? ''
    const link = c.url
    const primary = c.style === 1
    return (
        <Pressable onPress={link ? () => open(link) : undefined} disabled={!link} accessibilityRole="button" accessibilityLabel={label}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, height: 32, borderRadius: 8, backgroundColor: primary ? C.blue : C.white, borderWidth: primary ? 0 : 1, borderColor: C.line, opacity: c.disabled ? 0.5 : 1 }}>
                {c.emoji?.id ? <Image source={{ uri: emojiUrl(c.emoji.id, !!c.emoji.animated) }} style={{ width: 16, height: 16 }} /> : null}
                <T size={13} color={primary ? C.white : C.ink} weight="700">
                    {c.emoji && !c.emoji.id && c.label ? `${c.emoji.name} ${label}` : label}
                </T>
                {link ? <Icon names={['WindowLaunchIcon', 'LinkExternalSmallIcon']} color={primary ? C.white : C.muted} size={14} /> : null}
            </View>
        </Pressable>
    )
}

export function Components({ list, guildId, depth = 0 }: { list: any[]; guildId?: string; depth?: number }): any {
    if (!Array.isArray(list) || depth > 4) return null
    return list.map((c: any, i: number) => {
        switch (c?.type) {
            case 1:
                return (
                    <View key={i} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {(c.components ?? []).map((b: any, j: number) =>
                            b.type === 2 ? (
                                <ButtonPill key={j} c={b} />
                            ) : (
                                <View key={j} style={{ paddingHorizontal: 12, height: 32, justifyContent: 'center', borderRadius: 8, backgroundColor: C.white, borderWidth: 1, borderColor: C.line }}>
                                    <T size={13} color={C.muted}>
                                        {b.placeholder ?? '선택'}
                                    </T>
                                </View>
                            ),
                        )}
                    </View>
                )
            case 9:
                return (
                    <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
                        <View style={{ flex: 1, gap: 4 }}>
                            <Components list={c.components ?? []} guildId={guildId} depth={depth + 1} />
                        </View>
                        {c.accessory?.type === 11 ? <Picture media={c.accessory.media} maxWidth={72} maxHeight={72} /> : c.accessory?.type === 2 ? <ButtonPill c={c.accessory} /> : null}
                    </View>
                )
            case 10:
                return <RichText key={i} text={c.content ?? ''} guildId={guildId} tone="dark" size={14} />
            case 11:
                return <Picture key={i} media={c.media} maxWidth={120} maxHeight={120} />
            case 12:
                return (
                    <View key={i} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {(c.items ?? []).map((it: any, j: number) => (
                            <Picture key={j} media={it.media} maxWidth={(c.items?.length ?? 1) > 1 ? 160 : 300} />
                        ))}
                    </View>
                )
            case 13:
                return (
                    <T key={i} size={13} color={C.ink}>
                        {`[파일] ${c.name ?? c.file?.filename ?? ''}`}
                    </T>
                )
            case 14:
                return <View key={i} style={{ height: c.divider === false ? 8 : 1, marginVertical: c.spacing === 2 ? 8 : 4, backgroundColor: c.divider === false ? 'transparent' : C.line }} />
            case 17: {
                const accent = embedColor({ color: c.accent_color ?? c.accentColor }) ?? C.teal
                return (
                    <View key={i} style={{ flexDirection: 'row', borderRadius: 12, overflow: 'hidden', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, maxWidth: 440 }}>
                        <View style={{ width: 4, backgroundColor: accent }} />
                        <View style={{ flexShrink: 1, padding: 10, gap: 6 }}>
                            <Components list={c.components ?? []} guildId={guildId} depth={depth + 1} />
                        </View>
                    </View>
                )
            }
            default:
                return null
        }
    })
}

// ── 반응 ────────────────────────────────────────────────────────────────
export function Reactions({ list, onToggle }: { list: any[]; onToggle: (r: any) => void }) {
    if (!list?.length) return null
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {list.map((r: any, i: number) => {
                const me = !!(r.me || r.me_burst)
                const n = r.count ?? (r.count_details?.normal ?? 0) + (r.count_details?.burst ?? 0)
                return (
                    <Pressable key={`${r.emoji?.id ?? r.emoji?.name}-${i}`} onPress={() => onToggle(r)} accessibilityRole="button" accessibilityLabel={`reaction ${r.emoji?.name}`}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 28, borderRadius: R.pill, backgroundColor: me ? C.blueSoft : C.white, borderWidth: 1.5, borderColor: me ? C.blue : C.line }}>
                            {r.emoji?.id ? <Image source={{ uri: emojiUrl(r.emoji.id, !!r.emoji.animated) }} style={{ width: 18, height: 18 }} /> : <Text style={{ fontSize: 15 }}>{r.emoji?.name}</Text>}
                            <T size={13} color={me ? C.blue : C.ink} weight="800">
                                {n}
                            </T>
                        </View>
                    </Pressable>
                )
            })}
        </View>
    )
}
