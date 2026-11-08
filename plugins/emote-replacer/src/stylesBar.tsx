import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useState } from 'react'
import { LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { COMMAND_ID } from './command'
import { MODIFIERS } from './img'
import { tokenColor } from './suggest'

/**
 * /replacer 의 styles 칸을 고르면 입력창 위에 효과 목록을 띄운다.
 * 누르면 그 효과가 styles 칸에 적힌다 (입력창의 insertText, 이름을 누를 때 멘션을 넣는 것과 같은 방법).
 */

const EXTRA: Record<string, string[]> = { rotate: ['45', '90', '180', '270'], speed: ['2', '5', '10'], resize: ['small', 'medium', 'large'] }

/** 목록에 보일 효과들 (세기까지) */
export const STYLE_CHIPS: string[] = MODIFIERS.flatMap(m => {
    const args = EXTRA[m.name] ?? m.args
    if (!args?.length) return [m.name]
    return args.map(a => (a ? `${m.name}-${a}` : m.name))
})

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}
const commandStore = (): any => (Stores as any).ApplicationCommandStore ?? find('getActiveOptionName', 'getActiveCommand')

function useStylesActive(channelId?: string) {
    const [on, setOn] = useState(false)
    useEffect(() => {
        const store = commandStore()
        if (!channelId || !store) return
        const check = () => {
            try {
                const ours = store.getActiveCommand?.(channelId)?.id === COMMAND_ID
                const next = ours && (store.getActiveOptionName?.(channelId) === 'styles' || !!store.getOptionState?.(channelId, 'styles')?.isActive || !!store.getOptionStates?.(channelId)?.styles?.isActive)
                setOn(prev => {
                    if (prev !== next) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                    return next
                })
            } catch {}
        }
        store.addChangeListener?.(check)
        check()
        return () => store.removeChangeListener?.(check)
    }, [channelId])
    return on
}

/** styles 칸에 지금 적힌 글 */
function stylesText(channelId: string): string {
    try {
        const st = commandStore()?.getOptionState?.(channelId, 'styles')
        const v = st?.optionValue ?? st?.value
        if (typeof v === 'string') return v
        if (Array.isArray(v)) return v.map((x: any) => x?.text ?? x?.value ?? '').join('')
    } catch {}
    return ''
}

export function StylesBar({ channelId, inputRef }: { channelId?: string; inputRef?: any }) {
    const { Text } = Design as any
    const on = useStylesActive(channelId)
    if (!channelId || !on) return null
    const bg = tokenColor(['BACKGROUND_SURFACE_HIGHER', 'BACKGROUND_SECONDARY'], '#2b2d31')
    const chip = tokenColor(['BACKGROUND_MOD_SUBTLE', 'BACKGROUND_MODIFIER_ACCENT'], 'rgba(255,255,255,0.06)')
    return (
        <View style={{ backgroundColor: bg, borderRadius: 12, marginHorizontal: 8, marginBottom: 6, paddingVertical: 6 }}>
            <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6, gap: 6, alignItems: 'center' }}>
                {STYLE_CHIPS.map(name => (
                    <Pressable
                        key={name}
                        accessibilityRole="button"
                        accessibilityLabel={name}
                        onPress={() => {
                            const cur = inputRef?.current
                            if (typeof cur?.insertText !== 'function') return
                            const before = stylesText(channelId)
                            const gap = before && !/\s$/.test(before) ? ' ' : ''
                            cur.insertText(`${gap}${name} `)
                        }}
                        style={({ pressed }: any) => ({ paddingHorizontal: 10, height: 34, borderRadius: 8, justifyContent: 'center', backgroundColor: chip, opacity: pressed ? 0.6 : 1 })}
                    >
                        <Text variant="text-sm/medium" color="text-default">
                            {name}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    )
}
