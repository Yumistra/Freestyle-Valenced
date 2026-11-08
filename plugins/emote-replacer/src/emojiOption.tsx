import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { COMMAND_ID } from './command'
import { status } from './status'

/**
 * /replacer 의 emoji 칸을 고르면 이모지 패널을 연다.
 * 패널에서 이모지를 고르면 (칸에 값이 들어가면) 글자 키보드를 다시 연다.
 * 입력창의 이모지 버튼이 하는 것(handleToggleKeyboard({ type: EXPRESSION, context }))과 같다.
 * 입력창 그리기와 상관없이 플러그인이 켜질 때부터 명령어 상태(ApplicationCommandStore)를 지켜본다.
 */

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

const commandStore = (): any => (Stores as any).ApplicationCommandStore ?? find('getActiveOptionName', 'getActiveCommand')
const keyboardTypes = (): any => find('KeyboardTypes')?.KeyboardTypes ?? {}

/** 입력창 ref (ContextBar 를 그릴 때 받아 둔다) */
export const inputRefs = new Map<string, any>()

function inputOf(channelId: string): any {
    const r = inputRefs.get(channelId)?.current
    if (r) return r
    try {
        return find('getBestActiveInputForChannelId')?.getBestActiveInputForChannelId?.(channelId)
    } catch {}
}

function setKeyboard(channelId: string, req: any): string {
    const input = inputOf(channelId)
    if (typeof input?.handleToggleKeyboard === 'function') {
        input.handleToggleKeyboard(req)
        return 'input.handleToggleKeyboard'
    }
    const mod = find('setKeyboardType')
    if (typeof mod?.setKeyboardType === 'function') {
        mod.setKeyboardType(req)
        return 'setKeyboardType'
    }
    return 'none found'
}

function openEmojiPanel(channelId: string) {
    const types = keyboardTypes()
    const view = find('ExpressionPickerViewType')?.ExpressionPickerViewType?.EMOJI ?? 'emoji'
    try {
        status.panel = `Opened with ${setKeyboard(channelId, { type: types.EXPRESSION ?? 'expression', context: { type: view } })}`
    } catch (e: any) {
        status.panel = `Failed, ${e?.message ?? e}`
    }
}

function openTextKeyboard(channelId: string) {
    const types = keyboardTypes()
    try {
        const mod = find('setKeyboardType')
        if (typeof mod?.setKeyboardType === 'function') mod.setKeyboardType({ type: types.SYSTEM ?? 'system' })
        else inputOf(channelId)?.handleToggleKeyboard?.({ type: types.SYSTEM ?? 'system' })
    } catch {}
}

export function watchEmojiOption(): () => void {
    const store = commandStore()
    if (!store) {
        status.store = 'ApplicationCommandStore not found'
        return () => {}
    }
    status.store = 'Watching'
    let opened = false
    let hadValue = false
    const check = () => {
        try {
            const channelId = (Stores as any).SelectedChannelStore?.getChannelId?.()
            if (!channelId) return
            const cmd = store.getActiveCommand?.(channelId)
            // 칸이 눌렸는지는 칸마다의 상태(isActive)에 있다 (ApplicationCommandOptionItem 이 이것으로 칸을 칠한다)
            let active = store.getActiveOptionName?.(channelId)
            if (!active) {
                const states = store.getOptionStates?.(channelId) ?? {}
                for (const [name, st] of Object.entries<any>(states)) if (st?.isActive) active = name
                if (!active) for (const n of ['emoji', 'styles']) if (store.getOptionState?.(channelId, n)?.isActive) active = n
            }
            if (cmd?.id === COMMAND_ID) status.option = `Active option, ${active ?? 'none'}`
            const state = store.getOptionState?.(channelId, 'emoji')
            const has = !!state?.hasValue
            if (cmd?.id !== COMMAND_ID || active !== 'emoji') {
                opened = false
                return
            }
            if (!opened) {
                opened = true
                hadValue = has
                if (!has) setTimeout(() => openEmojiPanel(channelId), 50)
                return
            }
            // 패널에서 이모지를 골라 칸이 채워지면 글자 키보드로
            if (has && !hadValue) {
                hadValue = true
                setTimeout(() => openTextKeyboard(channelId), 80)
            }
        } catch (e: any) {
            status.option = `Error, ${e?.message ?? e}`
        }
    }
    store.addChangeListener?.(check)
    return () => store.removeChangeListener?.(check)
}
