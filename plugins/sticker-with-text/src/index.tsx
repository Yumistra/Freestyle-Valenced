import { callNativeMethod } from '@valenced/modules/native'
import { ScrollView } from 'react-native'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { addPending, clearAllPending, getPending, setStickerModule, takePending } from './preview'
import { addToTray, fakeStickerId, removeFromTray, setTrayStickerModule, trayStatus } from './tray'

/**
 * Sticker With Text: 글을 써 두거나 파일을 붙여 둔 채로 스티커를 고르면 전부 한 메시지로 보낸다.
 * 디스코드는 스티커를 고르면 sendStickers(채널, [스티커], 글, 옵션) 를 부르는데
 * 모바일은 글 자리를 비워 보낸다. 여기에 입력창의 글을 넣고, 입력창은 비운다.
 */

interface Settings {
    enabled: boolean
    /** wait: 입력창 위에 올려 두고 보낼 때 같이, now: 고르면 바로 (글, 파일과 함께) */
    mode: 'wait' | 'now'
    /** 붙여 둔 사진, 영상, 파일도 같이 */
    files: boolean
    /** 스티커를 고른 뒤 키보드를 올리지 않는다 */
    /** 사진 고르기처럼 스티커 고르기 창을 열어 둔다 (여러 개 고르기, 다시 누르면 빼기) */
    keepOpen: boolean
}
const DEFAULTS: Settings = { enabled: true, mode: 'wait', files: true, keepOpen: true }
let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

/** 채팅 메시지 임시 글 (DraftType.ChannelMessage) */
const CHANNEL_MESSAGE = 0

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

function draftOf(channelId: string): string {
    try {
        return String((Stores as any).DraftStore?.getDraft?.(channelId, CHANNEL_MESSAGE) ?? '')
    } catch {
        return ''
    }
}

/** 입력창 글을 디스코드가 보내는 모양으로 (멘션, 이모지 바꾸기) */
function parse(channelId: string, text: string): any {
    try {
        const P = find('parse', 'unparse')
        const channel = (Stores as any).ChannelStore?.getChannel?.(channelId)
        const m = P?.parse?.(channel, text)
        if (m && typeof m.content === 'string') return m
    } catch {}
    return { content: text, invalidEmojis: [], validNonShortcutEmojis: [], tts: false }
}

/** 입력창에 붙여 둔 사진, 영상, 파일 (아직 안 보낸 것) */
function uploadsOf(channelId: string): any[] {
    try {
        const u = (Stores as any).UploadAttachmentStore?.getUploads?.(channelId, CHANNEL_MESSAGE)
        return Array.isArray(u) ? u : []
    } catch {
        return []
    }
}

/** 붙여 둔 파일 목록을 비운다 (보낸 뒤) */
function clearUploads(channelId: string) {
    try {
        find('clearAll', 'addFiles')?.clearAll?.(channelId, CHANNEL_MESSAGE) ?? find('clearAll', 'popFirstFile')?.clearAll?.(channelId, CHANNEL_MESSAGE)
    } catch {}
}

/** 보낸 뒤 입력창과 임시 글을 비운다 */
function clearInput(channelId: string) {
    try {
        find('clearDraft', 'saveDraft')?.clearDraft?.(channelId, CHANNEL_MESSAGE)
    } catch {}
    try {
        const ref = find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
        if (typeof ref?.clearText === 'function') ref.clearText()
        else ref?.setText?.('')
    } catch {}
}

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const s = settings()
    const { Stack, TableRowGroup, TableRow, TableSwitchRow, TableRadioGroup, TableRadioRow } = Design as any
    const set = (patch: Partial<Settings>) => storage?.set({ ...settings(), ...patch }, true)
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }}>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="StickerIcon" />}
                        label="Sticker With Text"
                        value={s.enabled}
                        onValueChange={(enabled: boolean) => set({ enabled })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AttachmentIcon" />}
                        label="Include attached files"
                        value={s.files}
                        onValueChange={(files: boolean) => set({ files })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="StickerIcon" />}
                        label="Keep the sticker picker open"
                        value={s.keepOpen}
                        onValueChange={(keepOpen: boolean) => set({ keepOpen })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="When you pick a sticker" defaultValue={s.mode} onChange={(mode: Settings['mode']) => set({ mode })}>
                    <TableRadioRow
                        label="Put it above the chat bar"
                        value="wait"
                    />
                    <TableRadioRow label="Send right away" value="now" />
                </TableRadioGroup>
                <TableRowGroup title="Status">
                    <TableRow
                        icon={<TableRowAssetIcon name="InfoIcon" />}
                        label="Last sticker pick"
                        subLabel={seenPath.last ? `Caught through ${seenPath.last}${seenPath.shown ? `. ${seenPath.shown}` : ''}${trayStatus.renderer ? `. Animated sticker drawn by ${trayStatus.renderer}` : ''}` : 'No sticker picked yet since Discord started.'}
                    />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

/** 우리가 만든 보내기에 붙이는 표시 (우리 훅이 다시 건드리지 않게) */
const OURS = '__stickerWithText'
const ours = (o: any) => !!o?.[OURS]

/** 진단: 스티커를 고르면 디스코드가 어느 함수로 보내는지 */
export const seenPath = { last: '', shown: '' }

const emptyMessage = (m: any) => m == null || m === '' || (typeof m === 'string' ? !m.trim() : !String(m?.content ?? '').trim())

/** 디스코드 보내기 함수들 (MessageActionCreators) */
let actions: any

/** 써 둔 글 + 붙여 둔 파일 + 스티커를 한 메시지로 (디스코드 채팅 보내기와 같은 방식: sendMessage 에 attachmentsToUpload) */
function sendTogether(channelId: string, ids: string[], options: any, fallback?: () => any) {
    const text = draftOf(channelId)
    const all = settings().files ? uploadsOf(channelId) : []
    const { rest: files, ids: more } = splitFakes(all)
    ids = [...ids, ...more].filter((x, i, a) => a.indexOf(x) === i)
    if (!actions?.sendMessage) return fallback?.()
    // 디스코드도 보내기 전에 파일 목록과 입력창을 먼저 비운다
    if (all.length) clearUploads(channelId)
    if (text.trim()) clearInput(channelId)
    const message = text.trim() ? parse(channelId, text) : { content: '', tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }
    const opts: any = { ...(options ?? {}), stickerIds: ids.slice(0, 3), [OURS]: true }
    delete opts.attachmentsToUpload
    if (files.length) opts.attachmentsToUpload = files
    return actions.sendMessage(channelId, message, undefined, opts)
}

/** 보낼 파일 목록에서 우리 스티커를 빼내 스티커 ID 로 */
function splitFakes(list: any): { rest: any[]; ids: string[] } {
    const rest: any[] = []
    const ids: string[] = []
    for (const u of Array.isArray(list) ? list : []) {
        const id = fakeStickerId(u)
        if (id) ids.push(id)
        else rest.push(u)
    }
    return { rest, ids }
}

/** 스티커를 골랐을 때. 디스코드 대신 우리가 처리했으면 true */
function onPick(channelId: string, ids: string[], options: any, held = false): Promise<any> | undefined {
    const s = settings()
    if (!s.enabled || !ids.length) return
    const rest = { ...(options ?? {}) }
    delete rest.stickerIds
    if (s.mode === 'wait') {
        // 바로 보내지 않고 사진처럼 "보낼 파일" 줄에 올려 둔다.
        // 못 올리면 안 보이는 대기열에 두고 다음 메시지에 붙인다.
        ;(async () => {
            for (const id of ids) {
                // 사진 고르기처럼: 이미 올린 스티커를 다시 누르면 뺀다
                if (held && removeFromTray(channelId, id)) continue
                const ok = await addToTray(channelId, id)
                if (!ok) addPending(channelId, [id], rest)
            }
            seenPath.shown = trayStatus.last
        })()
        return Promise.resolve()
    }
    const files = s.files ? uploadsOf(channelId) : []
    if (draftOf(channelId).trim() || files.length) return Promise.resolve(sendTogether(channelId, ids, rest))
}

/** 디스코드가 비운 입력창에 글을 다시 넣는다 (비우는 일이 끝난 뒤) */
/** 디스코드 입력창 (getBestActiveInputForChannelId) */
const inputOf = (channelId: string): any => {
    try {
        return find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
    } catch {}
}

/**
 * 스티커를 고른 바로 그 순간에만 입력창의 비우기(clearText)와 닫기(dismissKeyboard)를 아무 일도 안 하게 한다.
 * 디스코드가 스티커를 보낸 뒤 같은 흐름 안에서 부르므로, 다음 틱에 원래대로 돌린다.
 */
/** 스티커를 고른 직후 잠깐 폰 글자 키보드가 아예 뜨지 않게 한다 (네이티브 부분) */
function blockIme() {
    try {
        ;(callNativeMethod as any)('yumistra.sticker-with-text.suppressIme', [1200])?.catch?.(() => {})
    } catch {}
}

/** DM 첫 화면의 "손 흔들기" 버튼이 보내는 웨이브 스티커는 건드리지 않는다 */
function isWave(ids: any[], options: any) {
    return ids.length === 1 && (String(ids[0]) === '749054660769218631' || /wave/i.test(String(options?.location ?? '')))
}

/** 스티커를 고른 그 순간 (디스코드의 키보드 닫기를 건너뛴다) */
let holding = false
/** 이번 고르기에서 디스코드의 글 지우기를 막았는지 (막았으면 글을 다시 넣지 않는다) */
let clearSkipped = false
function holdInput(channelId: string): boolean {
    // ChatInputUtils.dismissKeyboard 는 고르기 창을 닫고 키보드를 글자 키보드(SYSTEM)로 바꾼다. 이번만 막는다
    holding = true
    setTimeout(() => (holding = false), 0)
    // 디스코드가 스티커를 고른 뒤 부르는 입력창(chatInputRef.current)의 clearText, dismissKeyboard 를 이번만 막는다.
    // clearText 가 글을 지웠다 다시 넣으면 폰 키보드가 잠깐 올라온다
    clearSkipped = false
    const mod = find('getBestActiveInputForChannelId')
    const refs = new Set<any>()
    const add = (r: any) => {
        if (r && typeof r === 'object') {
            if (typeof r.clearText === 'function' || typeof r.dismissKeyboard === 'function') refs.add(r)
            if (r.current && typeof r.current === 'object') add(r.current)
        }
    }
    try {
        add(mod?.getBestActiveInputForChannelId?.(channelId))
    } catch {}
    for (const f of ['getChatInputRef', 'getActiveChatInputRef', 'getChatInputRefForChannelId'])
        try {
            add(mod?.[f]?.(channelId))
        } catch {}
    const saved: Array<[any, string, any]> = []
    for (const ref of refs)
        for (const key of ['dismissKeyboard', 'clearText']) {
            if (typeof ref[key] !== 'function') continue
            const fn = ref[key]
            try {
                ref[key] = () => {
                    if (key === 'clearText') clearSkipped = true
                }
                if (ref[key] !== fn) saved.push([ref, key, fn])
            } catch {}
        }
    setTimeout(() => {
        for (const [ref, key, fn] of saved)
            try {
                ref[key] = fn
            } catch {}
    }, 0)
    return saved.length > 0 || keyboardPatched
}

let keyboardPatched = false
const heldMods: Record<string, WeakSet<object>> = {}

function restoreText(channelId: string, text: string, held = false) {
    const put = () => {
        try {
            find('saveDraft', 'clearDraft')?.saveDraft?.(channelId, text, CHANNEL_MESSAGE)
        } catch {}
        // 글이 그대로 남아 있으면 다시 넣지 않는다 (다시 넣으면 폰 키보드가 올라올 수 있다)
        if (!(held && clearSkipped))
            try {
                const ref = find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
                if (typeof ref?.setText === 'function') ref.setText(text)
            } catch {}
    }
    setTimeout(put, 0)
    // 키보드가 닫히며 한 번 더 비울 수 있어 조금 뒤에 다시 확인
    setTimeout(() => {
        if (!draftOf(channelId).trim()) put()
    }, 250)
}

/** 메시지를 보낼 때 올려 둔 스티커를 붙인다 */
function withPending(channelId: unknown, options: any) {
    if (typeof channelId !== 'string') return options
    const p = takePending(channelId)
    if (!p) return options
    const ids = [...(options?.stickerIds ?? []), ...p.ids].filter((x, i, a) => a.indexOf(x) === i).slice(0, 3)
    return { ...(p.options ?? {}), ...(options ?? {}), stickerIds: ids, [OURS]: true }
}

/** 올려 둔 스티커 옆 보내기 버튼 (글이나 파일이 있으면 같이) */
function sendPendingNow(channelId: string) {
    const p = takePending(channelId)
    if (!p) return
    try {
        sendTogether(channelId, p.ids, p.options)
    } catch {}
}

/** 보내기 함수 훅 하나: msgAt 은 메시지, optAt 은 옵션 자리 */
function sendHook(name: string, msgAt: number, optAt: number) {
    return function (this: unknown, args: any[], orig: (...a: any[]) => any) {
        try {
            const channelId = args[0]
            const opt = args[optAt]
            // 보낼 파일 중 우리 스티커 → 스티커 ID 로 바꿔서 보낸다
            const fakes = typeof channelId === 'string' && !ours(opt) ? splitFakes(opt?.attachmentsToUpload) : { rest: [], ids: [] }
            if (fakes.ids.length) {
                const next = [...args]
                const o: any = withPending(channelId, opt) ?? {}
                const ids = [...(o.stickerIds ?? []), ...fakes.ids].map(String).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3)
                const merged: any = { ...o, stickerIds: ids, [OURS]: true }
                if (fakes.rest.length) merged.attachmentsToUpload = fakes.rest
                else delete merged.attachmentsToUpload
                next[optAt] = merged
                return orig.apply(this, next)
            }
            if (typeof channelId === 'string' && !ours(opt) && settings().enabled) {
                const ids: string[] = Array.isArray(opt?.stickerIds) ? opt.stickerIds.map(String) : []
                // 스티커만 보내는 것 = 스티커를 고른 것
                if (ids.length && emptyMessage(args[msgAt]) && !opt?.attachmentsToUpload?.length) {
                    seenPath.last = name
                    const r = onPick(channelId, ids, opt)
                    if (r) return r
                } else if (getPending(channelId)) {
                    // 보내기 버튼으로 글, 파일을 보낼 때 올려 둔 스티커도 같이
                    const next = [...args]
                    next[optAt] = withPending(channelId, opt)
                    return orig.apply(this, next)
                }
            }
        } catch {}
        return orig.apply(this, args)
    }
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        cleanup(() => clearAllPending())
        const done = new WeakSet<object>()
        cleanup(
            getModules(withProps('sendStickers', 'sendMessage') as any, (mod: any) => {
                if (done.has(mod)) return
                done.add(mod)
                actions ??= mod
                if (typeof mod.sendStickers === 'function')
                    cleanup(
                        instead(mod, 'sendStickers', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                            try {
                                const [channelId, stickerIds, content, options] = args
                                // 디스코드는 스티커를 고르면 입력창 글을 같이 넣어 sendStickers 를 부르고, 입력창을 비운다
                                if (typeof channelId === 'string' && Array.isArray(stickerIds) && !ours(options) && !isWave(stickerIds, options) && settings().enabled) {
                                    seenPath.last = 'sendStickers'
                                    const s = settings()
                                    if (s.mode === 'wait') {
                                        // 글은 입력창에 그대로 돌려 두고, 스티커만 올려 둔다
                                        const text = draftOf(channelId) || (typeof content === 'string' ? content : String(content?.content ?? ''))
                                        // 디스코드는 이 다음에 입력창을 비우고(clearText) 고르기 창을 닫는다(dismissKeyboard). 이번만 막는다
                                        blockIme()
                                        const held = s.keepOpen && holdInput(channelId)
                                        const r = onPick(channelId, stickerIds.map(String), options, held)
                                        if (text.trim()) restoreText(channelId, text, held)
                                        if (r) return r
                                    } else {
                                        // 바로 보내기: 디스코드가 글은 이미 넣었으니 붙여 둔 파일만 더한다
                                        const all = s.files ? uploadsOf(channelId) : []
                                        const { rest: files, ids: more } = splitFakes(all)
                                        if (files.length || more.length) {
                                            const next = [...args]
                                            next[1] = [...stickerIds.map(String), ...more].filter((x, i, a) => a.indexOf(x) === i).slice(0, 3)
                                            const o: any = { ...(options ?? {}), [OURS]: true }
                                            if (files.length) o.attachmentsToUpload = files
                                            next[3] = o
                                            clearUploads(channelId)
                                            return orig.apply(this, next)
                                        }
                                    }
                                }
                            } catch {}
                            return orig.apply(this, args)
                        }),
                    )
                // sendMessage(채널, 메시지, 기다리기, 옵션), _sendMessage(채널, 메시지, 옵션)
                if (typeof mod.sendMessage === 'function') cleanup(instead(mod, 'sendMessage', sendHook('sendMessage', 1, 3)))
                if (typeof mod._sendMessage === 'function') cleanup(instead(mod, '_sendMessage', sendHook('_sendMessage', 1, 2)))
            }) as any,
        )
        // 입력창 도구 (ChatInputUtils): 스티커를 고른 순간에는 키보드 닫기를 건너뛴다
        cleanup(
            // 스티커를 고른 뒤 디스코드는 입력창의 dismissKeyboard 를 부르고, 그 안에서
            // dismissGlobalKeyboard, closeCustomKeyboard 가 setKeyboardType(SYSTEM) 으로 글자 키보드를 연다.
            // 고른 그 순간에만 이 모듈 함수들을 건너뛰면 고르기 창이 그대로 남는다
            ...(['setKeyboardType', 'dismissGlobalKeyboard', 'closePortalKeyboardRequest', 'dismissKeyboard'] as const).map(name =>
                getModules(withProps(name) as any, (mod: any) => {
                    if (typeof mod?.[name] !== 'function') return
                    const done = (heldMods[name] ??= new WeakSet())
                    if (done.has(mod)) return
                    done.add(mod)
                    keyboardPatched = true
                    cleanup(
                        instead(mod, name, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                            if (holding && settings().keepOpen) return undefined
                            return orig.apply(this, args)
                        }),
                        () => done.delete(mod),
                    )
                }),
            ),
        )
        // 스티커 그리는 디스코드 부품 ({ default: Sticker, getStickerAssetUrl })
        cleanup(
            getModules(withProps('getStickerAssetUrl') as any, (m: any) => {
                if (typeof m?.default === 'function') {
                    setStickerModule(m)
                    setTrayStickerModule(m)
                }
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
