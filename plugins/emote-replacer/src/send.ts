import { Dispatcher } from '@valenced/discord/common/flux'
import { Stores } from '@valenced/discord/flux'
import { FileModule } from '@valenced/discord/native'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { allEmotes } from './emotes'
import { fromBase64, parseModifiers, render } from './img'
import { settings } from './store'

/**
 * 보낼 때 바꾸기 (원래 플러그인과 같이).
 *  - ;이름 (와 .flip 같은 효과) → 이모트 그림 파일
 *  - 니트로 없이 못 쓰는 디스코드 이모지 → 이모지 그림 파일
 *  - 니트로 없이 못 보내는 스티커 → 스티커 그림
 * 그림은 크기를 맞추고 효과를 넣어 파일로 붙여 보낸다 (sendMessage 의 attachmentsToUpload).
 * 파일로 못 붙이면 [𝅙](주소) 숨은 링크로 보낸다 (효과는 빠진다).
 */

const S = () => Stores as any
const HIDDEN = '\u{1D159}'
const link = (url: string) => `[${HIDDEN}](${url})`
const esc = (s: string) => s.replace(/[-\\/^$*+?.()|[\]{}]/g, '\\$&')
const MAX_FILES = 10
/** 폰에서 작게 보이게 하는 판의 가로세로 비율 */
const WIDE = 8

export function hasNitro() {
    try {
        const u = S().UserStore?.getCurrentUser?.()
        return !!u && u.premiumType != null && u.premiumType !== 0
    } catch {
        return false
    }
}

export function guildOf(channelId: string): string | undefined {
    try {
        const g = S().ChannelStore?.getChannel?.(channelId)?.guild_id
        return g == null ? undefined : String(g)
    } catch {}
}

/** 코드 블록, 인라인 코드 밖에서만 바꾼다 */
function outsideCode(text: string, fn: (part: string) => string) {
    return text
        .split(/(```[\s\S]*?```|`[^`\n]*`)/)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join('')
}

/** 내가 들어가 있는 모든 서버의 커스텀 이모지 (이름 → 이모지 목록) */
export function discordEmojis(channelId?: string): Map<string, any[]> {
    const out = new Map<string, any[]>()
    const push = (e: any) => {
        if (!e?.id || !e?.name) return
        const list = out.get(e.name) ?? []
        if (!list.some(x => x.id === e.id)) list.push(e)
        out.set(e.name, list)
    }
    const eat = (v: any) => {
        if (!v) return
        const vals = v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : Object.values(v)
        for (const x of vals) {
            if (Array.isArray(x)) x.forEach(push)
            else if (x && Array.isArray(x.emojis)) x.emojis.forEach(push)
            else if (x && typeof x.getEmojis === 'function') x.getEmojis().forEach?.(push)
            else push(x)
        }
    }
    try {
        const store = S().EmojiStore
        const ctx = store?.getDisambiguatedEmojiContext?.(channelId ? guildOf(channelId) : undefined)
        eat(ctx?.getGroupedCustomEmoji?.())
        if (!out.size) eat(store?.getGuilds?.())
    } catch {}
    return out
}

/** 이 채널에서 니트로 없이 쓸 수 있는 이모지인지 */
function usable(e: any, here: string | undefined) {
    if (e?.available === false) return false
    if (hasNitro()) return true
    const g = e?.guildId ?? e?.guild_id
    return !e?.animated && g != null && String(g) === here
}

/** 디스코드 이모지 원본 그림 주소 (파일로 만들 때는 png, gif 로 받는다) */
export const emojiSource = (e: any, size = 128) => `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=${size}&quality=lossless`
const emojiLink = (e: any) => `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'webp'}?size=${settings().emoteSize}&quality=lossless&name=${encodeURIComponent(e.name)}`

interface Job {
    /** 본문에 넣은 자리 표시 */
    mark: string
    name: string
    /** 그림을 받을 주소 */
    source: string
    /** 파일로 못 만들 때 보낼 링크 주소 */
    fallback: string
    mods: Array<[string, string]>
}

interface Plan {
    text: string
    jobs: Job[]
}

/** 글에서 바꿀 것들을 찾아 자리 표시로 바꾼다 */
function plan(content: string, channelId: string): Plan {
    const s = settings()
    const emotes = allEmotes()
    const lower: Record<string, string> = {}
    for (const k of Object.keys(emotes)) lower[k.toLowerCase()] ??= k
    const here = guildOf(channelId)
    let discord: Map<string, any[]> | undefined
    const discordLower = new Map<string, string>()
    const discordFind = (name: string) => {
        if (!discord) {
            discord = discordEmojis(channelId)
            for (const k of discord.keys()) if (!discordLower.has(k.toLowerCase())) discordLower.set(k.toLowerCase(), k)
        }
        return discord.get(name) ?? discord.get(discordLower.get(name.toLowerCase()) ?? '')
    }
    const jobs: Job[] = []
    const mark = () => `\u0000${jobs.length}\u0000`
    const emojiJob = (list: any[], mods: Array<[string, string]>): string => {
        // 효과가 없고 여기서 쓸 수 있으면 진짜 이모지로
        const ok = !mods.length && list.find(e => usable(e, here))
        if (ok) return `<${ok.animated ? 'a' : ''}:${ok.name}:${ok.id}>`
        const e = list[0]
        const m = mark()
        jobs.push({ mark: m, name: e.name, source: emojiSource(e), fallback: emojiLink(e), mods })
        return m
    }
    const urlJob = (name: string, url: string, mods: Array<[string, string]>) => {
        const m = mark()
        jobs.push({ mark: m, name, source: url, fallback: url, mods })
        return m
    }
    // 순서: 내 이모트, 같은 이름의 디스코드 이모지, Yentis 이모트 (대소문자까지 같은 것 먼저)
    const resolve = (name: string, mods: Array<[string, string]>): string | undefined => {
        if (s.customEmotes[name]) return urlJob(name, s.customEmotes[name], mods)
        const found = discordFind(name)
        if (found?.length && found[0].name === name) return emojiJob(found, mods)
        if (emotes[name]) return urlJob(name, emotes[name], mods)
        if (found?.length) return emojiJob(found, mods)
        const k = lower[name.toLowerCase()]
        return k ? urlJob(k, emotes[k], mods) : undefined
    }
    const prefix = s.prefix || ''
    const re =
        s.requirePrefix && prefix
            ? new RegExp(`(^|[^\\w/:])${esc(prefix)}([\\w~]{2,})((?:\\.[\\w-]+)*)`, 'g')
            : /(^|[^\w/:<])([\w~]{2,})((?:\.[\w-]+)*)(?![\w:>])/g
    let text = outsideCode(content, part =>
        part.replace(re, (all, before: string, name: string, modText: string) => {
            const mods = parseModifiers(modText)
            // 효과 자리에 효과가 아닌 것이 있으면 (예: 문장 끝 마침표) 이름만 바꾼다
            const r = resolve(name, mods)
            if (!r) return all
            const rest = mods.length ? '' : modText
            return before + r + rest
        }),
    )
    if (s.lockedEmojis && !hasNitro()) {
        // <:이름:ID> 로 들어온 잠긴 이모지
        text = outsideCode(text, part =>
            part.replace(/<(a?):(\w+):(\d+)>/g, (all, animated: string, name: string, id: string) => {
                const known = discordFind(name)?.find(e => String(e.id) === id)
                // 내 서버 이모지는 쓸 수 있는지 보고, 모르는 이모지(다른 곳에서 붙여 넣은 것)는 잠긴 것으로 본다
                if (known && usable(known, here)) return all
                const e = known ?? { id, name, animated: !!animated }
                return emojiJob([e], [])
            }),
        )
        // :이름: 으로 남은 것 (디스코드가 잠겨서 못 바꾼 것)
        text = outsideCode(text, part =>
            part.replace(/(^|[^\w<])(:([\w~]{2,}):)(?!\d)/g, (all, before: string, _w: string, name: string) => {
                const list = discordFind(name)
                if (!list?.length) return all
                return before + emojiJob(list, [])
            }),
        )
    }
    return { text, jobs }
}

// ── 파일로 만들기 ─────────────────────────────────────────────────────────
async function download(url: string): Promise<Uint8Array | undefined> {
    try {
        const res = await fetch(url)
        if (!res.ok) return
        const blob = await res.blob()
        const data: string = await new Promise((ok, no) => {
            const r = new FileReader()
            r.onload = () => ok(String(r.result ?? ''))
            r.onerror = () => no(r.error)
            r.readAsDataURL(blob)
        })
        const at = data.indexOf(',')
        return fromBase64(at >= 0 ? data.slice(at + 1) : data)
    } catch {}
}

const CHANNEL_MESSAGE = 0
/** 우리 파일만 따로 두는 칸 (입력창의 파일 줄에 안 보이게) */
const OUR_DRAFT = 77

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

function uploadsOf(channelId: string, draftType: number): any[] {
    try {
        const u = S().UploadAttachmentStore?.getUploads?.(channelId, draftType)
        return Array.isArray(u) ? u : []
    } catch {
        return []
    }
}

let seq = 0
/** 그림 파일을 디스코드의 업로드(CloudUpload)로 만든다. 사진 고르기와 같은 방법 */
async function makeUpload(channelId: string, b64: string, ext: string, name: string): Promise<{ upload: any; draftType: number } | undefined> {
    const safe = name.replace(/[^\w-]/g, '').slice(0, 40) || 'emote'
    const file = `${safe}.${ext}`
    const path: string = await (FileModule as any).writeFile('cache', `emote-replacer/${Date.now()}_${seq++}/${file}`, b64, 'base64')
    const uri = String(path).startsWith('file://') ? String(path) : `file://${path}`
    const platform = find('UploadPlatform')?.UploadPlatform?.REACT_NATIVE ?? 0
    const origin = find('UploadOrigin')?.UploadOrigin?.IMAGE_PICKER
    const item: any = { id: uri, uri, originalUri: uri, mimeType: ext === 'gif' ? 'image/gif' : 'image/png', width: 128, height: 128, filename: file, platform }
    if (origin != null) item.origin = origin
    for (const draftType of [OUR_DRAFT, CHANNEL_MESSAGE]) {
        const before = new Set(uploadsOf(channelId, draftType))
        try {
            Dispatcher.dispatch({ type: 'UPLOAD_ATTACHMENT_ADD_FILES', channelId, files: [item], draftType, allowOptimization: false } as any)
        } catch {
            continue
        }
        const added = uploadsOf(channelId, draftType).find(u => !before.has(u))
        if (added) return { upload: added, draftType }
    }
}

function removeUpload(channelId: string, u: { upload: any; draftType: number }) {
    const id = u.upload?.id ?? u.upload?.item?.id
    if (id == null) return
    try {
        Dispatcher.dispatch({ type: 'UPLOAD_ATTACHMENT_REMOVE_FILE', channelId, id, draftType: u.draftType } as any)
    } catch {}
}

// ── 스티커 ────────────────────────────────────────────────────────────────
let sendability: any
function stickerStore(): any {
    if (S().StickersStore?.getStickerById) return S().StickersStore
    return find('getStickerById', 'getStickerPack')
}
function stickerLocked(id: string, channelId: string): any {
    const sticker = stickerStore()?.getStickerById?.(id)
    const channel = S().ChannelStore?.getChannel?.(channelId)
    const user = S().UserStore?.getCurrentUser?.()
    try {
        sendability ??= find('isSendableSticker')
        if (sticker && channel && user && typeof sendability?.isSendableSticker === 'function' && !sendability.isSendableSticker(sticker, user, channel)) return sticker
    } catch {}
    if (hasNitro() || !sticker) return
    const g = sticker.guild_id ?? sticker.guildId
    if (g != null && String(g) !== guildOf(channelId)) return sticker
}
function stickerUrl(st: any): string | undefined {
    const format = st?.format_type ?? st?.formatType
    // 로티(움직이는 기본 스티커)는 그림 주소가 없다
    if (format === 3) return
    return `https://media.discordapp.net/stickers/${st.id}.${format === 4 ? 'gif' : 'png'}?size=160&name=${encodeURIComponent(String(st.name ?? 'sticker'))}`
}

export let lastError = ''

export interface Rewritten {
    args: any[]
    /** 보낸 뒤 할 일 (우리 업로드 정리) */
    after?: () => void
}

/** 바꿀 것이 있는지 (없으면 그대로 보낸다) */
export function quickPlan(args: any[]): Plan | undefined {
    const [channelId, message] = args
    if (typeof channelId !== 'string' || !message || typeof message.content !== 'string') return
    const p = plan(message.content, channelId)
    if (p.text === message.content && !p.jobs.length) return
    return p
}

/** sendMessage(channelId, message, _, options) 의 인자를 바꿔서 돌려준다 */
export async function rewrite(args: any[], p: Plan | undefined): Promise<Rewritten> {
    const [channelId, message, third, options] = args
    if (typeof channelId !== 'string' || !message) return { args }
    let text = p?.text ?? message.content
    const uploads: Array<{ upload: any; draftType: number }> = []
    for (const job of p?.jobs ?? []) {
        let made: { upload: any; draftType: number } | undefined
        // 효과가 없으면 링크로 (폰 디스코드는 작은 그림 파일을 화면 가득 키워서 보여 준다)
        const asFile = job.mods.length > 0 || settings().plainAsFile
        if (asFile && uploads.length < MAX_FILES) {
            try {
                const bytes = await download(job.source)
                if (bytes) {
                    const out = render(bytes, job.mods, settings().emoteSize, settings().phoneSize ? WIDE : 0)
                    made = await makeUpload(channelId, out.b64, out.ext, job.name)
                }
            } catch (e: any) {
                lastError = String(e?.message ?? e)
            }
        }
        if (made) {
            uploads.push(made)
            text = text.split(job.mark).join('')
        } else text = text.split(job.mark).join(link(job.fallback))
    }

    let opts = options
    const ids: string[] = Array.isArray(options?.stickerIds) ? options.stickerIds : []
    if (settings().lockedStickers && ids.length) {
        const keep: string[] = []
        const links: string[] = []
        for (const id of ids) {
            const st = stickerLocked(String(id), channelId)
            const url = st ? stickerUrl(st) : undefined
            if (url) links.push(link(url))
            else keep.push(id)
        }
        if (links.length) {
            text = [text.trim(), ...links].filter(Boolean).join('\n')
            opts = { ...opts, stickerIds: keep.length ? keep : undefined }
        }
    }
    if (uploads.length) opts = { ...opts, attachmentsToUpload: [...(opts?.attachmentsToUpload ?? []), ...uploads.map(u => u.upload)] }
    const next = { ...message, content: text.replace(/[ \t]{2,}/g, ' ').trim(), invalidEmojis: [] }
    return {
        args: [channelId, next, third, opts, ...args.slice(4)],
        after: uploads.some(u => u.draftType === CHANNEL_MESSAGE) ? () => uploads.filter(u => u.draftType === CHANNEL_MESSAGE).forEach(u => removeUpload(channelId, u)) : undefined,
    }
}

/** 스티커만 바꿀 것이 있는지 */
export function stickerNeedsWork(args: any[]) {
    const [channelId, , , options] = args
    const ids: string[] = Array.isArray(options?.stickerIds) ? options.stickerIds : []
    return typeof channelId === 'string' && settings().lockedStickers && ids.some(id => !!stickerLocked(String(id), channelId))
}
