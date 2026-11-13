export interface Settings {
    /** 켜져 있으면 Wave 버튼이 아래 메시지, 스티커를 보낸다 */
    enabled: boolean
    /** 보낼 메시지들 (하나를 무작위로). GIF 링크도 된다 */
    messages: string[]
    /** 보낼 스티커 ID 들 (하나를 무작위로) */
    stickers: string[]
    /** 답장할 때 그 사람에게 알림 (멘션) */
    ping: boolean
    /** 메시지와 스티커를 한 메시지로(together), 둘 중 하나만 무작위로(separate) */
    mode: 'together' | 'separate'
    /** 니트로가 없어 못 보내는 스티커는 이미지 링크로 보낸다 (FakeNitro 처럼) */
    stickerLinks: boolean
    /** DM 의 손 흔들기: 디스코드 그대로(wave), 서버와 같게(same), DM 용 따로(own) */
    dm: 'wave' | 'same' | 'own'
    /** DM 용 메시지들 */
    dmMessages: string[]
    /** DM 용 스티커 ID 들 */
    dmStickers: string[]
    /** 예전 버전에서 쓰던 값 */
    lastSticker?: string
}

export const DEFAULTS: Settings = {
    enabled: true,
    messages: ['Welcome {mention}! 👋'],
    stickers: [],
    ping: true,
    mode: 'together',
    stickerLinks: true,
    dm: 'wave',
    dmMessages: ['Hey {name}! 👋'],
    dmStickers: [],
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
