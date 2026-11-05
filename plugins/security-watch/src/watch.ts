import { ToastActionCreators } from '@valenced/discord/actions'
import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import * as Internal from '@valenced/plugins/_'
import { record, settings, type Kind } from './store'

/**
 * 누가 불렀는지는 호출 스택으로 안다. Valenced 는 플러그인 코드를
 * "//# sourceURL=Valenced:Plugin:<id>" 로 돌리므로 스택의 그 이름이 곧 플러그인이다.
 * 디스코드나 Valenced 자신이 부른 것(플러그인 이름이 없는 것)은 알리지 않는다.
 */

export const SELF = 'yumistra.security-watch'
const FRAME = /Valenced:Plugin:([^:\s)]+)/

/** 스택의 각 줄 → 플러그인 id ('' 는 플러그인이 아닌 코드) */
function frames(): string[] {
    const st = String(new Error().stack ?? '')
    return st
        .split('\n')
        .slice(1)
        .map(l => FRAME.exec(l)?.[1] ?? '')
}

/** 이 기기에서 스택에 플러그인 이름이 보이는지 (시작할 때 확인) */
export const status = { names: false, gap: 0, patched: [] as string[] }

/** 훅 바로 바깥에서 부른 플러그인 (patcher 안쪽 줄 수는 시작할 때 재 둔다) */
function directCaller(): string {
    const f = frames()
    let i = f.indexOf(SELF)
    if (i < 0) return ''
    while (f[i + 1] === SELF) i++
    if (status.gap) {
        const c = f[i + status.gap]
        return c && c !== SELF ? c : ''
    }
    for (let j = i + 1; j < Math.min(f.length, i + 5); j++) if (f[j] && f[j] !== SELF) return f[j]
    return ''
}

/** 스택 어디든 있는 다른 플러그인 (보내기, 복사처럼 결과만 봐도 위험한 것) */
function anyCaller(): string {
    for (const id of frames()) if (id && id !== SELF) return id
    return ''
}

export function nameOf(id: string) {
    if (!id) return 'Unknown code'
    try {
        const list: any = (Internal as any)?.pList
        const p = list?.get?.(id) ?? [...(list?.values?.() ?? [])].find((x: any) => x?.manifest?.id === id)
        if (p?.manifest?.name) return String(p.manifest.name)
    } catch {}
    return id
}

// ── 알리기 ───────────────────────────────────────────────────────────────
const BLOCKED: Record<Kind, string> = {
    read: 'reading your token',
    send: 'sending your token outside Discord',
    copy: 'copying your token',
    files: "reading Discord's app files",
    account: 'changing your login token',
}
const WHAT: Record<Kind, string> = {
    read: 'read your token',
    send: 'sent your token outside Discord',
    copy: 'copied your token',
    files: "read Discord's app files",
    account: 'changed your login token',
}

let seq = 0
const lastToast = new Map<string, number>()
/** 알리고, 막아야 하면 true 를 돌려준다 */
function alert(p: string, k: Kind, d?: string): boolean {
    const s = settings()
    const mode = s.watch[k]
    if (mode === 'off' || (p && s.trusted.includes(p))) return false
    const block = mode === 'block'
    record(p, k, d, block)
    if (!s.toasts) return block
    // 같은 플러그인, 같은 일은 30초에 한 번만 띄운다 (보내기는 매번)
    const key = `${p}|${k}|${block}`
    const now = Date.now()
    if (k !== 'send' && now - (lastToast.get(key) ?? 0) < 30_000) return block
    lastToast.set(key, now)
    const where = d && k !== 'files' ? `, ${d}` : ''
    try {
        ToastActionCreators.open(`security-watch-${now}-${seq++}`, { text: block ? `Blocked ${nameOf(p)} from ${BLOCKED[k]}${where}` : `${nameOf(p)} ${WHAT[k]}${where}` } as any)
    } catch {}
    return block
}

export const BLOCK_ERROR = 'Blocked by Security Watch'

// ── 토큰 값 (비교용으로 메모리에만 둔다. 저장하거나 보여 주지 않는다) ───────────
let token = ''
function remember(v: unknown) {
    if (typeof v === 'string' && v.length > 30 && v !== token) token = v
}
function hasToken(v: unknown) {
    return !!token && typeof v === 'string' && v.includes(token)
}

const DISCORD = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg|discord\.media|discordcdn\.com)$/i
function hostOf(url: unknown) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(url ?? ''))
    return m ? m[1].toLowerCase() : ''
}

// ── 토큰 읽기, 바꾸기 ──────────────────────────────────────────────────────
const done = new WeakSet<object>()
function patchTokenModule(cleanup: (...f: Array<() => void>) => void, mod: any, label: string) {
    if (typeof mod?.getToken !== 'function' || done.has(mod)) return
    done.add(mod)
    try {
        cleanup(
            instead(mod, 'getToken', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                const v = orig.apply(this, args)
                remember(v)
                if (probing) calibrate()
                else {
                    const p = directCaller()
                    if (p && alert(p, 'read')) return undefined
                }
                return v
            }),
        )
        for (const key of ['setToken', 'removeToken']) {
            if (typeof mod[key] !== 'function') continue
            cleanup(
                instead(mod, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    const p = directCaller()
                    if (p && alert(p, 'account', key === 'removeToken' ? 'removed' : undefined)) return undefined
                    return orig.apply(this, args)
                }),
            )
        }
        status.patched.push(label)
        if (!status.gap) probe(mod)
    } catch {}
}

// 우리 코드에서 한 번 불러 patcher 안쪽 줄 수를 잰다
let probing = false
function calibrate() {
    const f = frames()
    let i = f.indexOf(SELF)
    if (i < 0) return
    status.names = true
    while (f[i + 1] === SELF) i++
    const j = f.indexOf(SELF, i + 1)
    if (j > i) status.gap = j - i
}
function probe(mod: any) {
    probing = true
    try {
        remember(mod.getToken())
    } catch {}
    probing = false
}

// ── 네트워크 (fetch 도 결국 XMLHttpRequest 로 간다) ──────────────────────────
function patchNetwork(cleanup: (...f: Array<() => void>) => void) {
    const XHR: any = (globalThis as any).XMLHttpRequest?.prototype
    if (XHR) {
        try {
            cleanup(
                instead(XHR, 'open', function (this: any, args: any[], orig: (...a: any[]) => any) {
                    try {
                        this.__swUrl = args[1]
                        this.__swHeaders = []
                    } catch {}
                    return orig.apply(this, args)
                }),
                instead(XHR, 'setRequestHeader', function (this: any, args: any[], orig: (...a: any[]) => any) {
                    try {
                        ;(this.__swHeaders ??= []).push(String(args[1]))
                    } catch {}
                    return orig.apply(this, args)
                }),
                instead(XHR, 'send', function (this: any, args: any[], orig: (...a: any[]) => any) {
                    let block = false
                    try {
                        const host = hostOf(this.__swUrl)
                        if (host && !DISCORD.test(host) && (hasToken(String(this.__swUrl)) || (this.__swHeaders ?? []).some(hasToken) || hasToken(args[0]))) block = alert(anyCaller(), 'send', host)
                    } catch {}
                    // fetch 는 이 오류로 실패한다 (요청은 나가지 않는다)
                    if (block) throw new Error(BLOCK_ERROR)
                    return orig.apply(this, args)
                }),
            )
        } catch {}
    }
    const WS: any = (globalThis as any).WebSocket?.prototype
    if (WS) {
        try {
            cleanup(
                instead(WS, 'send', function (this: any, args: any[], orig: (...a: any[]) => any) {
                    let block = false
                    try {
                        const host = hostOf(this.url)
                        if (host && !DISCORD.test(host) && hasToken(args[0])) block = alert(anyCaller(), 'send', host)
                    } catch {}
                    if (block) throw new Error(BLOCK_ERROR)
                    return orig.apply(this, args)
                }),
            )
        } catch {}
    }
}

// ── 클립보드 ──────────────────────────────────────────────────────────────
function patchClipboard(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(withProps('setString') as any, (mod: any) => {
            if (typeof mod?.setString !== 'function') return
            try {
                cleanup(
                    instead(mod, 'setString', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        let block = false
                        try {
                            if (hasToken(args[0])) block = alert(anyCaller(), 'copy')
                        } catch {}
                        if (block) return undefined
                        return orig.apply(this, args)
                    }),
                )
            } catch {}
        }) as any,
    )
}

// ── 디스코드 앱 파일 (Valenced 네이티브 다리로 가는 fs 호출) ─────────────────
const SECRET_PATH = /mmkv|shared_prefs|databases|app_webview|cookies|token|keystore/i
function patchBridge(cleanup: (...f: Array<() => void>) => void) {
    const g: any = globalThis
    for (const name of ['valenced.bridge.call.sync', 'valenced.bridge.call.async']) {
        const sym = Symbol.for(name)
        const orig = g[sym]
        if (typeof orig !== 'function') continue
        const isAsync = name.endsWith('async')
        const wrapped = function (this: unknown, payload: any) {
            let block = false
            try {
                const m = payload?.valenced?.method
                const path = payload?.valenced?.args?.[0]
                if (typeof m === 'string' && /^valenced\.fs\./.test(m) && typeof path === 'string' && SECRET_PATH.test(path) && !/\/valenced\/|plugins?\//i.test(path)) {
                    const p = anyCaller()
                    if (p) block = alert(p, 'files', path)
                }
            } catch {}
            // callNativeMethod 는 { error } 를 받으면 실패로 던진다
            if (block) return isAsync ? Promise.resolve({ error: BLOCK_ERROR }) : { error: BLOCK_ERROR }
            return orig.call(this, payload)
        }
        try {
            g[sym] = wrapped
            if (g[sym] === wrapped) cleanup(() => g[sym] === wrapped && (g[sym] = orig))
        } catch {}
    }
}

/** 스토어는 디스코드가 뜬 뒤에야 있으니 start 에서 한 번 더 부른다 */
export function patchStores(cleanup: (...f: Array<() => void>) => void) {
    try {
        const A: any = (Stores as any).AuthenticationStore
        if (A && typeof A.getToken === 'function') patchTokenModule(cleanup, A, 'AuthenticationStore')
    } catch {}
}

/** preInit 에서 부른다: 다른 플러그인의 init, start 보다 먼저 */
export function startWatching(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(withProps('getToken', 'setToken') as any, (mod: any) => patchTokenModule(cleanup, mod, 'token module')) as any,
    )
    patchStores(cleanup)
    patchNetwork(cleanup)
    patchClipboard(cleanup)
    patchBridge(cleanup)
}
