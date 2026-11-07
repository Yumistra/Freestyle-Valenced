import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { ToastActionCreators } from '@valenced/discord/actions'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod } from '@valenced/modules/native'
import { instead } from '@valenced/patcher'
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'

/**
 * Intelligent Compression
 *
 * 압축 판단과 처리는 전부 네이티브(Resolve.kt)가 디스코드의 MediaManagerModule.resolveToMediaFilePath 를 가로채서 한다.
 * (새 디스코드는 MediaManager 가 TurboModule 이라 JS 에서 바꿀 수 없다)
 * JS 는 지금 채널의 업로드 한도(계정·서버 부스트 중 큰 쪽)와 설정을 네이티브에 알려 주기만 한다.
 */

const NS = 'yumistra.intelligent-compression'
const MB = 1024 * 1024
const FREE_LIMIT = 10 * MB

type Codec = 'avc' | 'hevc' | 'discord'
interface Settings {
    images: boolean
    videos: boolean
    codec: Codec
}
const DEFAULTS: Settings = { images: true, videos: true, codec: 'avc' }
const CODECS: Array<[Codec, string, string]> = [
    ['avc', 'H.264 (recommended)', 'Plays everywhere. Tuned for quality: High profile, smart resolution and frame rate.'],
    ['hevc', 'H.265 / HEVC', 'Best quality for the size. Some older phones and PCs may not play it.'],
    ['discord', "Discord's encoder", 'Fastest, lowest quality.'],
]

let storage: any
const settings = (): Settings => ({ ...DEFAULTS, ...(storage?.cache ?? {}) })

const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)
const fmt = (b: number) => (b >= MB ? `${(b / MB).toFixed(b >= 100 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

let seq = 0
const toast = (text: string) => {
    try {
        ToastActionCreators.open(`intelligent-compression-${Date.now()}-${seq++}`, { text })
    } catch {}
}

/** 네이티브가 남긴 알림을 디스코드 토스트로 */
async function pullToasts() {
    try {
        const list = JSON.parse(String(unwrap(await (callNativeMethod as any)(`${NS}.toasts`, [])) ?? '[]'))
        if (Array.isArray(list)) for (const t of list) toast(String(t))
    } catch {}
}

/** 업로드 실패 이유를 짧게 */
function why(p: any) {
    const parts: string[] = []
    for (const k of ['reason', 'error', 'code', 'status', 'message']) {
        const v = p?.[k]
        if (v == null) continue
        parts.push(typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v))
    }
    if (!parts.length) {
        // 이유 필드가 없으면 받은 내용 전체 (ID 류는 빼고)
        try {
            const o: any = {}
            for (const k of Object.keys(p ?? {})) if (!/id$|Id$|^type$/.test(k)) o[k] = p[k]
            parts.push(JSON.stringify(o).slice(0, 200))
        } catch {}
    }
    return parts.join(', ').slice(0, 220)
}

// ── 업로드 한도 ───────────────────────────────────────────────────────────────
/** maxFileSize(guildId): 계정(니트로)과 서버 부스트 중 큰 쪽. getUserMaxFileSize(user): 계정만 */
const guildLimitFns: Array<(guildId?: string) => number> = []
const userLimitFns: Array<(user: any) => number> = []
/** getEffectiveUploadLimit(x) = max(기본 최소 한도, x). 디스코드 업로드 검사와 똑같이 맞추려고 */
const effectiveFns: Array<(v: number) => number> = []

function uploadLimit(): number {
    const s: any = Stores
    let guildId: string | undefined
    try {
        const ch = s.SelectedChannelStore?.getChannelId?.()
        guildId = ch ? s.ChannelStore?.getChannel?.(ch)?.guild_id ?? undefined : undefined
    } catch {}
    let best = 0
    for (const f of guildLimitFns) {
        try {
            const v = f(guildId)
            if (typeof v === 'number' && v > best) best = v
        } catch {}
    }
    if (!best) {
        for (const f of userLimitFns) {
            try {
                const v = f(s.UserStore?.getCurrentUser?.())
                if (typeof v === 'number' && v > best) best = v
            } catch {}
        }
    }
    // 디스코드 업로드 검사(getMaxFileSize)는 여기에 getEffectiveUploadLimit 을 한 번 더 씌운다 (기본 최소 한도)
    for (const f of effectiveFns) {
        try {
            const v = f(best)
            if (typeof v === 'number' && v > best) best = v
        } catch {}
    }
    return best > 0 ? best : FREE_LIMIT
}

/** 네이티브가 가로챈 곳 ("resolveToMediaFilePath, compressVideo") 또는 오류. 네이티브가 없으면 빈 문자열 */
let nativeStatus = ''
let lastUploadError = ''
/** 디스코드의 "압축 뒤 크기로만 검사" 스위치: 찾았는지, 몇 번 불렸는지 */
const flag = { found: false, calls: 0 }
let nativeError = ''

async function push() {
    const s = settings()
    try {
        nativeStatus = String(unwrap(await (callNativeMethod as any)(`${NS}.config`, [uploadLimit(), s.images, s.videos, s.codec])) ?? '')
        nativeError = ''
    } catch (e: any) {
        nativeError = String(e?.message ?? e)
    }
}

function SettingsPage({ api }: { api?: any }) {
    if (api?.jsonStorage) storage = api.jsonStorage
    storage?.use?.()
    const s = settings()
    const [, force] = useState(0)
    useEffect(() => {
        push().then(() => force(n => n + 1))
    }, [s.images, s.videos, s.codec])
    const { Stack, TableRowGroup, TableSwitchRow, TableRow, TableRadioGroup, TableRadioRow } = Design as any
    const set = (patch: Partial<Settings>) => storage?.set({ ...settings(), ...patch }, true)
    let limit = FREE_LIMIT
    try {
        limit = uploadLimit()
    } catch {}
    let diag: any = {}
    try {
        diag = JSON.parse(nativeStatus)
    } catch {}
    const ready = !nativeError && /resolveToMediaFilePath/.test(String(diag.hooked ?? '')) && !/not found|error/.test(String(diag.hooked ?? ''))
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Stack spacing={24}>
                <TableRowGroup title="Compress only when needed">
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="ImageIcon" />}
                        label="Images"
                        value={s.images}
                        onValueChange={(images: boolean) => set({ images })}
                    />
                    <TableSwitchRow
                        icon={<TableRowAssetIcon name="VideoIcon" />}
                        label="Videos"
                        value={s.videos}
                        onValueChange={(videos: boolean) => set({ videos })}
                    />
                </TableRowGroup>
                <TableRadioGroup title="Video encoder (when compressing)" defaultValue={s.codec} onChange={(codec: Codec) => set({ codec })}>
                    {CODECS.map(([value, label]) => (
                        <TableRadioRow key={value} label={label} value={value} />
                    ))}
                </TableRadioGroup>
                <TableRowGroup title="Upload limit">
                    <TableRow
                        label={`${fmt(limit)} here`}
                        subLabel={ready ? undefined : 'Not active yet, fully close and reopen Discord.'}
                    />
                </TableRowGroup>
                <TableRowGroup title="Diagnostics">
                    <TableRow
                        label={`Native: ${ready ? 'active' : 'not active'}, size check switch: ${flag.found ? `on (${flag.calls})` : 'not found'}`}
                        subLabel={`${diag.calls ?? 0} file(s) handled${diag.last ? `, last: ${diag.last}` : ''}${lastUploadError ? `, ${lastUploadError}` : ''}${nativeError ? `, ${nativeError}` : ''}`}
                    />
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}

export default plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start({ cleanup, jsonStorage }: any) {
        storage = jsonStorage
        cleanup(
            getModules(withProps('maxFileSize') as any, (mod: any) => {
                if (typeof mod?.maxFileSize === 'function') {
                    guildLimitFns.push(mod.maxFileSize.bind(mod))
                    push()
                }
            }) as any,
            getModules(withProps('getUserMaxFileSize') as any, (mod: any) => {
                if (typeof mod?.getUserMaxFileSize === 'function') {
                    userLimitFns.push(mod.getUserMaxFileSize.bind(mod))
                    push()
                }
            }) as any,
            getModules(withProps('getEffectiveUploadLimit') as any, (mod: any) => {
                if (typeof mod?.getEffectiveUploadLimit === 'function') {
                    effectiveFns.push(mod.getEffectiveUploadLimit.bind(mod))
                    push()
                }
            }) as any,
            () => {
                effectiveFns.length = 0
                guildLimitFns.length = 0
                userLimitFns.length = 0
            },
        )
        // 디스코드는 압축하기 전 원본 크기로도 한도를 검사해서 "크기 제한 초과" 창을 띄운다.
        // 디스코드 자체 실험 플래그(압축 뒤 크기로만 검사)를 켜서, 줄인 뒤의 크기로만 검사하게 한다
        cleanup(
            getModules(withProps('shouldCheckUploadSizeOnlyAfterCompression') as any, (mod: any) => {
                if (typeof mod?.shouldCheckUploadSizeOnlyAfterCompression !== 'function') return
                try {
                    const before = mod.shouldCheckUploadSizeOnlyAfterCompression
                    cleanup(
                        instead(mod, 'shouldCheckUploadSizeOnlyAfterCompression', () => {
                            flag.calls++
                            return settings().images || settings().videos
                        }),
                    )
                    if (mod.shouldCheckUploadSizeOnlyAfterCompression !== before) flag.found = true
                } catch {}
            }) as any,
        )
        // 채널을 옮길 때마다 (서버마다 한도가 다르다), 그리고 가끔씩
        const s: any = Stores
        const onChange = () => {
            push()
        }
        try {
            s.SelectedChannelStore?.addChangeListener?.(onChange)
            cleanup(() => s.SelectedChannelStore?.removeChangeListener?.(onChange))
        } catch {}
        const timer = setInterval(onChange, 15_000)
        cleanup(() => clearInterval(timer))
        // 압축 결과·거부·오류 알림 (네이티브 → 디스코드 토스트)
        const toastTimer = setInterval(pullToasts, 700)
        cleanup(() => clearInterval(toastTimer))
        // 첨부 업로드 오류 코드 (디스코드가 전송 실패로 넘기기 전에)
        const record = (where: string, a: any) => {
            try {
                const code = a?.code ?? a?.body?.code ?? a?.status
                const reason = a?.reason ?? a?.body?.message ?? a?.message
                // 설정의 Diagnostics 에만 남긴다 (토스트는 띄우지 않는다)
                lastUploadError = `${where}: code ${JSON.stringify(code)} ${reason == null ? '' : JSON.stringify(reason).slice(0, 600)}`.trim()
            } catch {}
        }
        cleanup(
            getModules(withProps('handleUploadMessageAttachmentsErrors') as any, (mod: any) => {
                if (typeof mod?.handleUploadMessageAttachmentsErrors !== 'function') return
                try {
                    cleanup(
                        instead(mod, 'handleUploadMessageAttachmentsErrors', function (this: any, args: any[], orig: (...a: any[]) => any) {
                            record('attachment', args[0])
                            return orig.apply(this, args)
                        }),
                    )
                } catch {}
            }) as any,
            getModules(withName('CloudUpload') as any, (cls: any) => patchUpload(cls?.prototype)) as any,
            getModules(withProps('CloudUpload') as any, (mod: any) => patchUpload(mod?.CloudUpload?.prototype)) as any,
        )
        function patchUpload(proto: any) {
            if (!proto || proto.__icPatched) return
            proto.__icPatched = true
            for (const name of ['handleError', '_handleError']) {
                if (typeof proto[name] !== 'function') continue
                try {
                    cleanup(
                        instead(proto, name, function (this: any, args: any[], orig: (...a: any[]) => any) {
                            try {
                                const a = args[0]
                                const info = `size ${this?.currentSize ?? '?'} pre ${this?.preCompressionSize ?? '?'} file ${String(this?.item?.file?.uri ?? this?.item?.uri ?? '').slice(-40)}`
                                record(`upload.${name}`, typeof a === 'object' ? { ...a, reason: `${JSON.stringify(a?.reason ?? a?.message ?? a)}, ${info}` } : { code: a, reason: info })
                            } catch {}
                            return orig.apply(this, args)
                        }),
                    )
                } catch {}
            }
        }
        cleanup(
            getModules(withProps('CloudUploadDisabled__') as any, (mod: any) => {
                const proto = mod?.CloudUpload?.prototype
                if (typeof proto?.handleError !== 'function') return
                try {
                    cleanup(
                        instead(proto, 'handleError', function (this: any, args: any[], orig: (...a: any[]) => any) {
                            record('upload', typeof args[0] === 'object' ? args[0] : { code: args[0] })
                            return orig.apply(this, args)
                        }),
                    )
                } catch {}
            }) as any,
        )
        // 업로드가 실패하면 이유를 보여 준다 (원인 찾기용)
        for (const type of ['UPLOAD_FAIL', 'UPLOAD_FAILED']) {
            try {
                cleanup(
                    onFluxEventDispatched(type as any, (p: any) => {
                        try {
                            const r = why(p)
                            lastUploadError = `${type}${r ? `: ${r}` : ''}`
                        } catch {}
                        return p
                    }) as any,
                )
            } catch {}
        }
        push()
    },
    SettingsComponent: SettingsPage,
} as any)
