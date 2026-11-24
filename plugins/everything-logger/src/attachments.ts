import { FileModule } from '@valenced/discord/native'
import { rm } from '@valenced/modules/native/fs'
import { MAX_FILE_BYTES } from './store'

/**
 * 지운 메시지의 첨부파일을 기기에 저장한다.
 * 디스코드는 메시지가 지워지면 첨부파일 주소도 곧 막는다. 지워진 직후에 받아 두고,
 * 저장한 메시지의 첨부파일 주소를 file:// 로 바꿔서 채팅과 다시 켠 뒤에도 그대로 보이게 한다.
 * 파일은 Documents/message-logger/ 에 "메시지ID_첨부ID.확장자" 로 저장한다.
 */

const DIR = 'message-logger'
const fm = () => FileModule as any

function docsDir(): string | undefined {
    try {
        return String(fm().getConstants().DocumentsDirPath).replace(/\/+$/, '')
    } catch {}
}

function extOf(a: any) {
    const name = String(a?.filename ?? '')
    const m = name.match(/\.([A-Za-z0-9]{1,8})$/)
    if (m) return m[1].toLowerCase()
    const t = String(a?.content_type ?? '')
    const sub = t.split('/')[1]?.split(';')[0]
    return sub && /^[a-z0-9]{1,8}$/i.test(sub) ? sub : 'bin'
}

function toBase64(blob: any): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onerror = () => reject(r.error)
        r.onload = () => {
            const s = String(r.result ?? '')
            const at = s.indexOf(',')
            resolve(at >= 0 ? s.slice(at + 1) : s)
        }
        r.readAsDataURL(blob)
    })
}

async function download(urls: string[]): Promise<string | undefined> {
    for (const url of urls) {
        try {
            const res = await fetch(url)
            if (!res.ok) continue
            const b64 = await toBase64(await res.blob())
            if (b64) return b64
        } catch {}
    }
}

export const isLocal = (u?: string) => typeof u === 'string' && u.startsWith('file://')

/**
 * 첨부파일들을 저장하고, 주소를 기기 파일로 바꾼 새 목록과 저장한 경로들을 돌려준다.
 * 못 받은 것은 원래 주소 그대로 둔다.
 */
export async function saveAll(messageId: string, attachments: any[]): Promise<{ list: any[]; paths: string[] } | undefined> {
    const docs = docsDir()
    if (!docs || !Array.isArray(attachments) || !attachments.length) return
    const paths: string[] = []
    let any = false
    const list = await Promise.all(
        attachments.map(async (a: any) => {
            if (!a || isLocal(a.url) || (typeof a.size === 'number' && a.size > MAX_FILE_BYTES)) return a
            const urls = [a.url, a.proxy_url].filter((u: any) => typeof u === 'string' && /^https?:\/\//.test(u))
            if (!urls.length) return a
            const b64 = await download(urls)
            if (!b64) return a
            const rel = `${DIR}/${messageId}_${a.id ?? paths.length}.${extOf(a)}`
            try {
                await fm().writeFile('documents', rel, b64, 'base64')
            } catch {
                return a
            }
            const path = `${docs}/${rel}`
            paths.push(path)
            any = true
            const local = `file://${path}`
            return { ...a, url: local, proxy_url: local, original_url: a.url }
        }),
    )
    return any ? { list, paths } : undefined
}

export function removeFiles(paths?: string[]) {
    for (const p of paths ?? []) rm(p).catch?.(() => {})
}
