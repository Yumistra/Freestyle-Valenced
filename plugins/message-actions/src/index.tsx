import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Constants } from '@valenced/discord/common/constants'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules, lookupModule, lookupModules } from '@valenced/modules/finders'
import { withDependencies, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'
import { useState } from 'react'
import { Image, ScrollView, View } from 'react-native'

/**
 * 내 메시지를 두 번 누르면 (기본: 반응 달기) 대신 가운데 작은 창으로 수정·삭제를 고르게 한다.
 *
 * 안드로이드 채팅 목록은 네이티브라 JS 에는 "어느 메시지를 두 번 눌렀는지"만 온다.
 * 채팅 화면마다 만들어지는 MessagesHandlers 인스턴스의 handleDoubleTapMessage 를 감싼다.
 * 창은 디스코드 AlertModal 이라 테마 색을 그대로 따라간다.
 *
 * 내 메시지를 왼쪽으로 세게 당기면 (디스코드: 바로 수정) 대신 그 메시지 밑에 수정·삭제 버튼을 띄울 수도 있다.
 * 당기기는 handleEdit(message, channel, chatInputRef, 'message_swipe', true) 로 오고,
 * 버튼은 네이티브(plugin.jar)가 손가락이 닿은 메시지 줄 밑에 띄운다.
 */

const NATIVE_ID = 'yumistra.message-actions'

type Mode = 'buttons' | 'dialog' | 'default'
interface Settings {
    /** 세게 당기기: buttons = 밑에 버튼, default = 바로 수정 (디스코드 기본) */
    swipe: 'buttons' | 'default'
    /** 두 번 누르기: dialog = 가운데 창, buttons = 밑에 버튼, default = 반응 달기 (디스코드 기본) */
    doubleTap: Mode
    /** 밑에 버튼에서 삭제는 한 번 더 눌러야 */
    confirmDelete: boolean
    /** (Edit Before Delete 에서 합침) 내 메시지를 지우기 전에 이 내용으로 먼저 수정 */
    editBeforeDelete: boolean
    text: string
    /** 수정과 삭제 사이 기다리는 시간 (ms) */
    delay: number
}
const DEFAULTS: Settings = { swipe: 'buttons', doubleTap: 'dialog', confirmDelete: true, editBeforeDelete: true, text: '** **', delay: 300 }
let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

const D = () => Design as any
const PREVIEW_PATH = 'modules/messages/native/long_press/LongPressMessageChatItemPreview.tsx'
/** 디스코드가 길게 누를 때·삭제 확인창에서 쓰는 메시지 미리보기 (아바타·이름·시간·내용, 테마 색) */
let ChatItemPreview: any

const PREVIEW_NAME = 'LongPressMessageChatItemPreview'
// 이 모듈이 가져오는 모듈 번호. 21·587·558·576·2 는 350.8 과 351.9 에서 같았고,
// 나머지는 경로로 번호를 알아낸다 (모르면 아무거나 허용). 이름으로 한 번 더 확인한다
const CREATE_STYLES_PATH = 'design/components/Styles/native/createStyles.tsx'
const ROW_GENERATOR_PATH = 'modules/messages/native/renderer/RowGenerator.tsx'
const CHAT_ITEM_PATH = 'components_native/chat/ChatItem.tsx'
const idOf = (path: string) => {
    try {
        return (lookupModuleWithImportedPath(path) as any)[1] ?? null
    } catch {
        return null
    }
}

function usePreviewExports(exports: any) {
    const C = exports?.default ?? exports
    if (C && (typeof C === 'function' || typeof C === 'object')) ChatItemPreview = C
}

/** 미리보기 컴포넌트를 확실히 준비한다 (디스코드가 아직 안 불러왔으면 직접 불러옴) */
function loadPreview() {
    if (ChatItemPreview) return
    try {
        const [exports] = lookupModuleWithImportedPath(PREVIEW_PATH) as any
        if (exports) return usePreviewExports(exports)
    } catch {}
    try {
        const deps = [21, idOf(CREATE_STYLES_PATH), 587, idOf(ROW_GENERATOR_PATH), 558, 576, idOf(CHAT_ITEM_PATH), 2]
        for (const [exports] of lookupModules(withDependencies(deps) as any) as any) {
            const C = exports?.default
            if (typeof C === 'function' && C.name === PREVIEW_NAME) {
                ChatItemPreview = C
                break
            }
        }
    } catch {}
}
let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`message-actions-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const find = (...props: string[]) => {
    try {
        return (lookupModule(withProps(...(props as [string])) as any) as any)[0]
    } catch {}
}

let snowflakeUtils: any
let editUtils: any
let messageActions: any
const mods = () => {
    snowflakeUtils ??= find('getNativeSyntheticEventData')
    editUtils ??= find('handleEdit', 'longPressMessageOptionHandler')
    messageActions ??= find('deleteMessage', 'startEditMessageRecord') ?? find('deleteMessage', 'sendMessage')
}

const MESSAGE_TYPES_EDITABLE = new Set([0, 19])

function isMine(message: any) {
    const me = (Stores as any).UserStore?.getCurrentUser?.()
    return !!me && message?.author?.id === me.id
}

/** 이 채널에서 남의 메시지를 지울 수 있는지 (메시지 관리 권한. DM 에서는 못 지운다) */
function canManageMessages(channel: any) {
    try {
        if (!channel?.id || channel.isPrivate?.() === true || channel.type === 1 || channel.type === 3) return false
        const flag = (Constants as any)?.Permissions?.MANAGE_MESSAGES
        if (flag == null) return false
        const ps = (Stores as any).PermissionStore
        if (typeof ps?.can === 'function') return !!ps.can(flag, channel)
        if (typeof ps?.canWithPartialContext === 'function') return !!ps.canWithPartialContext(flag, { channelId: channel.id })
    } catch {}
    return false
}

/** 버튼·창을 띄울 메시지: 내 메시지, 또는 지울 권한이 있는 남의 메시지 */
const actionable = (message: any, channel: any) => isMine(message) || canManageMessages(channel)

function previewOf(message: any) {
    const text = String(message?.content ?? '').trim()
    if (text) return text.length > 300 ? `${text.slice(0, 300)}…` : text
    const files = message?.attachments?.length ?? 0
    if (files) return `(${files} attachment${files === 1 ? '' : 's'})`
    if (message?.stickerItems?.length || message?.sticker_items?.length) return '(sticker)'
    return '(empty)'
}

/** 우리가 부르는 handleEdit 는 가로채지 않는다 */
let bypass = 0

function edit(handlers: any, message: any, channel: any, chatInputRef = handlers?.params?.chatInputRef, source = 'double_tap', extra: any[] = []) {
    mods()
    try {
        if (editUtils?.handleEdit && chatInputRef) {
            bypass++
            try {
                editUtils.handleEdit(message, channel, chatInputRef, source, ...extra)
            } finally {
                bypass--
            }
            return
        }
    } catch {}
    try {
        messageActions.startEditMessageRecord(channel.id, message)
        chatInputRef?.current?.openSystemKeyboard?.()
    } catch (e: any) {
        toast(`Couldn't edit: ${e?.message ?? e}`)
    }
}

async function remove(message: any, channel: any) {
    mods()
    try {
        await messageActions.deleteMessage(channel.id, message.id, false)
    } catch (e: any) {
        toast(`Couldn't delete${e?.body?.message ? `: ${e.body.message}` : ''}`)
    }
}

/** 디스코드 미리보기를 아직 못 불러왔을 때: 아바타 · 이름 · 내용 */
function FallbackPreview({ message, channel }: { message: any; channel: any }) {
    const { Text } = D()
    const author = message?.author
    let avatar: string | undefined
    try {
        avatar = author?.getAvatarURL?.(channel?.guild_id, 64)
    } catch {}
    const name = author?.globalName ?? author?.global_name ?? author?.username ?? ''
    return (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            {avatar ? <Image source={{ uri: avatar }} style={{ width: 36, height: 36, borderRadius: 18 }} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="text-md/semibold" color="text-strong" numberOfLines={1}>
                    {name}
                </Text>
                <Text variant="text-md/normal" color="text-default" numberOfLines={6}>
                    {previewOf(message)}
                </Text>
            </View>
        </View>
    )
}

function openActions(handlers: any, message: any, channel: any, chatInputRef?: any, source?: string, extra?: any[]) {
    loadPreview()
    const { AlertModal, AlertActionButton } = D()
    const editable = isMine(message) && editableOf(message)
    AlertActionCreators.openAlert(
        `message-actions-${seq++}`,
        <AlertModal
            title="Message"
            content={
                ChatItemPreview ? (
                    // 네이티브 메시지 뷰는 너비가 정해져야 글자를 그린다 (가운데 정렬 부모 안에서 너비 0이 되면 빈칸)
                    <View style={{ alignSelf: 'stretch', width: '100%', minWidth: 240, marginTop: 4 }}>
                        <ChatItemPreview message={message} />
                    </View>
                ) : (
                    <FallbackPreview message={message} channel={channel} />
                )
            }
            actions={
                <>
                    {editable && <AlertActionButton text="Edit" variant="primary" onPress={() => edit(handlers, message, channel, chatInputRef ?? handlers?.params?.chatInputRef, source, extra)} />}
                    <AlertActionButton text="Delete" variant="destructive" onPress={() => remove(message, channel)} />
                    <AlertActionButton text="Cancel" variant="secondary" />
                </>
            }
        />,
    )
}

const editableOf = (message: any) =>
    MESSAGE_TYPES_EDITABLE.has(message?.type ?? 0) && message?.state !== 'SEND_FAILED' && message?.state !== 'SENDING'

/** 테마 색 (#rrggbbaa → 안드로이드 #aarrggbb) */
function themeColor(names: string[], fallback: string) {
    try {
        const tokens: any = Tokens
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const name of names) {
            const key = tokens.default.colors[name]
            if (!key) continue
            const c = tokens.default.internal.resolveSemanticColor(theme, key)
            if (typeof c !== 'string') continue
            const hex = c.trim()
            if (/^#[0-9a-f]{6}$/i.test(hex)) return hex
            if (/^#[0-9a-f]{8}$/i.test(hex)) return `#${hex.slice(7, 9)}${hex.slice(1, 7)}`
            const m = hex.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
            if (m) {
                const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
                const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4])
                return `#${h(a * 255)}${h(+m[1])}${h(+m[2])}${h(+m[3])}`
            }
        }
    } catch {}
    return fallback
}

/** 디스코드 버튼 종류별 색 (Button 의 variant 와 같은 토큰) */
const VARIANTS: Record<string, string> = {
    primary: 'CONTROL_PRIMARY',
    secondary: 'CONTROL_SECONDARY',
    'critical-primary': 'CONTROL_CRITICAL_PRIMARY',
    'critical-secondary': 'CONTROL_CRITICAL_SECONDARY',
}
const FALLBACK: Record<string, [string, string]> = {
    primary: ['#5865f2', '#ffffff'],
    secondary: ['#4e5058', '#ffffff'],
    'critical-primary': ['#da373c', '#ffffff'],
    'critical-secondary': ['#4e5058', '#f23f43'],
}
function variantColors(variant: string) {
    const p = VARIANTS[variant] ?? VARIANTS.secondary
    const [bg, fg] = FALLBACK[variant] ?? FALLBACK.secondary
    const bgc = themeColor([`${p}_BACKGROUND_DEFAULT`], bg)
    const border = themeColor([`${p}_BORDER_DEFAULT`], '#00000000')
    return {
        bg: bgc,
        bgActive: themeColor([`${p}_BACKGROUND_ACTIVE`], bgc),
        border,
        borderActive: themeColor([`${p}_BORDER_ACTIVE`], border),
        fg: themeColor([`${p}_TEXT_DEFAULT`], fg),
    }
}

/** 디스코드 버튼 글자 (text-sm/semibold: 글꼴을 바꾸는 플러그인도 따라감) */
function buttonFont() {
    try {
        const style = D().TextStyleSheet?.['text-sm/semibold']
        if (style?.fontFamily) return { family: String(style.fontFamily), size: Number(style.fontSize) || 14 }
    } catch {}
    return { family: 'ggsans-Semibold', size: 14 }
}

function buttonRadius() {
    try {
        const t: any = (Tokens as any).default
        const r = t?.modules?.button?.BORDER_RADIUS ?? t?.radii?.sm
        if (typeof r === 'number' && r >= 0) return Math.min(r, 999)
    } catch {}
    return 8
}

const ICON = (name: string) => `design_components_icon_native_redesign_generated_images_${name}`

/** 네이티브가 없거나 메시지 줄을 못 찾으면 null */
async function showButtons(message: any): Promise<string | null> {
    const buttons: any[] = []
    if (isMine(message) && editableOf(message)) buttons.push({ id: 'edit', label: 'Edit', icon: ICON('pencilicon'), colors: variantColors('secondary') })
    buttons.push({
        id: 'delete',
        label: 'Delete',
        icon: ICON('trashicon'),
        colors: variantColors('critical-secondary'),
        confirm: settings().confirmDelete ? { label: 'Delete?', colors: variantColors('critical-primary') } : undefined,
    })
    const opts = { buttons, font: buttonFont(), radius: buttonRadius(), inset: 68 }
    try {
        const r = await Promise.resolve((callNativeMethod as any)(`${NATIVE_ID}.showActions`, [JSON.stringify(opts)]))
        if (r === 'norow' || typeof r !== 'string') return null
        return r
    } catch {
        return null
    }
}

/** 밑에 버튼으로 고르게 한다. 못 띄우면 가운데 창으로 */
async function inlineActions(handlers: any, message: any, channel: any, chatInputRef?: any, source?: string, extra?: any[]) {
    const choice = await showButtons(message)
    if (choice === null) return openActions(handlers, message, channel, chatInputRef, source, extra)
    if (choice === 'edit') edit(handlers, message, channel, chatInputRef, source, extra)
    else if (choice === 'delete') remove(message, channel)
}

/** MessagesHandlers 인스턴스의 두 번 누르기 처리를 감싼다 */
function wrapInstance(inst: any) {
    const orig = inst?.handleDoubleTapMessage
    if (typeof orig !== 'function' || orig.__messageActions) return
    const wrapped = function (this: unknown, event: any) {
        try {
            mods()
            const data = snowflakeUtils?.getNativeSyntheticEventData?.(event) ?? event?.nativeEvent ?? event
            const result = data?.messageId ? inst.getMessageData?.(data.messageId) : undefined
            const mode = settings().doubleTap
            if (mode !== 'default' && result?.message && result.messageChannel && actionable(result.message, result.messageChannel)) {
                if (mode === 'buttons') inlineActions(inst, result.message, result.messageChannel)
                else openActions(inst, result.message, result.messageChannel)
                return
            }
        } catch {}
        return orig.apply(this, arguments as any)
    }
    ;(wrapped as any).__messageActions = true
    inst.handleDoubleTapMessage = wrapped

    // 세게 당기기 (수정): 디스코드는 내 메시지만 수정으로 넘긴다. 지울 권한이 있는 남의 메시지면 밑에 버튼으로
    const origEdit = inst?.handleInitiateEdit
    if (typeof origEdit === 'function' && !origEdit.__messageActions) {
        const wrappedEdit = function (this: unknown, event: any) {
            try {
                mods()
                if (settings().swipe === 'buttons') {
                    const data = snowflakeUtils?.getNativeSyntheticEventData?.(event) ?? event?.nativeEvent ?? event
                    const result = data?.messageId ? inst.getMessageData?.(data.messageId) : undefined
                    const message = result?.message
                    const channel = result?.messageChannel
                    if (message && channel && !isMine(message) && canManageMessages(channel)) {
                        inlineActions(inst, message, channel, inst.params?.chatInputRef, 'message_swipe')
                        return
                    }
                }
            } catch {}
            return origEdit.apply(this, arguments as any)
        }
        ;(wrappedEdit as any).__messageActions = true
        inst.handleInitiateEdit = wrappedEdit
    }
}

/** 남의 메시지라도 지울 권한이 있으면 세게 당길 수 있게 (줄 데이터의 canEdit → 당기기 종류 REPLY_EDIT) */
function swipeRowPatch(args: any[]) {
    const row = args[0]
    if (!row || row.canEdit || !row.canReply || settings().swipe !== 'buttons') return args
    const message = row.message
    if (!message || isMine(message)) return args
    const channel = (Stores as any).ChannelStore?.getChannel?.(message.channel_id ?? message.getChannelId?.())
    if (!canManageMessages(channel)) return args
    return [{ ...row, canEdit: true }, ...args.slice(1)]
}

// ── 지우기 전에 수정 (Edit Before Delete) ─────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function shouldEditFirst(channelId: string, messageId: string, local: unknown) {
    if (local === true) return // 보내기 실패·전송 중인 메시지 (서버에 없음)
    const message = (Stores as any).MessageStore?.getMessage?.(channelId, messageId)
    if (!message || !isMine(message)) return
    if (message.state && message.state !== 'SENT') return
    if (message.poll) return // 투표는 수정할 수 없음
    return message
}

// ── 네이티브: 당길 때 보이는 아이콘 ────────────────────────────────

function syncNative() {
    try {
        Promise.resolve((callNativeMethod as any)(`${NATIVE_ID}.setSwipeButtons`, [settings().swipe === 'buttons'])).catch(() => {})
    } catch {}
}

function Choice<T extends string>({ title, value, options, onChange }: { title: string; value: T; options: [T, string, string?][]; onChange: (v: T) => void }) {
    const { TableRadioGroup, TableRadioRow } = D()
    return (
        <TableRadioGroup title={title} value={value} onChange={onChange}>
            {options.map(([v, label, sub]) => (
                <TableRadioRow key={v} value={v} label={label} subLabel={sub} />
            ))}
        </TableRadioGroup>
    )
}

function SettingsPage({ api }: { api: any }) {
    const { Stack, TableRowGroup, TableSwitchRow, TextInput } = D()
    storage ??= api?.jsonStorage
    const [s, setS] = useState<Settings>(settings)
    const save = async (patch: Partial<Settings>) => {
        const next = { ...s, ...patch }
        setS(next)
        try {
            await storage?.get?.()
        } catch {}
        await storage?.set({ ...(storage?.cache ?? {}), ...next }, true)
        syncNative()
    }
    return (
        <ScrollView style={{ flex: 1 }}>
            <Stack spacing={24} style={{ padding: 16, paddingBottom: 48 }}>
                <Choice
                    title="Swipe to edit"
                    value={s.swipe}
                    onChange={swipe => save({ swipe })}
                    options={[
                        ['buttons', 'Buttons'],
                        ['default', 'Default'],
                    ]}
                />
                <Choice
                    title="Double tap"
                    value={s.doubleTap}
                    onChange={doubleTap => save({ doubleTap })}
                    options={[
                        ['dialog', 'Dialog'],
                        ['buttons', 'Buttons'],
                        ['default', 'Default'],
                    ]}
                />
                <TableRowGroup title="Delete">
                    <TableSwitchRow label="Confirm" value={s.confirmDelete} onValueChange={(confirmDelete: boolean) => save({ confirmDelete })} />
                    <TableSwitchRow label="Edit before delete" value={s.editBeforeDelete} onValueChange={(editBeforeDelete: boolean) => save({ editBeforeDelete })} />
                </TableRowGroup>
                {s.editBeforeDelete && (
                    <Stack spacing={12}>
                        <TextInput label="Replace with" value={s.text} onChange={(text: string) => save({ text })} placeholder="** **" size="md" />
                        <TextInput
                            label="Delay (ms)"
                            value={String(s.delay)}
                            onChange={(v: string) => save({ delay: Math.max(0, Math.min(5000, Number(v.replace(/\D/g, '')) || 0)) })}
                            placeholder="300"
                            keyboardType="number-pad"
                            size="md"
                        />
                    </Stack>
                )}
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        // 저장된 설정을 다 불러온 뒤 네이티브에 알린다
        Promise.resolve(jsonStorage?.get?.()).then(syncNative, syncNative)
        cleanup(() => {
            try {
                Promise.resolve((callNativeMethod as any)(`${NATIVE_ID}.setSwipeButtons`, [false])).catch(() => {})
            } catch {}
        })
        // 지우기 전에 수정
        cleanup(
            getModules(withProps('editMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.deleteMessage !== 'function' || typeof mod?.editMessage !== 'function') return
                cleanup(
                    instead(mod, 'deleteMessage', async function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const [channelId, messageId, local] = args
                        try {
                            const { editBeforeDelete, text, delay } = settings()
                            const message = editBeforeDelete ? shouldEditFirst(channelId, messageId, local) : undefined
                            if (message && text && message.content !== text) {
                                await mod.editMessage(channelId, messageId, { content: text })
                                if (delay > 0) await sleep(delay)
                            }
                        } catch {
                            // 수정에 실패해도 삭제는 한다
                        }
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
        cleanup(
            getModuleWithImportedPath(PREVIEW_PATH, (exports: any) => usePreviewExports(exports)) as any,
        )
        // 플러그인을 켜기 전에 열려 있던 채팅 화면은 이미 만들어진 MessagesHandlers 를 쓰므로,
        // 그 안에서 부르는 "기본 반응 달기" 함수도 가로챈다 (입력창 참조가 없어 키보드는 직접 열어야 함)
        cleanup(
            getModules(withProps('handleAddDefaultDoubleTapReaction') as any, (mod: any) => {
                cleanup(
                    instead(mod, 'handleAddDefaultDoubleTapReaction', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            const [message, channel] = args
                            const mode = settings().doubleTap
                            if (mode !== 'default' && message && channel && actionable(message, channel)) {
                                if (mode === 'buttons') inlineActions(undefined, message, channel)
                                else openActions(undefined, message, channel)
                                return
                            }
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
        // 지울 권한이 있는 남의 메시지도 세게 당길 수 있게 (당기면 handleInitiateEdit → 위에서 밑에 버튼으로)
        cleanup(
            getModules(withProps('generateMessageRowData') as any, (mod: any) => {
                if (typeof mod?.generateMessageRowData !== 'function') return
                cleanup(
                    instead(mod, 'generateMessageRowData', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            args = swipeRowPatch(args)
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
        // 세게 당겨 수정하기 → 밑에 버튼
        cleanup(
            getModules(withProps('handleEdit', 'longPressMessageOptionHandler') as any, (mod: any) => {
                if (typeof mod?.handleEdit !== 'function') return
                editUtils ??= mod
                cleanup(
                    instead(mod, 'handleEdit', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            const [message, channel, chatInputRef, source] = args
                            if (!bypass && source === 'message_swipe' && settings().swipe === 'buttons' && message && channel && isMine(message)) {
                                inlineActions(undefined, message, channel, chatInputRef, source, args.slice(4))
                                return
                            }
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
        cleanup(
            getModules(withProps('MessagesHandlers') as any, (mod: any) => {
                const Orig = mod?.MessagesHandlers
                if (typeof Orig !== 'function' || Orig.__messageActions) return
                // 채팅 화면이 new MessagesHandlers(...) 할 때 만들어진 인스턴스를 바로 감싼다
                const Patched: any = function (this: unknown, ...args: any[]) {
                    const inst = Reflect.construct(Orig, args, Patched)
                    wrapInstance(inst)
                    return inst
                }
                Patched.prototype = Orig.prototype
                Patched.__messageActions = true
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
    },
    SettingsComponent: SettingsPage,
} as any)
