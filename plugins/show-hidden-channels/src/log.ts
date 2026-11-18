import { channelOf, find, isHidden, S } from './util'

/** 테스트용 상태 기록 (설정의 Copy log) */
export const status: Record<string, any> = {}
export const errors: string[] = []
export function err(where: string, e: any) {
    if (errors.length < 30) errors.push(`${where}: ${e?.message ?? e}`)
}
export function count(key: string) {
    status[key] = (status[key] ?? 0) + 1
}

export function report(): string {
    const lines = ['Show Hidden Channels log']
    for (const [k, v] of Object.entries(status)) lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    try {
        const gid = S().SelectedGuildStore?.getGuildId?.()
        lines.push(`\nselected guild: ${gid}`)
        const chans: any = gid ? (S().GuildChannelStore?.getChannels?.(gid) ?? {}) : {}
        const all: any[] = Object.values<any>(S().ChannelStore?.getMutableGuildChannelsForGuild?.(gid) ?? {})
        const hidden = all.filter(c => isHidden(c))
        lines.push(`ChannelStore channels: ${all.length}, hidden: ${hidden.length}`)
        lines.push(`named ___hidden___: ${all.filter(c => c?.name === '___hidden___').length}, obfuscated flag: ${all.filter(c => { try { return c?.isObfuscated?.() } catch { return false } }).length}`)
        lines.push(`GuildChannelStore SELECTABLE: ${chans?.SELECTABLE?.length ?? '?'}, VOCAL: ${chans?.VOCAL?.length ?? '?'}`)
        const list = S().ChannelListStore?.getGuild?.(gid)?.guildChannels
        let shown = 0
        let cannot = 0
        let total = 0
        for (const cat of list?.getSortedCategories?.() ?? []) {
            for (const ch of Object.values<any>(cat?.channels ?? {})) {
                total++
                if (isHidden(ch?.record)) {
                    if (ch.renderLevel === 3 || String(ch.renderLevel).toLowerCase().includes('show')) shown++
                    cannot++
                }
            }
        }
        lines.push(`channel list entries: ${total}, hidden entries: ${cannot}, sample renderLevels: ${JSON.stringify(
            [...(list?.getSortedCategories?.() ?? [])].flatMap((c: any) => Object.values<any>(c?.channels ?? {})).filter((c: any) => isHidden(c?.record)).slice(0, 5).map((c: any) => [c.constructor?.name, c.renderLevel]),
        )}`)
        for (const c of hidden.slice(0, 5)) lines.push(`  ${c.id} type ${c.type} name ${c.name} parent ${c.parent_id} flags ${c.flags}`)
        for (const k of ['isChannelMetadataObfuscationEnabled', 'isChannelMetadataIntegrityCheckEnabled']) {
            try {
                lines.push(`${k}: ${find(k)?.[k]?.('ShowHiddenChannels')}`)
            } catch (e: any) {
                lines.push(`${k}: error ${e?.message}`)
            }
        }
        void channelOf
    } catch (e: any) {
        lines.push(`report error: ${e?.message ?? e}`)
    }
    if (errors.length) lines.push('\nerrors:', ...errors)
    return lines.join('\n')
}
