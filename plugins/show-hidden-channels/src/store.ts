export interface Settings {
    /** 숨겨진 채널에 보여 줄 이름 (디스코드는 진짜 이름 대신 ___hidden___ 을 보내고 앱은 "액세스 권한 없음" 으로 보여 준다) */
    name: string
    /** 숨겨진 채널의 안 읽음 표시 숨기기 */
    hideUnreads: boolean
    /** lock: 디스코드 그대로 (자물쇠 달린 아이콘), muted: 흐리게 + 오른쪽에 눈 아이콘 */
    showMode: 'lock' | 'muted'
    /** 잠금 화면의 허용된 역할, 사용자 목록을 처음부터 펼쳐 둘지 */
    rolesOpen: boolean
}

export const DEFAULTS: Settings = { name: 'hidden', hideUnreads: true, showMode: 'lock', rolesOpen: true }

let storage: any
const listeners = new Set<() => void>()

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

export function onChange(f: () => void) {
    listeners.add(f)
    return () => void listeners.delete(f)
}

export function update(patch: Partial<Settings>) {
    const r = storage?.set({ ...settings(), ...patch }, true)
    listeners.forEach(f => {
        try {
            f()
        } catch {}
    })
    return r
}
