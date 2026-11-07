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
import { settings } from './store'

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
    useEffect(() => onEmotesChange(() => tick(n => n + 1)), [])
    const list = useMemo(() => search(query, 60), [query, emoteStatus().count])
    const prefix = settings().prefix || ''
    return (
        <View style={{ alignSelf: 'stretch', gap: 8 }}>
            <TextInput value={query} placeholder="Search emotes" onChange={setQuery} isClearable />
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }} keyboardShouldPersistTaps="handled">
                {list.length ? (
                    list.map(([name, url]) => (
                        <Pressable
                            key={name}
                            accessibilityLabel={name}
                            onPress={() => {
                                insert(channelId, prefix + name)
                                setAdded(name)
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
                {added ? `Added ${prefix}${added}` : 'Tap an emote to add it to your message'}
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
