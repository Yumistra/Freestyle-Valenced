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
        // 디스코드 명령어 칸은 25개까지: emoji, styles(여러 개를 직접), style ~ style23(목록에서)
        options: [
            option('emoji', 'Emoji, opens the emoji panel', true),
            option('styles', 'Any number of styles, like spin rainbow shake-fast', false),
            ...Array.from({ length: 23 }, (_, i) => option(i ? `style${i + 1}` : 'style', i ? 'Another style' : 'Style', false, STYLES)),
        ],
        execute(args: any[], ctx: any) {
            const get = (n: string) => (Array.isArray(args) ? args.find(a => a?.name === n)?.value : undefined)
            const name = String(get('emoji') ?? '').trim()
            const typed = String(get('styles') ?? '')
                .split(/[\s,]+/)
                .map(x => x.replace(/^\.+/, '').trim())
                .filter(Boolean)
            const picked = Array.from({ length: 23 }, (_, i) => get(i ? `style${i + 1}` : 'style')).filter((x): x is string => typeof x === 'string' && !!x)
            const styles = [...typed, ...picked]
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
