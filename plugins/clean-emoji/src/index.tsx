import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'

/**
 * Clean Emoji: 이모지, 스티커 고르기에서 쓸 수 없는(흐리게, 자물쇠로 보이는) 것을 숨긴다.
 * 스티커: useStickerCategories 결과와 검색(searchAllStickers)에서 니트로 없이 못 보내는 다른 서버 스티커를 뺀다.
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

/** 설정 화면 Status 에 보여 줄 값 */
const status = {
    found: 0,
    patched: [] as string[],
    errors: [] as string[],
    calls: 0,
    searches: 0,
    lastSections: 0,
    lastEmojis: 0,
    lastNitro: false as boolean,
    lastGuild: undefined as string | undefined,
    stickerCalls: 0,
    lastPacks: 0,
    lastStickers: 0,
}
const err = (where: string, e: any) => {
    const m = `${where}: ${e?.message ?? e}`
    if (!status.errors.includes(m)) status.errors.push(m)
}

const cache = new WeakMap<object, { key: string; out: any }>()

function filterCategories(cats: any[], guild: string | undefined): any[] {
    if (!Array.isArray(cats)) return cats
    const nitro = hasNitro()
    const key = `${nitro}|${guild}`
    status.calls++
    status.lastNitro = nitro
    status.lastGuild = guild
    const hit = cache.get(cats)
    if (hit?.key === key) return hit.out
    const out: any[] = []
    let changed = false
    let sections = 0
    let hidden = 0
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
            sections++
            hidden += emojis.length
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
        hidden += hide.length
        if (!kept.length) {
            sections++
            continue
        }
        const next: any = { ...c, emojis: kept, isNitroLocked: false }
        if (c.guild) {
            const was = c.emojisHidden
            const ids = new Set<string>([...(was ? Array.from(was as any, String) : []), ...hide])
            next.emojisHidden = Array.isArray(was) ? [...ids] : ids
        }
        out.push(next)
    }
    status.lastSections = sections
    status.lastEmojis = hidden
    const res = changed ? out : cats
    cache.set(cats, { key, out: res })
    return res
}

function filterSearch(res: any, guild: string | undefined): any {
    if (!res || typeof res !== 'object') return res
    const nitro = hasNitro()
    const key = `${nitro}|${guild}`
    status.searches++
    const hit = cache.get(res)
    if (hit?.key === key) return hit.out
    const keep = (list: any) => (Array.isArray(list) ? list.filter((e: any) => !locked(e, nitro, guild)) : list)
    let out = res
    if (Array.isArray(res)) out = keep(res)
    else if ('locked' in res || 'unlocked' in res) out = { ...res, locked: Array.isArray(res.locked) ? [] : res.locked, unlocked: keep(res.unlocked) }
    cache.set(res, { key, out })
    return out
}

/** 니트로가 없으면 다른 서버 스티커는 못 보낸다. 디스코드 기본 스티커(guild_id 없음)는 괜찮다 */
function stickerLocked(st: any, nitro: boolean, guild: string | undefined) {
    if (!st) return false
    if (st.available === false) return true
    if (nitro) return false
    const g = st.guild_id ?? st.guildId
    return g != null && String(g) !== guild
}

function filterStickerCategories(cats: any[], guild: string | undefined): any[] {
    if (!Array.isArray(cats)) return cats
    const nitro = hasNitro()
    const key = `${nitro}|${guild}`
    status.stickerCalls++
    const hit = cache.get(cats)
    if (hit?.key === key) return hit.out
    let changed = false
    let packs = 0
    let hidden = 0
    const out: any[] = []
    for (const c of cats) {
        const list = c?.stickers
        if (!c || !Array.isArray(list)) {
            out.push(c)
            continue
        }
        if (c.isNitroLocked === true) {
            changed = true
            packs++
            hidden += list.length
            continue
        }
        const kept = list.filter((st: any) => !stickerLocked(st, nitro, guild))
        if (kept.length === list.length) {
            out.push(c)
            continue
        }
        changed = true
        hidden += list.length - kept.length
        if (!kept.length) {
            packs++
            continue
        }
        out.push({ ...c, stickers: kept })
    }
    status.lastPacks = packs
    status.lastStickers = hidden
    const res = changed ? out : cats
    cache.set(cats, { key, out: res })
    return res
}

/** 이모지 고르기의 쓰임 (EmojiIntention): 0 이 반응, 3 이 채팅 */
const REACTION = 0
let storage: any
const reactionsOnly = () => !!storage?.cache?.reactionsOnly
/** "반응에서만" 이면 반응이 아닌 곳(채팅 등)의 고르기는 그대로 둔다 */
function skip(args: any[]) {
    if (!reactionsOnly()) return false
    const intention = args.find(a => typeof a === 'number')
    return intention !== REACTION
}

function patchModule(mod: any, cleanup: (...f: any[]) => void, patched: WeakSet<object>) {
    if (!mod || typeof mod !== 'object' || patched.has(mod)) return
    patched.add(mod)
    status.found++
    const hook = (name: string, wrap: (res: any, args: any[]) => any) => {
        if (typeof mod[name] !== 'function') return
        try {
            cleanup(
                instead(mod, name, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                    const res = orig.apply(this, args)
                    try {
                        return wrap(res, args)
                    } catch (e) {
                        err(name, e)
                        return res
                    }
                }),
            )
            if (!status.patched.includes(name)) status.patched.push(name)
        } catch (e) {
            err(`patch ${name}`, e)
        }
    }
    hook('useEmojiCategories', (res, args) => (skip(args) ? res : filterCategories(res, guildOf(args[1], args[2]))))
    hook('useEmojiSearchResults', (res, args) => (skip(args) ? res : filterSearch(res, guildOf(args[1], undefined))))
    // 스티커는 반응에 못 쓰니 "반응에서만" 이면 건드리지 않는다
    hook('useStickerCategories', (res, args) => (reactionsOnly() ? res : filterStickerCategories(res, guildOf(args[0], undefined))))
    hook('searchAllStickers', res => {
        if (!Array.isArray(res) || reactionsOnly()) return res
        const nitro = hasNitro()
        const guild = selectedGuild()
        return res.filter((st: any) => !stickerLocked(st, nitro, guild))
    })
}

function SettingsPage({ api }: { api: any }) {
    const { Stack, TableRowGroup, TableRow, TableSwitchRow } = Design as any
    storage ??= api?.jsonStorage
    storage?.use?.()
    const [, tick] = useState(0)
    useEffect(() => {
        const t = setInterval(() => tick(n => n + 1), 1000)
        return () => clearInterval(t)
    }, [])
    const nitro = hasNitro()
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 160 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Where">
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ReactionIcon" />}
                        label="Only in reactions"
                        subLabel="Hides them only when adding a reaction. The chat emoji and sticker pickers stay as they are, so fake Nitro plugins still work"
                        value={reactionsOnly()}
                        onValueChange={(v: boolean) => storage?.set({ ...(storage.cache ?? {}), reactionsOnly: v }, true)}
                    />
                </TableRowGroup>
                <TableRowGroup title="Status">
                    <TableRow
                        icon={<TableRowAssetIcon name="InfoIcon" />}
                        label="Hooks"
                        subLabel={status.patched.length ? `Hooked, ${status.patched.join(', ')}` : status.found ? 'Found, but not hooked' : 'Not found yet'}
                    />
                    <TableRow icon={<TableRowAssetIcon name="InfoIcon" />} label="Nitro" subLabel={nitro ? 'Yes, nothing is hidden' : 'No'} />
                    <TableRow
                        icon={<TableRowAssetIcon name="ReactionIcon" />}
                        label="Emoji picker"
                        subLabel={
                            status.calls
                                ? `Opened, last time hid ${status.lastSections} servers and ${status.lastEmojis} emojis${status.lastGuild ? '' : ', outside a server'}`
                                : 'Not opened since Discord started'
                        }
                    />
                    <TableRow
                        icon={<TableRowAssetIcon name="StickerIcon" />}
                        label="Sticker picker"
                        subLabel={
                            status.stickerCalls
                                ? `Opened, last time hid ${status.lastPacks} packs and ${status.lastStickers} stickers`
                                : 'Not opened since Discord started'
                        }
                    />
                    {status.errors.length ? <TableRow icon={<TableRowAssetIcon name="InfoIcon" />} label="Errors" subLabel={status.errors.slice(-3).join('\n')} /> : null}
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: { reactionsOnly: false } },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        const patched = new WeakSet<object>()
        for (const prop of ['useEmojiCategories', 'useStickerCategories', 'searchAllStickers']) {
            try {
                patchModule((lookupModule(withProps(prop) as any) as any)?.[0], cleanup, patched)
            } catch (e) {
                err(`lookup ${prop}`, e)
            }
            try {
                cleanup(getModules(withProps(prop) as any, (mod: any) => patchModule(mod, cleanup, patched)) as any)
            } catch (e) {
                err(`getModules ${prop}`, e)
            }
        }
    },
    SettingsComponent: SettingsPage,
} as any)
