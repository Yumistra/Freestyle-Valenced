import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import Page from '@valenced/components/Page'
import { useEffect, useState } from 'react'

/**
 * Server Count: /servers 로 들어가 있는 서버 수를 알려준다 (나만 보이게, 또는 보내기).
 * 명령어 API 가 없어서 디스코드 기본 명령어 목록(getBuiltInCommands)에 덧붙인다 (Commands 와 같은 방식).
 */

const CHAT = 1
const BOOLEAN = 5

const S = () => Stores as any

/** 장애 등으로 앱에 안 보이는 서버 수 */
function unavailable(): number {
    const st = S().GuildAvailabilityStore ?? S().UnavailableGuildsStore
    try {
        if (typeof st?.totalUnavailableGuilds === 'number') return st.totalUnavailableGuilds
        const u = st?.getUnavailableGuilds?.() ?? st?.unavailableGuilds
        if (Array.isArray(u)) return u.length
        if (u && typeof u === 'object') return Object.keys(u).length
    } catch {}
    return 0
}

/** 디스코드 서버에 직접 물어본 실제 서버 수 (/users/@me/guilds). 안 되면 null */
let http: any
async function serverCount(): Promise<number | null> {
    try {
        if (!http) {
            const a = (lookupModule(withProps('HTTP') as any) as any)?.[0]?.HTTP
            http = a?.get ? a : (lookupModule(withProps('getAPIBaseURL', 'get') as any) as any)?.[0]
        }
        const res = await http?.get?.({ url: '/users/@me/guilds', query: { limit: 200 } })
        return Array.isArray(res?.body) ? res.body.length : null
    } catch {
        return null
    }
}

/** 서버 수와 그중 내가 만든 서버 수 */
function counts() {
    const guilds: any = S().GuildStore?.getGuilds?.() ?? {}
    const list: any[] = Object.values(guilds)
    const me = S().UserStore?.getCurrentUser?.()?.id
    const total = (typeof S().GuildStore?.getGuildCount === 'function' ? S().GuildStore.getGuildCount() : list.length) + unavailable()
    const owned = me ? list.filter(g => (g?.ownerId ?? g?.owner_id) === me).length : 0
    // 서버 한도: 기본 100, Nitro 200
    const premium = S().UserStore?.getCurrentUser?.()?.premiumType
    const limit = premium === 2 ? 200 : 100
    return { total, owned, limit }
}

async function text() {
    const c = counts()
    const real = await serverCount()
    const total = real ?? c.total
    const lines = [`You're in **${total}** server${total === 1 ? '' : 's'} (${c.owned} owned, ${Math.max(0, c.limit - total)} left of ${c.limit}).`]
    // 앱에 보이는 수와 다르면 같이 알려준다
    if (real != null && real !== c.total) lines.push(`-# Discord's servers say ${real}, the app only shows ${c.total}.`)
    if (real == null) lines.push(`-# Counted from the app, couldn't ask Discord's servers.`)
    return lines.join('\n')
}

let bot: any
function sendEphemeral(channelId: string, content: string) {
    bot ??= (lookupModule(withProps('sendBotMessage') as any) as any)?.[0]
    bot?.sendBotMessage?.(channelId, content)
}

function enumValue(name: string, key: string, fallback: any) {
    try {
        const [mod] = lookupModule(withProps(name) as any) as any
        return mod?.[name]?.[key] ?? fallback
    } catch {
        return fallback
    }
}

let command: any
function makeCommand() {
    if (command) return command
    const description = 'Show how many servers you are in'
    const option = 'Send it to the chat instead of only you'
    command = {
        id: '-73930',
        untranslatedName: 'servers',
        displayName: 'servers',
        type: CHAT,
        inputType: enumValue('ApplicationCommandInputType', 'BUILT_IN_TEXT', 1),
        applicationId: '-1',
        untranslatedDescription: description,
        displayDescription: description,
        options: [{ name: 'send', displayName: 'send', description: option, displayDescription: option, type: BOOLEAN, required: false }],
        async execute(args: any[], ctx: any) {
            const send = Array.isArray(args) && args.find(a => a?.name === 'send')?.value
            const content = await text()
            if (send) return { content }
            const id = ctx?.channel?.id
            if (id) sendEphemeral(id, content)
        },
    }
    return command
}

function SettingsPage() {
    const [, tick] = useState(0)
    const [real, setReal] = useState<number | null | undefined>(undefined)
    useEffect(() => {
        serverCount().then(setReal)
    }, [])
    useEffect(() => {
        const store = S().GuildStore
        const on = () => tick(n => n + 1)
        store?.addChangeListener?.(on)
        return () => store?.removeChangeListener?.(on)
    }, [])
    const c = counts()
    const total = real ?? c.total
    const { owned, limit } = c
    const { Stack, TableRowGroup, TableRow, Text } = Design as any
    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup title="Your servers">
                    <TableRow label="Servers" trailing={<Text variant="text-md/semibold">{`${total} / ${limit}`}</Text>} />
                    <TableRow label="Owned by you" trailing={<Text variant="text-md/semibold">{String(owned)}</Text>} />
                    <TableRow label="Room left" trailing={<Text variant="text-md/semibold">{String(Math.max(0, limit - total))}</Text>} />
                    <TableRow
                        label="Shown in the app"
                        subLabel={real === undefined ? 'Asking Discord\u2019s servers\u2026' : real === null ? 'Couldn\u2019t ask Discord\u2019s servers' : real === c.total ? 'Same as Discord\u2019s servers' : `Discord\u2019s servers say ${real}`}
                        trailing={<Text variant="text-md/semibold">{String(c.total)}</Text>}
                    />
                </TableRowGroup>
                <Text variant="text-sm/medium" color="text-muted">
                    Type /servers in any chat to see this, or /servers send:True to post it.
                </Text>
            </Stack>
        </Page>
    )
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
                            const ours = makeCommand()
                            return result.some((r: any) => r?.id === ours.id) ? result : [...result, ours]
                        } catch {
                            return result
                        }
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
