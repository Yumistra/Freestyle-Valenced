import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { findInReactFiber } from '@valenced/utils/react'
import { SilentButton } from './button'
import { idsFor } from './chat'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings } from './store'

/**
 * Silent Messages (siguma 의 Revenge 플러그인을 Valenced 로).
 * 정한 사람·채널로 보내는 메시지 앞에 "@silent " 를 붙여 알림 없이 보낸다.
 * /silent 명령어 대신 채팅 입력창의 종 버튼으로 지금 대화를 켜고 끈다 (Silent Typing 버튼처럼).
 */

const PREFIX = '@silent '

function shouldSilence(channelId: unknown, message: any): boolean {
    if (typeof channelId !== 'string' || typeof message?.content !== 'string') return false
    // 내용 없이 "@silent" 만 남으면 그 글자가 그대로 가므로 (파일만 보낼 때 등) 건드리지 않는다
    if (!message.content.trim() || message.content.startsWith('@silent')) return false
    const s = settings()
    if (s.alwaysSilent) return true
    if (!s.silentList.length) return false
    return idsFor(channelId, message.mentions ?? []).some(id => s.silentList.includes(id))
}

// 매번 같은 요소라야 다시 그려진 트리에서 찾아 뺄 수 있다
const button = <SilentButton key="yumistra-silent-messages" />

function insertButton(tree: any, side: 'left' | 'right') {
    const node: any = findInReactFiber(tree, (n: any): n is any => Array.isArray(n?.props?.children))
    if (!node) return tree
    const children: any[] = node.props.children
    const i = children.indexOf(button)
    if (i !== -1) children.splice(i, 1)
    if (settings().button === side) {
        // 왼쪽은 첨부(+) 버튼 뒤, 오른쪽은 이모지 버튼 앞
        if (side === 'left') children.push(button)
        else children.unshift(button)
    }
    return tree
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        cleanup(
            getModules(withProps('sendMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.sendMessage !== 'function') return
                cleanup(
                    instead(mod, 'sendMessage', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            const [channelId, message] = args
                            if (shouldSilence(channelId, message)) args = [channelId, { ...message, content: PREFIX + message.content }, ...args.slice(2)]
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }, { max: 1 } as any) as any,
            getModuleWithImportedPath('modules/chat_input/native/action_buttons/ChatInputActions.tsx', ({ default: Actions }: any) => {
                if (Actions) cleanup(after(Actions, 'type', (tree: any) => insertButton(tree, 'left')))
            }) as any,
            getModuleWithImportedPath('modules/chat_input/native/action_buttons/ChatInputRightActions.tsx', ({ default: Actions }: any) => {
                if (Actions) cleanup(after(Actions, 'type', (tree: any) => insertButton(tree, 'right')))
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
