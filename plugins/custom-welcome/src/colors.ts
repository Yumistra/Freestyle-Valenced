import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'

/** 지금 디스코드 테마(커스텀 테마 포함)의 색 토큰을 읽는다 */
function tokenColor(names: string[], fallback: string) {
    try {
        const t: any = (Tokens as any).default
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

export function palette() {
    const brand = tokenColor(['BACKGROUND_BRAND', 'BRAND_500', 'TEXT_BRAND'], '#5865f2')
    const muted = tokenColor(['TEXT_MUTED'], '#949ba4')
    return {
        brand,
        brandSoft: alpha(brand, 0.22),
        text: tokenColor(['TEXT_DEFAULT', 'TEXT_NORMAL'], '#dbdee1'),
        header: tokenColor(['TEXT_STRONG', 'HEADER_PRIMARY', 'TEXT_DEFAULT'], '#f2f3f5'),
        muted,
        surface: tokenColor(['BACKGROUND_SURFACE_HIGH', 'BACKGROUND_FLOATING', 'BACKGROUND_SECONDARY'], alpha(muted, 0.1)),
        input: tokenColor(['INPUT_BACKGROUND_DEFAULT', 'INPUT_BACKGROUND', 'BACKGROUND_TERTIARY'], alpha(muted, 0.14)),
        chip: alpha(muted, 0.14),
    }
}
