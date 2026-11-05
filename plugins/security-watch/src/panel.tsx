import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { useState } from 'react'
import { LayoutAnimation, Pressable, View } from 'react-native'
import { setRule, useSettings, type Kind, type Rule } from './store'
import { SELF } from './watch'

/**
 * 다른 플러그인 설정 화면 맨 위에 그 플러그인만의 Security Watch 규칙을 넣는다.
 * Valenced 는 플러그인 설정을 디스코드 설정 목록(SETTING_RENDERER_CONFIG)에
 * 플러그인 id 를 키로 등록하므로, 그 항목의 화면(getComponent)을 감싼다.
 */

export const KIND_LABEL: Record<Kind, string> = {
    read: 'Token reads',
    send: 'Token sent outside Discord',
    copy: 'Token copied',
    files: "Discord's app files",
    account: 'Login token changed',
}
const KINDS = Object.keys(KIND_LABEL) as Kind[]
const CHOICES: Array<[Rule | undefined, string]> = [
    [undefined, 'Default'],
    ['block', 'Block'],
    ['alert', 'Alert'],
    ['allow', 'Allow'],
]

function tokenColor(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}
function alpha(color: string, a: number) {
    const h = /^#([0-9a-f]{6})/i.exec(color)
    if (!h) return color
    const n = parseInt(h[1], 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
function palette() {
    const brand = tokenColor(['BACKGROUND_BRAND', 'BRAND_500', 'TEXT_BRAND'], '#5865f2')
    const muted = tokenColor(['TEXT_MUTED'], '#949ba4')
    return {
        brand,
        danger: tokenColor(['TEXT_FEEDBACK_CRITICAL', 'TEXT_DANGER', 'STATUS_DANGER'], '#f23f43'),
        text: tokenColor(['TEXT_DEFAULT', 'TEXT_NORMAL'], '#dbdee1'),
        muted,
        surface: tokenColor(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_FLOATING', 'BACKGROUND_SECONDARY'], alpha(muted, 0.1)),
        chip: alpha(muted, 0.16),
        onBrand: tokenColor(['WHITE', 'TEXT_ON_BRAND'], '#ffffff'),
    }
}

export function RulesPanel({ id }: { id: string }) {
    const { Text } = Design as any
    const s = useSettings()
    const [open, setOpen] = useState(false)
    const P = palette()
    const mine = s.rules[id] ?? {}
    const trusted = s.trusted.includes(id)
    const custom = Object.keys(mine).length
    const blocked = s.log.filter(h => h.p === id && h.b).reduce((n, h) => n + h.n, 0)
    const summary = [trusted ? 'Trusted' : custom ? `${custom} custom rule(s)` : 'Default rules', blocked ? `blocked ${blocked} time(s)` : ''].filter(Boolean).join(', ')
    return (
        <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 16, backgroundColor: P.surface, overflow: 'hidden' }}>
            <Pressable
                onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                    setOpen(v => !v)
                }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 }}
            >
                <TableRowAssetIcon name="ShieldIcon" />
                <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text variant="text-md/semibold" style={{ color: P.text }}>
                        Security Watch
                    </Text>
                    <Text variant="text-xs/medium" style={{ color: blocked ? P.danger : P.muted }}>
                        {summary}
                    </Text>
                </View>
                <TableRowAssetIcon name={open ? 'ChevronSmallUpIcon' : 'ChevronSmallDownIcon'} />
            </Pressable>
            {open ? (
                <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
                    {trusted ? (
                        <Text variant="text-xs/medium" style={{ color: P.muted, marginBottom: 6 }}>
                            This plugin is trusted, so everything is allowed. Remove it from Trusted plugins in Security Watch to use these.
                        </Text>
                    ) : null}
                    {KINDS.map(k => (
                        <View key={k} style={{ marginTop: 8 }}>
                            <Text variant="text-xs/bold" style={{ color: P.muted, marginBottom: 6 }}>
                                {KIND_LABEL[k].toUpperCase()}
                            </Text>
                            <View style={{ flexDirection: 'row' }}>
                                {CHOICES.map(([r, label]) => {
                                    const on = mine[k] === r
                                    const tint = r === 'block' ? P.danger : P.brand
                                    return (
                                        <Pressable
                                            key={label}
                                            onPress={() => setRule(id, k, r)}
                                            style={{ flex: 1, height: 32, marginRight: r === 'allow' ? 0 : 6, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? tint : P.chip }}
                                        >
                                            <Text variant="text-sm/semibold" style={{ color: on ? P.onBrand : P.text }}>
                                                {label}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                    ))}
                    <Text variant="text-xs/medium" style={{ color: P.muted, marginTop: 10 }}>
                        Default follows the Security Watch settings.
                    </Text>
                </View>
            ) : null}
        </View>
    )
}

// ── 다른 플러그인 설정 화면 감싸기 ──────────────────────────────────────────────
const ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/
export function patchPluginScreens(cleanup: (...f: Array<() => void>) => void) {
    let SRC: any
    const restore: Array<() => void> = []
    const seen = new WeakSet<object>()
    const scan = () => {
        let cfg: any
        try {
            cfg = SRC?.SETTING_RENDERER_CONFIG
        } catch {}
        const self = cfg?.[SELF]
        if (!self) return
        for (const key of Object.keys(cfg)) {
            const item = cfg[key]
            if (key === SELF || !item || seen.has(item) || !ID.test(key)) continue
            if (item.type !== 'route' || item.parent !== self.parent || item.screen?.route !== key) continue
            const screen = item.screen
            const get = screen.getComponent
            if (typeof get !== 'function') continue
            seen.add(item)
            let Inner: any
            let Outer: any
            item.screen = {
                ...screen,
                getComponent: () => {
                    const C = get()
                    if (C !== Inner || !Outer) {
                        Inner = C
                        Outer = function SecurityWatchWrapped(props: any) {
                            return (
                                <View style={{ flex: 1 }}>
                                    <RulesPanel id={key} />
                                    <View style={{ flex: 1 }}>
                                        <C {...props} />
                                    </View>
                                </View>
                            )
                        }
                    }
                    return Outer
                },
            }
            restore.push(() => {
                if (item.screen?.getComponent && item.screen.route === key) item.screen = screen
            })
        }
    }
    cleanup(
        getModules(withProps('SETTING_RENDERER_CONFIG') as any, (mod: any) => {
            SRC = mod
            scan()
        }, { max: 1 } as any) as any,
    )
    // 플러그인은 켜질 때 설정 항목을 등록하니 가끔 다시 본다
    const t = setInterval(scan, 2000)
    cleanup(() => {
        clearInterval(t)
        for (const r of restore) r()
    })
}
