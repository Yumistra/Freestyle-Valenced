export interface Settings {
    /** 숨겨진 채널에 보여 줄 이름 (디스코드는 진짜 이름 대신 ___hidden___ 을 보낸다) */
    name: string
}

export const DEFAULTS: Settings = { name: 'hidden' }

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
