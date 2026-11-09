import { ActionSheetActionCreators, AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule, getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'

/**
 * Reaction Words
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
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`reaction-words-${Date.now()}-${seq++}`, { text })
    } catch {}
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
async function run(label: string, jobs: Array<() => Promise<void>>) {
    if (busy) return toast('Still reacting, wait a moment')
    busy = true
    let ok = 0
    let fail = 0
    try {
        for (const job of jobs) {
            try {
                await job()
                ok++
            } catch {
                fail++
            }
            // 너무 빨리 달면 디스코드가 막는다
            await sleep(350)
        }
    } finally {
        busy = false
    }
    toast(fail ? `${label}: ${ok} added, ${fail} failed` : `${label}: ${ok} added`)
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
function spell(word: string, taken: Set<string>): { emojis: string[]; missing: string[] } {
    const used = new Set(taken)
    const emojis: string[] = []
    const missing: string[] = []
    for (const raw of word.toUpperCase()) {
        if (raw === ' ') continue
        const pick = choices(raw).find(e => !used.has(keyOf({ name: e })))
        if (!pick) {
            missing.push(raw)
            continue
        }
        used.add(keyOf({ name: pick }))
        emojis.push(pick)
    }
    return { emojis, missing }
}

function WordInput({ message, onChange }: { message: any; onChange: (v: string) => void }) {
    const { TextInput, Text } = D()
    const [v, setV] = useState('')
    const taken = new Set<string>((message?.reactions ?? []).filter((r: any) => r.me).map((r: any) => keyOf(r.emoji)))
    const { emojis, missing } = spell(v, taken)
    return (
        <View style={{ gap: 8 }}>
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
            <Text variant="text-lg/normal">{emojis.join(' ') || ' '}</Text>
            {missing.length ? <Text variant="text-sm/normal" color="text-danger">{`Can't use again: ${[...new Set(missing)].join(', ')}`}</Text> : null}
            {emojis.length > 20 ? <Text variant="text-sm/normal" color="text-danger">Messages can only have 20 different reactions</Text> : null}
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
        if (!p) return orig(copy)
        if (p.seq === handledSeq || !d?.messageId) return
        handledSeq = p.seq
        try {
            const result = inst.getMessageData?.(d.messageId)
            if (!result?.message || !result.messageChannel) return
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

// ── 설정 화면 (상태) ────────────────────────────────────────────

function SettingsPage() {
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TextInput, Button, Text } = D()
    storage?.use?.()
    const ms = ignoreMs()
    const [draft, setDraft] = useState(String(ms))
    const apply = (v: number) => {
        const n = Math.min(5000, Math.max(100, Math.round(v)))
        storage?.set?.({ ...(storage?.cache ?? {}), ignoreMs: n }, true)
        if (storage?.cache) storage.cache.ignoreMs = n
        setDraft(String(n))
        sendIgnoreMs()
    }
    const save = () => {
        const n = Number(draft)
        if (Number.isFinite(n) && n > 0) apply(n)
        else setDraft(String(ms))
    }
    const [st, setSt] = useState<any>(undefined)
    const refresh = () =>
        (callNativeMethod as any)(`${NATIVE}.status`, [])
            .then((r: any) => setSt(r ?? {}))
            .catch((e: any) => setSt({ error: `Android part not loaded: ${String(e?.message ?? e).slice(0, 300)}` }))
    useState(() => void refresh())
    const yes = (b: any) => (b ? 'yes' : 'no')
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={24}>
                <TableRowGroup title="How to use">
                    <TableRow label="React with a word" subLabel="Long press a message, then React with a word." />
                    <TableRow label="React with every emoji" subLabel="Long press the add reaction button at the end of the reactions." />
                    <TableRow label="Word button" subLabel="Tap Aa next to the add reaction button to react with a word." />
                </TableRowGroup>
                <TableRowGroup title="Buttons">
                    <TableSwitchRow
                        label="Word button"
                        subLabel="An Aa button next to the add reaction button. Tap it to react with a word."
                        value={look().wordButton}
                        onValueChange={(v: boolean) => {
                            storage?.set?.({ ...(storage?.cache ?? {}), wordButton: v }, true)
                            if (storage?.cache) storage.cache.wordButton = v
                            sendLook()
                        }}
                    />
                    <TableSwitchRow
                        label="Same size as reactions"
                        subLabel="Makes the add reaction button as tall as the reactions."
                        value={look().fitSize}
                        onValueChange={(v: boolean) => {
                            storage?.set?.({ ...(storage?.cache ?? {}), fitSize: v }, true)
                            if (storage?.cache) storage.cache.fitSize = v
                            sendLook()
                        }}
                    />
                </TableRowGroup>
                <TableRowGroup title="Delay">
                    <View style={{ padding: 12, gap: 8 }}>
                        <Text variant="text-md/semibold">{`Ignore reaction taps for ${ms} ms`}</Text>
                        <Text variant="text-sm/normal" color="text-muted">After the add reaction button long press (from the vibration). Too short and the first reaction can turn off, too long and your next tap is ignored.</Text>
                        <TextInput
                            value={draft}
                            placeholder={String(DEFAULT_IGNORE)}
                            keyboardType="number-pad"
                            onChange={(v: string) => setDraft(v.replace(/[^0-9]/g, ''))}
                            onSubmitEditing={save}
                            returnKeyType="done"
                        />
                        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                            {[600, 800, 1000, 1500, 2000].map(v => (
                                <Button key={v} text={`${v}`} size="sm" variant={ms === v ? 'primary' : 'secondary'} onPress={() => apply(v)} />
                            ))}
                            <Button text="Save" size="sm" variant="primary" onPress={save} />
                        </View>
                    </View>
                </TableRowGroup>
                <TableRowGroup title="Status">
                    {st === undefined ? (
                        <TableRow label="Checking…" />
                    ) : (
                        <>
                            <TableRow label="Android part" subLabel={st.rowHook === undefined ? 'Not loaded' : `Reactions row ${yes(st.rowHook)}, button touch ${yes(st.touchHook)}`} />
                            {st.rowHook !== undefined ? <TableRow label="Seen" subLabel={`${st.rows} reaction rows, ${st.touches} button touches, ${st.fires} presses, ${st.buttons ?? 0} word buttons`} /> : null}
                            {st.error ? <TableRow label="Last error" subLabel={String(st.error)} /> : null}
                        </>
                    )}
                    <TableRow label="Refresh" onPress={refresh} arrow />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: { ignoreMs: DEFAULT_IGNORE, fitSize: true, wordButton: true } },
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
