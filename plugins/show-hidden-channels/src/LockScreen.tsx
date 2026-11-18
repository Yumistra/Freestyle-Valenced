import { Design } from '@valenced/discord/design'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { settings } from './store'
import { perm, S } from './util'

/**
 * 숨겨진 채널에 들어가면 채팅 대신 보여 주는 화면 (원본의 HiddenChannelLockScreen).
 * 디스코드가 이름, 주제, 진짜 권한은 안 보내서 남아 있는 것만 보여 준다.
 */

const EPOCH = 1420070400000n

const TYPES: Record<number, string> = {
    0: 'Text',
    2: 'Voice',
    4: 'Category',
    5: 'Announcement',
    13: 'Stage',
    15: 'Forum',
    16: 'Media',
}

function dateOf(id: unknown): string | undefined {
    try {
        if (typeof id !== 'string' || !/^\d+$/.test(id)) return
        return new Date(Number((BigInt(id) >> 22n) + EPOCH)).toLocaleString()
    } catch {}
}

function duration(sec: number) {
    if (sec < 60) return `${sec}s`
    if (sec < 3600) return `${Math.round(sec / 60)}m`
    return `${Math.round(sec / 3600)}h`
}

function nameOf(guildId: string, userId: string) {
    const u = S().UserStore?.getUser?.(userId)
    return S().GuildMemberStore?.getNick?.(guildId, userId) ?? u?.globalName ?? u?.global_name ?? u?.username ?? userId
}

function avatarOf(guildId: string, userId: string): string | undefined {
    try {
        const u = S().UserStore?.getUser?.(userId)
        return u?.getAvatarURL?.(guildId, 64) ?? undefined
    } catch {}
}

function roleOf(guildId: string, roleId: string): any {
    try {
        return S().GuildRoleStore?.getRole?.(guildId, roleId) ?? S().GuildStore?.getRole?.(guildId, roleId) ?? S().GuildStore?.getGuild?.(guildId)?.roles?.[roleId]
    } catch {}
}

/** 덮어쓰기에서 VIEW_CHANNEL(잠긴 음성 채널이면 CONNECT) 을 허용한 역할과 사용자 */
function allowed(channel: any, bit: bigint) {
    const roles: any[] = []
    const users: string[] = []
    for (const o of Object.values<any>(channel?.permissionOverwrites ?? {})) {
        try {
            if ((BigInt(o.allow ?? 0) & bit) !== bit) continue
            if (o.type === 1 || o.type === 'member') users.push(o.id)
            else {
                const r = roleOf(channel.guild_id, o.id)
                if (r) roles.push(r)
            }
        } catch {}
    }
    return { roles, users }
}

function useVoiceUsers(channelId: string): string[] {
    const read = () => Object.keys(S().VoiceStateStore?.getVoiceStatesForChannel?.(channelId) ?? {})
    const [ids, setIds] = useState(read)
    useEffect(() => {
        const st = S().VoiceStateStore
        const f = () => setIds(read())
        st?.addChangeListener?.(f)
        return () => st?.removeChangeListener?.(f)
    }, [channelId])
    return ids
}

function Row({ label, value }: { label: string; value?: string }) {
    const { Text } = Design as any
    if (!value) return null
    return (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: 12 }}>
            <Text variant="text-md/medium" color="text-muted">
                {label}
            </Text>
            <Text variant="text-md/semibold" color="text-default" style={{ flexShrink: 1, textAlign: 'right' }}>
                {value}
            </Text>
        </View>
    )
}

function Person({ guildId, id }: { guildId: string; id: string }) {
    const { Text } = Design as any
    const uri = avatarOf(guildId, id)
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
            {uri ? <Image source={{ uri }} style={{ width: 24, height: 24, borderRadius: 12 }} /> : <View style={{ width: 24, height: 24 }} />}
            <Text variant="text-md/medium" color="text-default">
                {nameOf(guildId, id)}
            </Text>
        </View>
    )
}

export default function LockScreen({ channel }: { channel: any }) {
    const { Text, Card: DCard } = Design as any
    const Card = DCard ?? View
    const Lock = lookupGeneratedIconComponent('LockIcon') as any
    const Chevron = lookupGeneratedIconComponent('ChevronSmallDownIcon') as any
    const [open, setOpen] = useState(settings().rolesOpen)
    const guildId = channel?.guild_id
    const vocal = channel?.type === 2 || channel?.type === 13
    const voice = useVoiceUsers(channel?.id)
    const canView = !!S().PermissionStore?.can?.(perm('VIEW_CHANNEL'), channel)
    // 볼 수는 있는데 들어갈 수 없는 음성 채널이면 CONNECT 를 허용한 쪽을 보여 준다
    const { roles, users } = allowed(channel, BigInt(perm(canView ? 'CONNECT' : 'VIEW_CHANNEL')))
    const name = settings().name
    const last = dateOf(channel?.lastMessageId ?? channel?.last_message_id)
    const slow = Number(channel?.rateLimitPerUser ?? channel?.rate_limit_per_user ?? 0)

    return (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, flexGrow: 1, justifyContent: 'center' }}>
            <View style={{ alignItems: 'center', gap: 8 }}>
                {Lock ? <Lock size="lg" color="icon-muted" /> : null}
                <Text variant="heading-lg/bold" color="text-strong" style={{ textAlign: 'center' }}>
                    {canView ? channel?.name : name}
                </Text>
                <Text variant="text-md/medium" color="text-muted" style={{ textAlign: 'center' }}>
                    {canView ? "You can't join this channel." : "You can't see the messages in this channel."}
                </Text>
            </View>
            <Card>
                <Row label="Type" value={TYPES[channel?.type] ?? String(channel?.type ?? '')} />
                <Row label="Created" value={dateOf(channel?.id)} />
                <Row label="Last message" value={last} />
                <Row label="Slowmode" value={slow > 0 ? duration(slow) : undefined} />
                <Row label="Age restricted" value={channel?.nsfw ? 'Yes' : undefined} />
                <Row label="Bitrate" value={vocal && channel?.bitrate ? `${Math.round(channel.bitrate / 1000)} kbps` : undefined} />
                <Row label="User limit" value={vocal && channel?.userLimit ? String(channel.userLimit) : undefined} />
            </Card>
            {vocal ? (
                <Card>
                    <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 4 }}>
                        {`In voice, ${voice.length}`}
                    </Text>
                    {voice.length ? voice.map(id => <Person key={id} guildId={guildId} id={id} />) : <Text variant="text-md/medium" color="text-muted">Nobody</Text>}
                </Card>
            ) : null}
            <Card>
                <Pressable onPress={() => setOpen(o => !o)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text variant="text-sm/semibold" color="text-muted">
                        {`Allowed roles and users, ${roles.length + users.length}`}
                    </Text>
                    {Chevron ? <Chevron size="sm" color="icon-muted" style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} /> : null}
                </Pressable>
                {open ? (
                    <View style={{ marginTop: 4 }}>
                        {roles.map(r => (
                            <Text key={r.id} variant="text-md/medium" style={{ paddingVertical: 4, ...(r.colorString ? { color: r.colorString } : null) }} color={r.colorString ? undefined : 'text-default'}>
                                {r.id === guildId ? '@everyone' : `@${r.name}`}
                            </Text>
                        ))}
                        {users.map(id => (
                            <Person key={id} guildId={guildId} id={id} />
                        ))}
                        {!roles.length && !users.length ? (
                            <Text variant="text-md/medium" color="text-muted" style={{ paddingVertical: 4 }}>
                                {canView ? 'None' : 'Discord no longer sends this'}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
            </Card>
        </ScrollView>
    )
}
