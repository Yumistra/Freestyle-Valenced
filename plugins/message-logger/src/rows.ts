import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'
import { processColor } from 'react-native'
import { takeChanged } from './logger'
import { logs } from './store'

const MESSAGE_ROW = 1
const UPDATE = 2

/** 핑 배경의 투명도 (디스코드 핑 줄을 보면 그걸로 맞춘다) */
let bgAlpha = 0x1f
let seenMention = false

function argb(color: number | null | undefined, alpha: number) {
    if (typeof color !== 'number') return undefined
    return ((alpha & 0xff) << 24) | (color & 0xffffff)
}

function themeColor(name: string, fallback: string) {
    try {
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        const t: any = Tokens
        const c = t.default.internal.resolveSemanticColor(theme, t.default.colors[name])
        return processColor(c ?? fallback) as number
    } catch {
        return processColor(fallback) as number
    }
}

/**
 * 아래 표시 글자(\uE000…)는 이 플러그인의 네이티브 부분(Markers.kt)이 꾸밈으로 바꾼다.
 * 네이티브 부분이 안 켜진 기기(네이티브 플러그인을 못 쓰는 설치 등)에서는 표시 글자가 그대로
 * 한자 같은 이상한 글자로 보이므로, 네이티브가 대답한 뒤에만 쓰고 그 전에는 꾸밈 없이 보여 준다.
 */
let native = false
export function setNative(v: boolean) {
    native = v
}

const red = () => themeColor('TEXT_FEEDBACK_CRITICAL', '#f23f43')
const gray = () => themeColor('TEXT_MUTED', '#949ba4')

const text = (content: string) => ({ type: 'text', content })

/** 이 메시지를 다른 내용으로 (수정 표시 없이) */
function withContent(rec: any, content: string) {
    let next = typeof rec?.set === 'function' ? rec.set('content', content) : Object.assign(Object.create(Object.getPrototypeOf(rec)), rec, { content })
    try {
        if (typeof next?.set === 'function') next = next.set('editedTimestamp', null)
        else next.editedTimestamp = null
    } catch {}
    return next
}

function contentOf(content: string, args: any, generate: (a: any) => any): any[] | undefined {
    try {
        const c = generate({ ...args, message: withContent(args.message, content) })?.message?.content
        if (Array.isArray(c) && c.length) return stripHistory(c)
    } catch {}
}

/**
 * 이미 붙어 있는 수정 기록(우리 표시로 시작하는 줄들)을 떼어 낸다.
 * 업데이트 직후처럼 이 플러그인이 두 겹으로 걸려 있으면 안쪽 층이 붙인 기록이 섞여 들어오므로.
 */
export function stripHistory(nodes: any[]): any[] {
    if (!Array.isArray(nodes)) return nodes
    // 수정 기록 배경 표시로 시작하면 그 끝 표시까지 통째로
    if (typeof nodes[0]?.content === 'string' && nodes[0].content.startsWith(BG_START)) {
        const end = nodes.findIndex((n: any) => n?.type === 'text' && n.content === BG_END)
        return end >= 0 ? stripHistory(nodes.slice(end + 1)) : nodes.slice(1)
    }
    if (nodes[0]?.content !== FADE_START) return nodes
    let cut = -1
    for (let i = 0; i < nodes.length; i++) {
        const c = nodes[i]?.content
        if (nodes[i]?.type === 'text' && c === '\n') {
            cut = i
            // 다음 줄도 기록이면 계속, 아니면 여기까지
            if (nodes[i + 1]?.content !== FADE_START) break
        }
    }
    return cut >= 0 ? nodes.slice(cut + 1) : nodes
}

// Kotlin(Markers.kt)과 같아야 한다
const FADE_START = '\uE000'
const FADE_END = '\uE001'
const LABEL_START = '\uE002'
const LABEL_SEPARATOR = '\uE003'
const LABEL_END = '\uE004'
const BG_START = '\uE005'
const BG_SEPARATOR = '\uE006'
const BG_END = '\uE007'

/** 디스코드 "(수정됨)"처럼 작은 글자 (색은 네이티브가 입힌다) */
const label = (color: number | null | undefined, content: string) => text(`${LABEL_START}${typeof color === 'number' ? color : ''}${LABEL_SEPARATOR}${content}${LABEL_END}`)

/** 이 시각에 보냈다면 메시지 옆에 나올 시간 글자 (디스코드가 만드는 그대로) */
function timeOf(at: number, args: any, generate: (a: any) => any, fallback?: string) {
    try {
        const rec = args.message
        const ts = rec?.timestamp
        const moved = ts && typeof ts.clone === 'function' && typeof ts.valueOf === 'function' ? ts.clone().add(at - ts.valueOf(), 'ms') : new Date(at)
        const next = typeof rec?.set === 'function' ? rec.set('timestamp', moved) : Object.assign(Object.create(Object.getPrototypeOf(rec)), rec, { timestamp: moved })
        const t = generate({ ...args, message: next })?.message?.timestamp
        if (typeof t === 'string' && t) return t
    } catch {}
    return fallback ?? new Date(at).toLocaleString()
}

/** 예전 내용 한 줄씩: "예전 내용 (수정됨) 시간" (예전 내용은 흐리게, 뒤는 디스코드 수정 표시·시간 모양) */
function history(edits: Array<{ t: string; at: number }>, edited: string, row: any, args: any, generate: (a: any) => any, full: (a: any) => any) {
    const out: any[] = []
    for (const { t, at } of edits) {
        if (!native) {
            // 꾸밈 없이: "예전 내용 (수정됨) 시간"
            out.push(...(contentOf(t, args, generate) ?? [text(t)]), text(` ${edited} ${timeOf(at, args, full)}`), text('\n'))
            continue
        }
        out.push(
            text(FADE_START),
            ...(contentOf(t, args, generate) ?? [text(t)]),
            text(FADE_END),
            text(' '),
            label(row.message.editedColor, edited),
            text(' '),
            label(row.message.timestampColor, timeOf(at, args, full)),
            text('\n'),
        )
    }
    return out
}

export function styleRow(row: any, args: any, generate: (a: any) => any, full: (a: any) => any = generate) {
    if (row?.type !== MESSAGE_ROW || !row.message?.id) return
    const id = row.message.id
    // 핑 줄의 배경 투명도를 배운다
    if (!seenMention && typeof row.backgroundHighlight?.backgroundColor === 'number') {
        bgAlpha = (row.backgroundHighlight.backgroundColor >>> 24) & 0xff || bgAlpha
        seenMention = true
    }
    if (takeChanged(id)) row.changeType = UPDATE
    const e = logs()[id]
    if (!e || e.h) return
    if (e.e?.length) {
        // 디스코드가 메시지 옆에 붙이는 "(수정됨)" 글자 그대로
        const raw = typeof row.message.edited === 'string' && row.message.edited.trim() ? row.message.edited.trim() : 'edited'
        const edited = raw.startsWith('(') ? raw : `(${raw})`
        const lines = history(e.e, edited, row, args, generate, full)
        // 지워진 게 아니면 수정 기록 줄들에만 핑처럼 회색 배경 (지금 내용은 그대로)
        if (!e.d && native) {
            const g = gray()
            lines.unshift(text(`${BG_START}${argb(g, bgAlpha)},${argb(g, 0xff)}${BG_SEPARATOR}`))
            lines.push(text(BG_END))
        }
        row.message.content = [...lines, ...stripHistory(Array.isArray(row.message.content) ? row.message.content : [])]
    }
    if (!e.d) return
    // 지워진 메시지는 줄 전체 빨간 배경 + 글자도 빨간색 (본문·시간)
    const color = red()
    row.backgroundHighlight = { backgroundColor: argb(color, bgAlpha), gutterColor: argb(color, 0xff) }
    row.message.textColor = color
    row.message.timestampColor = color
}
