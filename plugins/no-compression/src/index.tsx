import Page from '@valenced/components/Page'
import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { getNativeModule } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'

/**
 * No Compression (MSMA 의 Vendetta 플러그인을 Valenced 로).
 *
 * 원래 플러그인은 CloudUpload.reactNativeCompressAndExtractData 결과를 덮어썼다. 지금(352) 디스코드는 압축을
 * 파일을 고를 때 네이티브 MediaManager.resolveToMediaFilePath(uri, options) 에서 한다. 그 함수에는 이미 스위치가 있다:
 *  - allowOptimization: false → 사진을 다시 압축하지 않고 원본을 그대로 복사 (HEIC 만은 호환을 위해 변환)
 *  - skipVideoTranscode: true → 영상을 다시 인코딩하지 않고 원본을 그대로 복사
 * 그래서 이 함수로 가는 옵션만 바꾼다. 크기·파일 이름 등 나머지 준비는 디스코드가 하던 대로 한다.
 */

interface Settings {
    images: boolean
    videos: boolean
}
const DEFAULTS: Settings = { images: true, videos: true }

let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

function rewrite(options: any) {
    const s = settings()
    const next = { ...(options ?? {}) }
    if (s.images) {
        next.allowOptimization = false
        next.isLowQuality = false
    }
    if (s.videos) next.skipVideoTranscode = true
    return next
}

const KEY = 'resolveToMediaFilePath'
const patched = new WeakSet<object>()

/** 이 객체의 resolveToMediaFilePath 를 감싼다. 실제로 바뀌었으면 true (네이티브 객체는 안 바뀔 수 있다) */
function hook(obj: any, cleanup: (...f: Array<() => void>) => void) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || patched.has(obj)) return false
    const orig = obj[KEY]
    if (typeof orig !== 'function') return false
    try {
        const undo = instead(obj, KEY, function (this: unknown, args: any[], fn: (...a: any[]) => any) {
            try {
                args = [args[0], rewrite(args[1]), ...args.slice(2)]
            } catch {}
            return fn.apply(this, args)
        })
        if (obj[KEY] === orig) {
            undo?.()
            return false
        }
        cleanup(undo)
        patched.add(obj)
        return true
    } catch {
        return false
    }
}

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`no-compression-${Date.now()}-${seq++}`, { text })
    } catch {}
}

const isTooLarge = (e: any) => {
    const code = e?.code ?? e?.body?.code ?? e?.status ?? e
    return code === 40005 || code === 413
}

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const s = settings()
    const { Stack, TableRowGroup, TableSwitchRow } = Design as any
    const set = (patch: Partial<Settings>) => storage?.set({ ...settings(), ...patch }, true)
    return (
        <Page>
            <Stack spacing={24}>
                <TableRowGroup title="Upload in original quality">
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ImageIcon" />}
                        label="Images"
                        subLabel="No resizing or WebP/JPEG conversion."
                        value={s.images}
                        onValueChange={(images: boolean) => set({ images })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="VideoIcon" />}
                        label="Videos"
                        subLabel="No re-encoding. Big videos may go over your upload limit."
                        value={s.videos}
                        onValueChange={(videos: boolean) => set({ videos })}
                    />
                </TableRowGroup>
            </Stack>
        </Page>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        // 1. 네이티브 모듈 자체 (디스코드 JS 가 부르는 바로 그 객체)
        try {
            hook(getNativeModule('MediaManager'), cleanup)
        } catch {}
        // 2. 그걸 내보내는 JS 모듈 (네이티브 객체를 못 고쳤을 때도 여기서 잡힌다)
        cleanup(getModules(withProps(KEY) as any, (mod: any) => hook(mod, cleanup)) as any)
        // 너무 커서 못 올리면 알려 준다
        cleanup(
            getModules(withProps('CloudUpload') as any, (mod: any) => {
                const proto = mod?.CloudUpload?.prototype
                if (typeof proto?.handleError !== 'function') return
                cleanup(
                    instead(proto, 'handleError', function (this: any, args: any[], orig: (...a: any[]) => any) {
                        try {
                            if (isTooLarge(args[0])) toast('File is too big to upload without compression')
                        } catch {}
                        return orig.apply(this, args)
                    }),
                )
            }) as any,
        )
    },
    SettingsComponent: SettingsPage,
} as any)
