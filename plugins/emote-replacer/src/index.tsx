import { getModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after, instead } from '@valenced/patcher'
import { findInReactFiber } from '@valenced/utils/react'
import { addCommand } from './command'
import { loadEmotes } from './emotes'
import { EmoteButton } from './picker'
import { quickPlan, rewrite, stickerNeedsWork } from './send'
import SettingsPage from './Settings'
import { bind, DEFAULTS, settings } from './store'
import { EmojiOptionWatcher } from './emojiOption'
import { StylesBar } from './stylesBar'
import { Suggestions } from './suggest'

/**
 * Emote Replacer (BetterDiscord EmoteReplacer 를 옮긴 것).
 * ;이름 을 이모트 그림으로 (효과 포함), 니트로 없이 못 쓰는 이모지와 스티커를 그림으로 바꿔 보낸다.
 * 입력창 위에 자동 완성 줄, 입력창 오른쪽에 이모트 버튼.
 */

const button = <EmoteButton key="yumistra-emote-replacer" />

function insertButton(tree: any) {
    const node: any = findInReactFiber(tree, (n: any): n is any => Array.isArray(n?.props?.children))
    if (!node) return tree
    const children: any[] = node.props.children
    const i = children.indexOf(button)
    if (i !== -1) children.splice(i, 1)
    if (settings().button) children.unshift(button)
    return tree
}

/** 입력창 위 "답장 중" 줄 자리에 자동 완성 줄을 같이 그린다 */
function withSuggestions(props: any, original: any) {
    return (
        <>
            <Suggestions channelId={props?.channel?.id} inputRef={props?.chatInputRef} />
            <StylesBar channelId={props?.channel?.id} inputRef={props?.chatInputRef} />
            <EmojiOptionWatcher channelId={props?.channel?.id} inputRef={props?.chatInputRef} />
            {original}
        </>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        loadEmotes()
        cleanup(
            getModules(withProps('getBuiltInCommands') as any, (mod: any) => {
                cleanup(
                    instead(mod, 'getBuiltInCommands', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const result = orig.apply(this, args)
                        try {
                            return addCommand(result, args?.[0])
                        } catch {
                            return result
                        }
                    }),
                )
            }) as any,
            getModules(withProps('sendMessage', 'deleteMessage') as any, (mod: any) => {
                if (typeof mod?.sendMessage !== 'function') return
                cleanup(
                    instead(mod, 'sendMessage', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        let p: any
                        try {
                            p = quickPlan(args)
                            if (!p && !stickerNeedsWork(args)) return orig.apply(this, args)
                        } catch {
                            return orig.apply(this, args)
                        }
                        const self = this
                        return (async () => {
                            let r: any = { args }
                            try {
                                r = await rewrite(args, p)
                            } catch {}
                            try {
                                return await orig.apply(self, r.args)
                            } finally {
                                if (r.after) setTimeout(r.after, 0)
                            }
                        })()
                    }),
                )
            }, { max: 1 } as any) as any,
            getModuleWithImportedPath('modules/chat_input/native/action_buttons/ChatInputRightActions.tsx', ({ default: Actions }: any) => {
                if (Actions) cleanup(after(Actions, 'type', (tree: any) => insertButton(tree)))
            }) as any,
            getModuleWithImportedPath('modules/chat_input/native/ChatInputContextBar.tsx', (mod: any) => {
                const bar = mod?.default
                if (!bar) return
                const key = typeof bar === 'function' ? 'default' : typeof bar?.type === 'function' ? 'type' : undefined
                const target = key === 'default' ? mod : bar
                if (!key) return
                cleanup(
                    instead(target, key, function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const out = orig.apply(this, args)
                        try {
                            return withSuggestions(args[0], out)
                        } catch {
                            return out
                        }
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
