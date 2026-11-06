import { FileModule } from '@valenced/discord/native'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { renderLottie } from './lottie'

/**
 * 고른 스티커를 디스코드의 "보낼 파일" 줄(사진 고를 때 입력창 위에 뜨는 그 줄)에 올린다.
 * 스티커 그림을 폰 캐시에 파일로 저장해 사진처럼 넣고, 파일 이름에 표시(swt-sticker-ID)를 단다.
 * 보낼 때 그 파일은 빼고 진짜 스티커(stickerIds)로 바꿔 보낸다 (index.tsx splitFakes).
 */

const CHANNEL_MESSAGE = 0
export const FAKE = /swt-sticker-(\d+)/

export const trayStatus = { last: '' }

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

// ── 아주 작은 PNG 만들기 (Lottie 스티커처럼 그림 파일이 없을 때 자리 표시용) ─────
const CRC = (() => {
    const t: number[] = []
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()
function crc32(bytes: number[]) {
    let c = 0xffffffff
    for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function chunk(type: string, data: number[]) {
    const t = type.split('').map(c => c.charCodeAt(0))
    return [...u32(data.length), ...t, ...data, ...u32(crc32([...t, ...data]))]
}
function toBase64(bytes: number[]) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
        const n = (a << 16) | (b << 8) | c
        out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=')
    }
    return out
}
/** 둥근 보라색 판에 흰 점 세 개 (스티커 자리) */
function placeholderPng(size = 96) {
    const rgba = new Uint8Array(size * size * 4)
    const r = size / 2
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            const dx = x - r + 0.5
            const dy = y - r + 0.5
            const inside = dx * dx + dy * dy <= r * r
            const dot = [-0.3, 0, 0.3].some(o => (dx - o * size) ** 2 + dy * dy <= (size * 0.07) ** 2)
            const c = !inside ? [0, 0, 0, 0] : dot ? [255, 255, 255, 255] : [88, 101, 242, 255]
            rgba.set(c, (y * size + x) * 4)
        }
    return encodePng(rgba, size)
}

/** RGBA → PNG (base64) */
export function encodePng(rgba: Uint8Array, size: number) {
    const raw: number[] = []
    for (let y = 0; y < size; y++) {
        raw.push(0)
        for (let x = 0; x < size * 4; x++) raw.push(rgba[y * size * 4 + x])
    }
    // 압축 없이 (stored) deflate
    const z: number[] = [0x78, 0x01]
    for (let i = 0; i < raw.length; i += 65535) {
        const part = raw.slice(i, i + 65535)
        const last = i + 65535 >= raw.length ? 1 : 0
        z.push(last, part.length & 255, (part.length >> 8) & 255, ~part.length & 255, (~part.length >> 8) & 255)
        for (let j = 0; j < part.length; j++) z.push(part[j])
    }
    let a = 1
    let b = 0
    for (const v of raw) {
        a = (a + v) % 65521
        b = (b + a) % 65521
    }
    z.push(...u32(((b << 16) | a) >>> 0))
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(size), ...u32(size), 8, 6, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]
    return toBase64(png)
}

/** 스티커 그림을 base64 로 (못 받으면 undefined) */
async function download(url: string): Promise<string | undefined> {
    try {
        const res = await fetch(url)
        if (!res.ok) return
        const type = res.headers?.get?.('content-type') ?? ''
        if (!/^image\//.test(type)) return
        const blob = await res.blob()
        const data: string = await new Promise((ok, no) => {
            const r = new FileReader()
            r.onload = () => ok(String(r.result ?? ''))
            r.onerror = () => no(r.error)
            r.readAsDataURL(blob)
        })
        const i = data.indexOf('base64,')
        return i >= 0 ? data.slice(i + 7) : undefined
    } catch {}
}

/** 스티커 JSON (Lottie) 받기 */
async function lottieJson(sticker: any, id: string): Promise<any> {
    const urls: string[] = []
    try {
        const u = stickerModule?.getStickerAssetUrl?.(sticker)
        if (typeof u === 'string') urls.push(u)
    } catch {}
    urls.push(`https://discord.com/stickers/${id}.json`, `https://media.discordapp.net/stickers/${id}.json`, `https://cdn.discordapp.com/stickers/${id}.json`)
    for (const u of urls) {
        try {
            const res = await fetch(u)
            if (!res.ok) continue
            const j = await res.json()
            if (j && Array.isArray(j.layers)) return j
        } catch {}
    }
}

/** 움직이는(Lottie) 스티커 한 장면을 그려 PNG 로 */
async function lottiePng(sticker: any, id: string): Promise<string | undefined> {
    const json = await lottieJson(sticker, id)
    if (!json) return
    for (const at of [0.4, 0.6, 0.25, 0.8, 0]) {
        try {
            const rgba = renderLottie(json, 160, at)
            if (rgba) return encodePng(rgba, 160)
        } catch {}
    }
}

let stickerModule: any
export const setTrayStickerModule = (m: any) => (stickerModule ??= m)

/** 한 번 만든 그림 파일은 다시 쓴다 */
const files = new Map<string, { uri: string; mime: string; name: string }>()

/** 스티커를 폰 캐시에 파일로 저장하고 file:// 주소를 돌려준다 */
async function stickerFile(id: string): Promise<{ uri: string; mime: string; name: string }> {
    const cached = files.get(id)
    if (cached) return cached
    let s: any
    try {
        s = (Stores as any).StickersStore?.getStickerById?.(id)
    } catch {}
    const gif = s?.format_type === 4
    let b64: string | undefined
    if (s?.format_type === 3) b64 = await lottiePng(s, id)
    else b64 = await download(`https://media.discordapp.net/stickers/${id}.${gif ? 'gif' : 'png'}?size=160`)
    const real = !!b64
    b64 ??= placeholderPng()
    const name = `swt-sticker-${id}.${real && gif ? 'gif' : 'png'}`
    const path: string = await (FileModule as any).writeFile('cache', `sticker-with-text/${name}`, b64, 'base64')
    const uri = String(path).startsWith('file://') ? String(path) : `file://${path}`
    const f = { uri, mime: name.endsWith('.gif') ? 'image/gif' : 'image/png', name }
    if (real) files.set(id, f)
    return f
}

/** 올린 파일 하나가 우리 스티커면 그 ID */
export function fakeStickerId(u: any): string | undefined {
    for (const v of [u?.item?.filename, u?.filename, u?.item?.uri, u?.uri, u?.item?.originalUri, u?.item?.file?.uri, u?.file?.uri, u?.file?.name]) {
        const m = typeof v === 'string' ? FAKE.exec(v) : null
        if (m) return m[1]
    }
}

function uploads(channelId: string): any[] {
    try {
        const u = (Stores as any).UploadAttachmentStore?.getUploads?.(channelId, CHANNEL_MESSAGE)
        return Array.isArray(u) ? u : []
    } catch {
        return []
    }
}

/** 스티커를 보낼 파일 줄에 올린다. 올라가면 true */
export async function addToTray(channelId: string, id: string): Promise<boolean> {
    const add = find('addFile', 'addFiles')
    if (typeof add?.addFile !== 'function') {
        trayStatus.last = 'Discord upload list not found'
        return false
    }
    const have = uploads(channelId).map(fakeStickerId).filter(Boolean) as string[]
    if (have.includes(id)) return true
    if (have.length >= 3) {
        trayStatus.last = 'Already 3 stickers'
        return true
    }
    try {
        const f = await stickerFile(id)
        const platform = find('UploadPlatform')?.UploadPlatform?.REACT_NATIVE ?? 0
        const origin = find('UploadOrigin')?.UploadOrigin?.IMAGE_PICKER
        const item: any = { id: f.uri, uri: f.uri, originalUri: f.uri, mimeType: f.mime, width: 160, height: 160, filename: f.name, platform }
        if (origin != null) item.origin = origin
        const before = uploads(channelId).length
        add.addFile({ file: item, channelId, draftType: CHANNEL_MESSAGE, allowOptimization: false })
        // 사진 고를 때처럼 바로 목록에 들어갔는지 확인
        await new Promise(r => setTimeout(r, 50))
        const after = uploads(channelId).length
        trayStatus.last = after > before ? 'Added next to your photos' : `Added, but Discord's list did not change (${before} → ${after})`
        return after > before
    } catch (e: any) {
        trayStatus.last = `Failed: ${e?.message ?? e}`
        return false
    }
}
