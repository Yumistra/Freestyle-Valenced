import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

/**
 * 테마 색. 디스코드 부품이 쓰는 useToken 훅으로 읽어서
 *  - 지금 테마(미드나잇 같은 변형, 커스텀 테마 포함)의 값을 그대로 받고
 *  - 테마를 바꾸면 화면이 다시 그려진다
 */
export const T = (): any => (Tokens as any)?.default ?? {}

let tokenHooks: any
const hooks = () => {
    if (tokenHooks === undefined)
        try {
            tokenHooks = (lookupModule(withProps('useToken') as any) as any)?.[0] ?? null
        } catch {
            tokenHooks = null
        }
    return tokenHooks
}

/** 훅이 아닌 곳에서 쓰는 값 (테마 이름으로 직접 푼다) */
export function tokenColor(names: string[], fallback: string) {
    try {
        const t = T()
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        for (const n of names) {
            const key = t?.colors?.[n]
            if (!key) continue
            const c = t.internal.resolveSemanticColor(theme, key)
            if (typeof c === 'string' && c) return c
        }
    } catch {}
    return fallback
}

/** 컴포넌트 안에서 쓰는 테마 색 (names 는 렌더마다 같아야 한다) */
export function useColor(names: string[], fallback: string): string {
    const t = T()
    const name = names.find(n => t?.colors?.[n])
    const h = hooks()
    let c: any
    if (name && typeof h?.useToken === 'function')
        try {
            c = h.useToken(t.colors[name])
        } catch {}
    return typeof c === 'string' && c ? c : tokenColor(names, fallback)
}

export function alpha(color: string, a: number) {
    const h = /^#([0-9a-f]{6})/i.exec(color)
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color)
    if (h) {
        const n = parseInt(h[1], 16)
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
    }
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`
    return color
}
