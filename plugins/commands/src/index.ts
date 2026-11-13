import { ToastActionCreators } from '@valenced/discord/actions'
import { ClientInfoModule, DeviceModule } from '@valenced/discord/native'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod, getBridgeInfo } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'
import * as Internal from '@valenced/plugins/_'
import { formatVersion } from '@valenced/plugins/utils'
import { React, ReactNative } from '@valenced/react'
import { API_NAME, MOD, NS, api } from './ns'

/**
 * Commands: 예전 Vendetta·Revenge 의 기본 명령어 /plugins, /eval, /debug.
 * 명령어 API 가 없어서 디스코드 기본 명령어 목록(getBuiltInCommands)에 덧붙인다 (Silent Leave 와 같은 방식).
 *  - 결과를 { content } 로 돌려주면 디스코드가 메시지로 보낸다
 *  - "나만 보기"는 디스코드의 봇 메시지(sendBotMessage, Clyde 처럼 나만 보임)로
 */

const CHAT = 1
const BOOLEAN = 5
const STRING = 3
const MAX = 1950

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`commands-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function enumValue(name: string, key: string, fallback: any) {
    try {
        const [mod] = lookupModule(withProps(name) as any) as any
        return mod?.[name]?.[key] ?? fallback
    } catch {
        return fallback
    }
}

let bot: any
/** 나만 보이는 메시지 (Clyde 처럼) */
function sendEphemeral(channelId: string, content: string) {
    bot ??= (lookupModule(withProps('sendBotMessage') as any) as any)?.[0]
    if (typeof bot?.sendBotMessage !== 'function') {
        toast(content.slice(0, 200))
        return
    }
    bot.sendBotMessage(channelId, content)
}

const argOf = (args: any[], name: string) => (Array.isArray(args) ? args.find(a => a?.name === name)?.value : undefined)

function clip(text: string, max = MAX) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 2000 자 제한에 맞게 줄 단위로 나눈다 */
function chunks(text: string, max = MAX): string[] {
    const out: string[] = []
    let cur = ''
    for (const line of text.split('\n')) {
        const l = clip(line, max)
        if (cur && cur.length + 1 + l.length > max) {
            out.push(cur)
            cur = l
        } else cur = cur ? `${cur}\n${l}` : l
    }
    if (cur) out.push(cur)
    return out
}

let sender: any
function sendMessage(channelId: string, content: string) {
    sender ??= (lookupModule(withProps('sendMessage', 'receiveMessage') as any) as any)?.[0]
    sender?.sendMessage?.(channelId, { content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] }, undefined, { allowedMentions: { parse: [], replied_user: false } })
}

/** 보내거나(기본) 나만 보이게. 길면 여러 메시지로 나눈다 */
function reply(ctx: any, content: string, ephemeral: boolean) {
    const parts = chunks(content)
    const id = ctx?.channel?.id
    if (ephemeral) {
        if (id) parts.forEach((t, i) => setTimeout(() => sendEphemeral(id, t), i * 150))
        return
    }
    // 멘션이 있으면 직접 보내되 아무도 알림을 받지 않게 (allowedMentions 비움)
    if (id && /<@!?\d+>/.test(content)) {
        parts.forEach((t, i) => setTimeout(() => sendMessage(id, t), i * 700))
        return
    }
    // 첫 부분은 명령어 결과로, 나머지는 이어서 보낸다
    if (id) parts.slice(1).forEach((t, i) => setTimeout(() => sendMessage(id, t), 700 + i * 700))
    return { content: parts[0] ?? '' }
}

// ── /plugins ───────────────────────────────────────────────────

interface Info {
    id: string
    name: string
    version: string
    enabled: boolean
    author?: string
    authorRaw?: string
    description?: string
    native?: boolean
}

const authorOf = (m: any) => (Array.isArray(m?.authors) ? m.authors.map((a: any) => a?.name ?? a).join(', ') : typeof m?.author === 'string' ? m.author : m?.author?.name)

/** Valenced 의 author 형식: `Name <DISCORD_ID> (LINK "LABEL")` (ID, 링크는 없거나 여러 개) */
const ContributorEntry = /^(?:<(\d{17,20})>|\(((?:https?:\/\/|mailto:)[^()\s]+)(?:\s+"([^"()]+)")?\))\s*/i
function parseContributor(raw: string): { name: string; ids: string[]; links: { url: string; label?: string }[] } {
    const start = raw.search(/[<(]/)
    const name = (start === -1 ? raw : raw.slice(0, start)).trim() || raw
    const ids: string[] = []
    const links: { url: string; label?: string }[] = []
    let rest = start === -1 ? '' : raw.slice(start)
    while (rest) {
        const m = ContributorEntry.exec(rest)
        if (!m) return { name: raw.trim(), ids: [], links: [] }
        if (m[1]) ids.push(m[1])
        else links.push({ url: m[2]!, label: m[3] })
        rest = rest.slice(m[0].length)
    }
    return { name, ids, links }
}
/** "Wolfie(<@id>)" 와 링크 줄 */
function authorText(raw?: string) {
    if (!raw) return { by: '', links: '' }
    const c = parseContributor(raw)
    const by = `${c.name}${c.ids.length ? `(${c.ids.map(id => `<@${id}>`).join(' ')})` : ''}`
    const label = (l: { url: string; label?: string }) => l.label ?? safeHost(l.url)
    // <url> 로 감싸 링크 미리보기가 줄줄이 붙지 않게
    const links = c.links.map(l => `["${label(l)}"](<${l.url}>)`).join(' ')
    return { by, links }
}
function safeHost(url: string) {
    try {
        return url.replace(/^\w+:(\/\/)?/, '').split(/[/?#]/)[0] || url
    } catch {
        return url
    }
}

const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)

/** 설치한 플러그인 (내장 플러그인 제외). 개발자 모드면 내부 API, 아니면 네이티브 목록 */
async function installedPlugins(): Promise<Info[]> {
    try {
        const I: any = Internal
        if (I?.pList) {
            const out: Info[] = []
            for (const p of I.pList.values() as Iterable<any>) {
                const meta = I.getInternalPluginMeta?.(p)
                if (I.isPluginInternal?.(meta)) continue
                out.push({
                    id: p.manifest.id,
                    name: p.manifest.name,
                    version: formatVersion(p.manifest.version),
                    enabled: !!I.isPluginEnabledInActiveSlot?.(p),
                    author: authorOf(p.manifest),
                    authorRaw: typeof p.manifest.author === 'string' ? p.manifest.author : undefined,
                    description: p.manifest.description,
                    native: !!(p.manifest.native ?? p.native ?? p.manifest.dist?.native),
                })
            }
            return out
        }
    } catch {}
    const list: any[] = unwrap(await (callNativeMethod as any)(`${NS}.plugins.list`, [])) ?? []
    let states: any = {}
    let active = 'default'
    try {
        states = unwrap(await (callNativeMethod as any)(`${NS}.plugins.states.read`, [])) ?? {}
        active = unwrap(await (callNativeMethod as any)(`${NS}.plugins.states.getSlots`, []))?.active ?? active
    } catch {}
    return list
        .filter(p => p?.manifest?.id && !p.internal)
        .map(p => {
            const v = p.manifest.version
            return {
                id: p.manifest.id,
                name: p.manifest.name ?? p.manifest.id,
                version: typeof v === 'string' ? v : v ? formatVersion(v) : '?',
                enabled: !!states?.[active]?.[p.manifest.id]?.enabled,
                author: authorOf(p.manifest),
                authorRaw: typeof p.manifest.author === 'string' ? p.manifest.author : undefined,
                description: p.manifest.description,
                native: !!(p.manifest.native ?? p.native ?? p.manifest.dist?.native),
            }
        })
}

async function pluginsText(versions: boolean, detailed = false) {
    const all = (await installedPlugins()).sort((a, b) => a.name.localeCompare(b.name))
    if (detailed) {
        // 자세히: 플러그인마다 이름, 버전, 만든 사람, 설명, ID
        const block = (p: Info) => {
            const a = p.authorRaw ? authorText(p.authorRaw) : { by: p.author ?? '', links: '' }
            return [`> **${p.name}** ${p.version}${a.by ? `, by ${a.by}` : ''}`, a.links || null, p.description ? `> ${p.description}` : null, `> \`${p.id}\``]
                .filter(Boolean)
                .join('\n')
        }
        const on = all.filter(p => p.enabled)
        const off = all.filter(p => !p.enabled)
        const lines = [`**Installed Plugins (${all.length}), ${on.length} enabled, ${off.length} disabled**`]
        if (on.length) lines.push('', `**Enabled (${on.length}):**`, ...on.map(block))
        if (off.length) lines.push('', `**Disabled (${off.length}):**`, ...off.map(block))
        return lines.join('\n')
    }
    const fmt = (p: Info) => (versions ? `${p.name} (${p.version})` : p.name)
    const on = all.filter(p => p.enabled)
    const off = all.filter(p => !p.enabled)
    const lines = [`**Installed Plugins (${all.length}):**`]
    if (on.length) lines.push(`> **Enabled (${on.length}):**`, `> ${on.map(fmt).join(', ')}`)
    if (off.length) lines.push(`> **Disabled (${off.length}):**`, `> ${off.map(fmt).join(', ')}`)
    return lines.join('\n')
}

// ── /debug ─────────────────────────────────────────────────────

function safe<T>(fn: () => T): T | undefined {
    try {
        return fn()
    } catch {}
}

async function debugText(detailed = false) {
    const P: any = (ReactNative as any).Platform?.constants ?? {}
    const client: any = safe(() => (ClientInfoModule as any).getConstants?.()) ?? {}
    const device: any = safe(() => (DeviceModule as any).getConstants?.()) ?? {}
    const bridge: any = safe(() => getBridgeInfo())
    const hermes: any = safe(() => (globalThis as any).HermesInternal?.getRuntimeProperties?.()) ?? {}
    const rn = P.reactNativeVersion
    const os = ReactNative.Platform.OS === 'ios' ? 'iOS' : 'Android'
    const lines = [
        `**${MOD} Debug Info**`,
        `> **${MOD}:** ${bridge ? `${bridge.name} (${bridge.version})` : 'unknown'}`,
        `> **Discord:** ${client.Version ?? '?'} (${client.Build ?? '?'})${client.ReleaseChannel ? `, ${client.ReleaseChannel}` : ''}`,
        `> **React:** ${(React as any).version ?? '?'}`,
        `> **React Native:** ${rn ? `${rn.major}.${rn.minor}.${rn.patch}${rn.prerelease ? `-${rn.prerelease}` : ''}` : '?'}`,
        `> **Hermes:** ${hermes['OSS Release Version'] ?? hermes.Build ?? '?'} (bytecode ${hermes['Bytecode Version'] ?? '?'})`,
        `> **System:** ${os} ${P.Release ?? device.systemVersion ?? ReactNative.Platform.Version}${os === 'Android' ? ` (SDK ${ReactNative.Platform.Version})` : ''}`,
        `> **Device:** ${P.Model ?? device.deviceModel ?? '?'}${P.Manufacturer ? ` (${P.Manufacturer})` : ''}${device.deviceCodename ? `, ${device.deviceCodename}` : ''}`,
    ]
    if (!detailed) return lines.join('\n')

    // 자세히: 화면, 언어, 플러그인 수, 실행 시간, 그 밖의 값들
    const win = safe(() => ReactNative.Dimensions.get('window'))
    const screen = safe(() => ReactNative.Dimensions.get('screen'))
    const scale = safe(() => ReactNative.PixelRatio.get())
    const font = safe(() => ReactNative.PixelRatio.getFontScale())
    const intl = safe(() => Intl.DateTimeFormat().resolvedOptions())
    const plugins = await safe(() => installedPlugins())?.catch?.(() => undefined)
    const up = safe(() => (globalThis as any).performance?.now?.())
    const dur = (ms?: number) => {
        if (ms == null) return '?'
        const m = Math.floor(ms / 60000)
        return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`
    }
    const dark = safe(() => ReactNative.Appearance.getColorScheme())
    const extra = [
        `> **Screen:** ${screen ? `${Math.round(screen.width * (scale ?? 1))}x${Math.round(screen.height * (scale ?? 1))}` : '?'} px, ${win ? `${Math.round(win.width)}x${Math.round(win.height)}` : '?'} dp, scale ${scale ?? '?'}, font ${font ?? '?'}`,
        `> **Language:** ${intl?.locale ?? '?'}, ${intl?.timeZone ?? '?'}`,
        `> **Theme:** ${dark ?? '?'}`,
        `> **Plugins:** ${plugins ? `${plugins.filter(p => p.enabled).length} enabled of ${plugins.length} installed` : '?'}`,
        `> **App running for:** ${dur(up)}`,
        `> **Hermes:** ${Object.entries(hermes)
            .filter(([k]) => /version|build|bytecode/i.test(k))
            .map(([k, v]) => `${k} ${v}`)
            .join(', ') || '?'}`,
        `> **Discord:** ${[client.Version, client.Build, client.ReleaseChannel, client.Manifest, client.OTABuild].filter(Boolean).join(', ') || '?'}`,
        `> **Android:** ${[P.Brand, P.Model, P.Release, P.Fingerprint ? P.Fingerprint.split('/').slice(-3).join('/') : null, (P as any).uiMode].filter(Boolean).join(', ') || '?'}`,
        bridge ? `> **${MOD} bridge:** ${Object.entries(bridge).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}` : null,
    ].filter(Boolean)
    return [...lines, ...extra].join('\n')
}

// ── /eval ──────────────────────────────────────────────────────

/** 결과를 읽기 좋은 글로 (Node 의 util.inspect 비슷하게, 얕게) */
function inspect(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
    if (value === null) return 'null'
    const t = typeof value
    if (t === 'undefined') return 'undefined'
    if (t === 'string') return depth ? JSON.stringify(value) : (value as string)
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
    if (t === 'symbol') return String(value)
    if (t === 'function') {
        const f = value as Function
        return `[Function${f.name ? `: ${f.name}` : ' (anonymous)'}]`
    }
    const o = value as any
    if (seen.has(o)) return '[Circular]'
    if (o instanceof Error) return o.stack ?? `${o.name}: ${o.message}`
    if (depth >= 2) return Array.isArray(o) ? `[Array(${o.length})]` : `[${o?.constructor?.name ?? 'Object'}]`
    seen.add(o)
    const pad = '  '.repeat(depth + 1)
    const end = '  '.repeat(depth)
    if (Array.isArray(o)) {
        const items = o.slice(0, 50).map(x => inspect(x, depth + 1, seen))
        if (o.length > 50) items.push(`… ${o.length - 50} more`)
        return items.length ? `[\n${pad}${items.join(`,\n${pad}`)}\n${end}]` : '[]'
    }
    if (o instanceof Map) return `Map(${o.size}) ${inspect(Object.fromEntries([...o.entries()].slice(0, 50)), depth, seen)}`
    if (o instanceof Set) return `Set(${o.size}) ${inspect([...o].slice(0, 50), depth, seen)}`
    let keys: string[] = []
    try {
        keys = Object.keys(o)
    } catch {}
    const name = o?.constructor?.name && o.constructor.name !== 'Object' ? `${o.constructor.name} ` : ''
    const shown = keys.slice(0, 50).map(k => {
        let v: unknown
        try {
            v = o[k]
        } catch (e) {
            v = `[Getter threw: ${(e as any)?.message ?? e}]`
        }
        return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${inspect(v, depth + 1, seen)}`
    })
    if (keys.length > 50) shown.push(`… ${keys.length - 50} more`)
    return shown.length ? `${name}{\n${pad}${shown.join(`,\n${pad}`)}\n${end}}` : `${name}{}`
}

const fence = (s: string) => s.replace(/```/g, '`​``')

/** 식으로 먼저, 안 되면 문장들로 (return 으로 값 돌려주기) */
function compile(code: string) {
    const names = [API_NAME, 'api', 'React', 'ReactNative', 'Stores', 'findByProps', 'ctx']
    try {
        return new Function(...names, `return (${code}\n)`)
    } catch {
        return new Function(...names, code)
    }
}

const findByProps = (...props: string[]) => (lookupModule(withProps(...(props as [string])) as any) as any)?.[0]

async function evaluate(code: string, ctx: any, awaitResult: boolean) {
    const started = Date.now()
    let result: unknown
    let failed = false
    try {
        const fn = compile(code)
        const a = api()
        result = fn(a, a, React, ReactNative, Stores, findByProps, ctx)
        if (awaitResult && result && typeof (result as any).then === 'function') result = await result
    } catch (e) {
        failed = true
        result = e
    }
    const ms = Date.now() - started
    const body = fence(clip(inspect(result), MAX - 80))
    return `${failed ? '**Error**' : '**Result**'}, ${ms}ms\n\`\`\`js\n${body}\n\`\`\``
}

// ── 명령어 ────────────────────────────────────────────────────

function option(name: string, description: string, type: number, required = false) {
    return { name, displayName: name, description, displayDescription: description, type, required }
}

let commands: any[] | undefined
function makeCommands() {
    if (commands) return commands
    const inputType = enumValue('ApplicationCommandInputType', 'BUILT_IN_TEXT', 1)
    const base = (id: string, name: string, description: string, options: any[], execute: (args: any[], ctx: any) => any) => ({
        id,
        untranslatedName: name,
        displayName: name,
        type: CHAT,
        inputType,
        applicationId: '-1',
        untranslatedDescription: description,
        displayDescription: description,
        options,
        execute,
    })
    commands = [
        base('-73918', 'plugins', 'Send list of installed plugins', [option('ephemeral', 'Only you can see it', BOOLEAN), option('versions', 'Show versions', BOOLEAN), option('detailed', 'Show version, author, description and ID of each plugin', BOOLEAN)], async (args, ctx) => {
            try {
                return reply(ctx, await pluginsText(!!argOf(args, 'versions'), !!argOf(args, 'detailed')), !!argOf(args, 'ephemeral'))
            } catch (e: any) {
                reply(ctx, `Couldn't list plugins: ${e?.message ?? e}`, true)
            }
        }),
        base('-73919', 'eval', 'Evaluate JavaScript code', [option('code', 'Code to run', STRING, true), option('async', 'Wait for promises', BOOLEAN), option('silent', "Don't show the result", BOOLEAN)], async (args, ctx) => {
            const code = String(argOf(args, 'code') ?? '')
            if (!code.trim()) return
            const text = await evaluate(code, ctx, argOf(args, 'async') !== false)
            if (!argOf(args, 'silent')) reply(ctx, text, true)
        }),
        base('-73920', 'debug', 'Send debug information', [option('ephemeral', 'Only you can see it', BOOLEAN), option('detailed', 'Also show screen, language, plugins, uptime and build details', BOOLEAN)], async (args, ctx) =>
            reply(ctx, await debugText(!!argOf(args, 'detailed')), !!argOf(args, 'ephemeral')),
        ),
    ]
    return commands
}

export default plugin({
    start({ cleanup }: any) {
        cleanup(
            getModules(withProps('getBuiltInCommands') as any, (mod: any) => {
                cleanup(
                    instead(mod, 'getBuiltInCommands', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const result = orig.apply(this, args)
                        try {
                            const types = args?.[0]
                            const wantsChat = Array.isArray(types) ? types.includes(CHAT) : types == null || types === CHAT
                            if (!wantsChat || !Array.isArray(result)) return result
                            const ours = makeCommands().filter(c => !result.some((r: any) => r?.id === c.id))
                            return ours.length ? [...result, ...ours] : result
                        } catch {
                            return result
                        }
                    }),
                )
            }) as any,
        )
    },
} as any)
