import { ToastActionCreators } from '@valenced/discord/actions'
import { Tokens } from '@valenced/discord/common/tokens'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { proxify } from '@valenced/utils/proxy'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { currentChannelId, labelOf, targetOf } from './chat'
import { settings, update, useSettings } from './store'

const BUTTON_PATH = 'modules/chat_input/native/action_buttons/ChatInputActionButton.tsx'

let seq = 0
function toast(text: string, icon?: any) {
    try {
        ToastActionCreators.open(`silent-mentions-${Date.now()}-${seq++}`, { text, ...(icon ? { icon } : {}) })
    } catch {}
}

/** 지금 보고 있는 채널 (바뀌면 다시 그린다) */
function useChannelId() {
    const [id, setId] = useState(currentChannelId)
    useEffect(() => {
        const store: any = (Stores as any).SelectedChannelStore
        const on = () => setId(currentChannelId())
        store?.addChangeListener?.(on)
        on()
        return () => store?.removeChangeListener?.(on)
    }, [])
    return id
}

/** 채팅 입력창의 @ 버튼. 누르면 이 대화의 멘션 알림 끄기를 켜고 끈다 (Silent Messages 의 종 버튼처럼) */
export function MentionButton() {
    const s = useSettings()
    const channelId = useChannelId()
    const AtIcon = lookupGeneratedIconComponent('AtIcon')
    const [ActionButton, setActionButton] = useState(() => (lookupModuleWithImportedPath(BUTTON_PATH) as any)?.[0]?.default)

    // 디스코드가 필요할 때 불러오는 모듈이라 처음엔 없을 수 있다
    useEffect(() => {
        if (ActionButton) return
        return getModuleWithImportedPath(BUTTON_PATH, (mod: any) => mod?.default && setActionButton(() => mod.default)) as any
    }, [ActionButton])

    if (!ActionButton || !AtIcon) return null
    const target = targetOf(channelId)
    const silent = s.always || (!!target && s.list.includes(target))
    return (
        <ActionButton
            accessibilityLabel="Toggle silent mentions"
            accessibilityState={{ checked: silent }}
            IconComponent={silent ? AtOffIcon : AtIcon}
            onPress={() => {
                const cur = settings()
                if (cur.always) {
                    toast('Silent mentions are on everywhere (plugin settings)', AtIcon)
                    return
                }
                if (!target) return
                const on = !cur.list.includes(target)
                update({ list: on ? [...cur.list, target] : cur.list.filter(x => x !== target) })
                toast(`Silent mentions ${on ? 'on' : 'off'} for ${labelOf(target)}`, AtIcon)
            }}
        />
    )
}

/** @ 위에 빨간 사선 (켜져 있다는 표시) */
function AtOffIcon(props: any) {
    const styles = useStyles()
    const AtIcon = lookupGeneratedIconComponent('AtIcon')!
    const { width = 24, height = 24 } = (StyleSheet.flatten(props.style) ?? {}) as any
    const length = Math.hypot(width, height) * 0.85
    return (
        <View>
            <AtIcon {...props} />
            <View style={[styles.slash, { width: length, top: (height - SLASH_HEIGHT) / 2, left: (width - length) / 2 }]} />
        </View>
    )
}

const SLASH_BORDER = 2
const SLASH_HEIGHT = 2 + SLASH_BORDER * 2

const useStyles = proxify(() =>
    (Design as any).createStyles({
        slash: {
            position: 'absolute',
            height: SLASH_HEIGHT,
            backgroundColor: (Tokens as any).default.colors.ICON_FEEDBACK_CRITICAL,
            borderWidth: SLASH_BORDER,
            borderColor: (Tokens as any).default.colors.MOBILE_CHATINPUT_BACKGROUND_DEFAULT,
            borderRadius: SLASH_HEIGHT / 2,
            transform: [{ rotate: '-45deg' }],
        },
    }),
)
