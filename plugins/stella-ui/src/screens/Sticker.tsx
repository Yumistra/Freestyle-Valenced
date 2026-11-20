import { lookupModuleWithImportedPath } from '@valenced/discord/utils/modules/finders'
import { Image, View } from 'react-native'
import { Boundary, T } from '../parts'
import { C } from '../theme'

// ── 스티커: 디스코드의 스티커 그림(움직이는 것, 로티 포함)을 그대로 쓴다 ──
const STICKER_PATH = 'modules/stickers/native/Sticker.tsx'
let StickerComp: any
function stickerComponent(): any {
    if (StickerComp === undefined) {
        try {
            const mod: any = lookupModuleWithImportedPath(STICKER_PATH)
            StickerComp = typeof mod?.default === 'function' || mod?.default?.$$typeof ? mod.default : null
        } catch {
            StickerComp = null
        }
    }
    return StickerComp
}
export const forgetSticker = () => (StickerComp = undefined)

export function StickerView({ s, mine = false, size = 140, animated = true }: { s: any; mine?: boolean; size?: number; animated?: boolean }) {
    const format = s.format_type ?? s.formatType
    const fallback =
        format === 3 ? (
            <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
                <T size={13} color={mine ? C.white : C.muted} lines={3}>
                    {`[스티커] ${s.name ?? ''}`}
                </T>
            </View>
        ) : (
            <Image source={{ uri: `https://media.discordapp.net/stickers/${s.id}.${format === 4 ? 'gif' : 'png'}?size=160` }} style={{ width: size, height: size }} />
        )
    const D = stickerComponent()
    if (!D) return fallback
    return (
        <Boundary fallback={fallback}>
            <View style={{ width: size, height: size }}>
                <D sticker={{ ...s, format_type: format, type: s.type ?? 1 }} size={size} animated={animated} />
            </View>
        </Boundary>
    )
}
