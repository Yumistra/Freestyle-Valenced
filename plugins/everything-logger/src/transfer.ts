import { callNativeMethod } from '@valenced/modules/native'
import { readFile } from '@valenced/modules/native/fs'
import { NativeModules } from 'react-native'
import { slim } from './away'
import { allowed } from './filters'
import { markChanged, showLateDeleted } from './logger'
import { addEdit, buried, events, logs, save, settings, type Entry, type Event } from './store'

/**
 * 로그 내보내기, 가져오기, 그리고 알림 앱(디스코드가 꺼져 있을 때 기록하는 앱)이 보낸 기록 합치기.
 */

const NS = 'yumistra.everything-logger'
const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)
const call = async (name: string, args: any[]) => {
    const r: any = await (callNativeMethod as any)(`${NS}.${name}`, args)
    if (r && typeof r === 'object' && 'error' in r && !('result' in r)) throw new Error(String(r.error?.message ?? r.error))
    return unwrap(r)
}

export const FORMAT = 'yumistra.everything-logger'
/** Message Logger 때 내보낸 파일 */
const OLD_FORMAT = 'yumistra.message-logger'

/** 지금 로그를 JSON 글로 */
export function exportText(): string {
    return JSON.stringify({ format: FORMAT, v: 1, at: Date.now(), logs: logs(), events: events() })
}

/** 다운로드 폴더(Download/EverythingLogger)에 저장하고 경로를 돌려준다 */
export async function exportLogs(): Promise<string> {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const name = `everything-logger-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`
    return String(await call('export', [name, exportText()]))
}

/** 두 로그 합치기 (이미 있는 건 수정 기록만 더한다). 더한 개수 */
export function mergeData(data: any): number {
    if (!data || (data.format !== FORMAT && data.format !== OLD_FORMAT)) throw new Error('Not an Everything Logger file')
    const mine = logs()
    let added = 0
    for (const [id, e] of Object.entries((data.logs ?? {}) as Record<string, Entry>)) {
        if (!e || typeof e !== 'object' || !e.c) continue
        const have = mine[id]
        if (!have) {
            mine[id] = { ...e, f: undefined }
            added++
            continue
        }
        const edits = [...(have.e ?? [])]
        for (const h of e.e ?? []) if (!edits.some(x => x.at === h.at && x.t === h.t)) edits.push(h)
        edits.sort((a, b) => a.at - b.at)
        if (edits.length !== (have.e ?? []).length) {
            have.e = edits
            added++
        }
        if (e.d && !have.d) {
            have.d = e.d
            have.m = have.m ?? e.m
            added++
        }
    }
    const ev = events()
    const ids = new Set(ev.map(x => x.id))
    for (const x of (data.events ?? []) as Event[]) {
        if (x?.id && !ids.has(x.id)) {
            ev.push(x)
            added++
        }
    }
    ev.sort((a, b) => a.at - b.at)
    save(true)
    return added
}

/** 파일 고르기 (디스코드에 들어 있는 문서 고르기) → 합치기 */
export async function importLogs(): Promise<number> {
    const picker: any = (NativeModules as any)?.RNDocumentPicker
    if (typeof picker?.pick !== 'function') throw new Error('No file picker')
    const res: any = await picker.pick({ type: ['*/*'], allowMultiSelection: false, copyTo: 'cachesDirectory', mode: 'import' })
    const f = Array.isArray(res) ? res[0] : res
    if (!f) return 0
    const copy = String(f.fileCopyUri ?? '')
    let text = ''
    if (copy.startsWith('file://')) text = await readFile(decodeURIComponent(copy.slice(7)))
    else text = await (await fetch(String(f.uri))).text()
    return mergeData(JSON.parse(text))
}

// ── 알림 앱 ─────────────────────────────────────────────────────────────
/**
 * 알림 앱이 디스코드가 꺼져 있는 동안 본 삭제, 수정을 보내 둔 것 (한 줄에 하나)
 *  {"t":"delete","at":ms,"g":"서버","m":{API 메시지}}
 *  {"t":"edit","at":ms,"g":"서버","m":{API 메시지(새 내용)},"before":"예전 내용"}
 */
export const companionStatus = { received: 0, last: 0 }

export async function pullCompanion(): Promise<number> {
    let text = ''
    try {
        text = String((await call('takeCompanion', [])) ?? '')
    } catch {
        return 0
    }
    if (!text.trim()) return 0
    const s = settings()
    const all = logs()
    let n = 0
    const lateDeleted = new Set<string>()
    for (const line of text.split('\n')) {
        let x: any
        try {
            x = JSON.parse(line)
        } catch {
            continue
        }
        // 앱이 보낸 메시지는 사용자 정보가 일부 빠져 있다 (discriminator 등).
        // 그대로 채팅에 다시 넣으면 디스코드의 사용자 검색이 그 빈 칸에서 튕긴다 → 플러그인이 쓰는 모양으로 채운다
        const m = slim(x?.m)
        if (!m?.id || !m.channel_id) continue
        const g = x.g ?? m.guild_id
        if (s.ignoreBots && m.author?.bot) continue
        if (!allowed({ ...m, guild_id: g })) continue
        const at = Number(x.at) || Date.now()
        // 사용자가 지운 로그는 앱이 다시 보내도 넣지 않는다
        if (buried(String(m.id), at)) continue
        const e: Entry = all[m.id] ?? { c: String(m.channel_id), at }
        if (g) e.g = String(g)
        if (x.t === 'delete' && s.logDeletes && !e.d) {
            e.d = at
            e.m = e.m ?? m
            e.away = 1
            lateDeleted.add(String(m.channel_id))
        } else if (x.t === 'edit' && s.logEdits && typeof x.before === 'string') {
            // 앱은 3일 동안 같은 기록을 다시 보낸다: 이미 있으면 건너뛴다 (지운 뒤, 같은 글도)
            if (!addEdit(e, x.before, at, typeof m.content === 'string' ? m.content : undefined)) continue
            // 앱이 잡은 수정은 디스코드에 그 메시지가 없을 수 있다: 보낸 사람과 지금 내용을 같이 둔다
            if (!e.d) e.m = m
        } else continue
        e.at = Math.max(e.at ?? 0, at)
        all[m.id] = e
        markChanged(m.id)
        n++
    }
    companionStatus.received += n
    companionStatus.last = Date.now()
    if (n) save(true)
    if (lateDeleted.size) {
        try {
            showLateDeleted(lateDeleted)
        } catch {}
    }
    return n
}

// ── Message Logger 에서 옮겨 오기 (플러그인 ID 가 바뀌었다) ─────────────
const KEYS = ['logs', 'seen', 'notes', 'profiles', 'gone'] as const

/**
 * 처음 켤 때 한 번: 예전 Message Logger 의 저장 내용(로그, 기억, 기록, 설정)을 가져온다.
 * 이미 있는 건 덮지 않고 합친다. 가져온 로그 수를 돌려준다.
 */
export async function migrateOld(storage: any): Promise<number> {
    const c = storage?.cache
    if (!c || typeof c !== 'object' || c.migrated) return 0
    let text = ''
    try {
        text = String((await call('migrate', [])) ?? '')
    } catch {
        return 0
    }
    if (!text.trim() || text.startsWith('error')) {
        c.migrated = Date.now()
        save(true)
        return 0
    }
    let old: any
    try {
        old = JSON.parse(text)
    } catch {
        return 0
    }
    if (old && typeof old === 'object' && !old.logs && old.data && typeof old.data === 'object') old = old.data
    let n = 0
    for (const k of KEYS) {
        const src = old?.[k]
        if (!src || typeof src !== 'object') continue
        const dst = (c[k] && typeof c[k] === 'object' ? c[k] : (c[k] = {})) as Record<string, any>
        for (const [id, v] of Object.entries(src))
            if (!(id in dst)) {
                dst[id] = v
                if (k === 'logs') n++
            }
    }
    if (Array.isArray(old?.events)) {
        const ev: any[] = Array.isArray(c.events) ? c.events : (c.events = [])
        const have = new Set(ev.map(e => e?.id))
        for (const e of old.events) if (e?.id && !have.has(e.id)) ev.push(e)
        ev.sort((a, b) => (a?.at ?? 0) - (b?.at ?? 0))
    }
    // 설정: 이쪽에서 아직 아무것도 안 바꿨으면 예전 설정을 그대로
    if (old?.settings && typeof old.settings === 'object' && (!c.settings || !Object.keys(c.settings).length)) c.settings = { ...old.settings }
    c.migrated = Date.now()
    save(true)
    return n
}
