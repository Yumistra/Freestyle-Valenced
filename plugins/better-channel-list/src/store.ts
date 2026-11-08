export interface Settings {
    /** 채널 이름 아래에 마지막 메시지 */
    lastMessage: boolean
    /** 보낸 사람 이름을 역할 색으로 */
    roleColor: boolean
    /** 보낸 사람 이름 보이기 */
    showAuthor: boolean
}
export const DEFAULTS: Settings = { lastMessage: true, roleColor: true, showAuthor: true }

let storage: any
export const bind = (s: any) => (storage = s)
export const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}
export const update = (patch: Partial<Settings>) => storage?.set({ ...settings(), ...patch }, true)
