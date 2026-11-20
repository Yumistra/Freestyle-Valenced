/**
 * 저장되는 설정 (Valenced 의 jsonStorage).
 */
export interface Settings {
    /** 디스코드를 켜면 로비부터 보여 준다 */
    openOnStart: boolean
    /** 로비 캐릭터 그림 (직접 고른 것, 없으면 빈 값) */
    character: string
    /** 배경 그림 (없으면 기본 하늘) */
    background: string
    /** 캐릭터 말풍선 (한 줄에 하나, 비우면 기본 인사) */
    lines: string
}

export const DEFAULTS: Settings = { openOnStart: true, character: '', background: '', lines: '' }

let storage: any
export const bindStorage = (s: any) => {
    storage = s
}
export const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

export function save(patch: Partial<Settings>) {
    try {
        storage?.set?.({ ...settings(), ...patch }, true)
    } catch {}
}

/** 설정이 바뀌면 다시 그린다 */
export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}
