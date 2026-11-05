import SettingsPage from './Settings'
import { bind, DEFAULTS } from './store'
import { startWatching } from './watch'

/**
 * Security Watch: 다른 플러그인이 토큰이나 민감한 것을 건드릴 때마다 알린다.
 *  - 토큰 읽기 (getToken), 로그인 토큰 바꾸기 (setToken, removeToken)
 *  - 디스코드가 아닌 곳으로 가는 요청 안의 토큰 (XMLHttpRequest, fetch, WebSocket)
 *  - 클립보드에 토큰 복사
 *  - 디스코드 앱 저장소, DB, 쿠키 파일 읽기 (Valenced fs)
 * 막지는 않고 알리기만 한다.
 */
export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        bind(jsonStorage)
        startWatching(cleanup)
    },
    SettingsComponent: SettingsPage,
} as any)
