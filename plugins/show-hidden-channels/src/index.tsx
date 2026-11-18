import { ToastActionCreators } from '@valenced/discord/actions'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import SettingsPage from './Settings'
import { bind, DEFAULTS, onChange, settings } from './store'

/**
 * Show Hidden Channels: ShowHiddenChannelsLite (Vencord, CyberKird) 를 옮긴 것.
 *
 * 디스코드는 볼 수 없는 채널도 보내 주지만 이름은 ___hidden___, 주제는 비우고 권한은 가짜로 바꿔 보낸다.
 * 채널 목록(ChannelListState)은 채널마다 computeState 에서 PermissionStore.can(VIEW_CHANNEL, 채널) 을 보고
 * 못 보면 CannotShow 로 빼 버린다. 그 순간에만 can 이 true 를 돌려주게 해서 목록에 남긴다.
 * 들어가서 메시지를 받아 오거나 음성에 들어가는 건 막는다 (어차피 서버가 거절한다).
 */

const S = () => Stores as any
const REDACTED = '___hidden___'

function find(...props: string[]): any {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

let VIEW: any
/** 디스코드의 VIEW_CHANNEL 권한 값 (못 찾으면 1 << 10) */
function view() {
    if (VIEW == null) VIEW = find('Permissions', 'ChannelTypes')?.Permissions?.VIEW_CHANNEL ?? 1024n
    return VIEW
}

const isView = (perm: unknown) => {
    if (perm === view()) return true
    try {
        return BigInt(perm as any) === 1024n
    } catch {
        return false
    }
}

/** 지금 목록 상태를 계산 중인 숨겨진 채널. 이 채널에 대한 VIEW_CHANNEL 검사만 통과시킨다 */
let listing: any

function isHidden(channel: any): boolean {
    try {
        if (!channel?.guild_id || channel.id == null) return false
        if (typeof channel.isDM === 'function' && (channel.isDM() || channel.isGroupDM?.())) return false
        const ps = S().PermissionStore
        return !!ps?.can && !ps.can(view(), channel)
    } catch {
        return false
    }
}

function isHiddenId(channelId: unknown): boolean {
    if (typeof channelId !== 'string') return false
    return isHidden(S().ChannelStore?.getChannel?.(channelId))
}

// ── 이름 ─────────────────────────────────────────────────────────────────
/** 이름을 바꿔 둔 채널 (끌 때 되돌린다) */
const renamed = new Map<string, any>()
function rename(rec: any) {
    if (rec?.name !== REDACTED && !renamed.has(rec?.id)) return
    try {
        rec.name = settings().name || DEFAULTS.name
        renamed.set(rec.id, rec)
    } catch {}
}
function restoreNames() {
    for (const rec of renamed.values()) {
        try {
            rec.name = REDACTED
        } catch {}
    }
    renamed.clear()
}

// ── 채널 목록 다시 만들기 ────────────────────────────────────────────────
/** ChannelListStore 안의 ChannelListStates (서버별 목록을 들고 있다) */
let states: any
function rebuild() {
    try {
        states?.clear?.()
        S().ChannelListStore?.emitChange?.()
    } catch {}
}

let seq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`show-hidden-channels-${Date.now()}-${seq++}`, { text } as any)
    } catch {}
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)

        // 목록 계산 중인 숨겨진 채널만 볼 수 있다고 답한다
        const ps = S().PermissionStore
        if (ps?.can)
            cleanup(
                instead(ps, 'can', function (this: any, args: any[], orig: any) {
                    if (listing && args[1] === listing && isView(args[0])) return true
                    return orig.apply(this, args)
                }),
            )

        let channelProto: any
        const patchChannel = (impl: any) => {
            if (channelProto) return false
            let cats: any[] = []
            try {
                cats = impl?.getSortedCategories?.() ?? []
            } catch {}
            for (const cat of cats) {
                for (const ch of Object.values<any>(cat?.channels ?? {})) {
                    // 일반 채널 클래스(ChannelListChannelImpl). 즐겨찾기, 최근, 음성 칸 클래스는 건너뛴다
                    let p = Object.getPrototypeOf(ch)
                    while (p && !Object.prototype.hasOwnProperty.call(p, 'computeState')) p = Object.getPrototypeOf(p)
                    if (!p || !/^ChannelListChannelImpl$/.test(p.constructor?.name ?? '')) continue
                    channelProto = p
                    cleanup(
                        instead(p, 'computeState', function (this: any, args: any[], orig: any) {
                            const rec = this?.record
                            if (!isHidden(rec)) return orig.apply(this, args)
                            rename(rec)
                            // 온보딩을 쓰는 서버는 고른 채널만 보여 주는데, 숨겨진 채널은 고를 수가 없다
                            const opted = this?.category?.guild?.optInEnabled ? this.category.guild.optedInChannels : undefined
                            let added = false
                            try {
                                if (opted?.has && !opted.has(rec.id)) {
                                    opted.add(rec.id)
                                    added = true
                                }
                            } catch {}
                            listing = rec
                            try {
                                return orig.apply(this, args)
                            } finally {
                                listing = undefined
                                if (added) {
                                    try {
                                        opted.delete(rec.id)
                                    } catch {}
                                }
                            }
                        }),
                    )
                    return true
                }
            }
            return false
        }

        // ChannelListStates 를 잡고, 채널 클래스를 처음 보면 그 서버 목록을 다시 만든다
        const statesMod = find('computeThreadIds', 'ChannelListSections')
        const proto = statesMod?.default?.prototype
        if (proto?.getGuild)
            cleanup(
                instead(proto, 'getGuild', function (this: any, args: any[], orig: any) {
                    states = this
                    const impl = orig.apply(this, args)
                    if (!channelProto && patchChannel(impl)) {
                        try {
                            delete this.guilds?.[args[0]]
                        } catch {}
                        return orig.apply(this, args)
                    }
                    return impl
                }),
            )

        // 이미 만들어진 목록에 반영
        try {
            const store = S().ChannelListStore
            const gid = S().SelectedGuildStore?.getGuildId?.() ?? Object.keys(S().GuildStore?.getGuilds?.() ?? {})[0]
            if (gid) store?.getGuild?.(gid)
        } catch {}
        rebuild()

        // 메시지를 받아 오지 않는다 (서버가 거절한다)
        cleanup(
            getModules(withProps('fetchMessages') as any, (mod: any) => {
                if (typeof mod?.fetchMessages !== 'function') return
                cleanup(
                    instead(mod, 'fetchMessages', function (this: any, args: any[], orig: any) {
                        const a = args[0]
                        if (isHiddenId(typeof a === 'string' ? a : a?.channelId)) return Promise.resolve()
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )

        // 숨겨진 음성, 스테이지 채널에 들어가지 않는다
        cleanup(
            getModules(withProps('selectVoiceChannel') as any, (mod: any) => {
                if (typeof mod?.selectVoiceChannel !== 'function') return
                cleanup(
                    instead(mod, 'selectVoiceChannel', function (this: any, args: any[], orig: any) {
                        if (isHiddenId(args[0])) {
                            toast("You can't join a hidden channel")
                            return
                        }
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )

        // 원본처럼 채널 정보 가리기 실험을 끈다 (앱을 다시 켜야 적용)
        for (const key of ['isChannelMetadataObfuscationEnabled', 'isChannelMetadataIntegrityCheckEnabled']) {
            const mod = find(key)
            if (typeof mod?.[key] !== 'function') continue
            try {
                cleanup(instead(mod, key, () => false))
            } catch {}
        }

        // 이름을 바꾸면 바로 반영
        cleanup(
            onChange(() => {
                const name = settings().name || DEFAULTS.name
                for (const rec of renamed.values()) {
                    try {
                        rec.name = name
                    } catch {}
                }
                rebuild()
            }),
        )

        cleanup(() => {
            restoreNames()
            channelProto = undefined
            // 패치가 풀린 뒤에 다시 만들어지게
            setTimeout(rebuild, 0)
        })
    },
    SettingsComponent: SettingsPage,
} as any)
