import { BottomSheet } from '@valenced/externals/gorhom'
import { beforeJSX } from '@valenced/react/jsx-runtime'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { createElement, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

/**
 * Liquid Glass (test): OpenGlass UI (moekoelueker/open-glass-ui) 의 "liquid" 재질을 디스코드에 입힌다.
 *  - 유리를 깔 곳(지금은 아래에서 올라오는 창 전부)에 빈 배경 칸을 nativeID "ogui-glass:둥글기" 로 넣는다
 *  - 네이티브가 그 칸 뒤의 화면을 찍어 흐리게(blur), 채도 높이고(saturate), 어둡게(brightness) 그린 뒤
 *    색 한 겹, 빛 받는 쪽 테두리(rim), 안쪽 빛(lensing) 을 올린다 (OpenGlass 의 liquid 토큰 값 그대로)
 */

const NATIVE = 'yumistra.liquid-glass'
const native = (name: string, args: any[] = []) => Promise.resolve((callNativeMethod as any)(`${NATIVE}.${name}`, args))

type Material = 'clear' | 'regular' | 'frosted'
interface Settings {
    enabled: boolean
    material: Material
    sheets: boolean
}
const DEFAULTS: Settings = { enabled: true, material: 'regular', sheets: true }

let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
const sendConfig = () => native('config', [JSON.stringify(settings())]).catch(() => {})

/** 아래 창 배경: 빈 칸 하나 (네이티브가 유리를 그린다) */
function GlassSheetBackground(props: any) {
    const r = 24
    return createElement(View, {
        pointerEvents: 'none',
        nativeID: `ogui-glass:${r},${r},0,0`,
        style: [props?.style, StyleSheet.absoluteFill, { backgroundColor: 'transparent', borderTopLeftRadius: r, borderTopRightRadius: r, overflow: 'hidden' }],
    })
}

function patchSheets(cleanup: (...f: Array<() => void>) => void) {
    const lib: any = BottomSheet
    for (const type of new Set([lib?.default, lib?.BottomSheetModal].filter(Boolean)))
        cleanup(
            beforeJSX(type, (args: any[]) => {
                const s = settings()
                if (!s.enabled || !s.sheets || !args[1]) return args as any
                return [args[0], { ...args[1], backgroundComponent: GlassSheetBackground, backgroundStyle: { backgroundColor: 'transparent' } }, ...args.slice(2)] as any
            }) as any,
        )
}

function SettingsPage() {
    storage?.use?.()
    const s = settings()
    const { TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, Text } = Design as any
    const [st, setSt] = useState<any>({})
    useEffect(() => {
        let alive = true
        const tick = () =>
            native('status')
                .then(r => alive && setSt(typeof r === 'string' ? JSON.parse(r) : (r ?? {})))
                .catch(() => {})
        tick()
        const t = setInterval(tick, 1000)
        return () => {
            alive = false
            clearInterval(t)
        }
    }, [])
    const set = (p: Partial<Settings>) => {
        storage?.set?.({ ...settings(), ...p }, true)
        sendConfig()
    }
    return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
            <TableRowGroup>
                <TableSwitchRow label="Liquid glass" value={s.enabled} onValueChange={(v: boolean) => set({ enabled: v })} />
                <TableSwitchRow label="Sheets (menus, profiles)" value={s.sheets} onValueChange={(v: boolean) => set({ sheets: v })} />
            </TableRowGroup>
            {TableRadioGroup && TableRadioRow ? (
                <TableRadioGroup title="Glass" value={s.material} onChange={(v: Material) => set({ material: v })}>
                    <TableRadioRow label="Clear" value="clear" />
                    <TableRadioRow label="Regular" value="regular" />
                    <TableRadioRow label="Frosted" value="frosted" />
                </TableRadioGroup>
            ) : null}
            <View style={{ gap: 4 }}>
                <Text variant="heading-sm/bold">Test status</Text>
                <Text variant="text-sm/medium" color="text-muted">
                    {`Android ${st.sdk ?? '?'}, blur ${st.blur ? 'on' : 'off (Android 12+ needed)'}, ${st.views ?? 0} glass view(s), ${st.frames ?? 0} backdrop frame(s)`}
                </Text>
                {st.error ? (
                    <Text variant="text-xs/medium" color="text-danger">
                        {String(st.error)}
                    </Text>
                ) : null}
            </View>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        patchSheets(cleanup)
        sendConfig()
        const again = [1500, 5000].map(ms => setTimeout(sendConfig, ms))
        cleanup(() => again.forEach(clearTimeout))
    },
    SettingsComponent: SettingsPage,
} as any)
