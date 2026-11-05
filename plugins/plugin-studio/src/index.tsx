import { Studio } from './ui'

/**
 * Plugin Studio: 디스코드 안에서 Valenced 플러그인을 만든다.
 * 화면은 진짜 디스코드 부품으로 미리 보면서 만들고, 다운로드 폴더에 설치용 zip 으로 저장한다.
 * 깔린 플러그인을 열면 그 코드는 그대로 두고 설정 화면만 바꾼 새 버전을 만든다.
 */
export default plugin({
    jsonStorage: { load: true, default: { projects: {} } },
    start() {},
    SettingsComponent: Studio,
} as any)
