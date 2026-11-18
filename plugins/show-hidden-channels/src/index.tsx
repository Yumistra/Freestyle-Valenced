import { ToastActionCreators } from '@valenced/discord/actions'
import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import LockScreen from './LockScreen'
import SettingsPage from './Settings'
import { bind, DEFAULTS, onChange, settings } from './store'
import { count, err, status } from './log'
import { channelOf, find, isHidden, S, samePerm } from './util'

/**
 * Show Hidden Channels: ShowHiddenChannelsLite (Vencord, CyberKird) 를 옮긴 것.
 *
 * 디스코드는 볼 수 없는 채널도 보내 주지만 이름은 ___hidden___, 주제는 비우고 권한은 가짜로 바꿔 보낸다.
 * - 채널 목록(ChannelListState)은 채널마다 computeState 에서 can(VIEW_CHANNEL) 을 보고 못 보면 뺀다.
 *   그 순간에만 can 이 true 를 돌려주게 해서 목록에 남긴다.
 * - 이름: 앱은 가려진 채널(OBFUSCATED 플래그)을 computeChannelName 에서 "액세스 권한 없음" 으로 바꾼다. 거기서 고른 이름을 준다.
 * - 들어가면 채팅 대신 잠금 화면 (NSFW 확인 화면과 같은 자리, useChannelContentGate)
 */

const GATE = 'SHOW_HIDDEN_CHANNELS'

/** 지금 목록 상태를 계산 중인 숨겨진 채널. 이 채널에 대한 VIEW_CHANNEL 검사만 통과시킨다 */
let listing: any
/** #채널 자동완성을 찾는 중 */
let querying = 0

/** 목록에 보여 준 숨겨진 채널 (안 읽음 숨기기에 쓴다) */
const hiddenIds = new Set<string>()
const hiddenId = (id: unknown) => typeof id === 'string' && hiddenIds.has(id) && isHidden(channelOf(id))

/** ChannelListStore 안의 ChannelListStates (서버별 목록을 들고 있다) */
let states: any
function rebuild() {
    try {
        states?.clear?.()
        S().ChannelListStore?.emitChange?.()
    } catch {}
}


// ── 이름 (채널 기록) ─────────────────────────────────────────────────────
/**
 * 채팅 채널 줄은 computeChannelName 의 다른 사본을 불러서 위의 패치가 안 닿는다.
 * computeChannelName 은 channel.name 을 읽고 channel.isObfuscated() 가 참이면 "액세스 권한 없음" 을 준다.
 * 그래서 숨겨진 채널 기록의 name 을 바꾸고, computeChannelName 안에서 부른 isObfuscated 만 거짓으로 답한다.
 */
const REDACTED = '___hidden___'
const renamed = new Map<string, any>()
function rename(rec: any) {
    if (!rec || rec.type === 4) return
    if (rec.name !== REDACTED && renamed.get(rec.id) !== rec) return
    try {
        rec.name = settings().name || DEFAULTS.name
        renamed.set(rec.id, rec)
    } catch (e) {
        err('rename', e)
    }
}
function restoreNames() {
    for (const rec of renamed.values()) {
        try {
            rec.name = REDACTED
        } catch {}
    }
    renamed.clear()
}
const recordProtos = new Set<any>()
function patchRecord(rec: any, cleanup: (...f: any[]) => void) {
    let p = rec && Object.getPrototypeOf(rec)
    while (p && !Object.prototype.hasOwnProperty.call(p, 'isObfuscated')) p = Object.getPrototypeOf(p)
    if (!p || recordProtos.has(p)) return
    recordProtos.add(p)
    status['record classes'] = recordProtos.size
    cleanup(
        instead(p, 'isObfuscated', function (this: any, args: any[], orig: any) {
            const out = orig.apply(this, args)
            if (!out || this?.type === 4 || renamed.get(this?.id) !== this) return out
            try {
                // computeChannelName 이 부른 것만
                if (/computeChannelName/.test(String(new Error().stack))) return false
            } catch {}
            return out
        }),
    )
}

let seq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`show-hidden-channels-${Date.now()}-${seq++}`, { text } as any)
    } catch {}
}

/** 숨겨진 채널 화면으로 간다 (음성 채널을 눌렀을 때) */
let routers: any[] = []
function openChannel(channel: any) {
    for (const r of routers) {
        try {
            // transitionToGuild(서버, 채널, 메시지) 쪽만 쓴다
            if (typeof r?.transitionToGuild === 'function' && r.transitionToGuild.length >= 3) {
                r.transitionToGuild(channel.guild_id, channel.id)
                return true
            }
        } catch {}
    }
    return false
}

const eye = (key: string) => {
    const Eye = lookupGeneratedIconComponent('EyeSlashIcon') as any
    return Eye ? <Eye key={key} size="xs" color="icon-muted" /> : null
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)

        // 목록 계산 중인 숨겨진 채널, 자동완성 중에만 볼 수 있다고 답한다
        const ps = S().PermissionStore
        if (ps?.can)
            cleanup(
                instead(ps, 'can', function (this: any, args: any[], orig: any) {
                    if ((listing && args[1] === listing) || querying) {
                        if (samePerm(args[0], 'VIEW_CHANNEL')) return true
                    }
                    return orig.apply(this, args)
                }),
            )

        // ── 채널 목록 ──
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
                    status['channel class'] = p.constructor?.name
                    cleanup(
                        instead(p, 'computeState', function (this: any, args: any[], orig: any) {
                            const rec = this?.record
                            if (!isHidden(rec)) return orig.apply(this, args)
                            hiddenIds.add(rec.id)
                            count('hidden computeState')
                            patchRecord(rec, cleanup)
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

        // ChannelListStates 를 잡고, 채널 클래스를 처음 보면 목록을 전부 다시 만든다.
        // 앱이 켜질 때는 이 모듈이 아직 안 불려 있어서, 불릴 때까지 기다린다
        status['ChannelListStates.getGuild'] = 'waiting'
        cleanup(
            getModules(withProps('computeThreadIds', 'ChannelListSections') as any, (mod: any) => {
                const proto = mod?.default?.prototype
                status['ChannelListStates.getGuild'] = !!proto?.getGuild
                if (!proto?.getGuild) return
                cleanup(
                    instead(proto, 'getGuild', function (this: any, args: any[], orig: any) {
                        states = this
                        count('getGuild calls')
                        const impl = orig.apply(this, args)
                        if (!channelProto && patchChannel(impl)) {
                            try {
                                this.clear?.()
                            } catch {}
                            setTimeout(() => S().ChannelListStore?.emitChange?.(), 0)
                            return orig.apply(this, args)
                        }
                        return impl
                    }),
                )
                // 이미 만들어진 목록에 반영
                try {
                    const gid = S().SelectedGuildStore?.getGuildId?.() ?? Object.keys(S().GuildStore?.getGuilds?.() ?? {})[0]
                    if (gid) S().ChannelListStore?.getGuild?.(gid)
                } catch (e) {
                    err('first build', e)
                }
                rebuild()
            }) as any,
        )

        // ── 이름 ──
        cleanup(
            getModules(
                withProps('computeChannelName') as any,
                (mod: any) => {
                    // useChannelName 은 같은 모듈 안에서 computeChannelName 을 바로 불러서 따로 바꾼다 (채팅 채널 줄이 이걸 쓴다)
                    for (const key of ['computeChannelName', 'useChannelName']) {
                        if (typeof mod?.[key] !== 'function') continue
                        status[key] = true
                        cleanup(
                            instead(mod, key, function (this: any, args: any[], orig: any) {
                                // 훅이라 원래 것은 항상 부른다
                                const out = orig.apply(this, args)
                                const ch = args[0]
                                // 카테고리는 디스코드의 "액세스 권한 없음" 그대로 (원본과 같다)
                                if (ch?.type !== 4 && isHidden(ch)) return settings().name || DEFAULTS.name
                                return out
                            }),
                        )
                    }
                },
                { max: 5 } as any,
            ) as any,
        )

        // ── 줄 모양: 흐리게 + 눈 아이콘, 안 읽음 숨기기 ──
        cleanup(
            getModuleWithImportedPath('modules/guild_sidebar/native/BaseChannelItem.tsx', (mod: any) => {
                if (typeof mod?.default !== 'function' || mod.default.prototype?.isReactComponent) return
                cleanup(
                    instead(mod, 'default', function (this: any, args: any[], orig: any) {
                        const p = args[0]
                        const channel = p?.icon?.props?.channel ?? p?.channel
                        if (!channel || !isHidden(channel)) return orig.apply(this, args)
                        try {
                            const s = settings()
                            const next: any = { ...p }
                            // ChannelModes: Selected, Locked, Muted, Relevant, UnreadLessImportant, UnreadImportant, Default
                            if (s.hideUnreads) {
                                next.unread = false
                                if (typeof p.mode === 'string' && p.mode.startsWith('Unread')) next.mode = 'Default'
                            }
                            if (s.showMode === 'muted') {
                                if (p.mode !== 'Selected') next.mode = 'Muted'
                                const info = p.channelInfo
                                next.channelInfo = [...(Array.isArray(info) ? info : info != null ? [info] : []), eye('shc-eye')]
                            }
                            return orig.apply(this, [next, ...args.slice(1)])
                        } catch {
                            return orig.apply(this, args)
                        }
                    }),
                )
            }) as any,
        )

        // 안 읽음 수, 멘션 수 (목록 아래 "신규" 표시, 서버 아이콘 표시)
        const rs = S().ReadStateStore
        for (const key of ['hasUnread', 'hasUnreadOrMentions', 'getMentionCount', 'getUnreadCount']) {
            if (typeof rs?.[key] !== 'function') continue
            cleanup(
                instead(rs, key, function (this: any, args: any[], orig: any) {
                    if (settings().hideUnreads && hiddenId(args[0])) return key.startsWith('has') ? false : 0
                    return orig.apply(this, args)
                }),
            )
        }

        // ── 들어갔을 때: 채팅 대신 잠금 화면 ──
        cleanup(
            getModuleWithImportedPath('modules/chat/native/useChannelContentGate.tsx', (mod: any) => {
                if (typeof mod?.useChannelContentGate === 'function')
                    cleanup(
                        instead(mod, 'useChannelContentGate', function (this: any, args: any[], orig: any) {
                            // 훅이라 원래 것은 항상 부른다
                            const gate = orig.apply(this, args)
                            const channel = args[1]
                            if (isHidden(channel, true)) count('lock screen')
                            if (isHidden(channel, true)) return { kind: GATE, guildId: args[0], channelId: channel.id }
                            return gate
                        }),
                    )
                if (typeof mod?.renderChannelContentGate === 'function')
                    cleanup(
                        instead(mod, 'renderChannelContentGate', function (this: any, args: any[], orig: any) {
                            const gate = args[0]
                            if (gate?.kind === GATE) return <LockScreen channel={channelOf(gate.channelId)} />
                            return orig.apply(this, args)
                        }),
                    )
            }) as any,
        )

        // 메시지를 받아 오지 않는다 (서버가 거절한다)
        cleanup(
            getModules(withProps('fetchMessages') as any, (mod: any) => {
                if (typeof mod?.fetchMessages !== 'function') return
                cleanup(
                    instead(mod, 'fetchMessages', function (this: any, args: any[], orig: any) {
                        const a = args[0]
                        if (isHidden(channelOf(typeof a === 'string' ? a : a?.channelId))) return Promise.resolve()
                        return orig.apply(this, args)
                    }),
                )
            }, { max: 10 } as any) as any,
        )

        // 숨겨진 음성, 스테이지 채널은 들어가지 않고 잠금 화면을 연다
        cleanup(
            getModules(
                withProps('transitionToGuild') as any,
                (mod: any) => {
                    routers.push(mod)
                },
                { max: 10 } as any,
            ) as any,
        )
        cleanup(
            getModules(withProps('selectVoiceChannel') as any, (mod: any) => {
                if (typeof mod?.selectVoiceChannel !== 'function') return
                cleanup(
                    instead(mod, 'selectVoiceChannel', function (this: any, args: any[], orig: any) {
                        const ch = channelOf(args[0])
                        count('selectVoiceChannel calls')
                        if (isHidden(ch)) {
                            if (!openChannel(ch)) toast("You can't join a hidden channel")
                            return
                        }
                        return orig.apply(this, args)
                    }),
                )
            }, { max: 10 } as any) as any,
        )

        // 숨겨진 음성 채널의 "참가하기" 는 디스코드가 권한 없음 창을 띄운다. 대신 토스트로 알린다
        cleanup(
            getModules(withProps('openAlert', 'dismissAlert') as any, (mod: any) => {
                if (typeof mod?.openAlert !== 'function') return
                cleanup(
                    instead(mod, 'openAlert', function (this: any, args: any[], orig: any) {
                        const el = args[1]
                        const name = el?.type?.name ?? el?.type?.displayName ?? ''
                        if (String(args[0]).includes('NoJoinPermissions') || name === 'VoicePanelNoJoinPermissionsAlert') {
                            count('join alert')
                            const ch = channelOf(S().SelectedChannelStore?.getChannelId?.()) ?? channelOf(S().SelectedChannelStore?.getVoiceChannelId?.())
                            if (!ch || isHidden(ch)) {
                                toast("You can't join a hidden channel")
                                return
                            }
                        }
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )

        // #채널 자동완성에 숨겨진 채널도 나오게
        cleanup(
            getModules(withProps('queryChannels') as any, (mod: any) => {
                if (typeof mod?.queryChannels !== 'function') return
                cleanup(
                    instead(mod, 'queryChannels', function (this: any, args: any[], orig: any) {
                        querying++
                        try {
                            return orig.apply(this, args)
                        } finally {
                            querying--
                        }
                    }),
                )
            }) as any,
        )

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
            channelProto = undefined
            routers = []
            hiddenIds.clear()
            restoreNames()
            recordProtos.clear()
            // 패치가 풀린 뒤에 다시 만들어지게
            setTimeout(rebuild, 0)
        })
    },
    SettingsComponent: SettingsPage,
} as any)
