import { ActionSheetActionCreators, AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, Text as RNText, View } from 'react-native'
import { EMOJI_COLORS } from './colors'
import { EmojiTile } from './redesign'
import { settings, update } from './store'

/**
 * 채널을 꾹 누르면 나오는 창(ChannelLongPressActionSheet) 맨 위에 "Emoji" 줄을 넣는다.
 * 누르면 디스코드 이모지 고르기 창이 열리고, 고른 이모지가 그 채널의 아이콘이 된다 (나만 보인다).
 * 바꾼 채널이면 "Reset emoji" 줄도 넣는다.
 */

const SHEET = 'modules/channel/native/ChannelLongPressActionSheet.tsx'
const EMOJI = 'modules/emoji_picker/native/openEmojiPickerActionSheet.tsx'

let emojiFn: ((props: any) => void) | undefined
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

const EXPRESSION = 'modules/expression_picker/native/openExpressionPickerActionSheet.tsx'
let expressionFn: ((props: any) => void) | undefined

/** 경로로 모듈을 찾고, 아직 안 불렸으면 불러 본다 */
function load(path: string, name: string) {
    try {
        const [ex, id] = lookupModuleWithImportedPath(path) as any
        let m = ex
        if (!m && id !== undefined) m = (globalThis as any).__r?.(id)
        return firstFn(m, name)
    } catch {}
}

function openPicker(channel: any, onPick: (v: string) => void): boolean {
    emojiFn ??= load(EMOJI, 'openEmojiPickerActionSheet')
    expressionFn ??= load(EXPRESSION, 'openExpressionPickerActionSheet')
    const onPressEmoji = (e: any) => {
        const v = emojiValue(e)
        if (v) onPick(v)
    }
    if (emojiFn)
        try {
            emojiFn({ channel, onPressEmoji })
            return true
        } catch {}
    // 채팅 입력창의 이모지, GIF, 스티커 창 (이모지 탭만 쓴다)
    if (expressionFn)
        try {
            expressionFn({ channelId: channel.id, onPressEmoji, onPressGIF: () => {}, onPressSticker: () => {}, onDismiss: () => {} })
            return true
        } catch {}
    return false
}

let seq = 0
function toast(text: string) {
    try {
        ;(ToastActionCreators as any).open(`bcl-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const UNICODE = Object.keys(EMOJI_COLORS)

/**
 * 디스코드 이모지 창을 못 열 때 쓰는 창.
 * 위에 글칸(폰 이모지 자판으로 넣거나 붙여 넣기), 아래에 내 서버 이모지와 기본 이모지 목록.
 */
function Picker({ onPick }: { onPick: (v: string) => void }) {
    const { TextInput, Button, Text } = Design as any
    const [text, setText] = useState('')
    const servers = useMemo(() => {
        const out: any[] = []
        try {
            const S: any = Stores
            const guilds = Object.keys(S.GuildStore?.getGuilds?.() ?? {})
            for (const g of guilds) for (const e of S.EmojiStore?.getGuildEmoji?.(g) ?? []) if (e?.id && e.available !== false) out.push(e)
        } catch {}
        return out
    }, [])
    const q = text.trim().toLowerCase()
    const isEmoji = !!q && !/^[a-z0-9_]+$/i.test(q)
    const custom = (q && !isEmoji ? servers.filter(e => String(e.name).toLowerCase().includes(q)) : servers).slice(0, 120)
    const cell = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 } as const
    return (
        <View style={{ alignSelf: 'stretch', gap: 8 }}>
            <TextInput value={text} placeholder="Type an emoji or search server emojis" onChange={setText} isClearable />
            {isEmoji ? <Button text={`Use ${text.trim()}`} variant="primary" size="md" onPress={() => onPick(text.trim())} /> : null}
            <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4 }}>
                {custom.map(e => (
                    <Pressable key={e.id} accessibilityLabel={e.name} onPress={() => onPick(`<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)} style={({ pressed }: any) => ({ ...cell, opacity: pressed ? 0.5 : 1 })}>
                        <Image source={{ uri: `https://cdn.discordapp.com/emojis/${e.id}.png?size=48` }} style={{ width: 32, height: 32 }} resizeMode="contain" />
                    </Pressable>
                ))}
                {!q
                    ? UNICODE.map(u => (
                          <Pressable key={u} accessibilityLabel={u} onPress={() => onPick(u)} style={({ pressed }: any) => ({ ...cell, opacity: pressed ? 0.5 : 1 })}>
                              <RNText allowFontScaling={false} style={{ fontSize: 26 }}>
                                  {u}
                              </RNText>
                          </Pressable>
                      ))
                    : null}
                {q && !isEmoji && !custom.length ? (
                    <Text variant="text-sm/medium" color="text-muted" style={{ padding: 16 }}>
                        No server emojis found
                    </Text>
                ) : null}
            </ScrollView>
        </View>
    )
}

function openOwnPicker(channel: any) {
    const { AlertModal, AlertActionButton } = Design as any
    const key = `bcl-emoji-${seq++}`
    const done = (v: string) => {
        setIcon(channel.id, v)
        try {
            ;(AlertActionCreators as any).dismissAlert(key)
        } catch {}
    }
    try {
        ;(AlertActionCreators as any).openAlert(key, <AlertModal title={`Emoji for #${channel.name}`} extraContent={<Picker onPick={done} />} actions={<AlertActionButton text="Cancel" variant="secondary" />} />)
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
                if (!openPicker(channel, v => setIcon(channel.id, v)) && !openOwnPicker(channel)) toast('Could not open the emoji picker')
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
    bindOne(cleanup, EMOJI, m => (emojiFn = firstFn(m, 'openEmojiPickerActionSheet') ?? emojiFn))
    bindOne(cleanup, EXPRESSION, m => (expressionFn = firstFn(m, 'openExpressionPickerActionSheet') ?? expressionFn))
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
