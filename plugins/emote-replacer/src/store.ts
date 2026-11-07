export interface Settings {
    /** 이모트 이름 앞에 붙이는 글자 */
    prefix: string
    /** 앞 글자 없이 이름만 써도 바꿀지 */
    requirePrefix: boolean
    /** Yentis 이모트 목록 쓰기 */
    showStandardEmotes: boolean
    /** 내가 추가한 이모트 (이름 → 이미지 주소) */
    customEmotes: Record<string, string>
    /** 니트로 없이 못 쓰는 디스코드 이모지를 이미지로 */
    lockedEmojis: boolean
    /** 니트로 없이 못 보내는 스티커를 이미지로 */
    lockedStickers: boolean
    /** 디스코드 이모지, 스티커 이미지 크기 */
    emoteSize: number
    /** 채팅 입력창의 이모트 버튼 */
    button: boolean
}

export const DEFAULTS: Settings = {
    prefix: ';',
    requirePrefix: true,
    showStandardEmotes: true,
    customEmotes: {},
    lockedEmojis: true,
    lockedStickers: true,
    emoteSize: 48,
    button: true,
}

let storage: any
export function bind(s: any) {
    storage = s
}
export function settings(): Settings {
    return { ...DEFAULTS, ...(storage?.cache ?? {}) }
}
export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}
export function update(patch: Partial<Settings>) {
    return storage?.set({ ...settings(), ...patch }, true)
}
