import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { findInReactFiber } from '@valenced/utils/react'
import { loadEmotes } from './emotes'
import { EmoteButton } from './picker'
import { rewrite } from './send'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings } from './store'

/**
 * Emote Replacer (BetterDiscord EmoteReplacer 를 옮긴 것).
 * ;이름 을 Yentis 이모트 이미지로, 니트로 없이 못 쓰는 이모지와 스티커를 이미지로 바꿔 보낸다.
 * 원래 플러그인은 이미지를 파일로 올리지만, 여기서는 [𝅙](주소) 숨은 링크로 보낸다 (이미지만 보인다).
 * 원래의 .flip, .spin 같은 효과(GIF 를 새로 만드는 것)는 아직 없다.
 */

const button = <EmoteButton key="yumistra-emote-replacer" />

function insertButton(tree: any) {
    const node: any = findInReactFiber(tree, (n: any): n is any => Array.isArray(n?.props?.children))
    if (!node) return tree
    const children: any[] = node.props.children
    const i = children.indexOf(button)
    if (i !== -1) children.splice(i, 1)
    if (settings().button) children.push(button)
    return tree
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        loadEmotes()
        cleanup(
            getModules(withProps('sendMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.sendMessage !== 'function') return
                cleanup(
                    instead(mod, 'sendMessage', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        try {
                            args = rewrite(args)
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }, { max: 1 } as any) as any,
            getModuleWithImportedPath('modules/chat_input/native/action_buttons/ChatInputActions.tsx', ({ default: Actions }: any) => {
                if (Actions) cleanup(after(Actions, 'type', (tree: any) => insertButton(tree)))
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
