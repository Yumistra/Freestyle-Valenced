import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { removedReactions } from './events'
import { settings } from './store'
import { when } from './time'

/**
 * 반응 목록 창 (메시지의 반응을 꾹 눌렀을 때 나오는 창, modules/reactions/native/MessageReactionsContent.tsx)에
 * 반응을 지운 사람도 넣는다. 이름은 빨간색, 옆에 지운 시각.
 *  - 목록은 MessageReactionsStore.getReactions(채널, 메시지, 이모지, 개수, 종류) 결과를 그대로 그린다 → 거기에 덧붙인다
 *  - 이름은 DiscordTag({ user, nick }) 가 그린다 → 우리가 표시한 사람만 빨간 이름으로 바꿔 그린다
 */

const NAME = 'modules/user_profile/native/DiscordTag.tsx'
const MARK = '__mlRemovedAt'

const S = () => Stores as any

export const sameEmoji = (a: any, b: any) => (a?.id ? String(a.id) === String(b?.id ?? '') : !b?.id && String(a?.name ?? '') === String(b?.name ?? ''))

/** 지금 그 이모지에 반응해 있지 않은, 이 메시지에서 그 이모지를 지운 사람들 (사람마다 마지막 것) */
export function removedFor(messageId: string, emoji: any, present: Set<string>) {
    const last = new Map<string, any>()
    for (const r of removedReactions(messageId)) {
        if (!r.u || present.has(r.u) || !sameEmoji(r.em, emoji)) continue
        last.set(r.u, r)
    }
    return [...last.values()]
}

/** 목록에 넣을 사용자 객체: 디스코드 사용자 객체의 복사본에 지운 시각 표시 (원본은 건드리지 않는다) */
export function markedUser(r: any): any {
    let real: any
    let proto: any = Object.prototype
    try {
        real = S().UserStore?.getUser?.(r.u)
        const any = real ?? S().UserStore?.getCurrentUser?.()
        if (any) proto = Object.getPrototypeOf(any)
    } catch {}
    const base = real ?? { id: r.u, username: r.un?.username ?? 'unknown', globalName: r.un?.global_name ?? null, avatar: r.un?.avatar ?? null, discriminator: '0', bot: false }
    const x = Object.assign(Object.create(proto), base)
    x[MARK] = r.at
    return x
}

/** getReactions 결과에 지운 사람들을 덧붙인다 (결과는 Map 이거나 values() 가 있는 것) */
export function withRemoved(out: any, args: any[]) {
    if (!settings().logReactions) return out
    const [, messageId, emoji, , type] = args
    // 일반 반응만 (슈퍼 반응, 투표는 그대로)
    if (!messageId || !emoji || (type != null && type !== 0)) return out
    const current: any[] = out ? Array.from(typeof out.values === 'function' ? out.values() : Object.values(out)) : []
    const present = new Set(current.map(u => String(u?.id)))
    const extra = removedFor(String(messageId), emoji, present)
    if (!extra.length) return out
    const users = extra.map(markedUser)
    if (out instanceof Map) {
        const m = new Map(out)
        for (const u of users) m.set(String(u.id), u)
        return m
    }
    const all = [...current, ...users]
    return { values: () => all[Symbol.iterator](), size: all.length, get: (id: string) => all.find(u => String(u?.id) === String(id)) }
}

function RemovedName({ user, nick }: { user: any; nick?: string }) {
    const { Text } = Design as any
    const name = nick || user?.globalName || user?.global_name || user?.username || 'unknown'
    return (
        <Text variant="text-md/semibold" color="text-danger" numberOfLines={1}>
            {name}
            <Text variant="text-xs/medium" color="text-danger">{`  removed ${when(user[MARK])}`}</Text>
        </Text>
    )
}

export function patchReactors(cleanup: (...f: any[]) => void) {
    // 목록
    let store: any
    try {
        store = S().MessageReactionsStore
    } catch {}
    if (typeof store?.getReactions !== 'function') store = (lookupModule(withProps('getReactions', 'getReactionsForMessage') as any) as any)?.[0] ?? (lookupModule(withProps('getReactions') as any) as any)?.[0]
    if (typeof store?.getReactions === 'function') {
        cleanup(
            instead(store, 'getReactions', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                const out = orig.apply(this, args)
                try {
                    return withRemoved(out, args)
                } catch {
                    return out
                }
            }),
        )
    }
    // 이름
    const patchName = (mod: any) => {
        if (typeof mod?.default !== 'function') return
        cleanup(
            instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                const p = args?.[0]
                if (p?.user?.[MARK]) return <RemovedName user={p.user} nick={p.nick} />
                return orig.apply(this, args)
            }),
        )
    }
    cleanup(
        getModuleWithImportedPath(NAME, (m: any) => {
            if (m) patchName(m)
            else cleanup(waitForModuleWithImportedPath(NAME, (x: any) => patchName(x)) as any)
        }) as any,
    )
}
