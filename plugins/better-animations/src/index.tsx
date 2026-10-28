import { pingNative, syncNative } from './native'
import { patchChannelRows } from './patches/channels'
import { patchConstants } from './patches/constants'
import { patchLayout, patchServerSwitch } from './patches/layout'
import { patchLists } from './patches/lists'
import { patchPress } from './patches/press'
import { patchNativeScreens } from './patches/screens'
import { patchSheets } from './patches/sheets'
import { patchJsStack } from './patches/stack'
import { patchMediaTiming, patchWorklets } from './patches/worklets'
import { bindStorage, DEFAULTS, onSettingsChange, report } from './settings'
import SettingsPage from './ui/Settings'

/**
 * Better Animations (모바일판)
 *  - 큰 화면·모달: react-native-screens 네이티브 전환 종류 바꾸기
 *  - 설정·메뉴 화면: @react-navigation/stack 카드 전환을 직접 만든 효과로
 *  - 아래 창: @gorhom/bottom-sheet 의 열고 닫는 움직임
 *  - 팝업 메뉴·확인창·토스트·서버 폴더: Reanimated 워클릿을 우리 워클릿으로 바꿔 넣기
 *  - 채널 화면 밀기·작은 움직임·폴더 펼침: 디스코드 애니메이션 상수 바꾸기
 *  - 채널 목록 접기·서버 바꾸기: Flux 액션에 맞춰 LayoutAnimation
 *  - 채팅 메시지: 네이티브(plugin.jar)가 채팅 목록(RecyclerView)에서 직접
 * 각 부분은 따로 실패해도 나머지는 동작하게 한다.
 */
export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bindStorage(jsonStorage)
        const tryPatch = (name: string, fn: () => any) => {
            try {
                const undo = fn()
                if (typeof undo === 'function') cleanup(undo)
            } catch (e) {
                report(name, e)
            }
        }
        tryPatch('screens', () => patchNativeScreens(cleanup))
        tryPatch('stack', patchJsStack)
        tryPatch('sheets', patchSheets)
        tryPatch('worklets', () => patchWorklets(cleanup))
        tryPatch('media', () => patchMediaTiming(cleanup))
        tryPatch('constants', () => patchConstants(cleanup))
        tryPatch('layout', patchLayout)
        tryPatch('servers', () => patchServerSwitch(cleanup))
        tryPatch('channelRows', () => patchChannelRows(cleanup))
        tryPatch('lists', () => patchLists(cleanup))
        tryPatch('press', patchPress)
        // 메시지 애니메이션은 네이티브가 설정 파일을 직접 읽는다
        cleanup(onSettingsChange(() => syncNative()) as any)
        syncNative().then(() => pingNative())
    },
    SettingsComponent: SettingsPage,
} as any)
