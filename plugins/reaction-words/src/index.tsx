import { ActionSheetActionCreators, AlertActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule, getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { callNativeMethod } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useRef, useState } from 'react'
import { Platform, ScrollView, Switch as RNSwitch, Text as RNText, View } from 'react-native'

/**
 * Reaction+ (예전 이름 Reaction Words)
 *  - 메시지를 꾹 누르면 나오는 창에 "React with a word" 줄을 넣는다. 단어를 쓰면 글자 이모지(🇵🇱🇺🇬🇮🇳)로 반응한다.
 *    같은 글자가 또 나오면 🅰️ ⭕ 같은 다른 모양을 쓴다.
 *  - 반응 옆 "반응 추가" 버튼을 꾹 누르면 그 메시지에 달린 이모지 전부로 반응한다.
 *    니트로가 없으면 슈퍼 반응만 있는 이모지는 건너뛴다.
 * 디스코드 채팅은 반응 추가 버튼을 꾹 누르면 반응(reaction) 없이 handleLongPressReaction 을 부른다.
 */

const D = () => Design as any
const S = () => Stores as any
const VS = '️'

let seq = 0
/** 알림(토스트)은 띄우지 않는다 */
const toast = (_text: string) => {}

// ── 반응 달기 ───────────────────────────────────────────────────

/** lookupModule 은 [모듈, ...] 을 돌려준다 */
const find = (...props: string[]) => {
    try {
        return (lookupModule(withProps(...(props as [string])) as any) as any)?.[0]
    } catch {}
}

let reactionMod: any
function reactions(): any {
    reactionMod ??= find('addReaction', 'removeReaction')
    return reactionMod
}

const isNitro = () => {
    try {
        return (S().UserStore?.getCurrentUser?.()?.premiumType ?? 0) > 0
    } catch {
        return false
    }
}

async function react(channelId: string, messageId: string, emoji: any, burst = false) {
    const m = reactions()
    if (typeof m?.addReaction !== 'function') throw new Error('Could not find how Discord adds reactions')
    await m.addReaction(channelId, messageId, emoji, undefined, burst ? { burst: true } : undefined)
}

/** 같은 이모지인지 (커스텀은 id, 유니코드는 이름. 변형 선택자는 무시) */
const keyOf = (e: any) => (e?.id ? `id:${e.id}` : `u:${String(e?.name ?? '').replace(/️/g, '')}`)

let busy = false
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 반응을 하나씩 보낸다. 디스코드 답을 기다리지 않고, 보내고 나서 정한 시간만큼 쉬고 다음을 보낸다
 * (전부 반응, 단어 둘 다)
 */
async function run(_label: string, jobs: Array<() => Promise<void>>) {
    if (busy) return
    busy = true
    try {
        note(`send ${jobs.length} reactions, ${wordDelay()} ms apart`)
        for (let i = 0; i < jobs.length; i++) {
            jobs[i]().catch((e: any) => note(`reaction ${i + 1} failed: ${String(e?.message ?? e).slice(0, 200)}`))
            if (i < jobs.length - 1) await sleep(wordDelay())
        }
    } finally {
        busy = false
    }
}

// ── 1. 달린 이모지 전부로 반응 ──────────────────────────────────

function reactWithAll(message: any, channel: any) {
    const list: any[] = message?.reactions ?? []
    const nitro = isNitro()
    const jobs: Array<() => Promise<void>> = []
    let skipped = 0
    for (const r of list) {
        const normal = (r.count ?? 0) - (r.me ? 1 : 0) > 0 || (r.count ?? 0) > (r.burst_count ?? 0)
        if (!r.me && (r.count ?? 0) > 0 && normal) jobs.push(() => react(channel.id, message.id, r.emoji))
        if ((r.burst_count ?? 0) > 0 && !r.me_burst) {
            if (nitro) jobs.push(() => react(channel.id, message.id, r.emoji, true))
            else skipped++
        }
    }
    if (!jobs.length) return toast(skipped ? 'Only super reactions left, they need Nitro' : 'You already reacted with all of them')
    run('React with all', jobs)
}

// ── 2. 단어로 반응 ──────────────────────────────────────────────

const REGIONAL = (c: string) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)
/** 같은 글자를 또 쓸 때 쓰는 다른 모양 */
const ALT: Record<string, string[]> = {
    A: ['🅰' + VS],
    B: ['🅱' + VS],
    C: ['©' + VS],
    E: ['📧'],
    I: ['ℹ' + VS],
    M: ['Ⓜ' + VS],
    O: ['🅾' + VS, '⭕'],
    P: ['🅿' + VS],
    R: ['®' + VS],
    X: ['❌', '✖' + VS],
    '!': ['❗', '❕'],
    '?': ['❓', '❔'],
}
const KEYCAP = (d: string) => `${d}${VS}⃣`

function choices(ch: string): string[] {
    if (/[A-Z]/.test(ch)) return [REGIONAL(ch), ...(ALT[ch] ?? [])]
    if (/[0-9]/.test(ch)) return [KEYCAP(ch)]
    return ALT[ch] ?? []
}

/** 단어를 이모지 목록으로. 못 만드는 글자는 missing 에 */
function spell(word: string, taken: Set<string>): { emojis: string[]; missing: string[]; items: Array<{ ch: string; emoji?: string }> } {
    const used = new Set(taken)
    const emojis: string[] = []
    const missing: string[] = []
    /** 글자 순서대로 (못 쓰는 글자는 emoji 없음) */
    const items: Array<{ ch: string; emoji?: string }> = []
    for (const raw of word.toUpperCase()) {
        if (raw === ' ') continue
        const pick = choices(raw).find(e => !used.has(keyOf({ name: e })))
        if (!pick) {
            missing.push(raw)
            items.push({ ch: raw })
            continue
        }
        used.add(keyOf({ name: pick }))
        emojis.push(pick)
        items.push({ ch: raw, emoji: pick })
    }
    return { emojis, missing, items }
}

function WordInput({ message, onChange }: { message: any; onChange: (v: string) => void }) {
    const { TextInput, Text } = D()
    const [v, setV] = useState('')
    const taken = new Set<string>((message?.reactions ?? []).filter((r: any) => r.me).map((r: any) => keyOf(r.emoji)))
    const { items } = spell(v, taken)
    return (
        // 창이 안쪽을 가운데로 모아서 입력칸이 글자만큼만 커졌다: 폭을 꽉 채운다
        <View style={{ gap: 12, alignSelf: 'stretch', width: '100%' }}>
            <View style={{ alignSelf: 'stretch', width: '100%' }}>
                <TextInput
                    value={v}
                    placeholder="Type a word"
                    autoFocus
                    autoCapitalize="characters"
                    onChange={(t: string) => {
                        setV(t)
                        onChange(t)
                    }}
                    isClearable
                />
            </View>
            {/* 미리보기: 아무것도 안 쓰면 칸을 없앤다. 쓰고 나면 높이를 고정하고, 못 쓰는 글자는 그 자리에 흐린 빨간 글자로 */}
            {items.length ? (
            <View style={{ alignSelf: 'stretch', minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 6 }}>
                {items.map((it, i) =>
                    it.emoji ? (
                        <RNText key={i} style={{ fontSize: 30, lineHeight: 40 }}>
                            {it.emoji}
                        </RNText>
                    ) : (
                        <RNText key={i} style={{ fontSize: 26, lineHeight: 40, fontWeight: '700', color: '#F23F43', opacity: 0.6, textDecorationLine: 'line-through' }}>
                            {it.ch}
                        </RNText>
                    ),
                )}
            </View>
            ) : null}
        </View>
    )
}

function openWordDialog(message: any, channel: any) {
    const { AlertModal, AlertActionButton } = D()
    let word = ''
    const go = () => {
        const taken = new Set<string>((message?.reactions ?? []).filter((r: any) => r.me).map((r: any) => keyOf(r.emoji)))
        const { emojis } = spell(word, taken)
        if (!emojis.length) return toast('Type a word first')
        run('React with a word', emojis.map(name => () => react(channel.id, message.id, { id: null, name, animated: false })))
    }
    AlertActionCreators.openAlert(
        `reaction-words-${seq++}`,
        <AlertModal
            title="React with a word"
            content={<WordInput message={message} onChange={v => (word = v)} />}
            actions={[<AlertActionButton key="go" text="React" variant="primary" onPress={go} />, <AlertActionButton key="no" text="Cancel" variant="secondary" />]}
        />,
    )
}

// ── 메시지 꾹 누르기 창에 줄 넣기 ───────────────────────────────

const nameOf = (t: any): string => t?.name || t?.displayName || t?.type?.name || t?.type?.displayName || t?.render?.name || ''
function isGroup(n: any) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return false
    const G = D().ActionSheetRow?.Group
    return (G && n.type === G) || /ActionSheetRowGroup$/.test(nameOf(n.type))
}
const flat = (c: any): any[] => (Array.isArray(c) ? c.flatMap(flat) : [c])

function addRow(node: any, message: any, channel: any, close: () => void, depth = 0): any {
    if (!node || typeof node !== 'object' || depth > 12) return node
    if (Array.isArray(node)) {
        let changed = false
        const out = node.map(n => {
            const r = addRow(n, message, channel, close, depth + 1)
            if (r !== n) changed = true
            return r
        })
        return changed ? out : node
    }
    const props = node.props
    if (!props) return node
    const kids = flat(props.children)
    const groupAt = kids.findIndex(isGroup)
    if (groupAt >= 0) {
        if (kids.some((k: any) => k?.key === 'reaction-words')) return node
        const { ActionSheetRow } = D()
        const Icon: any = lookupGeneratedIconComponent('ReactionIcon' as any) ?? lookupGeneratedIconComponent('EmojiSmileIcon' as any)
        const group = (
            <ActionSheetRow.Group key="reaction-words" hasIcons>
                <ActionSheetRow
                    label="React with a word"
                    icon={Icon ? <ActionSheetRow.Icon IconComponent={Icon} /> : undefined}
                    onPress={() => {
                        close()
                        setTimeout(() => openWordDialog(message, channel), 350)
                    }}
                />
            </ActionSheetRow.Group>
        )
        const next = [...kids]
        next.splice(groupAt, 0, group)
        return { ...node, props: { ...props, children: next } }
    }
    if (props.children == null || typeof props.children !== 'object') return node
    const c = addRow(props.children, message, channel, close, depth + 1)
    return c === props.children ? node : { ...node, props: { ...props, children: c } }
}

const innerWrapped = new WeakMap<any, any>()
function patchSheet(cleanup: (...f: any[]) => void) {
    const patched = new WeakSet<any>()
    const render = (args: any[], orig: (...a: any[]) => any, self: unknown) => {
        const out = orig.apply(self, args)
        try {
            const p = args[0] ?? {}
            const channel = p.channel ?? S().ChannelStore?.getChannel?.(p.channelId ?? p.message?.channel_id)
            const message = p.message ?? S().MessageStore?.getMessage?.(channel?.id, p.messageId)
            if (!message || !channel) return out
            const close = () => {
                try {
                    if (typeof p.onClose === 'function') p.onClose()
                    else (ActionSheetActionCreators as any).hideActionSheet()
                } catch {}
            }
            const direct = addRow(out, message, channel, close)
            if (direct !== out) return direct
            // 바깥 컴포넌트가 안쪽 컴포넌트 하나만 돌려주면 안쪽을 감싼다
            const type = out?.type
            if (type && typeof type !== 'string') {
                const MEMO = Symbol.for('react.memo')
                const inner = type.$$typeof === MEMO ? type.type : type
                if (typeof inner === 'function') {
                    let w = innerWrapped.get(type)
                    if (!w) {
                        w = function ReactionWordsSheet(props: any) {
                            const o = inner(props)
                            try {
                                return addRow(o, message, channel, close)
                            } catch {
                                return o
                            }
                        }
                        innerWrapped.set(type, w)
                    }
                    return { ...out, type: w }
                }
            }
        } catch {}
        return out
    }
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
    cleanup(
        instead(ActionSheetActionCreators as any, 'openLazy', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
            try {
                const [sheet, key] = args
                if (key === 'MessageLongPressActionSheet' && typeof sheet?.then === 'function') args[0] = sheet.then((m: any) => patchMod(m))
            } catch {}
            return orig.apply(this, args)
        }),
    )
}

// ── 반응 추가 버튼 꾹 누르기 ────────────────────────────────────

let eventUtils: any
let storage: any
const DEFAULT_IGNORE = 1000
const DEFAULT_WORD_DELAY = 300
/** 단어로 반응할 때 글자 하나에서 다음 글자까지 (ms) */
const wordDelay = (): number => {
    const v = Number(storage?.cache?.wordDelay)
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WORD_DELAY
}
const ignoreMs = (): number => {
    const v = Number(storage?.cache?.ignoreMs)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_IGNORE
}
const look = () => ({ fitSize: storage?.cache?.fitSize !== false, wordButton: storage?.cache?.wordButton !== false })
const sendLook = () => Promise.resolve((callNativeMethod as any)(`${NATIVE}.setLook`, [look().fitSize, look().wordButton])).catch(() => {})
const sendIgnoreMs = () => Promise.resolve((callNativeMethod as any)(`${NATIVE}.setIgnoreMs`, [ignoreMs()])).catch(() => {})
/** 안드로이드 부분이 켜져 있는지 (켜져 있을 때만 반응 누르기를 잠깐 기다려 확인한다) */
let nativeOk = false
const NATIVE = 'yumistra.reaction-words'

/** 방금 반응 추가 버튼을 꾹 눌렀으면 그 번호 (흉내 낸 꾹 누르기가 끝날 때까지 같은 번호를 준다), 아니면 0 */
async function addPending(): Promise<{ seq: number; kind: string } | undefined> {
    if (!nativeOk) return undefined
    try {
        const r = await (callNativeMethod as any)(`${NATIVE}.addPending`, [])
        // "번호:종류" (all = 전부 반응, word = 단어로 반응 창)
        const m = typeof r === 'string' ? /^(\d+):(\w+)$/.exec(r) : null
        return m ? { seq: Number(m[1]), kind: m[2] } : undefined
    } catch {
        return undefined
    }
}
/** 이미 전부 반응한 꾹 누르기 번호 */
let handledSeq = 0

/**
 * 반응 꾹 누르기/누르기가 오면 안드로이드에 확인한다. 방금 반응 추가 버튼을 꾹 누른 거면
 * 원래 동작(목록 열기, 켜고 끄기)은 버리고, 처음 한 번만 전부 반응한다.
 */
function viaPending(inst: any, event: any, orig: (e: any) => void) {
    let d: any
    let copy: any = event
    try {
        eventUtils ??= find('getNativeSyntheticEventData')
        d = eventUtils?.getNativeSyntheticEventData?.(event) ?? event?.nativeEvent ?? event
        // 기다리는 동안 이벤트가 재사용되면 원래 동작이 안 먹으니, 내용을 복사해서 넘긴다
        if (event?.nativeEvent) copy = { ...event, nativeEvent: JSON.parse(JSON.stringify(event.nativeEvent)) }
    } catch {}
    addPending().then(p => {
        note(`event message=${d?.messageId ?? '?'} pending=${p ? `${p.seq}:${p.kind}` : 'none'} handled=${handledSeq}`)
        if (!p) return orig(copy)
        if (p.seq === handledSeq || !d?.messageId) return
        handledSeq = p.seq
        try {
            const result = inst.getMessageData?.(d.messageId)
            if (!result?.message || !result.messageChannel) return
            note(`do ${p.kind} on ${d.messageId}`)
            if (p.kind === 'word') openWordDialog(result.message, result.messageChannel)
            else reactWithAll(result.message, result.messageChannel)
        } catch {}
    })
}

/**
 * 안드로이드가 반응 추가 버튼을 꾹 누르면 첫 번째 반응의 꾹 누르기로 디스코드에 알린다.
 * 그래서 반응 꾹 누르기(혹시 순서가 바뀌면 누르기)가 올 때 안드로이드에 확인하고,
 * 맞으면 원래 동작(반응 목록 열기, 반응 켜고 끄기) 대신 전부 반응한다.
 */
function wrapInstance(inst: any) {
    for (const name of ['handleTapReaction', 'handleLongPressReaction']) {
        const orig = inst?.[name]
        if (typeof orig !== 'function' || orig.__reactionWords) continue
        const wrapped = function (this: unknown, event: any) {
            if (!nativeOk) return orig.apply(this, arguments as any)
            const self = this
            viaPending(inst, event, e => orig.call(self, e))
        }
        ;(wrapped as any).__reactionWords = true
        inst[name] = wrapped
    }
}

function patchHandlers(cleanup: (...f: any[]) => void) {
    cleanup(
        getModules(withProps('MessagesHandlers') as any, (mod: any) => {
            const Orig = mod?.MessagesHandlers
            if (typeof Orig !== 'function' || Orig.__reactionWords) return
            // 채팅 화면이 new MessagesHandlers(...) 할 때 만들어진 인스턴스를 감싼다
            const Patched: any = function (this: unknown, ...args: any[]) {
                const inst = Reflect.construct(Orig, args, Patched)
                wrapInstance(inst)
                return inst
            }
            Patched.prototype = Orig.prototype
            Patched.__reactionWords = true
            Object.setPrototypeOf(Patched, Orig)
            try {
                mod.MessagesHandlers = Patched
            } catch {
                return
            }
            cleanup(() => {
                if (mod.MessagesHandlers === Patched) mod.MessagesHandlers = Orig
            })
        }) as any,
    )
}

// ── 로그 ────────────────────────────────────────────────────────

const VERSION = '1.0.48'
/** 최근 일 (로그 복사용) */
const jlog: string[] = []
function note(msg: string) {
    const d = new Date()
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
    jlog.push(`${t} ${msg}`)
    if (jlog.length > 60) jlog.shift()
}

async function buildLog(): Promise<string> {
    const lines: string[] = []
    const add = (k: string, v: unknown) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    lines.push('Reaction+ log')
    add('Time', new Date().toISOString())
    add('Plugin', VERSION)
    try {
        const C: any = Platform.constants ?? {}
        add('Platform', `${Platform.OS} ${Platform.Version}`)
        add('Device', `${C.Manufacturer ?? '?'} ${C.Model ?? '?'} (${C.Brand ?? '?'})`)
        add('React Native', C.reactNativeVersion ? `${C.reactNativeVersion.major}.${C.reactNativeVersion.minor}.${C.reactNativeVersion.patch}` : '?')
    } catch {}
    try {
        add('Theme', S().ThemeStore?.theme ?? '?')
        add('Nitro', isNitro())
    } catch {}
    add('Settings', storage?.cache ?? {})
    add('Native ok (ping)', nativeOk)
    add('Reaction module', typeof reactions()?.addReaction === 'function' ? 'found' : 'missing')
    add('Event utils', eventUtils ? 'found' : 'not used yet')
    add('Handled long press seq', handledSeq)
    try {
        const st = await (callNativeMethod as any)(`${NATIVE}.status`, [])
        lines.push('')
        lines.push('Android part:')
        for (const [k, v] of Object.entries(st ?? {})) if (k !== 'log') add(`  ${k}`, v)
        if (st?.log) {
            lines.push('')
            lines.push('Android recent:')
            lines.push(String(st.log))
        }
    } catch (e: any) {
        lines.push('')
        lines.push(`Android part: not reachable (${String(e?.stack ?? e?.message ?? e).slice(0, 800)})`)
    }
    lines.push('')
    lines.push('JS recent:')
    lines.push(jlog.length ? jlog.join('\n') : '(nothing yet)')
    return lines.join('\n')
}

// ── 설정 화면 ───────────────────────────────────────────────────

/** 테마 색 (CSS 그대로) */
function col(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default ?? Tokens
        const theme = S().ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}
const C = () => ({
    card: col(['CARD_PRIMARY_BG', 'BACKGROUND_SECONDARY', 'BACKGROUND_BASE_LOWER'], '#1e1f22'),
    border: col(['BORDER_SUBTLE', 'BACKGROUND_MODIFIER_ACCENT'], 'rgba(128,128,128,0.25)'),
    pill: col(['BACKGROUND_MOD_SUBTLE', 'BACKGROUND_SECONDARY_ALT', 'BACKGROUND_MODIFIER_HOVER'], 'rgba(128,128,128,0.16)'),
    pillBorder: col(['BORDER_SUBTLE', 'BACKGROUND_MODIFIER_ACCENT'], 'rgba(128,128,128,0.25)'),
    tile: col(['BACKGROUND_MOD_NORMAL', 'BACKGROUND_TERTIARY'], 'rgba(128,128,128,0.24)'),
    icon: col(['INTERACTIVE_NORMAL', 'TEXT_MUTED'], '#b5bac1'),
})

/** 그림 Semantic Types 같은 카드: 굵은 제목, 흐린 설명, 그 밑에 내용 */
function SectionCard({ title, desc, children }: { title: string; desc?: string; children: any }) {
    const { Text } = D()
    const c = C()
    return (
        <View style={{ backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 }}>
            <Text variant="heading-lg/bold">{title}</Text>
            {desc ? (
                <Text variant="text-md/normal" color="text-muted">
                    {desc}
                </Text>
            ) : null}
            {children}
        </View>
    )
}

/** 반응 추가 버튼, Aa 버튼 같은 작은 그림 */
function Tile({ kind }: { kind: 'add' | 'aa' | 'msg'; key?: number }) {
    const { Text } = D()
    const c = C()
    const name = kind === 'add' ? 'ReactionIcon' : 'ChatIcon'
    const Icon: any = kind === 'aa' ? null : lookupGeneratedIconComponent(name as any) ?? lookupGeneratedIconComponent('EmojiSmileIcon' as any)
    return (
        <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: c.tile, alignItems: 'center', justifyContent: 'center' }}>
            {kind === 'aa' ? (
                <RNText style={{ color: c.icon, fontWeight: '700', fontSize: 13 }}>Aa</RNText>
            ) : Icon ? (
                <Icon size="sm" color={c.icon} />
            ) : (
                <Text variant="text-sm/bold">{kind === 'add' ? '☺' : '…'}</Text>
            )}
        </View>
    )
}

/** 그림 속 버튼처럼 생긴 한 줄 (그림 + 글) */
function Pill({ tiles, text }: { tiles: Array<'add' | 'aa' | 'msg'>; text: string }) {
    const { Text } = D()
    const c = C()
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.pill, borderColor: c.pillBorder, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
                {tiles.map((t, i) => (
                    <Tile key={i} kind={t} />
                ))}
            </View>
            <Text variant="text-md/semibold" style={{ flex: 1 }}>
                {text}
            </Text>
        </View>
    )
}

/** 두 칸 중 하나 (짝) */
function Half({ children }: { children: any }) {
    const c = C()
    return <View style={{ flex: 1, backgroundColor: c.pill, borderColor: c.pillBorder, borderWidth: 1, borderRadius: 12, padding: 12, gap: 8, justifyContent: 'space-between' }}>{children}</View>
}

function ToggleHalf({ tiles, label, value, onChange }: { tiles: Array<'add' | 'aa' | 'msg'>; label: string; value: boolean; onChange: (v: boolean) => void }) {
    const { Text } = D()
    const Sw: any = D().FormSwitch ?? D().Switch ?? RNSwitch
    return (
        <Half>
            <View style={{ flexDirection: 'row', gap: 6 }}>
                {tiles.map((t, i) => (
                    <Tile key={i} kind={t} />
                ))}
            </View>
            <Text variant="text-md/semibold">{label}</Text>
            <View style={{ alignItems: 'flex-start' }}>
                <Sw value={value} onValueChange={onChange} />
            </View>
        </Half>
    )
}

/** 숫자 칸 (적고 잠깐 뒤에 저장) */
function NumberHalf({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
    const { Text, TextInput } = D()
    const [draft, setDraft] = useState(String(value))
    const timer = useRef<any>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const change = (v: string) => {
        const clean = v.replace(/[^0-9]/g, '')
        setDraft(clean)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            if (clean === '') return
            const n = Math.min(max, Math.max(min, Math.round(Number(clean))))
            if (String(n) !== clean) setDraft(String(n))
            onSave(n)
        }, 700)
    }
    return (
        <Half>
            <Text variant="text-md/semibold">{label}</Text>
            <TextInput value={draft} placeholder={String(value)} keyboardType="number-pad" onChange={change} returnKeyType="done" />
            <Text variant="text-xs/normal" color="text-muted">
                ms
            </Text>
        </Half>
    )
}

function SettingsPage() {
    const { Stack, Button } = D()
    storage?.use?.()
    const set = (patch: Record<string, unknown>) => {
        storage?.set?.({ ...(storage?.cache ?? {}), ...patch }, true)
        if (storage?.cache) Object.assign(storage.cache, patch)
    }
    const copyLog = async () => {
        try {
            Clipboard.setString(await buildLog())
        } catch {}
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={16}>
                <SectionCard title="How to use" desc="Two buttons sit after the reactions of a message.">
                    <Pill tiles={['add']} text="Hold to react with every emoji" />
                    <Pill tiles={['aa']} text="Tap to react with a word" />
                    <Pill tiles={['msg']} text="Or hold a message, then React with a word" />
                </SectionCard>
                <SectionCard title="Buttons">
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                        <ToggleHalf
                            tiles={['aa']}
                            label="Aa button"
                            value={look().wordButton}
                            onChange={v => {
                                set({ wordButton: v })
                                sendLook()
                            }}
                        />
                        <ToggleHalf
                            tiles={['add', 'aa']}
                            label="Square"
                            value={look().fitSize}
                            onChange={v => {
                                set({ fitSize: v })
                                sendLook()
                            }}
                        />
                    </View>
                </SectionCard>
                <SectionCard title="Timing">
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                        <NumberHalf label="Between reactions" value={wordDelay()} min={0} max={3000} onSave={n => set({ wordDelay: n })} />
                        <NumberHalf
                            label="Ignore taps after hold"
                            value={ignoreMs()}
                            min={100}
                            max={5000}
                            onSave={n => {
                                set({ ignoreMs: n })
                                sendIgnoreMs()
                            }}
                        />
                    </View>
                </SectionCard>
                <Button text="Copy log" variant="secondary" size="lg" onPress={copyLog} />
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: { ignoreMs: DEFAULT_IGNORE, wordDelay: DEFAULT_WORD_DELAY, fitSize: true, wordButton: true } },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        ;(callNativeMethod as any)(`${NATIVE}.ping`, [])
            .then((r: any) => {
                nativeOk = r === 'pong'
                if (nativeOk) {
                    sendIgnoreMs()
                    sendLook()
                }
            })
            .catch(() => (nativeOk = false))
        patchHandlers(cleanup)
        patchSheet(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
