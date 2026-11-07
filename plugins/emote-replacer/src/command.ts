import { ToastActionCreators } from '@valenced/discord/actions'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { sendEmote } from './send'

/**
 * /replacer emoji: style: style2: style3:
 * 디스코드 기본 명령어 목록(getBuiltInCommands)에 덧붙인다 (Ghost Ping 과 같은 방법).
 */

const CHAT = 1
const STRING = 3

/** 고를 수 있는 효과 (디스코드 명령어 선택지는 25개까지) */
export const STYLES = [
    'flip',
    'flap',
    'spin',
    'spin-fast',
    'spin-hyper',
    'spinrev',
    'slide',
    'sliderev',
    'shake',
    'rainbow',
    'rainbow-fast',
    'infinite',
    'wiggle',
    'wiggle-huge',
    'wide',
    'wide-extreme',
    'rain',
    'rain-glitter',
    'rotate-90',
    'rotate-180',
    'reverse',
    'hyperspeed',
    'speed-2',
    'resize-small',
    'resize-large',
]

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

let command: any
export function makeCommand() {
    if (command) return command
    let inputType = 1
    try {
        inputType = find('ApplicationCommandInputType')?.ApplicationCommandInputType?.BUILT_IN_TEXT ?? 1
    } catch {}
    command = {
        id: '-73932',
        untranslatedName: 'replacer',
        displayName: 'replacer',
        type: CHAT,
        inputType,
        applicationId: '-1',
        untranslatedDescription: 'Send an emote, with styles',
        displayDescription: 'Send an emote, with styles',
        options: [option('emoji', 'Emote or emoji name', true), option('style', 'Style', false, STYLES), option('style2', 'Another style', false, STYLES), option('style3', 'Another style', false, STYLES)],
        execute(args: any[], ctx: any) {
            const get = (n: string) => (Array.isArray(args) ? args.find(a => a?.name === n)?.value : undefined)
            const name = String(get('emoji') ?? '').trim()
            const styles = ['style', 'style2', 'style3'].map(get).filter((x): x is string => typeof x === 'string' && !!x)
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
