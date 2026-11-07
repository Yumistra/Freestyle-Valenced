import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'

/**
 * Hide Disabled Emojis: 이모지 고르기에서 쓸 수 없는(흐리게, 자물쇠로 보이는) 이모지를 숨긴다.
 * BetterDiscord 의 HideDisabledEmojis 를 옮긴 것.
 *
 * 디스코드 모바일 이모지 고르기는 useEmojiCategories(intention, channel, { guildId }) 로 묶음 목록을 받는다.
 *  - 서버 묶음: { type, guild, isNitroLocked, emojis, emojisDisabled, emojisHidden }
 *  - 즐겨찾기, 최근, 자주 쓰는 것: { type, id, name, isNitroLocked, emojis, emojisDisabled }
 * 네이티브 고르기는 서버 묶음의 이모지를 기기 DB 에서 직접 읽고 emojisHidden 에 든 id 만 뺀다.
 * 그래서 숨길 이모지는 emojis 에서 빼고 emojisHidden 에도 넣는다.
 * 니트로가 없으면 다른 서버 묶음은 통째로 뺀다 (이름, 왼쪽 서버 아이콘까지).
 * 검색 결과(useEmojiSearchResults)도 같은 기준으로 거른다.
 */

function hasNitro() {
    try {
        const u = (Stores as any).UserStore?.getCurrentUser?.()
        return !!u && u.premiumType != null && u.premiumType !== 0
    } catch {
        return false
    }
}
function selectedGuild(): string | undefined {
    try {
        return (Stores as any).SelectedGuildStore?.getGuildId?.() ?? undefined
    } catch {}
}
function guildOf(channel: any, opts: any): string | undefined {
    try {
        if (opts?.guildId != null) return String(opts.guildId)
        const g = channel?.getGuildId?.() ?? channel?.guild_id
        if (g != null) return String(g)
    } catch {}
    return selectedGuild()
}
const emojiGuild = (e: any) => {
    const g = e?.guildId ?? e?.guild_id
    return g == null ? undefined : String(g)
}
/** 니트로가 없으면 움직이는 이모지와 다른 서버 이모지는 쓸 수 없다 */
function locked(e: any, nitro: boolean, guild: string | undefined) {
    if (nitro || !e || e.id == null) return false
    if (e.animated) return true
    const g = emojiGuild(e)
    return g != null && g !== guild
}
const inSet = (s: any, id: any) => (s instanceof Set ? s.has(id) : Array.isArray(s) ? s.includes(id) : false)

const cache = new WeakMap<object, { key: string; out: any }>()

function filterCategories(cats: any[], guild: string | undefined): any[] {
    if (!Array.isArray(cats)) return cats
    const nitro = hasNitro()
    const key = `${nitro}|${guild}`
    const hit = cache.get(cats)
    if (hit?.key === key) return hit.out
    const out: any[] = []
    let changed = false
    for (const c of cats) {
        const emojis = c?.emojis
        if (!c || !Array.isArray(emojis)) {
            out.push(c)
            continue
        }
        const gid = c.guild?.id != null ? String(c.guild.id) : undefined
        // 니트로가 없으면 다른 서버 묶음은 통째로, 통째로 잠긴 묶음도 뺀다
        if (c.guild && ((!nitro && gid !== guild) || c.isNitroLocked === true)) {
            changed = true
            continue
        }
        const hide: string[] = []
        const kept = emojis.filter((e: any) => {
            if (e?.id == null) return true
            if (inSet(c.emojisDisabled, e.id) || inSet(c.emojisDisabled, String(e.id)) || locked(e, nitro, guild)) {
                hide.push(String(e.id))
                return false
            }
            return true
        })
        if (!hide.length) {
            out.push(c)
            continue
        }
        changed = true
        if (!kept.length) continue
        const next: any = { ...c, emojis: kept, isNitroLocked: false }
        if (c.guild) {
            const was = c.emojisHidden
            const ids = new Set<string>([...(was ? Array.from(was as any, String) : []), ...hide])
            next.emojisHidden = Array.isArray(was) ? [...ids] : ids
        }
        out.push(next)
    }
    const res = changed ? out : cats
    cache.set(cats, { key, out: res })
    return res
}

function filterSearch(res: any, guild: string | undefined): any {
    if (!res || typeof res !== 'object') return res
    const nitro = hasNitro()
    const key = `${nitro}|${guild}`
    const hit = cache.get(res)
    if (hit?.key === key) return hit.out
    const keep = (list: any) => (Array.isArray(list) ? list.filter((e: any) => !locked(e, nitro, guild)) : list)
    let out = res
    if (Array.isArray(res)) out = keep(res)
    else if ('locked' in res || 'unlocked' in res) out = { ...res, locked: Array.isArray(res.locked) ? [] : res.locked, unlocked: keep(res.unlocked) }
    cache.set(res, { key, out })
    return out
}

export default plugin({
    start({ cleanup }: any) {
        const patched = new WeakSet<object>()
        cleanup(
            getModules(withProps('useEmojiCategories') as any, (mod: any) => {
                if (patched.has(mod)) return
                patched.add(mod)
                if (typeof mod?.useEmojiCategories === 'function')
                    cleanup(
                        instead(mod, 'useEmojiCategories', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                            const res = orig.apply(this, args)
                            try {
                                return filterCategories(res, guildOf(args[1], args[2]))
                            } catch {
                                return res
                            }
                        }),
                    )
                if (typeof mod?.useEmojiSearchResults === 'function')
                    cleanup(
                        instead(mod, 'useEmojiSearchResults', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                            const res = orig.apply(this, args)
                            try {
                                return filterSearch(res, guildOf(args[1], undefined))
                            } catch {
                                return res
                            }
                        }),
                    )
            }) as any,
        )
    },
} as any)
