export interface Settings {
    /** 모든 메시지를 조용히 */
    alwaysSilent: boolean
    /** 조용히 보낼 상대(사용자 ID) 또는 채널 ID */
    silentList: string[]
    /** 채팅 입력창 버튼 위치 */
    button: 'none' | 'left' | 'right'
}

export const DEFAULTS: Settings = {
    alwaysSilent: false,
    silentList: [],
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
