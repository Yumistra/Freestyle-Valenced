import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect } from 'react'
import { COMMAND_ID } from './command'

/**
 * /replacer 의 emoji 칸을 고르면 이모지 패널을 연다.
 * 패널에서 이모지를 고르면 (칸에 값이 들어가면) 글자 키보드를 다시 연다.
 * 디스코드 입력창의 이모지 버튼이 하는 것(handleToggleKeyboard({ type: EXPRESSION, context }))과 같다.
 */

const find = (...props: string[]): any => {
    try {
        return (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
}

function commandStore(): any {
    return (Stores as any).ApplicationCommandStore ?? find('getActiveOptionName', 'getActiveCommand')
}

function keyboardTypes(): any {
    return find('KeyboardTypes')?.KeyboardTypes ?? {}
}

function openEmojiPanel(inputRef: any) {
    const types = keyboardTypes()
    const view = find('ExpressionPickerViewType')?.ExpressionPickerViewType?.EMOJI ?? 'emoji'
    const expression = types.EXPRESSION ?? 'expression'
    const req = { type: expression, context: { type: view } }
    const cur = inputRef?.current
    if (typeof cur?.handleToggleKeyboard === 'function') return cur.handleToggleKeyboard(req)
    find('setKeyboardType')?.setKeyboardType?.(req)
}

function openTextKeyboard(inputRef: any) {
    const types = keyboardTypes()
    const req = { type: types.SYSTEM ?? 'system' }
    const set = find('setKeyboardType')?.setKeyboardType
    if (typeof set === 'function') return set(req)
    inputRef?.current?.handleToggleKeyboard?.(req)
}

export function EmojiOptionWatcher({ channelId, inputRef }: { channelId?: string; inputRef?: any }) {
    useEffect(() => {
        if (!channelId) return
        const store = commandStore()
        if (!store) return
        // 이번에 emoji 칸을 고른 동안 패널을 열었는지, 그때 칸에 값이 있었는지
        let opened = false
        let hadValue = false
        const check = () => {
            try {
                const cmd = store.getActiveCommand?.(channelId)
                const active = store.getActiveOptionName?.(channelId)
                const state = store.getOptionState?.(channelId, 'emoji')
                const has = !!state?.hasValue || !!String(state?.optionValue ?? state?.value ?? '').trim()
                if (cmd?.id !== COMMAND_ID || active !== 'emoji') {
                    opened = false
                    return
                }
                if (!opened) {
                    opened = true
                    hadValue = has
                    if (!has) setTimeout(() => openEmojiPanel(inputRef), 0)
                    return
                }
                // 패널에서 이모지를 골라 칸이 채워지면 글자 키보드로
                if (has && !hadValue) {
                    hadValue = true
                    setTimeout(() => openTextKeyboard(inputRef), 50)
                }
            } catch {}
        }
        store.addChangeListener?.(check)
        check()
        return () => store.removeChangeListener?.(check)
    }, [channelId])
    return null
}
