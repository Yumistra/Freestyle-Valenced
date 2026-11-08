export interface Settings {
    /** 채널 이름 아래에 마지막 메시지 */
    lastMessage: boolean
    /** 보낸 사람 이름을 역할 색으로 */
    roleColor: boolean
    /** 표시 이름 스타일 (글꼴, 색) */
    nameStyle: boolean
    /** 그라데이션 이름을 진짜 그라데이션으로 */
    realGradient: boolean
    /** 예전 버전에서 켜진 realGradient 를 한 번 끄기 위한 표시 */
    gradientReset?: boolean
    /** 1.0.12 에서 realGradient 를 한 번 다시 켜기 위한 표시 */
    splitReset?: boolean
    /** 보낸 사람 이름 보이기 */
    showAuthor: boolean
    /** 어느 채널에 미리보기를 보일지 */
    mode: 'all' | 'unreads' | 'default'
}
export const DEFAULTS: Settings = { lastMessage: true, roleColor: true, nameStyle: true, realGradient: true, showAuthor: true, mode: 'all' }

let storage: any
export const bind = (s: any) => (storage = s)
export const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })
export function useSettings(): Settings {
    storage?.use?.()
    return settings()
}
export const update = (patch: Partial<Settings>) => storage?.set({ ...settings(), ...patch }, true)
