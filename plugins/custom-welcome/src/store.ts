export interface Settings {
    /** 켜져 있으면 Wave 버튼이 아래 메시지, 스티커를 보낸다 */
    enabled: boolean
    /** 보낼 메시지들 (하나를 무작위로). GIF 링크도 된다 */
    messages: string[]
    /** 보낼 스티커 ID 들 (하나를 무작위로) */
    stickers: string[]
    /** 답장할 때 그 사람에게 알림 (멘션) */
    ping: boolean
    /** 메시지와 스티커를 한 메시지로(together), 따로 두 메시지로(separate) */
    mode: 'together' | 'separate'
    /** 예전 버전에서 쓰던 값 */
    lastSticker?: string
}

export const DEFAULTS: Settings = {
    enabled: true,
    messages: ['Welcome {mention}! 👋'],
    stickers: [],
    ping: true,
    mode: 'together',
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
