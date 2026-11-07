import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, LayoutAnimation, Pressable, ScrollView, View } from 'react-native'
import { allEmotes, emoteStatus, onEmotesChange } from './emotes'
import { MODIFIERS } from './img'
import { discordEmojis, emojiSource } from './send'
import { settings, useSettings } from './store'

/**
 * 입력창 바로 위의 이모트 미리보기 (원래 플러그인의 자동 완성).
 * ;이름 을 치는 중이면 맞는 이모트들을, 이모트 이름 뒤에 . 을 치면 효과들을 보여 준다.
 * 누르면 입력창의 글을 바꾼다. 입력창 위의 "답장 중" 줄(ChatInputContextBar) 자리에 같이 그린다.
 */

const CHANNEL_MESSAGE = 0
const esc = (s: string) => s.replace(/[-\\/^$*+?.()|[\]{}]/g, '\\$&')

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

export function tokenColor(names: string[], fallback: string) {
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

function draftOf(channelId: string): string {
    try {
        return String((Stores as any).DraftStore?.getDraft?.(channelId, CHANNEL_MESSAGE) ?? '')
    } catch {
        return ''
    }
}

export function setInputText(channelId: string, text: string) {
    try {
        find('saveDraft', 'clearDraft')?.saveDraft?.(channelId, text, CHANNEL_MESSAGE)
    } catch {}
    try {
        const ref = find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
        if (typeof ref?.setText === 'function') ref.setText(text)
    } catch {}
}

/** 입력창의 지금 글 (바뀌면 다시 그린다) */
function useInputText(channelId: string | undefined, inputRef: any) {
    const [text, setText] = useState(() => (channelId ? draftOf(channelId) : ''))
    useEffect(() => {
        if (!channelId) return
        const read = () => {
            let t: any
            try {
                const cur = inputRef?.current
                t = cur?.getText?.() ?? cur?.text ?? cur?.state?.text
            } catch {}
            if (typeof t !== 'string') t = draftOf(channelId)
            setText(prev => (prev === t ? prev : t))
        }
        const store: any = (Stores as any).DraftStore
        store?.addChangeListener?.(read)
        // 그려지는 동안 글이 바로 저장되지 않을 수도 있어 조금씩 다시 읽는다
        const timer = setInterval(read, 250)
        read()
        return () => {
            store?.removeChangeListener?.(read)
            clearInterval(timer)
        }
    }, [channelId])
    return text
}

interface Item {
    key: string
    label: string
    image?: string
    /** 누르면 글 끝의 이 부분을 바꾼다 */
    replace: string
    with: string
}

function items(text: string, channelId: string, discord: Map<string, any[]>): Item[] {
    const s = settings()
    const prefix = s.prefix || ';'
    // 효과: ;이름.ef 처럼 . 뒤를 치는 중
    const mod = new RegExp(`(^|\\s)(${esc(prefix)}[\\w~]{2,}(?:\\.[\\w-]+)*)\\.([\\w-]*)$`).exec(text)
    if (mod) {
        const [, , head, part] = mod
        const [name, arg] = part.split('-') as [string, string | undefined]
        const out: Item[] = []
        for (const m of MODIFIERS) {
            if (arg !== undefined) {
                if (m.name !== name) continue
                for (const a of m.args ?? []) if (a.startsWith(arg)) out.push({ key: `${m.name}-${a}`, label: a ? `.${m.name}-${a}` : `.${m.name}`, replace: `${head}.${part}`, with: `${head}.${m.name}${a ? `-${a}` : ''}` })
                continue
            }
            if (!m.name.startsWith(name.toLowerCase())) continue
            out.push({ key: m.name, label: `.${m.name}`, replace: `${head}.${part}`, with: `${head}.${m.name}` })
        }
        return out
    }
    const emote = new RegExp(`(^|\\s)${esc(prefix)}([\\w~]{1,})((?:\\.[\\w-]+)*)$`).exec(text)
    if (!emote) return []
    const [, , q, mods] = emote
    // 이름을 다 썼으면 효과를 고를 수 있게
    const all = allEmotes()
    const exact = all[q] || discord.get(q)
    if (exact) {
        return MODIFIERS.map(m => ({ key: m.name, label: `.${m.name}`, replace: `${prefix}${q}${mods}`, with: `${prefix}${q}${mods}.${m.name}` }))
    }
    if (mods) return []
    const ql = q.toLowerCase()
    const out: Item[] = []
    const seen = new Set<string>()
    const add = (name: string, image: string) => {
        if (seen.has(name) || out.length >= 30) return
        seen.add(name)
        out.push({ key: name, label: name, image, replace: `${prefix}${q}`, with: `${prefix}${name}` })
    }
    // 앞부분이 맞는 것 먼저
    for (const pass of [0, 1])
        for (const [name, list] of discord) {
            const n = name.toLowerCase()
            if (pass === 0 ? n.startsWith(ql) : !n.startsWith(ql) && n.includes(ql)) add(name, emojiSource(list[0], 48))
        }
    for (const pass of [0, 1])
        for (const [name, url] of Object.entries(all)) {
            const n = name.toLowerCase()
            if (pass === 0 ? n.startsWith(ql) : !n.startsWith(ql) && n.includes(ql)) add(name, url)
        }
    return out
}

export function Suggestions({ channelId, inputRef }: { channelId?: string; inputRef?: any }) {
    const s = useSettings()
    const { Text } = Design as any
    const text = useInputText(channelId, inputRef)
    const [, tick] = useState(0)
    useEffect(() => onEmotesChange(() => tick(n => n + 1)), [])
    const discord = useMemo(() => (channelId ? discordEmojis(channelId) : new Map()), [channelId])
    const list = useMemo(() => (channelId && s.suggestions ? items(text, channelId, discord) : []), [text, channelId, discord, s.suggestions, s.prefix, emoteStatus().count])
    const shown = useRef(false)
    if (shown.current !== list.length > 0) {
        shown.current = list.length > 0
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    }
    if (!channelId || !list.length) return null
    const bg = tokenColor(['BACKGROUND_SURFACE_HIGHER', 'BACKGROUND_SECONDARY'], '#2b2d31')
    const chip = tokenColor(['BACKGROUND_MOD_SUBTLE', 'BACKGROUND_MODIFIER_ACCENT'], 'rgba(255,255,255,0.06)')
    return (
        <View style={{ backgroundColor: bg, borderRadius: 12, marginHorizontal: 8, marginBottom: 6, paddingVertical: 6 }}>
            <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6, gap: 6, alignItems: 'center' }}>
                {list.map(it => (
                    <Pressable
                        key={it.key}
                        accessibilityRole="button"
                        accessibilityLabel={it.label}
                        onPress={() => {
                            const now = text
                            if (!now.endsWith(it.replace)) return
                            setInputText(channelId, now.slice(0, now.length - it.replace.length) + it.with)
                        }}
                        style={({ pressed }: any) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, height: 36, borderRadius: 8, backgroundColor: chip, opacity: pressed ? 0.6 : 1 })}
                    >
                        {it.image ? <Image source={{ uri: it.image }} style={{ width: 24, height: 24 }} resizeMode="contain" /> : null}
                        <Text variant="text-sm/medium" color="text-default" numberOfLines={1}>
                            {it.label}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    )
}
