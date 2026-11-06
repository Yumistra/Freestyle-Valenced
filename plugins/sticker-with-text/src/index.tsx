import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { View } from 'react-native'
import { addPending, clearAllPending, getPending, PendingStickers, setStickerModule, takePending } from './preview'

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
}
const DEFAULTS: Settings = { enabled: true, mode: 'wait', files: true }
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
        <Page>
            <Stack spacing={24}>
                <TableRowGroup>
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="StickerIcon" />}
                        label="Sticker With Text"
                        subLabel="Stickers go out together with your text and attached files."
                        value={s.enabled}
                        onValueChange={(enabled: boolean) => set({ enabled })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="AttachmentIcon" />}
                        label="Include attached files"
                        subLabel="Photos, videos and files you attached go out in the same message as the sticker."
                        value={s.files}
                        onValueChange={(files: boolean) => set({ files })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="When you pick a sticker" defaultValue={s.mode} onChange={(mode: Settings['mode']) => set({ mode })}>
                    <TableRadioRow
                        label="Put it above the chat bar"
                        subLabel="Like a photo: it waits above the chat bar and goes out when you press send. Tap × to take it off, or the send button next to it to send just the sticker. Up to 3 stickers."
                        value="wait"
                    />
                    <TableRadioRow label="Send right away" subLabel="It goes out at once, with whatever you typed or attached." value="now" />
                </TableRadioGroup>
                <TableRowGroup title="Status">
                    <TableRow
                        icon={<TableRowAssetIcon name="InfoIcon" />}
                        label="Last sticker pick"
                        subLabel={seenPath.last ? `Caught through ${seenPath.last}${seenPath.shown ? `, shown ${seenPath.shown}` : ''}` : 'No sticker picked yet since Discord started.'}
                    />
                    <TableRow
                        icon={<TableRowAssetIcon name={status.carousel ? 'CheckmarkLargeIcon' : 'WarningIcon'} />}
                        label="Chat bar"
                        subLabel={`${status.carousel ? 'Sticker spot found' : 'Sticker spot not found yet (open a chat once)'}, send button ${status.sendButton ? 'found' : 'not found yet'}`}
                    />
                </TableRowGroup>
            </Stack>
        </Page>
    )
}

/** 우리가 만든 보내기에 붙이는 표시 (우리 훅이 다시 건드리지 않게) */
const OURS = '__stickerWithText'
const ours = (o: any) => !!o?.[OURS]

/** 진단: 스티커를 고르면 디스코드가 어느 함수로 보내는지 */
export const seenPath = { last: '', shown: '' }
const status = { carousel: false, sendButton: false }

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

// ── 스티커를 사진처럼 입력창 위 "보낼 파일" 칸에 올리기 ─────────────────────────
// 디스코드 사진 고르기와 같은 모양의 항목(mediaNodeToUploadItem)을 addFile 로 넣는다.
// 그림 주소 끝에 표시(swt=1)를 달아 두고, 보낼 때 그 항목은 빼고 스티커 ID 로 바꾼다.
const MARK = 'swt=1'
const FAKE = /\/stickers\/(\d+)\.\w+\?[^#]*swt=1/

function stickerUri(id: string) {
    let format: number | undefined
    try {
        format = (Stores as any).StickersStore?.getStickerById?.(id)?.format_type
    } catch {}
    return { uri: `https://media.discordapp.net/stickers/${id}.${format === 4 ? 'gif' : 'png'}?size=160&${MARK}`, mime: format === 4 ? 'image/gif' : 'image/png' }
}

/** 올려 둔 파일 하나가 우리 스티커면 그 ID */
function fakeStickerId(u: any): string | undefined {
    for (const v of [u?.item?.uri, u?.item?.originalUri, u?.uri, u?.item?.file?.uri, u?.file?.uri]) {
        const m = typeof v === 'string' ? FAKE.exec(v) : null
        if (m) return m[1]
    }
}

function addStickerUploads(channelId: string, ids: string[]): boolean {
    const add = find('addFile', 'addFiles')
    if (typeof add?.addFile !== 'function') return false
    const platform = find('UploadPlatform')?.UploadPlatform?.REACT_NATIVE ?? 1
    const origin = find('UploadOrigin')?.UploadOrigin?.IMAGE_PICKER
    // 이미 올린 스티커는 다시 안 넣는다, 한 메시지에 3개까지
    const have = uploadsOf(channelId).map(fakeStickerId).filter(Boolean) as string[]
    let added = false
    for (const id of ids) {
        if (have.includes(id) || have.length >= 3) continue
        const { uri, mime } = stickerUri(id)
        const item: any = { id: `swt-${id}-${Date.now()}`, uri, originalUri: uri, mimeType: mime, width: 160, height: 160, filename: `sticker-${id}.${mime === 'image/gif' ? 'gif' : 'png'}`, platform }
        if (origin != null) item.origin = origin
        add.addFile({ file: item, channelId, draftType: CHANNEL_MESSAGE, allowOptimization: false })
        have.push(id)
        added = true
    }
    return added || have.length > 0
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
function onPick(channelId: string, ids: string[], options: any): Promise<any> | undefined {
    const s = settings()
    if (!s.enabled || !ids.length) return
    const rest = { ...(options ?? {}) }
    delete rest.stickerIds
    if (s.mode === 'wait') {
        // 바로 보내지 않고 사진처럼 입력창 위에 올려 둔다 (안 되면 우리 칸에)
        // (디스코드 파일 칸에 넣는 방식은 폰에서 안 보여서 쓰지 않는다: addStickerUploads)
        addPending(channelId, ids, rest)
        seenPath.shown = status.carousel ? 'above the chat bar' : 'nowhere yet (chat bar part not found)'
        return Promise.resolve()
    }
    const files = s.files ? uploadsOf(channelId) : []
    if (draftOf(channelId).trim() || files.length) return Promise.resolve(sendTogether(channelId, ids, rest))
}

/** 디스코드가 비운 입력창에 글을 다시 넣는다 (비우는 일이 끝난 뒤) */
function restoreText(channelId: string, text: string) {
    const put = () => {
        try {
            find('saveDraft', 'clearDraft')?.saveDraft?.(channelId, text, CHANNEL_MESSAGE)
        } catch {}
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
                                if (typeof channelId === 'string' && Array.isArray(stickerIds) && !ours(options) && settings().enabled) {
                                    seenPath.last = 'sendStickers'
                                    const s = settings()
                                    if (s.mode === 'wait') {
                                        // 글은 입력창에 그대로 돌려 두고, 스티커만 올려 둔다
                                        const text = draftOf(channelId) || (typeof content === 'string' ? content : String(content?.content ?? ''))
                                        const r = onPick(channelId, stickerIds.map(String), options)
                                        if (text.trim()) restoreText(channelId, text)
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
        // 스티커 그리는 디스코드 부품 ({ default: Sticker, getStickerAssetUrl })
        cleanup(
            getModules(withProps('getStickerAssetUrl') as any, (m: any) => {
                if (typeof m?.default === 'function') setStickerModule(m)
            }) as any,
        )
        // 입력창 위 사진 칸 앞에 올려 둔 스티커를 그린다.
        // 디스코드는 이 부품들을 React.memo 로 감싸 내보내므로 안쪽 함수(type)를 바꾼다.
        // 아직 안 불린 모듈이면 불릴 때까지 기다린다.
        const onModule = (path: string, fn: (m: any) => void) =>
            cleanup(
                getModuleWithImportedPath(path, (m: any) => {
                    if (m) fn(m)
                    else cleanup(waitForModuleWithImportedPath(path, (x: any) => fn(x)) as any)
                }) as any,
            )
        /** 내보낸 부품(함수 또는 memo)의 렌더 함수를 감싼다 */
        const wrapRender = (m: any, wrap: (args: any[], tree: any) => any) => {
            const d = m?.default
            if (!d || patched.has(d)) return false
            patched.add(d)
            if (typeof d === 'function') cleanup(after(m, 'default', wrap))
            else if (typeof d.type === 'function') cleanup(after(d, 'type', wrap))
            else if (typeof d.type?.render === 'function') cleanup(after(d.type, 'render', wrap))
            else return false
            return true
        }
        onModule('modules/chat_input/native/accessories/ChatInputImageCarousel.tsx', m => {
            status.carousel = wrapRender(m, (args: any[], tree: any) => {
                const channelId = args?.[0]?.channelId
                if (!channelId) return tree
                return (
                    <View>
                        <PendingStickers channelId={String(channelId)} onSend={() => sendPendingNow(String(channelId))} />
                        {tree}
                    </View>
                )
            })
        })
        // 스티커만 올려 둬도 보내기 버튼이 켜지게 (사진을 올려 뒀을 때처럼)
        onModule('modules/chat_input/native/accessories/ChatInputSendButton.tsx', m => {
            const d = m?.default
            const target = typeof d === 'function' ? m : typeof d?.type === 'function' ? d : undefined
            const key = typeof d === 'function' ? 'default' : 'type'
            if (!target || patched.has(target[key])) return
            patched.add(target[key])
            cleanup(
                instead(target, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    try {
                        const props = args[0]
                        const id = props?.channel?.id
                        if (id && getPending(String(id)) && !props.hasPendingAttachments) {
                            const next = [...args]
                            next[0] = { ...props, hasPendingAttachments: true }
                            return orig.apply(this, next)
                        }
                    } catch {}
                    return orig.apply(this, args)
                }),
            )
            status.sendButton = true
        })
    },
    SettingsComponent: SettingsPage,
} as any)

const patched = new WeakSet<object>()
