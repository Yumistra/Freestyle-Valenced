import { Stores } from '@valenced/discord/flux'
import { getModuleWithImportedPath, lookupModuleWithImportedPath, waitForModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'

/**
 * 디스코드의 이모지, GIF, 스티커 고르기 창 (채팅 입력창의 그것).
 * modules/expression_picker/native/openExpressionPickerActionSheet.tsx 가
 * openExpressionPickerActionSheet({ channelId, onPressEmoji, onPressGIF, onPressSticker, onDismiss }) 를 내보낸다.
 * 고르면 창은 알아서 닫힌다.
 */

let openFn: ((props: any) => void) | undefined
let emojiFn: ((props: any, opts?: any) => void) | undefined

const firstFn = (m: any, name: string) => (typeof m?.[name] === 'function' ? m[name] : typeof m?.default === 'function' ? m.default : undefined)

const EXPRESSION = 'modules/expression_picker/native/openExpressionPickerActionSheet.tsx'
const EMOJI = 'modules/emoji_picker/native/openEmojiPickerActionSheet.tsx'

function bindOne(cleanup: (...f: Array<() => void>) => void, path: string, set: (m: any) => void) {
    cleanup(
        getModuleWithImportedPath(path, (m: any) => {
            // 경로는 알지만 아직 안 불린 모듈이면 exports 가 없다. 불릴 때까지 기다린다
            if (m) set(m)
            else cleanup(waitForModuleWithImportedPath(path, (x: any) => set(x)) as any)
        }) as any,
    )
}

export function bindPicker(cleanup: (...f: Array<() => void>) => void) {
    bindOne(cleanup, EXPRESSION, m => (openFn = firstFn(m, 'openExpressionPickerActionSheet') ?? openFn))
    bindOne(cleanup, EMOJI, m => (emojiFn = firstFn(m, 'openEmojiPickerActionSheet') ?? emojiFn))
}

/** 누를 때 한 번 더 찾아본다 (그 사이에 모듈이 불렸을 수 있다) */
function refresh() {
    try {
        openFn ??= firstFn((lookupModuleWithImportedPath(EXPRESSION) as any)?.[0], 'openExpressionPickerActionSheet')
        emojiFn ??= firstFn((lookupModuleWithImportedPath(EMOJI) as any)?.[0], 'openEmojiPickerActionSheet')
    } catch {}
}

/** 스티커가 그 서버에서 쓸 수 있는지 등은 채널을 보고 정하니, 지금 또는 마지막에 본 채널을 준다 */
function channelId(): string | undefined {
    try {
        const S: any = (Stores as any).SelectedChannelStore
        return S?.getChannelId?.() ?? S?.getLastSelectedChannelId?.() ?? S?.getMostRecentSelectedTextChannelId?.(null) ?? undefined
    } catch {
        return undefined
    }
}

export const canPick = () => (refresh(), !!openFn || !!emojiFn)

/** 이모지 → 메시지에 넣을 글자 */
export function emojiText(e: any): string {
    if (!e) return ''
    if (e.unicode || (e.surrogates && !/^\d+$/.test(String(e.id ?? '')))) return String(e.surrogates)
    if (e.id) return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
    return String(e.surrogates ?? e.optionallyDiverseSequence ?? (e.name ? `:${e.name}:` : ''))
}

/** GIF → 링크 */
export function gifText(g: any): string {
    return String(g?.url ?? g?.gifUrl ?? g?.src ?? g?.href ?? '')
}

export function openPicker(on: { emoji?(e: any): void; sticker?(s: any): void; gif?(g: any): void }): boolean {
    refresh()
    const id = channelId()
    if (openFn) {
        try {
            openFn({
                channelId: id,
                onPressEmoji: (e: any) => on.emoji?.(e),
                onPressSticker: (s: any) => on.sticker?.(s),
                onPressGIF: (g: any) => on.gif?.(g),
                onDismiss: () => {},
            })
            return true
        } catch {}
    }
    // 이모지만 고르는 창 (예전 버전용)
    if (emojiFn && on.emoji) {
        try {
            const S: any = Stores
            emojiFn({ channel: id ? S.ChannelStore?.getChannel?.(id) : undefined, onPressEmoji: (e: any) => on.emoji?.(e) })
            return true
        } catch {}
    }
    return false
}
