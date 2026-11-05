import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'

/**
 * Sticker With Text: 글을 써 두거나 파일을 붙여 둔 채로 스티커를 고르면 전부 한 메시지로 보낸다.
 * 디스코드는 스티커를 고르면 sendStickers(채널, [스티커], 글, 옵션) 를 부르는데
 * 모바일은 글 자리를 비워 보낸다. 여기에 입력창의 글을 넣고, 입력창은 비운다.
 */

interface Settings {
    enabled: boolean
    /** 붙여 둔 사진, 영상, 파일도 같이 */
    files: boolean
}
const DEFAULTS: Settings = { enabled: true, files: true }
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
    const { TableRowGroup, TableSwitchRow } = Design as any
    return (
        <Page>
            <TableRowGroup>
                <TableSwitchRow
                    icon={<TableRowAssetIcon name="StickerIcon" />}
                    label="Send text with stickers"
                    subLabel="Type a message, then pick a sticker: both go out as one message. With nothing typed, the sticker is sent alone as usual."
                    value={s.enabled}
                    onValueChange={(enabled: boolean) => storage?.set({ ...settings(), enabled }, true)}
                />
                <TableSwitchRow
                    icon={<TableRowAssetIcon name="AttachmentIcon" />}
                    label="Send attached files with stickers"
                    subLabel="Photos, videos and files you attached go out in the same message as the sticker."
                    value={s.files}
                    onValueChange={(files: boolean) => storage?.set({ ...settings(), files }, true)}
                />
            </TableRowGroup>
        </Page>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        const done = new WeakSet<object>()
        cleanup(
            getModules(withProps('sendStickers') as any, (mod: any) => {
                if (typeof mod?.sendStickers !== 'function' || done.has(mod)) return
                done.add(mod)
                cleanup(
                    instead(mod, 'sendStickers', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            const [channelId, stickerIds, content] = args
                            const empty = content == null || content === '' || (typeof content === 'object' && !String(content.content ?? '').trim())
                            if (settings().enabled && typeof channelId === 'string' && Array.isArray(stickerIds) && empty) {
                                const text = draftOf(channelId)
                                const files = settings().files ? uploadsOf(channelId) : []
                                if (text.trim() || files.length) {
                                    const next = [...args]
                                    if (text.trim()) next[2] = parse(channelId, text)
                                    // 붙여 둔 사진, 영상, 파일도 같은 메시지로 (디스코드가 파일 보낼 때 쓰는 그 자리)
                                    if (files.length) next[3] = { ...(args[3] ?? {}), attachmentsToUpload: files }
                                    const r = orig.apply(this, next)
                                    if (text.trim()) clearInput(channelId)
                                    if (files.length) clearUploads(channelId)
                                    return r
                                }
                            }
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
