// 빌드된 플러그인을 Valenced 저장소 형식으로 묶는다.
//   dist/pool/<id>@<version>.zip  (manifest.json + index.js)
//   dist/index.json               (저장소 목록. Valenced에서 저장소 주소로 이 폴더를 추가)
// 사용법: node scripts/package.mjs [--base-url https://yumistra.github.io/Freestyle-Valenced]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import JSZip from 'jszip'

const { values } = parseArgs({ options: { 'base-url': { type: 'string' } } })
const baseUrl = (values['base-url'] || process.env.PAGES_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')
const config = existsSync('repo.config.json') ? JSON.parse(readFileSync('repo.config.json', 'utf8')) : {}

const VERSION = /^(\d+(?:\.\d+)*)(?:-([a-z0-9]+))?$/
const RESERVED = ['valenced.api', 'discord']

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist/pool', { recursive: true })

const plugins = {}
for (const name of readdirSync('plugins')) {
    const dir = `plugins/${name}`
    if (!existsSync(`${dir}/manifest.json`)) continue
    const raw = readFileSync(`${dir}/manifest.json`)
    const manifest = JSON.parse(raw.toString('utf8'))
    if (manifest.format !== 1) continue
    if (!/^[a-zA-Z0-9.-]+$/.test(manifest.id)) throw new Error(`${name}: 잘못된 id ${manifest.id}`)
    if (!VERSION.test(manifest.version)) throw new Error(`${name}: 잘못된 version ${manifest.version}`)
    for (const id of RESERVED) if (!(id in (manifest.dependencies ?? {}))) throw new Error(`${name}: dependencies에 ${id}가 필요합니다`)

    const zip = new JSZip()
    const date = new Date('2020-01-01T00:00:00Z')
    // 네이티브 부분 (scripts/build-native.sh 결과). 빌드에 실패했으면 JS 부분만 담는다
    let manifestBytes = raw
    const android = manifest.dist?.android
    if (android?.path) {
        const jar = `${dir}/build/plugin.jar`
        if (existsSync(jar)) {
            zip.file(android.path, readFileSync(jar), { date })
        } else {
            console.warn(`! ${name}: ${jar} 없음. 네이티브 빌드가 안 돼서 JS 부분만 담음`)
            const { android: _, ...dist } = manifest.dist
            manifestBytes = Buffer.from(`${JSON.stringify({ ...manifest, dist }, null, '\t')}\n`)
        }
    }
    zip.file('manifest.json', manifestBytes, { date })
    const script = manifest.dist?.script
    if (script) {
        const built = `${dir}/build/js/index.js`
        if (!existsSync(built)) throw new Error(`${name}: ${built} 없음. 먼저 npm run build`)
        zip.file(script, readFileSync(built), { date })
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    const file = `${manifest.id}@${manifest.version}.zip`
    writeFileSync(`dist/pool/${file}`, bytes)
    console.log(`✓ dist/pool/${file}`)

    plugins[manifest.id] = {
        name: manifest.name,
        description: manifest.description ?? '',
        author: manifest.author ?? '',
        ...(manifest.contributors?.length ? { contributors: manifest.contributors } : {}),
        ...(manifest.icon ? { icon: manifest.icon } : {}),
        channels: { [VERSION.exec(manifest.version)[2] ? 'beta' : 'latest']: manifest.version, ...(config.channels?.[manifest.id] ?? {}) },
        versions: {
            [manifest.version]: {
                url: `${baseUrl}/pool/${file}`,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                size: bytes.length,
                dependencies: Object.fromEntries(
                    Object.entries(manifest.dependencies ?? {}).map(([id, dep]) => [id, { version: dep.version, optional: dep.optional }]),
                ),
            },
        },
    }
}

const index = { format: 1, name: config.name ?? 'Plugin Repository', description: config.description ?? '', ...(config.icon ? { icon: config.icon } : {}), plugins }
writeFileSync('dist/index.json', `${JSON.stringify(index, null, 2)}\n`)
console.log(`✓ dist/index.json: 플러그인 ${Object.keys(plugins).length}개`)
