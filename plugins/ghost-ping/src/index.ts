import { Dispatcher } from '@valenced/discord/common/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'

/**
 * Ghost Ping: /ghostping 으로 메시지를 보내고 바로 (또는 정한 시간 뒤) 지운다.
 * Vendetta 플러그인을 옮긴 것. 명령어 API 가 없어서 디스코드 기본 명령어 목록(getBuiltInCommands)에 덧붙인다.
 *  - 빠른 길: 디스코드 REST API 로 바로 보내고 지운다 (보내기 줄, 임시 메시지를 거치지 않는다)
 *  - 느린 길: 보통 보내기 후 MESSAGE_CREATE 로 id 를 받아 지운다
 */

const CHAT = 1
const STRING = 3
const INTEGER = 4
const BOOLEAN = 5
const USER = 6
/** SUPPRESS_NOTIFICATIONS (앱의 @silent 와 같은 표시) */
const SILENT_FLAG = 4096

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}
const nonce = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const pending = new Set<() => void>()

async function fast(channelId: string, content: string, delay: number, silent: boolean) {
    const rest = find('getAPIBaseURL', 'get')
    const del = rest?.del ?? rest?.delete
    if (typeof rest?.post !== 'function' || typeof del !== 'function') return false
    const res = await rest.post({ url: `/channels/${channelId}/messages`, body: { content, tts: false, nonce: nonce(), ...(silent ? { flags: SILENT_FLAG } : {}) } })
    const id = res?.body?.id
    if (!id) throw new Error('no message id in response')
    if (delay > 0) await wait(delay)
    await del.call(rest, { url: `/channels/${channelId}/messages/${id}` })
    return true
}

function slow(channelId: string, content: string, delay: number, silent: boolean) {
    const actions = find('sendMessage', 'receiveMessage')
    const deleter = find('deleteMessage', 'startEditMessage') ?? actions
    if (!actions) return
    const n = nonce()
    let done = false
    let timer: any
    const onCreate = (e: any) => {
        const m = e?.message
        if (!m || e.optimistic || m.nonce !== n || m.state === 'SENDING') return
        remove(m.id)
    }
    const stop = () => {
        done = true
        try {
            ;(Dispatcher as any).unsubscribe('MESSAGE_CREATE', onCreate)
        } catch {}
        clearTimeout(timer)
        pending.delete(stop)
    }
    const remove = (id: string) => {
        if (done) return
        stop()
        const go = () => {
            try {
                deleter.deleteMessage(channelId, id)
            } catch {}
        }
        if (delay > 0) setTimeout(go, delay)
        else go()
    }
    ;(Dispatcher as any).subscribe('MESSAGE_CREATE', onCreate)
    pending.add(stop)
    timer = setTimeout(stop, 15000)
    const res = actions.sendMessage(channelId, { content: silent ? `@silent ${content}` : content, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] }, undefined, { nonce: n })
    Promise.resolve(res)
        .then((r: any) => r?.body?.id && remove(r.body.id))
        .catch(() => {})
}

function sendAndDelete(channelId: string, content: string, delay: number, silent: boolean) {
    fast(channelId, content, delay, silent)
        .then(ok => {
            if (!ok) slow(channelId, content, delay, silent)
        })
        .catch(() => slow(channelId, content, delay, silent))
}

function option(name: string, description: string, type: number) {
    return { name, displayName: name, description, displayDescription: description, type, required: false }
}

let command: any
function makeCommand() {
    if (command) return command
    let inputType = 1
    try {
        inputType = find('ApplicationCommandInputType')?.ApplicationCommandInputType?.BUILT_IN_TEXT ?? 1
    } catch {}
    command = {
        id: '-73931',
        untranslatedName: 'ghostping',
        displayName: 'ghostping',
        type: CHAT,
        inputType,
        applicationId: '-1',
        untranslatedDescription: 'Send a message and delete it right after',
        displayDescription: 'Send a message and delete it right after',
        options: [
            option('user', 'User to ping', USER),
            option('message', 'Extra text, <@id> pings more people', STRING),
            option('delay', 'Milliseconds before deleting (default 0)', INTEGER),
            option('silent', 'Send as a silent message', BOOLEAN),
        ],
        execute(args: any[], ctx: any) {
            const get = (n: string) => (Array.isArray(args) ? args.find(a => a?.name === n)?.value : undefined)
            const user = get('user')
            const text = get('message')
            const delay = Math.max(0, Number(get('delay')) || 0)
            const content = [user ? `<@${user}>` : '', text ?? ''].filter(Boolean).join(' ')
            const channelId = ctx?.channel?.id
            if (!content || !channelId) return
            sendAndDelete(channelId, content, delay, !!get('silent'))
        },
    }
    return command
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
                            const c = makeCommand()
                            return result.some((r: any) => r?.id === c.id) ? result : [...result, c]
                        } catch {
                            return result
                        }
                    }),
                )
            }) as any,
        )
        cleanup(() => {
            for (const stop of [...pending]) stop()
        })
    },
} as any)
