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
import { shortWhen } from './time'

/**
 * 반응 목록 창 (메시지의 반응을 꾹 눌렀을 때 나오는 창, modules/reactions/native/MessageReactionsContent.tsx)에
 * 반응을 지운 사람도 넣는다. 이름은 빨간색, 옆에 지운 시각.
 *  - 목록은 MessageReactionsStore.getReactions(채널, 메시지, 이모지, 개수, 종류) 결과를 그대로 그린다 → 거기에 덧붙인다
 *  - 이름은 DiscordTag({ user, nick }) 가 그린다 → 우리가 표시한 사람만 빨간 이름으로 바꿔 그린다
 */

const NAME = 'modules/user_profile/native/DiscordTag.tsx'
const CONTENT = 'modules/reactions/native/MessageReactionsContent.tsx'
const ROW = 'design/void/Form/native/FormRow.tsx'
const TAP = 'modules/messages/native/MessagesUtils.tsx'
const EMOJI = 'utils/EmojiUtils.tsx'

/** 줄 전체 (프로필 사진까지) 를 덮는 표시가 켜졌는지. 안 켜졌으면 이름 칸에만 표시 */
let rowPatched = false
const MARK = '__mlRemovedAt'

const S = () => Stores as any

export const sameEmoji = (a: any, b: any) => (a?.id ? String(a.id) === String(b?.id ?? '') : !b?.id && String(a?.name ?? '') === String(b?.name ?? ''))

/** 지금 그 이모지에 반응해 있지 않은, 이 메시지에서 그 이모지를 지운 사람들 (사람마다 마지막 것) */
export function removedFor(messageId: string, emoji: any, present: Set<string>) {
    const last = new Map<string, any>()
    for (const r of removedReactions(messageId)) {
        if (!r.u || !sameEmoji(r.em, emoji)) continue
        last.set(r.u, r)
    }
    // 마지막 기록이 "다시 반응함"이면 지운 사람이 아니다
    return [...last.values()].filter(r => !r.back && !present.has(r.u))
}

/** 목록에 넣을 사용자 객체: 디스코드 사용자 객체의 복사본에 지운 시각 표시 (원본은 건드리지 않는다) */
export function markedUser(r: any): any {
    let real: any
    let cur: any
    try {
        real = S().UserStore?.getUser?.(r.u)
        cur = S().UserStore?.getCurrentUser?.()
    } catch {}
    let x: any
    if (real) x = Object.assign(Object.create(Object.getPrototypeOf(real)), real)
    else {
        // 디스코드가 모르는 사람 (꺼져 있을 때 Discord Watch 가 잡은 사람 등).
        // 내 사용자 객체를 그대로 복사해 칸과 함수를 모두 갖춘 뒤 이름, 사진만 바꾼다.
        // 칸이나 함수가 빠진 객체를 넘기면 프로필 사진을 고르다가 멈춘다 (getAvatarSource, isProvisional)
        const name = r.un?.username ?? 'unknown'
        const own = {
            id: r.u,
            username: name,
            globalName: r.un?.global_name ?? null,
            global_name: r.un?.global_name ?? null,
            avatar: r.un?.avatar ?? null,
            discriminator: '0',
            bot: false,
            system: false,
            banner: null,
            bannerColor: null,
            avatarDecorationData: null,
            collectibles: null,
            primaryGuild: null,
            displayNameStyles: null,
            premiumType: null,
            flags: 0,
            publicFlags: 0,
        }
        // 칸을 바꿀 때는 defineProperty 로 (디스코드 사용자 객체는 읽기 전용 칸이 있어서 x[k] = v 는 오류가 난다)
        const put = (o: any, k: string, v: any) => {
            try {
                Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
            } catch {}
        }
        if (cur)
            try {
                x = Object.create(Object.getPrototypeOf(cur))
                for (const k of Object.getOwnPropertyNames(cur)) {
                    const d = Object.getOwnPropertyDescriptor(cur, k)
                    if (d) put(x, k, 'value' in d ? d.value : cur[k])
                }
                for (const k of Object.keys(own)) if (k in x || k === 'id' || k === 'username') put(x, k, (own as any)[k])
                for (const k of ['email', 'phone', 'verified', 'mfaEnabled', 'nsfwAllowed', 'purchasedFlags', 'premiumUsageFlags', 'ageVerificationStatus'])
                    if (k in x) put(x, k, null)
                if (x.id !== r.u) x = undefined
            } catch {
                x = undefined
            }
        x ??= { ...own }
        // 그래도 없는 함수는 무난한 값으로
        const safe: Record<string, (...a: any[]) => any> = {
            isProvisional: () => false,
            isNonUserBot: () => false,
            isSystemUser: () => false,
            isClyde: () => false,
            isStaff: () => false,
            isStaffPersonal: () => false,
            hasFlag: () => false,
            hasAnyFlag: () => false,
            hasAvatarForGuild: () => false,
            isPomelo: () => true,
            toString: () => name,
        }
        for (const k of Object.keys(safe)) if (typeof x[k] !== 'function') put(x, k, safe[k])
    }
    try {
        x[MARK] = r.at
    } catch {}
    if (x[MARK] !== r.at) Object.defineProperty(x, MARK, { value: r.at, enumerable: false, configurable: true })
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
    const red = redCss(1)
    // 한 줄로: 반응 목록은 줄 높이가 정해져 있어서 두 줄이면 다음 줄과 겹친다
    const text = (
        <Text variant="text-md/semibold" style={{ color: red }} numberOfLines={1}>
            {name}
            <Text variant="text-xs/medium" style={{ color: red, opacity: 0.8 }}>
                {`  removed ${shortWhen(user[MARK])}`}
            </Text>
        </Text>
    )
    if (rowPatched) return <View style={{ flex: 1, justifyContent: 'center' }}>{text}</View>
    return <View style={{ flex: 1, alignSelf: 'stretch', justifyContent: 'center', backgroundColor: redCss(0.14), borderLeftWidth: 3, borderLeftColor: red, borderRadius: 4, paddingHorizontal: 8 }}>{text}</View>
}

/** 반응 목록 창의 한 줄 (FormRow) 이 지운 사람이면 줄 전체를 지워진 메시지처럼: 옅은 빨간 배경 + 왼쪽 빨간 줄 */
export function isRemovedRow(props: any) {
    return !!props?.label?.props?.user?.[MARK]
}
export function RemovedRowBox({ children }: { children: any }) {
    return <View style={{ backgroundColor: redCss(0.14), borderLeftWidth: 3, borderLeftColor: redCss(1), borderRadius: 6, overflow: 'hidden' }}>{children}</View>
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

/** 지금 그 이모지에 반응해 있는 사람들 (디스코드가 불러 둔 만큼, 우리가 덧붙인 사람 빼고) */
function presentOf(channelId: string, messageId: string, emoji: any) {
    try {
        const out = rawGet?.(channelId, messageId, emoji, 100, 0)
        const all: any[] = out ? Array.from(typeof out.values === 'function' ? out.values() : Object.values(out)) : []
        return new Set(all.filter(u => !u?.[MARK]).map(u => String(u?.id)))
    } catch {
        return new Set<string>()
    }
}

// ── 채팅의 반응 버튼 ─────────────────────────────────────────────────────
// 네이티브 부분(Pills.kt)이 이모지 설명 끝의 표시를 보고 버튼 숫자 옆에 빨간 (n) 을 그린다.
export const PILL_START = '\uE010'
export const PILL_END = '\uE011'
const pillMark = (n: number, color: number, only: boolean) => `${PILL_START}${n},${color | 0}${only ? ',f' : ''}${PILL_END}`

let emojiUtils: any
const srcs = new Map<string, string>()

function srcFor(em: any): string | undefined {
    const known = srcs.get(emojiKey(em))
    if (known) return known
    if (em?.id) return `https://cdn.discordapp.com/emojis/${em.id}.${em.animated ? 'gif' : 'webp'}?size=48`
    try {
        const u = (emojiUtils?.default ?? emojiUtils)?.getURL?.(em?.name)
        if (typeof u === 'string' && u) return u
    } catch {}
}

/** 버튼 탭으로 온 반응이 우리가 넣은 "모두 지운 이모지" 버튼인지 */
export const isFakePill = (reaction: any) => {
    const d = String(reaction?.emoji?.displayName ?? '')
    return d.includes(PILL_START) && d.includes(`,f${PILL_END}`)
}

/**
 * 채팅 줄(row.message.reactions)에: 사람이 지운 이모지는 설명 끝에 (n) 표시,
 * 모두 지워서 사라진 이모지는 (n) 버튼을 새로 넣는다. 바꾼 게 있으면 true.
 */
export function decoratePills(message: any, color: number): boolean {
    if (!settings().logReactions || !message?.id || !Array.isArray(message.reactions)) return false
    const id = String(message.id)
    const list = removedReactions(id).filter((r: any) => r.u)
    if (!list.length) return false
    const ch = String(message.channelId ?? message.channel_id ?? list[0].c)
    const left = new Map<string, any>()
    for (const r of list) if (!left.has(emojiKey(r.em))) left.set(emojiKey(r.em), r.em)
    let changed = false
    const out = message.reactions.map((x: any) => {
        const key = emojiKey(x?.emoji)
        if (x?.emoji?.src) srcs.set(key, x.emoji.src)
        if (!left.has(key)) return x
        left.delete(key)
        if ((x?.burst_count ?? 0) > 0 || !x?.emoji) return x
        const n = removedFor(id, x.emoji, presentOf(ch, id, x.emoji)).length
        if (!n) return x
        changed = true
        const label = String(x.emoji.displayName ?? x.emoji.name ?? '')
        return { ...x, emoji: { ...x.emoji, displayName: label + pillMark(n, color, false) } }
    })
    for (const em of left.values()) {
        const n = removedFor(id, em, presentOf(ch, id, em)).length
        const src = n ? srcFor(em) : undefined
        if (!n || !src) continue
        changed = true
        out.push({
            count: n,
            me: false,
            me_burst: false,
            burst_count: 0,
            burst_colors: [],
            count_details: { normal: n, burst: 0 },
            emoji: { id: em.id ? String(em.id) : null, name: em.name, src, displayName: String(em.name ?? '') + pillMark(n, color, true), animated: !!em.animated },
        })
    }
    if (changed) message.reactions = out
    return changed
}

/** 반응 목록 창의 탭들: 사람이 지운 이모지는 숫자 옆에 빨간 (n), 모두 지워서 메시지에서 사라진 이모지는 빨간 (n) 탭으로 넣는다 */
export function withRemovedTabs(p: any) {
    const reactions: any[] = Array.isArray(p?.reactions) ? p.reactions : []
    if (!settings().logReactions || !p?.messageId) return reactions
    const mid = String(p.messageId)
    const list = removedReactions(mid).filter((r: any) => r.u)
    if (!list.length) return reactions
    const groups = new Map<string, any>()
    for (const r of list) if (!groups.has(emojiKey(r.em))) groups.set(emojiKey(r.em), r.em)
    const out = reactions.map(x => {
        const key = emojiKey(x?.emoji)
        if (!groups.has(key)) return x
        groups.delete(key)
        if ((x?.burst_count ?? 0) > 0) return x
        const n = removedFor(mid, x.emoji, presentOf(String(p.channelId), mid, x.emoji)).length
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
    // 채팅의 "모두 지운 이모지" 버튼을 눌러도 반응이 달리지 않게
    const patchTap = (mod: any) => {
        if (typeof mod?.handleAddOrRemoveReaction !== 'function') return
        cleanup(
            instead(mod, 'handleAddOrRemoveReaction', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                if (isFakePill(args?.[2])) return
                return orig.apply(this, args)
            }),
        )
    }
    cleanup(
        getModuleWithImportedPath(TAP, (m: any) => {
            if (m) patchTap(m)
            else cleanup(waitForModuleWithImportedPath(TAP, (x: any) => patchTap(x)) as any)
        }) as any,
    )
    cleanup(
        getModuleWithImportedPath(EMOJI, (m: any) => {
            if (m) emojiUtils = m
            else cleanup(waitForModuleWithImportedPath(EMOJI, (x: any) => (emojiUtils = x)) as any)
        }) as any,
    )
    // 줄 전체
    const patchRow = (mod: any) => {
        const orig = mod?.default
        if (typeof orig !== 'function') return
        cleanup(
            instead(mod, 'default', function (this: unknown, args: any[], o: (...a: any[]) => any) {
                const p = args?.[0]
                if (!isRemovedRow(p)) return o.apply(this, args)
                return <RemovedRowBox>{o.apply(this, args)}</RemovedRowBox>
            }),
        )
        // FormRow.Icon, FormRow.Arrow 같은 붙은 것들은 그대로 쓸 수 있게
        try {
            const now = mod.default
            if (now !== orig) for (const k of Object.keys(orig)) if (!(k in now)) now[k] = orig[k]
        } catch {}
        rowPatched = true
        cleanup(() => {
            rowPatched = false
        })
    }
    cleanup(
        getModuleWithImportedPath(ROW, (m: any) => {
            if (m) patchRow(m)
            else cleanup(waitForModuleWithImportedPath(ROW, (x: any) => patchRow(x)) as any)
        }) as any,
    )
    cleanup(
        getModuleWithImportedPath(NAME, (m: any) => {
            if (m) patchName(m)
            else cleanup(waitForModuleWithImportedPath(NAME, (x: any) => patchName(x)) as any)
        }) as any,
    )
}
