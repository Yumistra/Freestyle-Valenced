import { View } from 'react-native'
import { openNative, toast } from '../data'
import { Backdrop, NavButtons, PlaceChip } from '../parts'
import { useSettings } from '../settings'
import { back, go, isNarrow, setState } from '../state'

/** 디스코드 원래 화면으로 (Stella 를 내리고 연다). 결제, 보안 확인 등 */
export function leaveTo(where: Parameters<typeof openNative>[0]) {
    setState({ visible: false, menu: false })
    // 화면이 내려간 다음 연다
    setTimeout(() => {
        if (!openNative(where)) toast('그 화면을 열지 못했어요')
    }, 60)
}

/** 큰 화면 틀: 흐린 배경, 위 왼쪽 뒤로/로비 버튼과 위치 칩, 가운데 내용 */
export function Frame({ title, width, children, right }: { title: string; width: number; children: any; right?: any }) {
    const s = useSettings()
    const narrow = isNarrow(width)
    return (
        <View style={{ flex: 1 }}>
            <Backdrop uri={s.background || s.character} blur={14} dim={0.42} />
            <View style={{ position: 'absolute', top: 20, left: 24, right: 24, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <NavButtons onBack={back} onHome={go.lobby} />
                <PlaceChip text={title} />
                <View style={{ flex: 1 }} />
                {right}
            </View>
            <View style={{ flex: 1, paddingTop: 80, paddingHorizontal: narrow ? 0 : width * 0.12 }}>{children}</View>
        </View>
    )
}
