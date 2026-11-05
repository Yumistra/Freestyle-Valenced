import { pluginStoragePathFor } from '@valenced/json-storage'
import { readFileSync } from '@valenced/modules/native/fs'
import SettingsPage from './Settings'
import { bind, DEFAULTS, setEarly } from './store'
import { patchStores, SELF, startWatching } from './watch'

/**
 * Security Watch: 다른 플러그인이 토큰이나 민감한 것을 건드릴 때마다 알리거나 막는다.
 *  - 토큰 읽기 (getToken), 로그인 토큰 바꾸기 (setToken, removeToken)
 *  - 디스코드가 아닌 곳으로 가는 요청 안의 토큰 (XMLHttpRequest, fetch, WebSocket)
 *  - 클립보드에 토큰 복사
 *  - 디스코드 앱 저장소, DB, 쿠키 파일 읽기 (Valenced fs)
 * Valenced 는 모든 플러그인의 preInit 을 먼저 돌리고 init, start 를 돌리므로
 * preInit 에서 감시를 걸면 다른 플러그인이 일을 시작하기 전에 걸린다.
 */
export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    preInit({ cleanup }: any) {
        // 저장소는 init 부터 생기니 설정 파일을 바로 읽어 둔다 (막기 설정이 처음부터 먹게)
        try {
            setEarly(JSON.parse(String(readFileSync(pluginStoragePathFor(SELF)))))
        } catch {}
        startWatching(cleanup)
    },
    init({ jsonStorage }: any) {
        bind(jsonStorage)
    },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        patchStores(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
