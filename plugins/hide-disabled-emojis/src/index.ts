import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'

/**
 * Hide Disabled Emojis: 이모지 고르기에서 쓸 수 없는(흐리게 보이는) 이모지를 숨긴다.
 * BetterDiscord 의 HideDisabledEmojis 를 옮긴 것.
 *
 * 디스코드 모바일의 이모지 고르기는 useEmojiPickerData({ emojiSections, rowSize, ... }) 로 줄을 만든다.
 * 묶음(section)마다 emojis 와 쓸 수 없는 이모지 id 모음 emojisDisabled 가 있고,
 * 줄은 emojis 를 rowSize 개씩 잘라 만든다. 그래서 자르기 전에 emojis 에서 빼면 빈칸 없이 채워진다.
 * 다 빠진 묶음(니트로가 없어 통째로 잠긴 서버 등)은 이름표까지 없앤다.
 */

const done = new WeakMap<object, { key: string; out: any[] }>()

/** 니트로가 없으면 움직이는 이모지와 다른 서버 이모지는 쓸 수 없다 */
function hasNitro() {
    try {
        const u = (Stores as any).UserStore?.getCurrentUser?.()
        return !!u && u.premiumType != null && u.premiumType !== 0
    } catch {
        return false
    }
}
function currentGuild(): string | undefined {
    try {
        return (Stores as any).SelectedGuildStore?.getGuildId?.() ?? undefined
    } catch {}
}
/** 이 이모지를 숨길지 (니트로가 없을 때 움직이는 것, 다른 서버 것) */
function locked(e: any, nitro: boolean, guild: string | undefined) {
    if (nitro || !e || e.id == null) return false
    if (e.animated) return true
    const g = e.guildId ?? e.guild_id
    return g != null && g !== guild
}

function filterSections(sections: any[]): any[] {
    if (!Array.isArray(sections)) return sections
    const nitro = hasNitro()
    const guild = currentGuild()
    const key = `${nitro}|${guild}`
    const hit = done.get(sections)
    if (hit?.key === key) return hit.out
    const out: any[] = []
    for (const s of sections) {
        // 니트로가 없어 통째로 잠긴 묶음은 통째로 뺀다
        if (s?.isSectionNitroLocked === true && Array.isArray(s?.emojis)) continue
        const disabled = s?.emojisDisabled
        const emojis = s?.emojis
        if (!Array.isArray(emojis)) {
            out.push(s)
            continue
        }
        const has = (id: any) => (disabled instanceof Set ? disabled.has(id) : Array.isArray(disabled) ? disabled.includes(id) : false)
        const kept = emojis.filter((e: any) => e?.id == null || (!has(e.id) && !locked(e, nitro, guild)))
        if (!kept.length && emojis.length) continue
        out.push(kept.length === emojis.length ? s : { ...s, emojis: kept, emojisDisabled: new Set(), isSectionNitroLocked: false })
    }
    done.set(sections, { key, out })
    return out
}

export default plugin({
    start({ cleanup }: any) {
        const patched = new WeakSet<object>()
        cleanup(
            getModules(withProps('useEmojiPickerData') as any, (mod: any) => {
                if (typeof mod?.useEmojiPickerData !== 'function' || patched.has(mod)) return
                patched.add(mod)
                cleanup(
                    instead(mod, 'useEmojiPickerData', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const [props, ...rest] = args
                        if (!props || typeof props !== 'object' || !Array.isArray(props.emojiSections)) return orig.apply(this, args)
                        let sections = props.emojiSections
                        try {
                            sections = filterSections(props.emojiSections)
                        } catch {}
                        return orig.call(this, sections === props.emojiSections ? props : { ...props, emojiSections: sections }, ...rest)
                    }),
                )
            }) as any,
        )
    },
} as any)
