import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
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
        let ok = false
        try {
            ok = addStickerUploads(channelId, ids)
        } catch {}
        if (!ok) addPending(channelId, ids, rest)
        seenPath.shown = ok ? 'with your photos' : 'in its own row'
        return Promise.resolve()
    }
    const files = s.files ? uploadsOf(channelId) : []
    if (draftOf(channelId).trim() || files.length) return Promise.resolve(sendTogether(channelId, ids, rest))
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
                                if (typeof channelId === 'string' && Array.isArray(stickerIds) && emptyMessage(content) && !ours(options)) {
                                    seenPath.last = 'sendStickers'
                                    const r = onPick(channelId, stickerIds.map(String), options)
                                    if (r) return r
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
        // 입력창 위 사진 칸 앞에 올려 둔 스티커를 그린다
        cleanup(
            getModuleWithImportedPath('modules/chat_input/native/accessories/ChatInputImageCarousel.tsx', (m: any) => patchCarousel(m)) as any,
            getModules(withName('ChatInputImageCarousel') as any, (m: any) => patchCarousel(m), { returnNamespace: true } as any) as any,
        )
        function patchCarousel(m: any) {
            if (!m || typeof m.default !== 'function' || patched.has(m)) return
            patched.add(m)
            cleanup(
                after(m, 'default', (args: any[], tree: any) => {
                    const channelId = args?.[0]?.channelId
                    if (!channelId) return tree
                    return (
                        <View>
                            <PendingStickers channelId={String(channelId)} onSend={() => sendPendingNow(String(channelId))} />
                            {tree}
                        </View>
                    )
                }),
            )
        }
    },
    SettingsComponent: SettingsPage,
} as any)

const patched = new WeakSet<object>()
