import SettingsPage from './Settings'

export default plugin({
    // 백업 목록은 이 플러그인 전용 저장소에 둔다 (start/설정 화면의 api.jsonStorage)
    jsonStorage: { load: true, default: { backups: [] } },
    start() {},
    SettingsComponent: SettingsPage,
} as any)
