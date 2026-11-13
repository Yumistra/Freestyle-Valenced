export interface Settings {
    /** 모든 대화에서 멘션 알림 끄기 */
    always: boolean
    /** 멘션 알림을 끈 대화 (1:1 DM 은 상대 사용자 ID, 나머지는 채널 ID) */
    list: string[]
    /** 답장할 때 답장받는 사람 알림: 디스코드 설정 그대로(keep) 또는 끄기(off) */
    replyPing: 'keep' | 'off'
    /** 채팅 입력창 버튼 위치 */
    button: 'none' | 'left' | 'right'
}

export const DEFAULTS: Settings = {
    always: false,
    list: [],
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
    // 배열은 통째로 바꿔야 해서 전체를 갈아 끼운다
    return storage?.set({ ...settings(), ...patch }, true)
}
