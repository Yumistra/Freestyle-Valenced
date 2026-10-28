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

/** 보내거나(기본) 나만 보이게 */
function reply(ctx: any, content: string, ephemeral: boolean) {
    const text = clip(content)
    if (!ephemeral) return { content: text }
    const id = ctx?.channel?.id
    if (id) sendEphemeral(id, text)
}

// ── /plugins ───────────────────────────────────────────────────

interface Info {
    id: string
    name: string
    version: string
    enabled: boolean
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
                out.push({ id: p.manifest.id, name: p.manifest.name, version: formatVersion(p.manifest.version), enabled: !!I.isPluginEnabledInActiveSlot?.(p) })
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
            }
        })
}

async function pluginsText(versions: boolean) {
    const all = (await installedPlugins()).sort((a, b) => a.name.localeCompare(b.name))
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

function debugText() {
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
        `> **Discord:** ${client.Version ?? '?'} (${client.Build ?? '?'})${client.ReleaseChannel ? ` · ${client.ReleaseChannel}` : ''}`,
        `> **React:** ${(React as any).version ?? '?'}`,
        `> **React Native:** ${rn ? `${rn.major}.${rn.minor}.${rn.patch}${rn.prerelease ? `-${rn.prerelease}` : ''}` : '?'}`,
        `> **Hermes:** ${hermes['OSS Release Version'] ?? hermes.Build ?? '?'} (bytecode ${hermes['Bytecode Version'] ?? '?'})`,
        `> **System:** ${os} ${P.Release ?? device.systemVersion ?? ReactNative.Platform.Version}${os === 'Android' ? ` (SDK ${ReactNative.Platform.Version})` : ''}`,
        `> **Device:** ${P.Model ?? device.deviceModel ?? '?'}${P.Manufacturer ? ` (${P.Manufacturer})` : ''}${device.deviceCodename ? ` · ${device.deviceCodename}` : ''}`,
    ]
    return lines.join('\n')
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
    return `${failed ? '**Error**' : '**Result**'} · ${ms}ms\n\`\`\`js\n${body}\n\`\`\``
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
        base('-73918', 'plugins', 'Send list of installed plugins', [option('ephemeral', 'Only you can see it', BOOLEAN), option('versions', 'Show versions', BOOLEAN)], async (args, ctx) => {
            try {
                return reply(ctx, await pluginsText(!!argOf(args, 'versions')), !!argOf(args, 'ephemeral'))
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
        base('-73920', 'debug', 'Send debug information', [option('ephemeral', 'Only you can see it', BOOLEAN)], (args, ctx) => reply(ctx, debugText(), !!argOf(args, 'ephemeral'))),
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
