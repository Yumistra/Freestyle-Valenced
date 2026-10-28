import { Tokens } from '@valenced/discord/common/tokens'
import { Stores } from '@valenced/discord/flux'

/** 지금 테마에서 디스코드 색 토큰 값을 읽는다. 못 읽으면 fallback */
export function tokenColor(name: string, fallback: string) {
    try {
        const tokens: any = Tokens
        const theme = (Stores as any).ThemeStore?.theme ?? 'dark'
        const c = tokens.default.internal.resolveSemanticColor(theme, tokens.default.colors[name])
        return typeof c === 'string' ? c : fallback
    } catch {
        return fallback
    }
}

/** #rrggbb(aa) 에 투명도를 덧씌운다 */
export function withAlpha(color: string, alpha: number) {
    if (!/^#[0-9a-f]{6}/i.test(color)) return color
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
        .toString(16)
        .padStart(2, '0')
    return color.slice(0, 7) + a
}

export function palette() {
    const brand = tokenColor('TEXT_BRAND', '#c92e5c')
    return {
        brand,
        brandSoft: withAlpha(brand, 0.18),
        text: tokenColor('TEXT_DEFAULT', '#f2f3f5'),
        muted: tokenColor('TEXT_MUTED', '#949ba4'),
        border: tokenColor('BORDER_SUBTLE', '#ffffff22'),
        base: tokenColor('BACKGROUND_BASE_LOWER', '#1e1f22'),
        surface: tokenColor('BACKGROUND_BASE_LOW', '#2b2d31'),
        raised: tokenColor('BACKGROUND_SURFACE_HIGH', '#313338'),
    }
}
