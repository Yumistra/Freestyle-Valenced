import { AlertActionCreators } from '@valenced/discord/actions'
import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { readFileSync } from '@valenced/modules/native/fs'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

/**
 * Watch Tester: Security Watch 를 시험하는 무해한 플러그인.
 * 각 버튼은 Security Watch 의 감지기를 건드리지만 토큰은 기기 밖으로 나가지 않는다.
 *  - 토큰을 읽고 바로 버린다 (값을 쓰거나 보내지 않는다)
 *  - 토큰을 127.0.0.1 (내 폰) 으로 보낸다. 받는 쪽이 없어 아무 데도 가지 않는다
 *  - 토큰을 내 클립보드에 넣는다 (기기 안)
 *  - 디스코드 앱 파일 경로를 읽으려 시도만 한다
 * Security Watch 의 보내기, 복사 감지는 "진짜 토큰 값"이 보일 때만 켜지므로
 * 이 둘은 진짜 토큰을 쓴다. 다만 폰 밖으로는 절대 나가지 않는다.
 */

const fail = (e: unknown) => `Blocked or failed: ${String((e as any)?.message ?? e)}`

function token(): string | undefined {
    const [mod]: any = lookupModule(withProps('getToken', 'setToken') as any) ?? []
    return mod?.getToken?.()
}

function readToken(): string {
    try {
        const v = token()
        // 값은 쓰지 않는다. 길이만 확인하고 버린다
        return v ? `Read a token (${String(v).length} chars), then threw it away.` : 'No token module found.'
    } catch (e) {
        return fail(e)
    }
}

function sendLocal(): string {
    try {
        const v = token()
        if (!v) return 'No token module found.'
        // 127.0.0.1 = 내 폰. 받는 서버가 없어 그대로 실패한다. 폰 밖으로 나가지 않는다
        const x = new XMLHttpRequest()
        x.open('POST', 'http://127.0.0.1:1/test')
        x.setRequestHeader('X-Test-Token', v)
        x.onerror = () => {}
        x.send(v)
        return 'Tried to send the token to 127.0.0.1 (your own phone, nothing listening).'
    } catch (e) {
        return fail(e)
    }
}

function copyToken(): string {
    try {
        const v = token()
        if (!v) return 'No token module found.'
        const [mod]: any = lookupModule(withProps('setString') as any) ?? []
        // 내 클립보드 (기기 안)
        mod?.setString?.(v)
        return 'Put the token on your clipboard (on-device).'
    } catch (e) {
        return fail(e)
    }
}

function readFiles(): string {
    try {
        readFileSync('/data/data/com.discord/files/mmkv/mmkv.default')
        return "Read Discord's app files."
    } catch (e) {
        return fail(e)
    }
}

function show(text: string) {
    try {
        const { AlertModal, AlertActionButton } = Design as any
        AlertActionCreators.openAlert('watch-tester', <AlertModal title="Watch Tester" content={text} actions={<AlertActionButton text="OK" variant="primary" />} />)
    } catch {}
}

function SettingsPage() {
    const { Stack, TableRowGroup, TableRow, Button, Text } = Design as any
    const Row = (label: string, sub: string, icon: string, run: () => string) => (
        <TableRow icon={<TableRowAssetIcon name={icon} />} label={label} subLabel={sub} trailing={<Button size="sm" variant="secondary" text="Run" onPress={() => show(run())} />} />
    )
    return (
        <Page>
            <Stack spacing={16}>
                <Text variant="text-sm/medium" color="text-muted">
                    Each button trips one Security Watch alert. Your token never leaves the phone: the send goes to 127.0.0.1 (nothing listening) and the copy goes to your own clipboard.
                </Text>
                <TableRowGroup>
                    {Row('Read my token', 'Calls getToken, then drops the value.', 'KeyIcon', readToken)}
                    {Row('Send token to localhost', 'POSTs it to 127.0.0.1, which goes nowhere.', 'GlobeEarthIcon', sendLocal)}
                    {Row('Copy my token', 'Puts it on your own clipboard.', 'CopyIcon', copyToken)}
                    {Row("Read Discord's app files", 'Tries to read the mmkv store.', 'FolderIcon', readFiles)}
                </TableRowGroup>
            </Stack>
        </Page>
    )
}

export default plugin({
    SettingsComponent: SettingsPage,
} as any)
