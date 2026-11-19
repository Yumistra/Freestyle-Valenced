import Page from '@valenced/components/Page'
import { Design } from '@valenced/discord/design'
import { useState } from 'react'
import { Linking } from 'react-native'

/**
 * Shizuku Permissions: 디스코드에 Shizuku 로 권한을 준다.
 *
 * 디스코드에는 Shizuku 연결 부분(ShizukuProvider)이 없어서 플러그인이 직접 Shizuku 를 쓸 수 없다.
 * 그래서 Shizuku 를 쓰는 작은 도우미 앱(apps/shizuku-permissions)을 연다. 도우미 앱은 자기를 연 앱(디스코드)의
 * 권한 목록을 보여 주고, 켜고 끄면 Shizuku 로 pm grant, appops set 등을 실행한다.
 */

const APP_URL = 'freestyleperms://open'
const DOWNLOAD_URL = 'https://github.com/Yumistra/Freestyle-Valenced/raw/helper-apk/ShizukuPermissions.apk'
const SHIZUKU_URL = 'https://shizuku.rikka.app/download/'

function SettingsPage() {
    const { Stack, Button, Text } = Design as any
    const [missing, setMissing] = useState(false)

    const open = () => {
        Linking.openURL(APP_URL)
            .then(() => setMissing(false))
            .catch(() => setMissing(true))
    }

    return (
        <Page>
            <Stack spacing={12}>
                <Button size="lg" variant="primary" text="Open Shizuku Permissions" onPress={open} />
                {missing ? (
                    <Text variant="text-sm/medium" color="text-danger">
                        The helper app isn't installed.
                    </Text>
                ) : null}
                <Button size="lg" variant="secondary" text="Download the helper app" onPress={() => Linking.openURL(DOWNLOAD_URL).catch(() => {})} />
                <Button size="lg" variant="secondary" text="Download Shizuku" onPress={() => Linking.openURL(SHIZUKU_URL).catch(() => {})} />
            </Stack>
        </Page>
    )
}

export default plugin({
    start() {},
    SettingsComponent: SettingsPage,
} as any)
