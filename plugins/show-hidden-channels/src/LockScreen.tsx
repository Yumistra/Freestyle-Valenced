import { Design } from '@valenced/discord/design'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { settings } from './store'
import { channelOf, find, isHidden, perm, reads, S } from './util'

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


// ── 더 알아낼 수 있는 것 ─────────────────────────────────────────────────
/** 서버 설정에서 이 채널이 맡은 역할 (AFK, 시스템 메시지, 규칙 등) */
function usedFor(guild: any, id: string): string[] {
    if (!guild) return []
    const pick = (camel: string, snake: string) => guild[camel] ?? guild[snake]
    const out: string[] = []
    if (pick('afkChannelId', 'afk_channel_id') === id) out.push('AFK channel')
    if (pick('systemChannelId', 'system_channel_id') === id) out.push('System messages')
    if (pick('rulesChannelId', 'rules_channel_id') === id) out.push('Rules')
    if (pick('publicUpdatesChannelId', 'public_updates_channel_id') === id) out.push('Community updates')
    if (pick('safetyAlertsChannelId', 'safety_alerts_channel_id') === id) out.push('Safety alerts')
    if (pick('widgetChannelId', 'widget_channel_id') === id) out.push('Widget invite')
    return out
}

const VOCAL = new Set([2, 13])
/** 카테고리 이름과 그 안에서 몇 번째인지 */
function place(channel: any): string | undefined {
    try {
        const all: any[] = Object.values<any>(S().ChannelStore?.getMutableGuildChannelsForGuild?.(channel.guild_id) ?? {})
        const sibs = all
            .filter(c => (c?.parent_id ?? null) === (channel.parent_id ?? null) && c?.type !== 4)
            // 디스코드처럼 글 채널이 먼저, 그다음 음성. 같은 쪽은 position 순
            .sort((a, b) => Number(VOCAL.has(a.type)) - Number(VOCAL.has(b.type)) || (a.position ?? 0) - (b.position ?? 0) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        const i = sibs.findIndex(c => c.id === channel.id)
        const parent = channelOf(channel.parent_id)
        const where = !parent ? 'No category' : isHidden(parent) ? 'A hidden category' : parent.name
        return i < 0 ? where : `${where}, ${i + 1} of ${sibs.length}`
    } catch {}
}

/** 읽음 기록: 전에 볼 수 있었다면 남아 있다 */
function readState(channelId: string) {
    const rs = S().ReadStateStore
    reads.real = true
    try {
        const ack = rs?.ackMessageId?.(channelId)
        const last = rs?.lastMessageId?.(channelId)
        const mentions = Number(rs?.getMentionCount?.(channelId) ?? 0)
        return { ack: typeof ack === 'string' && ack !== '0' ? ack : undefined, last: typeof last === 'string' && last !== '0' ? last : undefined, mentions }
    } catch {
        return { mentions: 0 }
    } finally {
        reads.real = false
    }
}

function stage(channelId: string): any {
    try {
        return S().StageInstanceStore?.getStageInstanceByChannel?.(channelId)
    } catch {}
}

let http: any
function api() {
    if (!http) {
        const a = find('HTTP')?.HTTP
        http = a?.get ? a : find('getAPIBaseURL', 'get')
    }
    return http
}

interface Audit {
    state: 'loading' | 'found' | 'none' | 'error'
    name?: string
    topic?: string
    by?: string
    error?: string
}

/** 감사 로그에서 채널을 만들거나 바꾼 기록을 찾는다 (볼 권한이 있을 때만). 45일 동안만 남는다 */
function useAudit(channel: any, allowed: boolean): Audit | undefined {
    const [audit, setAudit] = useState<Audit | undefined>(allowed ? { state: 'loading' } : undefined)
    useEffect(() => {
        if (!allowed || !channel?.id) return
        let dead = false
        ;(async () => {
            try {
                const entries: any[] = []
                for (const type of [11, 10]) {
                    const res = await api()?.get?.({ url: `/guilds/${channel.guild_id}/audit-logs`, query: { action_type: type, limit: 100 } })
                    for (const e of res?.body?.audit_log_entries ?? []) if (e?.target_id === channel.id) entries.push(e)
                }
                // 새 것부터
                entries.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
                const value = (key: string) => {
                    for (const e of entries) {
                        const c = (e.changes ?? []).find((x: any) => x?.key === key && x.new_value != null)
                        if (c) return String(c.new_value)
                    }
                }
                const created = entries.find(e => e.action_type === 10)
                if (dead) return
                setAudit(entries.length ? { state: 'found', name: value('name'), topic: value('topic'), by: created?.user_id } : { state: 'none' })
            } catch (e: any) {
                if (!dead) setAudit({ state: 'error', error: e?.body?.message ?? e?.message ?? String(e) })
            }
        })()
        return () => {
            dead = true
        }
    }, [channel?.id, allowed])
    return audit
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
    const guild = S().GuildStore?.getGuild?.(guildId)
    const usedAs = usedFor(guild, channel?.id)
    const rs = readState(channel?.id)
    const live = vocal ? stage(channel?.id) : undefined
    const canAudit = !!guild && !!S().PermissionStore?.can?.(perm('VIEW_AUDIT_LOG'), guild)
    const audit = useAudit(channel, canAudit)

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
                <Row label="Used as" value={usedAs.length ? usedAs.join(', ') : undefined} />
                <Row label="Place" value={place(channel)} />
                <Row label="Last message" value={last ?? (rs.last && rs.last !== rs.ack ? dateOf(rs.last) : undefined)} />
                <Row label="Slowmode" value={slow > 0 ? duration(slow) : undefined} />
                <Row label="Age restricted" value={channel?.nsfw ? 'Yes' : undefined} />
                <Row label="Bitrate" value={vocal && channel?.bitrate ? `${Math.round(channel.bitrate / 1000)} kbps` : undefined} />
                <Row label="User limit" value={vocal && channel?.userLimit ? String(channel.userLimit) : undefined} />
            </Card>
            {rs.ack || rs.mentions > 0 ? (
                <Card>
                    <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 4 }}>
                        You could see this channel before
                    </Text>
                    <Row label="Last read" value={dateOf(rs.ack)} />
                    <Row label="Unread mentions" value={rs.mentions > 0 ? String(rs.mentions) : undefined} />
                </Card>
            ) : null}
            {live ? (
                <Card>
                    <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 4 }}>
                        Live stage
                    </Text>
                    <Row label="Topic" value={live.topic || undefined} />
                    <Row label="Started" value={dateOf(live.id)} />
                </Card>
            ) : null}
            {audit ? (
                <Card>
                    <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 4 }}>
                        Audit log
                    </Text>
                    {audit.state === 'loading' ? (
                        <Text variant="text-md/medium" color="text-muted">
                            Looking...
                        </Text>
                    ) : audit.state === 'none' ? (
                        <Text variant="text-md/medium" color="text-muted">
                            Not in the audit log, it only keeps 45 days
                        </Text>
                    ) : audit.state === 'error' ? (
                        <Text variant="text-md/medium" color="text-muted">
                            {`Couldn't load, ${audit.error}`}
                        </Text>
                    ) : (
                        <>
                            <Row label="Real name" value={audit.name} />
                            <Row label="Topic" value={audit.topic} />
                            {audit.by ? (
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 }}>
                                    <Text variant="text-md/medium" color="text-muted">
                                        Created by
                                    </Text>
                                    <Person guildId={guildId} id={audit.by} />
                                </View>
                            ) : null}
                            {!audit.name && !audit.topic && !audit.by ? (
                                <Text variant="text-md/medium" color="text-muted">
                                    Found, but without the name
                                </Text>
                            ) : null}
                        </>
                    )}
                </Card>
            ) : null}
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
