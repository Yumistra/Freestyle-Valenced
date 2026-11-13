export interface Settings {
    /** 멘션 알림 끄기 */
    on: boolean
    /** 답장할 때 답장받는 사람 알림: 디스코드 설정 그대로(keep) 또는 끄기(off) */
    replyPing: 'keep' | 'off'
    /** 채팅 입력창 버튼 위치 */
    button: 'none' | 'left' | 'right'
}

export const DEFAULTS: Settings = {
    on: true,
    replyPing: 'keep',
    button: 'left',
}

let storage: any

export function bind(s: any) {
    storage = s
}

export function settings(): Settings {
    return { ...DEFAULTS, ...(storage?.cache ?? {}) }
}

/** 화면이 설정 변화를 따라 다시 그려지게 */
export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}

export function update(patch: Partial<Settings>) {
    return storage?.set({ ...settings(), ...patch }, true)
}
