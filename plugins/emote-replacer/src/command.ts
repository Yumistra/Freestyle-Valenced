import { ToastActionCreators } from '@valenced/discord/actions'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { sendEmote } from './send'

/**
 * /replacer emoji: styles:
 * 디스코드 기본 명령어 목록(getBuiltInCommands)에 덧붙인다 (Ghost Ping 과 같은 방법).
 */

const CHAT = 1
const STRING = 3


const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`emote-replacer-cmd-${Date.now()}-${seq++}`, { text })
    } catch {}
}

function option(name: string, description: string, required = false, choices?: string[]) {
    return {
        name,
        displayName: name,
        description,
        displayDescription: description,
        type: STRING,
        required,
        ...(choices ? { choices: choices.map(c => ({ name: c, displayName: c, value: c })) } : {}),
    }
}

export const COMMAND_ID = '-73932'

let command: any
export function makeCommand() {
    if (command) return command
    let inputType = 1
    try {
        inputType = find('ApplicationCommandInputType')?.ApplicationCommandInputType?.BUILT_IN_TEXT ?? 1
    } catch {}
    command = {
        id: COMMAND_ID,
        untranslatedName: 'replacer',
        displayName: 'replacer',
        type: CHAT,
        inputType,
        applicationId: '-1',
        untranslatedDescription: 'Send an emote, with styles',
        displayDescription: 'Send an emote, with styles',
        // styles 칸을 고르면 입력창 위에 효과 목록이 뜨고, 누르면 칸에 적힌다 (stylesBar.tsx)
        options: [option('emoji', 'Emoji, opens the emoji panel', true), option('styles', 'Styles, pick from the list above or type like spin rainbow', false)],
        execute(args: any[], ctx: any) {
            const get = (n: string) => (Array.isArray(args) ? args.find(a => a?.name === n)?.value : undefined)
            const name = String(get('emoji') ?? '').trim()
            const typed = String(get('styles') ?? '')
                .split(/[\s,]+/)
                .map(x => x.replace(/^\.+/, '').trim())
                .filter(Boolean)
            const styles = typed
            const channelId = ctx?.channel?.id
            if (!channelId || !name) return
            if (!sendEmote(channelId, name, styles)) toast(`No emote named ${name.replace(/^[;:]+|:+$/g, '')}`)
        },
    }
    return command
}

export function addCommand(result: any, types: any) {
    const wantsChat = Array.isArray(types) ? types.includes(CHAT) : types == null || types === CHAT
    if (!wantsChat || !Array.isArray(result)) return result
    const c = makeCommand()
    return result.some((r: any) => r?.id === c.id) ? result : [...result, c]
}
