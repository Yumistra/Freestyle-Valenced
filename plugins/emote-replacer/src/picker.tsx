import { AlertActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { emoteStatus, loadEmotes, onEmotesChange, search } from './emotes'
import { MODIFIERS } from './img'
import { discordEmojis } from './send'
import { settings } from './store'
import { tokenColor } from './suggest'

/**
 * 채팅 입력창의 이모트 버튼. 누르면 이모트를 찾아 누를 수 있는 창이 뜨고,
 * 누른 이모트는 입력창에 ;이름 으로 들어간다 (보낼 때 이미지로 바뀐다).
 */

const BUTTON_PATH = 'modules/chat_input/native/action_buttons/ChatInputActionButton.tsx'
const CHANNEL_MESSAGE = 0

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

function currentChannelId(): string | undefined {
    try {
        return (Stores as any).SelectedChannelStore?.getChannelId?.() ?? undefined
    } catch {}
}

function draftOf(channelId: string): string {
    try {
        return String((Stores as any).DraftStore?.getDraft?.(channelId, CHANNEL_MESSAGE) ?? '')
    } catch {
        return ''
    }
}

/** 입력창 글 끝에 넣는다 */
function insert(channelId: string, word: string) {
    const now = draftOf(channelId)
    const text = `${now}${now && !/\s$/.test(now) ? ' ' : ''}${word} `
    try {
        find('saveDraft', 'clearDraft')?.saveDraft?.(channelId, text, CHANNEL_MESSAGE)
    } catch {}
    try {
        const ref = find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
        if (typeof ref?.setText === 'function') ref.setText(text)
    } catch {}
}

let seq = 0
export function toast(text: string) {
    try {
        ToastActionCreators.open(`emote-replacer-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function Grid({ channelId }: { channelId: string }) {
    const { TextInput, Text } = Design as any
    const [query, setQuery] = useState('')
    const [, tick] = useState(0)
    const [added, setAdded] = useState<string | undefined>()
    const [effects, setEffects] = useState<string[]>([])
    useEffect(() => onEmotesChange(() => tick(n => n + 1)), [])
    // 내가 들어가 있는 서버의 이모지도 같이 (니트로 없이 못 쓰는 것은 보낼 때 이미지로 바뀐다)
    const mine = useMemo(() => {
        const out: Array<[string, string]> = []
        for (const [name, list] of discordEmojis(channelId)) {
            const e = list[0]
            out.push([name, `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'webp'}?size=48&quality=lossless`])
        }
        return out
    }, [channelId])
    const list = useMemo(() => {
        const q = query.trim().toLowerCase().replace(/^[^\w]+/, '')
        const fromDiscord = mine.filter(([n]) => !q || n.toLowerCase().includes(q)).slice(0, 60)
        const seen = new Set(fromDiscord.map(([n]) => n))
        return [...fromDiscord, ...search(query, 60).filter(([n]) => !seen.has(n))].slice(0, 90)
    }, [query, mine, emoteStatus().count])
    const prefix = settings().prefix || ''
    return (
        <View style={{ alignSelf: 'stretch', gap: 8 }}>
            <TextInput value={query} placeholder="Search emotes" onChange={setQuery} isClearable />
            <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {MODIFIERS.map(m => {
                    const on = effects.includes(m.name)
                    const brand = tokenColor(['BACKGROUND_BRAND', 'BRAND_500'], '#5865f2')
                    return (
                        <Pressable
                            key={m.name}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            onPress={() => setEffects(x => (on ? x.filter(e => e !== m.name) : [...x, m.name]))}
                            style={({ pressed }: any) => ({ paddingHorizontal: 10, height: 30, borderRadius: 15, justifyContent: 'center', borderWidth: 1, borderColor: on ? brand : 'rgba(128,128,128,0.35)', backgroundColor: on ? brand : 'transparent', opacity: pressed ? 0.6 : 1 })}
                        >
                            <Text variant="text-sm/medium" style={on ? { color: '#ffffff' } : undefined} color={on ? undefined : 'text-muted'}>
                                {m.name}
                            </Text>
                        </Pressable>
                    )
                })}
            </ScrollView>
            <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }} keyboardShouldPersistTaps="handled">
                {list.length ? (
                    list.map(([name, url]) => (
                        <Pressable
                            key={name}
                            accessibilityLabel={name}
                            onPress={() => {
                                const word = prefix + name + effects.map(e => `.${e}`).join('')
                                insert(channelId, word)
                                setAdded(word)
                            }}
                            style={({ pressed }: any) => ({ width: 52, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, opacity: pressed ? 0.5 : 1 })}
                        >
                            <Image source={{ uri: url }} style={{ width: 40, height: 40 }} resizeMode="contain" />
                        </Pressable>
                    ))
                ) : (
                    <Text variant="text-sm/medium" color="text-muted" style={{ padding: 16, textAlign: 'center' }}>
                        {emoteStatus().failed ? "Couldn't load the emote list" : emoteStatus().count ? 'No emotes found' : 'Loading emotes'}
                    </Text>
                )}
            </ScrollView>
            <Text variant="text-xs/medium" color="text-muted" style={{ textAlign: 'center' }}>
                {added ? `Added ${added}` : effects.length ? `Effects, ${effects.join(', ')}` : 'Pick effects, then tap an emote'}
            </Text>
        </View>
    )
}

export function openPicker() {
    const channelId = currentChannelId()
    if (!channelId) return
    if (!emoteStatus().count) loadEmotes()
    const { AlertModal, AlertActionButton } = Design as any
    AlertActionCreators.openAlert(
        `emote-replacer-${seq++}`,
        <AlertModal title="Emotes" extraContent={<Grid channelId={channelId} />} actions={<AlertActionButton text="Done" variant="secondary" />} />,
    )
}

export function EmoteButton() {
    const Icon = lookupGeneratedIconComponent('ReactionIcon' as any) ?? lookupGeneratedIconComponent('EmojiSmileIcon' as any)
    const [ActionButton, setActionButton] = useState(() => (lookupModuleWithImportedPath(BUTTON_PATH) as any)?.[0]?.default)
    useEffect(() => {
        if (ActionButton) return
        return getModuleWithImportedPath(BUTTON_PATH, (mod: any) => mod?.default && setActionButton(() => mod.default)) as any
    }, [ActionButton])
    if (!ActionButton || !Icon) return null
    return <ActionButton accessibilityLabel="Emotes" IconComponent={Icon} onPress={openPicker} />
}
