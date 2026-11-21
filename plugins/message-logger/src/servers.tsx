import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { useEffect, useLayoutEffect, useState } from 'react'
import { FlatList, Image } from 'react-native'
import { onChange, setSettings, settings } from './store'

/** "고른 서버만 기록"에 넣을 서버 고르기 (설정 안의 새 화면) */
export const SERVERS_ROUTE = 'yumistra.message-logger.servers'

const S = () => Stores as any

function guilds(): Array<{ id: string; name: string; icon?: string }> {
    try {
        const all = S().GuildStore?.getGuilds?.() ?? {}
        const order: string[] = S().SortedGuildStore?.getFlattenedGuildIds?.() ?? Object.keys(all)
        return order
            .map(id => all[id])
            .filter(Boolean)
            .map((g: any) => ({ id: String(g.id), name: String(g.name ?? g.id), icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : undefined }))
    } catch {
        return []
    }
}

export function ServersScreen({ navigation }: { navigation?: any }) {
    useLayoutEffect(() => {
        try {
            navigation?.setOptions?.({ title: 'Servers to log' })
        } catch {}
    }, [])
    const { TableSwitchRow, TableRowGroup } = Design as any
    const [, force] = useState(0)
    useEffect(() => onChange(() => force(n => n + 1)) as any, [])
    const chosen = new Set(settings().onlyServers ?? [])
    const toggle = (id: string, on: boolean) => {
        const next = new Set(settings().onlyServers ?? [])
        if (on) next.add(id)
        else next.delete(id)
        setSettings({ onlyServers: [...next] })
    }
    return (
        <FlatList
            data={guilds()}
            keyExtractor={g => g.id}
            contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
            ListHeaderComponent={<TableRowGroup title={`${chosen.size} chosen, direct messages are not affected`} />}
            renderItem={({ item }) => (
                <TableSwitchRow
                    label={item.name}
                    icon={item.icon ? <Image source={{ uri: item.icon }} style={{ width: 24, height: 24, borderRadius: 12 }} /> : undefined}
                    value={chosen.has(item.id)}
                    onValueChange={(v: boolean) => toggle(item.id, v)}
                />
            )}
        />
    )
}
