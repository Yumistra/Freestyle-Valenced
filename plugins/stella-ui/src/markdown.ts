import { channel, displayName, emojiUrl, S, user } from './data'

/**
 * 디스코드 글 꾸밈(마크다운)을 조각으로 나눈다. 그리는 건 Rich.tsx.
 * 지원: **굵게**, *기울임*, __밑줄__, ~~취소선~~, ||스포일러||, `코드`, ```코드 블록```,
 * > 인용, # 제목, -# 작은 글, - 목록, [글](링크), 링크, 멘션, 커스텀 이모지, <t:시간>
 */

export type Inline =
    | { t: 'text'; v: string }
    | { t: 'b' | 'i' | 'u' | 's' | 'spoiler'; c: Inline[] }
    | { t: 'code'; v: string }
    | { t: 'mention'; v: string }
    | { t: 'emoji'; id: string; name: string; animated: boolean; url: string }
    | { t: 'link'; url: string; c: Inline[] }
    | { t: 'time'; v: string }

export type Block =
    | { t: 'p'; c: Inline[] }
    | { t: 'h'; level: number; c: Inline[] }
    | { t: 'sub'; c: Inline[] }
    | { t: 'li'; c: Inline[] }
    | { t: 'quote'; c: Block[] }
    | { t: 'codeblock'; v: string }

// ── 시간 ────────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
export function formatTime(seconds: number, style = 'f', now = Date.now()): string {
    const d = new Date(seconds * 1000)
    if (!Number.isFinite(d.getTime())) return '?'
    const date = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    switch (style) {
        case 't':
            return time
        case 'T':
            return `${time}:${pad(d.getSeconds())}`
        case 'd':
        case 'D':
            return date
        case 'R': {
            const diff = Math.round((d.getTime() - now) / 1000)
            const abs = Math.abs(diff)
            const [n, unit] = abs < 60 ? [abs, '초'] : abs < 3600 ? [Math.round(abs / 60), '분'] : abs < 86400 ? [Math.round(abs / 3600), '시간'] : abs < 86400 * 30 ? [Math.round(abs / 86400), '일'] : abs < 86400 * 365 ? [Math.round(abs / 86400 / 30), '달'] : [Math.round(abs / 86400 / 365), '년']
            return diff < 0 ? `${n}${unit} 전` : `${n}${unit} 후`
        }
        default:
            return `${date} ${time}`
    }
}

// ── 한 줄 안의 꾸밈 ─────────────────────────────────────────────────────
interface Rule {
    re: RegExp
    make: (m: RegExpExecArray, guildId: string | undefined, depth: number) => Inline
}

const RULES: Rule[] = [
    { re: /``([^`]+?)``|`([^`\n]+)`/, make: m => ({ t: 'code', v: m[1] ?? m[2] }) },
    { re: /<(@!?|@&|#)(\d+)>/, make: (m, g) => ({ t: 'mention', v: mention(m[1], m[2], g) }) },
    { re: /<(a?):(\w+):(\d+)>/, make: m => ({ t: 'emoji', id: m[3], name: m[2], animated: m[1] === 'a', url: emojiUrl(m[3], m[1] === 'a') }) },
    { re: /<t:(-?\d+)(?::([tTdDfFR]))?>/, make: m => ({ t: 'time', v: formatTime(Number(m[1]), m[2]) }) },
    { re: /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/, make: (m, g, d) => ({ t: 'link', url: m[2], c: inline(m[1], g, d + 1) }) },
    { re: /<?(https?:\/\/[^\s<>]+[^\s<>.,:;"')\]])>?/, make: m => ({ t: 'link', url: m[1], c: [{ t: 'text', v: m[1] }] }) },
    { re: /\*\*([\s\S]+?)\*\*(?!\*)/, make: (m, g, d) => ({ t: 'b', c: inline(m[1], g, d + 1) }) },
    { re: /__([\s\S]+?)__(?!_)/, make: (m, g, d) => ({ t: 'u', c: inline(m[1], g, d + 1) }) },
    { re: /~~([\s\S]+?)~~/, make: (m, g, d) => ({ t: 's', c: inline(m[1], g, d + 1) }) },
    { re: /\|\|([\s\S]+?)\|\|/, make: (m, g, d) => ({ t: 'spoiler', c: inline(m[1], g, d + 1) }) },
    { re: /\*(?![\s*])([^*\n]+?)\*/, make: (m, g, d) => ({ t: 'i', c: inline(m[1], g, d + 1) }) },
    { re: /\b_(?![\s_])([^_\n]+?)_\b/, make: (m, g, d) => ({ t: 'i', c: inline(m[1], g, d + 1) }) },
]

function mention(kind: string, id: string, guildId?: string): string {
    if (kind === '#') return `#${channel(id)?.name ?? '채널'}`
    if (kind === '@&') {
        const role = (guildId && (S().GuildRoleStore?.getRole?.(guildId, id) ?? S().GuildStore?.getRole?.(guildId, id))) || undefined
        return `@${role?.name ?? '역할'}`
    }
    const u = user(id)
    return u ? `@${displayName(u, guildId)}` : '@알 수 없는 사용자'
}

/** 한 줄(블록 안)의 꾸밈 조각 */
export function inline(text: string, guildId?: string, depth = 0): Inline[] {
    if (!text) return []
    if (depth > 6) return [{ t: 'text', v: text }]
    const out: Inline[] = []
    let rest = text
    while (rest) {
        let best: { i: number; m: RegExpExecArray; rule: Rule } | undefined
        for (const rule of RULES) {
            const m = rule.re.exec(rest)
            if (m && (!best || m.index < best.i)) best = { i: m.index, m, rule }
            if (best?.i === 0) break
        }
        if (!best) {
            out.push({ t: 'text', v: rest })
            break
        }
        if (best.i > 0) out.push({ t: 'text', v: rest.slice(0, best.i) })
        out.push(best.rule.make(best.m, guildId, depth))
        rest = rest.slice(best.i + best.m[0].length)
    }
    return out
}

// ── 블록 (줄 단위) ──────────────────────────────────────────────────────
const CODE = /```(?:[\w+-]*\n)?([\s\S]*?)```/g

export function blocks(text: string, guildId?: string, depth = 0): Block[] {
    const out: Block[] = []
    let last = 0
    CODE.lastIndex = 0
    let m: RegExpExecArray | null
    // 코드 블록을 먼저 떼어 낸다 (안의 글은 꾸미지 않는다)
    const parts: { code?: string; text?: string }[] = []
    while ((m = CODE.exec(text))) {
        if (m.index > last) parts.push({ text: text.slice(last, m.index) })
        parts.push({ code: m[1].replace(/\n$/, '') })
        last = m.index + m[0].length
    }
    if (last < text.length) parts.push({ text: text.slice(last) })
    for (const part of parts) {
        if (part.code !== undefined) out.push({ t: 'codeblock', v: part.code })
        else out.push(...lines(part.text ?? '', guildId, depth))
    }
    return out
}

function lines(text: string, guildId: string | undefined, depth: number): Block[] {
    const out: Block[] = []
    const rows = text.split('\n')
    let para: string[] = []
    let quote: string[] = []
    const flushPara = () => {
        // 앞뒤 빈 줄은 버린다
        while (para.length && !para[0].trim()) para.shift()
        while (para.length && !para[para.length - 1].trim()) para.pop()
        if (para.length) out.push({ t: 'p', c: inline(para.join('\n'), guildId, depth) })
        para = []
    }
    const flushQuote = () => {
        if (quote.length) out.push({ t: 'quote', c: depth < 2 ? lines(quote.join('\n'), guildId, depth + 1) : [{ t: 'p', c: inline(quote.join('\n'), guildId, depth) }] })
        quote = []
    }
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (depth === 0 && row.startsWith('>>> ')) {
            flushPara()
            flushQuote()
            quote = [row.slice(4), ...rows.slice(i + 1)]
            break
        }
        const q = /^> ?(.*)$/.exec(row)
        if (q && depth === 0) {
            flushPara()
            quote.push(q[1])
            continue
        }
        flushQuote()
        const h = /^(#{1,3}) (.+)$/.exec(row)
        if (h) {
            flushPara()
            out.push({ t: 'h', level: h[1].length, c: inline(h[2], guildId, depth) })
            continue
        }
        const sub = /^-# (.+)$/.exec(row)
        if (sub) {
            flushPara()
            out.push({ t: 'sub', c: inline(sub[1], guildId, depth) })
            continue
        }
        const li = /^\s*[-*] (.+)$/.exec(row)
        if (li) {
            flushPara()
            out.push({ t: 'li', c: inline(li[1], guildId, depth) })
            continue
        }
        para.push(row)
    }
    flushPara()
    flushQuote()
    return out
}

// ── 꾸밈 없는 글 (미리보기) ─────────────────────────────────────────────
function flat(nodes: Inline[]): string {
    return nodes
        .map(n => {
            switch (n.t) {
                case 'text':
                case 'code':
                case 'mention':
                case 'time':
                    return n.v
                case 'emoji':
                    return `:${n.name}:`
                default:
                    return flat(n.c)
            }
        })
        .join('')
}

export function plainText(content: string, guildId?: string): string {
    return blocks(content, guildId)
        .map(function text(b: Block): string {
            return b.t === 'codeblock' ? b.v : b.t === 'quote' ? b.c.map(text).join(' ') : flat(b.c)
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** 이모지만 있는 글인지 (크게 보여 준다) */
export function onlyEmoji(nodes: Block[]): boolean {
    if (nodes.length !== 1 || nodes[0].t !== 'p') return false
    const c = nodes[0].c
    return c.length > 0 && c.length <= 12 && c.some(n => n.t === 'emoji') && c.every(n => n.t === 'emoji' || (n.t === 'text' && !n.v.trim()))
}

// ── 미리보기 한 줄 ──────────────────────────────────────────────────────
export function previewText(m: any, guildId?: string): string {
    if (!m) return ''
    const text = plainText(m.content ?? '', guildId)
    if (text) return text
    if (m.attachments?.length) return '[파일]'
    if (m.stickerItems?.length || m.sticker_items?.length) return '[스티커]'
    const e = m.embeds?.[0]
    if (e) return plainText(e.rawTitle ?? e.title ?? e.rawDescription ?? e.description ?? '', guildId) || '[임베드]'
    if (m.components?.length) return '[메시지]'
    return ''
}
