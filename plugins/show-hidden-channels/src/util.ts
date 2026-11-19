import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

export const S = () => Stores as any

export function find(...props: string[]): any {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

let perms: any
/** 디스코드의 권한 값 (못 찾으면 직접 계산한 값) */
const FALLBACK = { VIEW_CHANNEL: 1n << 10n, CONNECT: 1n << 20n, VIEW_AUDIT_LOG: 1n << 7n }
export function perm(name: keyof typeof FALLBACK): any {
    // 아직 안 불렸으면 다음에 다시 찾는다
    perms ??= find('Permissions', 'ChannelTypes')?.Permissions
    return perms?.[name] ?? FALLBACK[name]
}

/** 잠금 화면이 진짜 읽음 기록을 읽는 동안에는 안 읽음 숨기기를 건너뛴다 */
export const reads = { real: false }

export function samePerm(a: unknown, name: keyof typeof FALLBACK) {
    const b = perm(name)
    if (a === b) return true
    try {
        return BigInt(a as any) === BigInt(b)
    } catch {
        return false
    }
}

/** 볼 수 없는 서버 채널. connect 면 볼 수는 있어도 들어갈 수 없는 음성 채널도 포함 */
export function isHidden(channel: any, connect = false): boolean {
    try {
        if (!channel?.guild_id || channel.id == null) return false
        if (typeof channel.isDM === 'function' && (channel.isDM() || channel.isGroupDM?.())) return false
        const ps = S().PermissionStore
        if (!ps?.can) return false
        if (!ps.can(perm('VIEW_CHANNEL'), channel)) return true
        return connect && (channel.type === 2 || channel.type === 13) && !ps.can(perm('CONNECT'), channel)
    } catch {
        return false
    }
}

export function channelOf(id: unknown) {
    return typeof id === 'string' ? S().ChannelStore?.getChannel?.(id) : undefined
}
