import { Stores } from '@valenced/discord/flux'

const DM = 1
const GROUP_DM = 3

const S = () => Stores as any

export const channel = (id: string | undefined) => (id ? S().ChannelStore?.getChannel?.(id) : undefined)

/**
 * 버튼이 켜고 끄는 대상: 1:1 DM 은 상대 사용자(어느 DM 에서든 그 사람에게), 나머지는 그 채널.
 * (원래 플러그인의 /silent 와 같은 기준)
 */
export function targetOf(channelId: string | undefined): string | undefined {
    const ch = channel(channelId)
    if (!ch) return channelId
    if (ch.type === DM && Array.isArray(ch.recipients) && ch.recipients[0]) return String(ch.recipients[0])
    return String(ch.id)
}

/** 이 채널로 보내는 메시지를 조용히 보낼지 판단할 때 볼 ID 들 */
export function idsFor(channelId: string, mentions: any[] = []): string[] {
    const ch = channel(channelId)
    const ids = new Set<string>([channelId])
    if (ch) {
        if (ch.parent_id) ids.add(String(ch.parent_id))
        if ((ch.type === DM || ch.type === GROUP_DM) && Array.isArray(ch.recipients)) for (const r of ch.recipients) ids.add(String(r))
    }
    for (const m of mentions) {
        const id = typeof m === 'string' ? m : m?.id
        if (id) ids.add(String(id))
    }
    return [...ids]
}

/** 목록 항목을 사람이 읽을 이름으로 */
export function labelOf(id: string): string {
    try {
        const user = S().UserStore?.getUser?.(id)
        if (user) return `@${user.globalName ?? user.global_name ?? user.username}`
        const ch = channel(id)
        if (ch) {
            if (ch.name) return `#${ch.name}`
            if (Array.isArray(ch.recipients)) return ch.recipients.map((r: string) => S().UserStore?.getUser?.(r)?.username ?? r).join(', ')
        }
    } catch {}
    return id
}

export function currentChannelId(): string | undefined {
    try {
        return S().SelectedChannelStore?.getChannelId?.() ?? undefined
    } catch {
        return undefined
    }
}
