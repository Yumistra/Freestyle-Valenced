import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { findInReactFiber } from '@valenced/utils/react'
import { MentionButton } from './button'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings } from './store'

/**
 * Silent Mentions: 멘션은 보이지만 아무도 알림을 받지 않게 보낸다.
 * 메시지를 보낼 때 디스코드에 allowed_mentions 를 비워서 넘긴다 (봇, 웹후크가 쓰는 방법).
 * 디스코드의 sendMessage(채널, 메시지, 기다림, 옵션) 는 옵션의 allowedMentions 를 그대로 서버로 보낸다.
 */

function withSilentMentions(options: any) {
    const s = settings()
    const prev = options?.allowedMentions
    // 답장받는 사람 알림은 고른 대로 (디스코드는 답장이면 기본으로 알린다)
    const repliedUser = s.replyPing === 'off' ? false : (prev?.replied_user ?? true)
    return { ...(options ?? {}), allowedMentions: { parse: [], replied_user: repliedUser } }
}

// 매번 같은 요소라야 다시 그려진 트리에서 찾아 뺄 수 있다
const button = <MentionButton key="yumistra-silent-mentions" />

function insertButton(tree: any, side: 'left' | 'right') {
    const node: any = findInReactFiber(tree, (n: any): n is any => Array.isArray(n?.props?.children))
    if (!node) return tree
    const children: any[] = node.props.children
    const i = children.indexOf(button)
    if (i !== -1) children.splice(i, 1)
    if (settings().button === side) {
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
                            if (settings().on && typeof args[0] === 'string') {
                                // 옵션은 네 번째 인자. 빈 자리는 디스코드 기본값(true) 으로 채운다
                                const next = [...args]
                                if (next.length < 3) next[2] = true
                                next[3] = withSilentMentions(next[3])
                                args = next
                            }
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
