import { FileModule } from '@valenced/discord/native'
import { callNativeMethod } from '@valenced/modules/native'
import { exists, readFile, rm, writeFile } from '@valenced/modules/native/fs'
import * as Internal from '@valenced/plugins/_'
import * as Repos from '@valenced/plugins/_/repositories'
import { pluginStorageDirFor } from '@valenced/plugins/constants'
import { formatVersion } from '@valenced/plugins/utils'

export const SELF_ID = 'yumistra.plugin-backup'
const FORMAT = 2
const KIND = 'valenced-plugin-backup'
/** Revenge Next 판 Plugin Backup 으로 만든 백업도 읽는다 (Valenced 는 Revenge Next 의 이름만 바뀐 포크) */
const REVENGE_KIND = 'revenge-next-plugin-backup'
const THEMES_ID = 'valenced.api.themes'

/** Revenge 백업의 내장 플러그인 ID·경로를 Valenced 것으로 (revenge.api.themes → valenced.api.themes 등) */
const fromRevengeId = (id: string) => (id.startsWith('revenge.') ? `valenced.${id.slice('revenge.'.length)}` : id)
const fromRevengePath = (path: string) => {
    const i = path.indexOf('/')
    return i < 0 ? fromRevengeId(path) : `${fromRevengeId(path.slice(0, i))}${path.slice(i)}`
}
const renameKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [fromRevengePath(k), v]))

// 플러그인 하나의 설정 파일이 이보다 크면 백업하지 않는다
const MAX_TEXT_CHARS = 2_000_000
// 데이터 파일(폰트·이미지 등) 크기 제한. base64 글자 수 기준 (실제 크기의 약 4/3)
const MAX_FILE_CHARS = 16_000_000
const MAX_TOTAL_CHARS = 80_000_000
// 복사/공유할 때 파일까지 넣을 수 있는 최대 크기 (안드로이드 클립보드 한계 때문)
const MAX_EXPORT_CHARS = 700_000

/** 플러그인 저장소 폴더에서 설정으로 읽어 볼 파일 이름 (폴더 목록을 볼 수 없어서 흔한 이름만) */
const TEXT_FILES = ['state.json', 'settings.json', 'config.json', 'data.json']

export interface BackupPlugin {
    id: string
    name: string
    version: string
    enabled: boolean
    /** Valenced에 내장된 플러그인 (설치할 필요 없이 켜짐 상태만 복원) */
    internal: boolean
    /** 설치한 저장소. null이면 파일로 직접 설치한 플러그인 */
    source: { repo: string | null; channel: string; held: boolean } | null
}

export interface Backup {
    kind: typeof KIND
    format: number
    createdAt: number
    repos: Array<{ url: string; enabled: boolean }>
    plugins: BackupPlugin[]
    /** 플러그인 ID → storage.json 내용 */
    storage: Record<string, string>
    /** 백업할 때의 플러그인 저장소 루트 (다른 기기·슬롯이면 경로를 바꿔서 복원) */
    root?: string
    /** 저장소 루트 기준 경로 → 기타 설정 파일 내용 (예: valenced.api.themes/state.json) */
    data?: Record<string, string>
    /** 저장소 루트 기준 경로 → 크기(바이트). 실제 내용은 이 플러그인 폴더의 backups/<createdAt>/ 에 둔다 */
    files?: Record<string, number>
    /** 복사/공유한 백업에만 들어 있는 파일 내용 (base64). 가져올 때 풀어서 저장한다 */
    filesData?: Record<string, string>
}

export interface RestoreOptions {
    repos: boolean
    install: boolean
    storage: boolean
    files: boolean
    enabled: boolean
}

export interface RestoreResult {
    installed: string[]
    failed: Array<{ id: string; reason: string }>
    skipped: Array<{ id: string; reason: string }>
    storage: number
    files: number
    toggled: number
}

export const messageOf = (e: unknown) => String((e as any)?.message ?? e)

/** Valenced 내부 API 를 열어 주는 내장 플러그인 (Valenced 설정의 "Developer Mode". 켜면 바로 적용된다) */
export const DEV_MODE_NOTICE = 'Turn on "Developer Mode" in Settings → Valenced.'

function tryInternal(): any {
    try {
        const api: any = Internal
        // 저장소 API도 같이 확인
        if (api?.pList && typeof (Repos as any).listRepos === 'function') return api
    } catch {}
}

/** 백업·복원에 필요한 Valenced 내부 API 를 쓸 수 있는지 (Developer Mode 가 꺼져 있으면 없다) */
export const hasInternalApi = () => !!tryInternal()

/** Valenced 내부 API. 없으면 켜는 방법을 알려 주는 오류를 낸다 */
function internal(): any {
    const api = tryInternal()
    if (!api) throw new Error(DEV_MODE_NOTICE)
    return api
}

const storagePathOf = (id: string) => `${pluginStorageDirFor(id)}/storage.json`
/** 플러그인 저장소 루트 (모든 플러그인 폴더의 부모) */
const storageRoot = () => pluginStorageDirFor('x').slice(0, -2)
const sidecarDirOf = (b: Pick<Backup, 'createdAt'>) => `${pluginStorageDirFor(SELF_ID)}/backups/${b.createdAt}`

// ── 바이너리 파일 (Discord FileModule: base64 읽기/쓰기) ─────────────────

const fileModule = () => FileModule as any

/** /data/data/<pkg> 와 /data/user/0/<pkg> 는 같은 곳이라 둘 다 받아 준다 */
function aliasesOf(path: string) {
    const out = [path]
    const m = path.match(/^\/data\/(?:data|user\/\d+)\/(.*)$/)
    if (m) out.push(`/data/data/${m[1]}`, `/data/user/0/${m[1]}`)
    return [...new Set(out)]
}

/** 절대 경로 → Documents 폴더 기준 상대 경로 (FileModule.writeFile 용) */
function documentsRelative(path: string) {
    const docs: string = fileModule().getConstants().DocumentsDirPath.replace(/\/+$/, '')
    for (const d of aliasesOf(docs)) for (const p of aliasesOf(path)) if (p.startsWith(`${d}/`)) return p.slice(d.length + 1)
    throw new Error(`Path outside the documents folder: ${path}`)
}

async function readBinary(path: string): Promise<string> {
    return fileModule().readFile(path, 'base64')
}

async function writeBinary(path: string, base64: string) {
    await fileModule().writeFile('documents', documentsRelative(path), base64, 'base64')
}

const bytesOf = (base64: string) => Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)

/** 설정 JSON 안에서 저장소 루트 밑의 파일 경로를 모은다 (폰트, 배경 이미지, 아이콘 등) */
function collectPaths(text: string, roots: string[], out: Set<string>) {
    let json: unknown
    try {
        json = JSON.parse(text)
    } catch {
        return
    }
    const walk = (v: unknown, depth: number) => {
        if (depth > 32 || v == null) return
        if (typeof v === 'string') {
            const path = v.startsWith('file://') ? decodeURI(v.slice(7)) : v
            for (const r of roots) if (path.startsWith(`${r}/`)) out.add(path.slice(r.length + 1))
        } else if (Array.isArray(v)) {
            for (const x of v) walk(x, depth + 1)
        } else if (typeof v === 'object') {
            for (const k in v as object) {
                walk(k, depth + 1)
                walk((v as any)[k], depth + 1)
            }
        }
    }
    walk(json, 0)
}

async function readText(path: string): Promise<string | undefined> {
    try {
        if (!(await exists(path))) return
        const text = await readFile(path)
        if (typeof text === 'string' && text.length && text.length <= MAX_TEXT_CHARS) return text
    } catch {}
}

// ── 백업 만들기 ───────────────────────────────────────────────

/** 지금 상태를 백업으로 만든다. 데이터 파일은 이 플러그인 폴더에 따로 복사해 둔다 */
export async function createBackup(progress: (text: string) => void = () => {}): Promise<Backup> {
    const I = internal()
    const root = storageRoot()
    const roots = aliasesOf(root)
    const repos = ((await Repos.listRepos()) as any[]).filter(r => !r.internal).map(r => ({ url: r.url, enabled: !!r.enabled }))

    const plugins: BackupPlugin[] = []
    const storage: Record<string, string> = {}
    const data: Record<string, string> = {}
    const referenced = new Set<string>()

    for (const plugin of I.pList.values() as Iterable<any>) {
        const id: string = plugin.manifest.id
        if (id === SELF_ID) continue
        const meta = I.getInternalPluginMeta(plugin)
        const source = meta?.source
        plugins.push({
            id,
            name: plugin.manifest.name,
            version: formatVersion(plugin.manifest.version),
            enabled: !!I.isPluginEnabledInActiveSlot(plugin),
            internal: !!I.isPluginInternal(meta),
            source: source ? { repo: source.repo ?? null, channel: source.channel ?? 'latest', held: !!source.held } : null,
        })

        progress(`Reading ${plugin.manifest.name}`)
        const main = await readText(storagePathOf(id))
        if (main) {
            storage[id] = main
            collectPaths(main, roots, referenced)
        }
        for (const name of TEXT_FILES) {
            const text = await readText(`${pluginStorageDirFor(id)}/${name}`)
            if (!text) continue
            data[`${id}/${name}`] = text
            collectPaths(text, roots, referenced)
        }
    }

    const backup: Backup = { kind: KIND, format: FORMAT, createdAt: Date.now(), repos, plugins, storage, root, data, files: {} }

    // 설정이 가리키는 데이터 파일을 백업 폴더로 복사 (폴더를 가리키는 경로는 목록을 볼 수 없어 건너뜀)
    const sidecar = sidecarDirOf(backup)
    let total = 0
    let n = 0
    for (const rel of referenced) {
        n++
        if (rel.startsWith(`${SELF_ID}/`) || rel.split('/').includes('..')) continue
        progress(`Copying files (${n}/${referenced.size})`)
        try {
            const base64 = await readBinary(`${root}/${rel}`)
            if (typeof base64 !== 'string' || base64.length > MAX_FILE_CHARS || total + base64.length > MAX_TOTAL_CHARS) continue
            await writeBinary(`${sidecar}/${rel}`, base64)
            total += base64.length
            backup.files![rel] = bytesOf(base64)
        } catch {
            // 폴더이거나 지워진 파일
        }
    }

    plugins.sort((a, b) => a.name.localeCompare(b.name))
    progress('')
    return backup
}

// ── 가져오기 / 내보내기 ─────────────────────────────────────────

/** 붙여넣은 글/파일 내용을 백업으로 읽는다 */
export function parseBackup(text: string): Backup {
    let data: any
    try {
        data = JSON.parse(text.trim())
    } catch {
        throw new Error('Not a backup (JSON)')
    }
    const fromRevenge = data?.kind === REVENGE_KIND
    if ((data?.kind !== KIND && !fromRevenge) || !Array.isArray(data.plugins)) throw new Error('Not a Plugin Backup backup')
    if (data.format > FORMAT) throw new Error('Made with a newer Plugin Backup')
    const obj = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
    const rename = fromRevenge ? renameKeys : <T>(o: Record<string, T>) => o
    const filesData: Record<string, string> = rename(obj(data.filesData))
    const plugins = data.plugins.filter((p: any) => typeof p?.id === 'string')
    return {
        kind: KIND,
        format: data.format ?? FORMAT,
        createdAt: Number(data.createdAt) || Date.now(),
        repos: Array.isArray(data.repos) ? data.repos.filter((r: any) => typeof r?.url === 'string') : [],
        plugins: fromRevenge ? plugins.map((p: any) => ({ ...p, id: fromRevengeId(p.id) })) : plugins,
        storage: rename(obj(data.storage)),
        root: typeof data.root === 'string' ? data.root : undefined,
        data: rename(obj(data.data)),
        // 가져온 백업은 내용이 같이 온 파일만 쓸 수 있다
        files: Object.fromEntries(Object.keys(filesData).map(k => [k, bytesOf(String(filesData[k]))])),
        filesData,
    }
}

/** 가져온 백업에 들어 있던 파일 내용을 백업 폴더에 풀어 두고, 목록 저장용으로 내용은 뺀다 */
export async function storeImportedFiles(b: Backup): Promise<Backup> {
    const { filesData, ...rest } = b
    const files: Record<string, number> = {}
    for (const rel in filesData ?? {}) {
        if (rel.split('/').includes('..')) continue
        try {
            await writeBinary(`${sidecarDirOf(b)}/${rel}`, filesData![rel])
            files[rel] = bytesOf(filesData![rel])
        } catch {}
    }
    return { ...rest, files }
}

/** 복사/공유용 JSON. 파일이 작으면 내용까지 넣는다 */
export async function exportBackup(b: Backup): Promise<{ json: string; withFiles: boolean }> {
    const { filesData: _, ...base } = b
    const rels = Object.keys(b.files ?? {})
    if (!rels.length) return { json: JSON.stringify(base), withFiles: true }

    const size = rels.reduce((s, r) => s + (b.files![r] * 4) / 3, 0)
    if (size <= MAX_EXPORT_CHARS) {
        try {
            const filesData: Record<string, string> = {}
            for (const rel of rels) filesData[rel] = await readBinary(`${sidecarDirOf(b)}/${rel}`)
            return { json: JSON.stringify({ ...base, filesData }), withFiles: true }
        } catch {}
    }
    return { json: JSON.stringify({ ...base, files: {} }), withFiles: false }
}

/** 백업을 지울 때 복사해 둔 데이터 파일도 지운다 */
export async function deleteBackupFiles(b: Backup) {
    try {
        await rm(sidecarDirOf(b))
    } catch {}
}

const fileCountOf = (b: Backup) => Object.keys(b.files ?? {}).length
const fileBytesOf = (b: Backup) => Object.values(b.files ?? {}).reduce((s, n) => s + (Number(n) || 0), 0)

export function formatBytes(n: number) {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function summaryOf(b: Backup) {
    const installed = b.plugins.filter(p => !p.internal).length
    const settings = Object.keys(b.storage).length + Object.keys(b.data ?? {}).length
    const files = fileCountOf(b)
    return `${installed} plugins · ${b.repos.length} repos · ${settings} settings${files ? ` · ${files} files (${formatBytes(fileBytesOf(b))})` : ''}`
}

/** 플러그인 하나가 백업에 가진 데이터 개수 (설정 파일 + 데이터 파일) */
export function dataCountOf(b: Backup, id: string) {
    const prefix = `${id}/`
    const count = (o?: Record<string, unknown>) => Object.keys(o ?? {}).filter(k => k.startsWith(prefix)).length
    return { settings: (b.storage[id] ? 1 : 0) + count(b.data), files: count(b.files) }
}

// ── 복원 ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 백업한 기기·슬롯의 경로를 지금 경로로 바꾼다 */
function relocate(text: string, from: string | undefined, to: string) {
    if (!from || from === to) return text
    for (const old of aliasesOf(from)) if (old !== to) text = text.split(`${old}/`).join(`${to}/`)
    // Revenge 백업: 내장 플러그인 폴더 이름도 바뀌었다 (…/revenge.api.themes/… → …/valenced.api.themes/…)
    return text.split(`${to}/revenge.`).join(`${to}/valenced.`)
}

/** 테마 API는 상태를 메모리에 들고 있어서, 파일만 바꾸면 덮어써진다. 네이티브 쪽에도 알려 준다 */
async function applyThemesState(text: string) {
    let state: any
    try {
        state = JSON.parse(text)
    } catch {
        return
    }
    const parts = [
        ['valenced.themes.setColors', state.colors],
        ['valenced.themes.setFonts', state.fonts],
        ['valenced.themes.setIcons', state.icons],
        ['valenced.themes.setEmoji', state.emoji],
        ['valenced.themes.setBackground', state.background],
    ] as const
    for (const [method, value] of parts) {
        try {
            await (callNativeMethod as any)(method, [value ? JSON.stringify(value) : null])
        } catch {
            // 테마 API가 꺼져 있으면 파일만으로 충분 (다음 시작 때 읽음)
        }
    }
}

/** 백업을 되살린다. 끝나면 앱을 다시 불러와야 완전히 적용된다 */
export async function restoreBackup(b: Backup, opts: RestoreOptions, progress: (text: string) => void): Promise<RestoreResult> {
    const I = internal()
    const result: RestoreResult = { installed: [], failed: [], skipped: [], storage: 0, files: 0, toggled: 0 }
    const root = storageRoot()

    // 1. 저장소: 백업에 있던 걸 앞에, 지금 있는 것 중 백업에 없는 건 뒤에 그대로 둔다
    if (opts.repos && b.repos.length) {
        progress('Adding repositories…')
        const current = ((await Repos.listRepos()) as any[]).filter(r => !r.internal)
        const known = new Set(b.repos.map(r => r.url))
        await Repos.setRepos([...b.repos.map(r => ({ url: r.url, enabled: r.enabled })), ...current.filter(r => !known.has(r.url)).map(r => ({ url: r.url, enabled: !!r.enabled }))])
        for (const repo of b.repos) {
            if (!repo.enabled) continue
            progress(`Refreshing ${repo.url}`)
            try {
                await Repos.refreshRepo(repo.url)
            } catch (e) {
                result.failed.push({ id: repo.url, reason: `refresh failed: ${messageOf(e)}` })
            }
        }
    }

    // 2. 없는 플러그인 설치 (하나씩. 의존 플러그인은 Valenced가 같이 설치)
    if (opts.install) {
        for (const p of b.plugins) {
            if (p.internal || p.id === SELF_ID || I.pList.has(p.id)) continue
            const repo = p.source?.repo
            if (!repo) {
                result.skipped.push({ id: p.name, reason: 'installed from file' })
                continue
            }
            progress(`Installing ${p.name}`)
            const targets = [
                // 버전을 고정해 뒀던 건 그 버전으로, 아니면 쓰던 채널로
                p.source!.held ? { repo, version: p.version } : { repo, channel: p.source!.channel || 'latest' },
                { repo },
            ]
            let lastError: unknown
            for (const target of targets) {
                try {
                    const plan = await Repos.planInstall(p.id, { targets: { [p.id]: target } })
                    if (plan.actions.length) await Repos.installFromRepo(plan)
                    result.installed.push(p.name)
                    lastError = undefined
                    break
                } catch (e) {
                    lastError = e
                }
            }
            if (lastError) result.failed.push({ id: p.name, reason: messageOf(lastError) })
        }
        try {
            await I.resyncPluginSources?.()
        } catch {}
    }

    // 3. 데이터 파일 (폰트·배경 이미지 등). 설정이 이 파일들을 가리키므로 먼저 둔다
    if (opts.files) {
        const rels = Object.keys(b.files ?? {})
        let n = 0
        for (const rel of rels) {
            n++
            if (rel.startsWith(`${SELF_ID}/`) || rel.split('/').includes('..')) continue
            progress(`Restoring files (${n}/${rels.length})`)
            try {
                const base64 = b.filesData?.[rel] ?? (await readBinary(`${sidecarDirOf(b)}/${rel}`))
                await writeBinary(`${root}/${rel}`, base64)
                result.files++
            } catch (e) {
                result.failed.push({ id: rel, reason: `file restore failed: ${messageOf(e)}` })
            }
        }
    }

    // 4. 플러그인 설정 (storage.json, state.json 등). 다른 기기에서 만든 백업이면 경로를 고친다
    if (opts.storage) {
        const texts: Array<[string, string]> = [
            ...Object.entries(b.storage).map(([id, text]) => [`${id}/storage.json`, text] as [string, string]),
            ...Object.entries(b.data ?? {}),
        ]
        for (const [rel, raw] of texts) {
            if (rel.startsWith(`${SELF_ID}/`) || rel.split('/').includes('..') || typeof raw !== 'string') continue
            progress(`Restoring ${rel}`)
            const text = relocate(raw, b.root, root)
            try {
                await writeFile(`${root}/${rel}`, text)
                if (rel === `${THEMES_ID}/state.json`) await applyThemesState(text)
                result.storage++
            } catch (e) {
                result.failed.push({ id: rel, reason: `settings restore failed: ${messageOf(e)}` })
            }
        }
    }

    // 5. 켜짐/꺼짐 상태. 방금 설치한 플러그인은 등록될 때까지 잠깐 기다린다
    if (opts.enabled) {
        progress('Updating enabled state…')
        const wanted = b.plugins.filter(p => p.id !== SELF_ID)
        for (let i = 0; i < 25 && wanted.some(p => p.source?.repo && !I.pList.has(p.id) && result.installed.includes(p.name)); i++) await sleep(200)

        // 켜는 것 먼저 (의존 플러그인도 같이 켜짐), 끄는 건 나중에
        for (const want of [true, false]) {
            for (const p of wanted) {
                if (p.enabled !== want) continue
                const plugin = I.pList.get(p.id)
                if (!plugin) continue
                const now = !!I.isPluginEnabledInActiveSlot(plugin)
                if (now === want) continue
                try {
                    if (want) await I.enablePluginInActiveSlot(plugin, true)
                    else await I.disablePluginInActiveSlot(plugin)
                    result.toggled++
                } catch (e) {
                    result.failed.push({ id: p.name, reason: `${want ? 'enable' : 'disable'} failed: ${messageOf(e)}` })
                }
            }
        }
    }

    progress('')
    return result
}
