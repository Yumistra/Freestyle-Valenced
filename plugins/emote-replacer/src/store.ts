export interface Settings {
    /** 글에 ;이름 을 쓰면 바꾸기 (꺼도 /replacer 와 이모트 버튼은 된다) */
    typing: boolean
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
    /** 효과 없는 이모트도 파일로 보내기 (폰에서는 크게 보인다). 효과가 있으면 늘 파일 */
    plainAsFile: boolean
    /** 입력할 때 위에 이모트 미리보기 */
    suggestions: boolean
}

export const DEFAULTS: Settings = {
    typing: false,
    prefix: ';',
    requirePrefix: true,
    showStandardEmotes: true,
    customEmotes: {},
    lockedEmojis: true,
    lockedStickers: true,
    emoteSize: 48,
    button: true,
    plainAsFile: false,
    suggestions: true,
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
