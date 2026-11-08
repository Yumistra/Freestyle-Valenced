import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useMemo, useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { COMMAND_ID } from './command'
import { allEmotes } from './emotes'
import { MODIFIERS } from './img'
import { discordEmojis, emojiSource } from './send'
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

function useOptionActive(channelId: string | undefined, option: string) {
    const [on, setOn] = useState(false)
    useEffect(() => {
        const store = commandStore()
        if (!channelId || !store) return
        const check = () => {
            try {
                const ours = store.getActiveCommand?.(channelId)?.id === COMMAND_ID
                const next = ours && (store.getActiveOptionName?.(channelId) === option || !!store.getOptionState?.(channelId, option)?.isActive || !!store.getOptionStates?.(channelId)?.[option]?.isActive)
                setOn(prev => {
                    if (prev !== next) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                    return next
                })
            } catch {}
        }
        store.addChangeListener?.(check)
        check()
        return () => store.removeChangeListener?.(check)
    }, [channelId, option])
    return on
}

/** 칸이 바뀔 때마다 다시 그린다 (칸에 적힌 글로 목록을 거른다) */
function useOptionText(channelId: string | undefined, option: string, on: boolean) {
    const [text, setText] = useState('')
    useEffect(() => {
        const store = commandStore()
        if (!channelId || !store || !on) return
        const read = () => {
            const t = optionText(channelId, option)
            setText(prev => (prev === t ? prev : t))
        }
        store.addChangeListener?.(read)
        const timer = setInterval(read, 300)
        read()
        return () => {
            store.removeChangeListener?.(read)
            clearInterval(timer)
        }
    }, [channelId, option, on])
    return text
}

/** 칸에 지금 적힌 글 */
function optionText(channelId: string, option: string): string {
    try {
        const st = commandStore()?.getOptionState?.(channelId, option)
        const v = st?.optionValue ?? st?.value
        if (typeof v === 'string') return v
        if (Array.isArray(v)) return v.map((x: any) => x?.text ?? x?.value ?? '').join('')
    } catch {}
    return ''
}

export function StylesBar({ channelId, inputRef }: { channelId?: string; inputRef?: any }) {
    const { Text } = Design as any
    const on = useOptionActive(channelId, 'styles')
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
                            const before = optionText(channelId, 'styles')
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

/**
 * /replacer 의 emoji 칸을 고르면 입력창 위에 내 서버 이모지(잠긴 것까지)와 내 이모트를 띄운다.
 * 칸에 글을 쓰면 그 글로 시작하는 것만 보이고, 누르면 나머지 글자가 칸에 적힌다.
 */
export function EmojiBar({ channelId, inputRef }: { channelId?: string; inputRef?: any }) {
    const { Text } = Design as any
    const on = useOptionActive(channelId, 'emoji')
    const typed = useOptionText(channelId, 'emoji', on).trim()
    const all = useMemo(() => {
        if (!on || !channelId) return [] as Array<[string, string]>
        const out: Array<[string, string]> = []
        for (const [name, list] of discordEmojis(channelId)) out.push([name, emojiSource(list[0], 48)])
        for (const [name, url] of Object.entries(allEmotes())) if (!out.some(([n]) => n === name)) out.push([name, url])
        return out
    }, [on, channelId])
    if (!channelId || !on) return null
    const q = typed.replace(/^[;:]+/, '').toLowerCase()
    const list = (q ? all.filter(([n]) => n.toLowerCase().startsWith(q)) : all).slice(0, 80)
    const bg = tokenColor(['BACKGROUND_SURFACE_HIGHER', 'BACKGROUND_SECONDARY'], '#2b2d31')
    const chip = tokenColor(['BACKGROUND_MOD_SUBTLE', 'BACKGROUND_MODIFIER_ACCENT'], 'rgba(255,255,255,0.06)')
    return (
        <View style={{ backgroundColor: bg, borderRadius: 12, marginHorizontal: 8, marginBottom: 6, paddingVertical: 6 }}>
            {list.length ? (
                <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6, gap: 6, alignItems: 'center' }}>
                    {list.map(([name, url]) => (
                        <Pressable
                            key={name}
                            accessibilityRole="button"
                            accessibilityLabel={name}
                            onPress={() => {
                                const cur = inputRef?.current
                                if (typeof cur?.insertText !== 'function') return
                                // 이미 쓴 앞부분은 두고 나머지만 적는다
                                const rest = q && name.toLowerCase().startsWith(q) ? name.slice(q.length) : name
                                if (rest) cur.insertText(rest)
                            }}
                            style={({ pressed }: any) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, height: 40, borderRadius: 8, backgroundColor: chip, opacity: pressed ? 0.6 : 1 })}
                        >
                            <Image source={{ uri: url }} style={{ width: 28, height: 28 }} resizeMode="contain" />
                            <Text variant="text-sm/medium" color="text-default" numberOfLines={1}>
                                {name}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>
            ) : (
                <Text variant="text-sm/medium" color="text-muted" style={{ padding: 10, textAlign: 'center' }}>
                    No emoji starts with {typed}
                </Text>
            )}
        </View>
    )
}
