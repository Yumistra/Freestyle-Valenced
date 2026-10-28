import { ToastActionCreators } from '@valenced/discord/actions'
import { instead } from '@valenced/patcher'
import { unproxify } from '@valenced/utils/proxy'
import { Image } from 'react-native'

/**
 * Discord 350.8의 알림은 open(key, { text, icon }) 형태다.
 * 옛 Vendetta 플러그인은 open({ key, content, source, icon })처럼 하나로 넘겨서
 * 알림 내용이 undefined로 저장되고, 알림 상자가 그려질 때 앱이 튕긴다.
 * 그런 호출을 새 형태로 바꾸고, 바꿀 수 없으면 무시한다.
 */

let seq = 0

/** 옛 형태의 아이콘(에셋 번호/주소)을 새 형태 { type: 'image', src }로 */
function iconOf(old: any): any {
    const icon = old.icon && typeof old.icon === 'object' ? old.icon : undefined
    if (icon?.type) return icon
    const source = old.source ?? (typeof old.icon !== 'boolean' ? old.icon : undefined)
    if (typeof source === 'string' && source) return { type: 'image', src: source }
    if (source && typeof source === 'object' && typeof source.uri === 'string') return { type: 'image', src: source.uri }
    if (typeof source === 'number') {
        try {
            const src = (Image as any).resolveAssetSource?.(source)?.uri
            if (src) return { type: 'image', src }
        } catch {}
    }
}

/** 고쳐서 넘길 인자. null이면 이 호출은 건너뛴다 */
export function normalize(args: any[]): any[] | null {
    const [key, toast] = args
    // 정상 호출
    if (toast && typeof toast === 'object') return args

    // 옛 형태: open({ key, content, ... })
    if (key && typeof key === 'object') {
        const text = key.content ?? key.text ?? key.message
        if (text == null || text === '') return null
        const next: any = { text: typeof text === 'string' ? text : String(text) }
        const icon = iconOf(key)
        if (icon) next.icon = icon
        if (typeof key.duration === 'number') next.duration = key.duration
        return [typeof key.key === 'string' ? key.key : `toast-fix-${Date.now()}-${seq++}`, next]
    }

    // open(key, '내용') 처럼 글자만 넘긴 경우
    if (typeof toast === 'string' && toast) return [String(key ?? `toast-fix-${seq++}`), { text: toast }]

    // 내용이 없는 호출: 띄우면 튕기니 무시
    return null
}

export default plugin({
    start({ cleanup }) {
        const target = unproxify(ToastActionCreators as any)
        cleanup(
            instead(target, 'open', function (this: any, args: any[], orig: (...a: any[]) => any) {
                const fixed = normalize(args)
                if (!fixed) return
                return orig.apply(this, fixed)
            }),
        )
    },
} as any)
