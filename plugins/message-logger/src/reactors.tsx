import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { createElement } from 'react'
import { Text as RNText, View } from 'react-native'
import { removedReactions } from './events'
import { redCss } from './rows'
import { settings } from './store'
import { when } from './time'

/**
 * 반응 목록 창 (메시지의 반응을 꾹 눌렀을 때 나오는 창, modules/reactions/native/MessageReactionsContent.tsx)에
 * 반응을 지운 사람도 넣는다. 이름은 빨간색, 옆에 지운 시각.
 *  - 목록은 MessageReactionsStore.getReactions(채널, 메시지, 이모지, 개수, 종류) 결과를 그대로 그린다 → 거기에 덧붙인다
 *  - 이름은 DiscordTag({ user, nick }) 가 그린다 → 우리가 표시한 사람만 빨간 이름으로 바꿔 그린다
 */

const NAME = 'modules/user_profile/native/DiscordTag.tsx'
const CONTENT = 'modules/reactions/native/MessageReactionsContent.tsx'
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
    // 지워진 메시지처럼: 옅은 빨간 배경 + 왼쪽 빨간 줄, 글자도 빨간색 (설정의 지운 색 또는 테마 색)
    const red = redCss(1)
    return (
        <View style={{ flex: 1, alignSelf: 'stretch', justifyContent: 'center', backgroundColor: redCss(0.14), borderLeftWidth: 3, borderLeftColor: red, borderRadius: 4, paddingVertical: 4, paddingHorizontal: 8 }}>
            <Text variant="text-md/semibold" style={{ color: red }} numberOfLines={1}>
                {name}
            </Text>
            <Text variant="text-xs/medium" style={{ color: red }} numberOfLines={1}>
                {`removed ${when(user[MARK])}`}
            </Text>
        </View>
    )
}

const emojiKey = (e: any) => (e?.id ? `i${e.id}` : `n${e?.name ?? ''}`)

/**
 * 탭의 숫자 자리에 넣을 것: 화면에는 "3 (1)" (괄호 안은 빨간색), 숫자로 쓰일 때는 n (디스코드가 "더 불러올지" 계산에 쓴다).
 * 디스코드는 반응 탭 숫자를 <Text>{count}</Text> 로 그리고, count > 불러온 사람 수 로 더 불러올지 정한다.
 */
export function countLabel(count: number | null, removed: number, numeric: number) {
    const red = <RNText style={{ color: redCss(1) }}>{`(${removed})`}</RNText>
    let el: any = count == null ? red : createElement(RNText, null, `${count} `, red)
    if (Object.isFrozen(el)) el = { ...el }
    try {
        Object.defineProperty(el, 'valueOf', { value: () => numeric })
        Object.defineProperty(el, 'toString', { value: () => (count == null ? `(${removed})` : `${count} (${removed})`) })
    } catch {}
    return el
}

let rawGet: ((...a: any[]) => any) | undefined

/** 반응 목록 창의 탭들: 사람이 지운 이모지는 숫자 옆에 빨간 (n), 모두 지워서 메시지에서 사라진 이모지는 빨간 (n) 탭으로 넣는다 */
export function withRemovedTabs(p: any) {
    const reactions: any[] = Array.isArray(p?.reactions) ? p.reactions : []
    if (!settings().logReactions || !p?.messageId) return reactions
    const mid = String(p.messageId)
    const list = removedReactions(mid).filter((r: any) => r.u)
    if (!list.length) return reactions
    const groups = new Map<string, any>()
    for (const r of list) if (!groups.has(emojiKey(r.em))) groups.set(emojiKey(r.em), r.em)
    const presentOf = (emoji: any) => {
        try {
            const out = rawGet?.(p.channelId, mid, emoji, 100, 0)
            const all: any[] = out ? Array.from(typeof out.values === 'function' ? out.values() : Object.values(out)) : []
            return new Set(all.map(u => String(u?.id)))
        } catch {
            return new Set<string>()
        }
    }
    const out = reactions.map(x => {
        const key = emojiKey(x?.emoji)
        if (!groups.has(key)) return x
        groups.delete(key)
        if ((x?.burst_count ?? 0) > 0) return x
        const n = removedFor(mid, x.emoji, presentOf(x.emoji)).length
        if (!n) return x
        const c = typeof x.count === 'number' ? x.count : Number(x.count) || 0
        return { ...x, count: countLabel(c, n, c + n) }
    })
    for (const em of groups.values()) {
        const n = removedFor(mid, em, new Set()).length
        if (!n) continue
        const emoji = { id: em.id ?? null, name: em.name, animated: !!em.animated }
        out.push({ emoji, count: countLabel(null, n, n), burst_count: 0, me: false, me_burst: false, burst_colors: [], count_details: { normal: 0, burst: 0 }, __mlRemoved: true })
    }
    return out
}

export function patchReactors(cleanup: (...f: any[]) => void) {
    // 목록
    let store: any
    try {
        store = S().MessageReactionsStore
    } catch {}
    if (typeof store?.getReactions !== 'function') store = (lookupModule(withProps('getReactions', 'getReactionsForMessage') as any) as any)?.[0] ?? (lookupModule(withProps('getReactions') as any) as any)?.[0]
    if (typeof store?.getReactions === 'function') {
        const raw = store.getReactions
        rawGet = (...a: any[]) => raw.apply(store, a)
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
    // 탭
    const patchTabs = (mod: any) => {
        if (typeof mod?.MessageReactionsContent !== 'function') return
        cleanup(
            instead(mod, 'MessageReactionsContent', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                const p = args?.[0]
                try {
                    const reactions = withRemovedTabs(p)
                    if (reactions !== p?.reactions) return orig.apply(this, [{ ...p, reactions }, ...args.slice(1)])
                } catch {}
                return orig.apply(this, args)
            }),
        )
    }
    cleanup(
        getModuleWithImportedPath(CONTENT, (m: any) => {
            if (m) patchTabs(m)
            else cleanup(waitForModuleWithImportedPath(CONTENT, (x: any) => patchTabs(x)) as any)
        }) as any,
    )
    cleanup(
        getModuleWithImportedPath(NAME, (m: any) => {
            if (m) patchName(m)
            else cleanup(waitForModuleWithImportedPath(NAME, (x: any) => patchName(x)) as any)
        }) as any,
    )
}
