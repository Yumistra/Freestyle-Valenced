// Valenced 플러그인 빌드
//
// plugins/<이름>/src/index.ts(x) → plugins/<이름>/build/js/index.js
//
// 공식 valenced-plugin CLI와 같은 결과를 낸다:
//  - @valenced/*, react, react-native 등의 import를 지우고, 쓰는 자리마다 `valenced.…` 속성 접근으로 바꾼다
//    (플러그인 스크립트가 처음 평가될 땐 React 등이 아직 없을 수 있어서, 실제로 쓰는 순간에 꺼내야 한다)
//  - Hermes가 eval로 못 읽는 문법(class, let/const, 화살표 함수 등)을 ES5로 낮춘다
//  - 결과는 `{ default: plugin({...}) }`를 돌려주는 식(expression) 하나. Valenced가 `return <스크립트>`로 평가한다
//
// 사용법: node scripts/build.mjs [플러그인 폴더 이름...]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import ts from 'typescript'

// ── import 경로 → valenced 전역 경로 ──────────────────────────────────────
// interop: namespace = 전역이 모듈 네임스페이스 / default = 전역 자체가 default export / cjs = 전역이 module.exports
const NAMESPACE = {
    '@valenced/assets': 'valenced.assets',
    '@valenced/components': 'valenced.components',
    '@valenced/discord/actions': 'valenced.discord.actions',
    '@valenced/discord/common/app-start-performance': 'valenced.discord.common.appStartPerformance',
    '@valenced/discord/common/constants': 'valenced.discord.common.constants',
    '@valenced/discord/common/flux': 'valenced.discord.common.flux',
    '@valenced/discord/common/import-tracker': 'valenced.discord.common.importTracker',
    '@valenced/discord/common/logger': 'valenced.discord.common.logger',
    '@valenced/discord/common/tokens': 'valenced.discord.common.tokens',
    '@valenced/discord/common/utils': 'valenced.discord.common.utils',
    '@valenced/discord/design': 'valenced.discord.design',
    '@valenced/discord/flux': 'valenced.discord.flux',
    '@valenced/discord/modules/main_tabs_v2': 'valenced.discord.modules.mainTabsV2',
    '@valenced/discord/modules/settings': 'valenced.discord.modules.settings',
    '@valenced/discord/modules/settings/renderer': 'valenced.discord.modules.settings.renderer',
    '@valenced/discord/native': 'valenced.discord.native',
    '@valenced/discord/utils/modules/finders': 'valenced.discord.utils.modules.finders',
    '@valenced/discord/utils/modules/metro/subscriptions': 'valenced.discord.utils.modules.metro.subscriptions',
    '@valenced/externals/browserify': 'valenced.externals.Browserify',
    '@valenced/externals/gorhom': 'valenced.externals.Gorhom',
    '@valenced/externals/react-native-clipboard': 'valenced.externals.ReactNativeClipboard',
    '@valenced/externals/react-native-community': 'valenced.externals.ReactNativeCommunity',
    '@valenced/externals/react-native-safe-area-context': 'valenced.externals.ReactNativeSafeAreaContext',
    '@valenced/externals/react-navigation': 'valenced.externals.ReactNavigation',
    '@valenced/externals/shopify': 'valenced.externals.Shopify',
    '@valenced/externals/zustand': 'valenced.externals.Zustand',
    '@valenced/json-storage': 'valenced.jsonStorage',
    '@valenced/modules/finders': 'valenced.modules.finders',
    '@valenced/modules/finders/filters': 'valenced.modules.finders.filters',
    '@valenced/modules/metro': 'valenced.modules.metro',
    '@valenced/modules/native': 'valenced.modules.native',
    '@valenced/modules/native/app': 'valenced.modules.native.app',
    '@valenced/modules/native/fs': 'valenced.modules.native.fs',
    '@valenced/patcher': 'valenced.patcher',
    '@valenced/plugins/constants': 'valenced.plugins.constants',
    '@valenced/plugins/utils': 'valenced.plugins.utils',
    '@valenced/react': 'valenced.react',
    '@valenced/react/jsx-runtime': 'valenced.react.jsxRuntime',
    '@valenced/react/native': 'valenced.react.native',
    '@valenced/utils/callback': 'valenced.utils.callback',
    '@valenced/utils/discord': 'valenced.utils.discord',
    '@valenced/utils/error': 'valenced.utils.error',
    '@valenced/utils/object': 'valenced.utils.object',
    '@valenced/utils/promise': 'valenced.utils.promise',
    '@valenced/utils/proxy': 'valenced.utils.proxy',
    '@valenced/utils/react': 'valenced.utils.react',
    '@valenced/utils/tree': 'valenced.utils.tree',
    // 숨김 API (valenced.hidden). Valenced 내부용이라 버전에 따라 바뀔 수 있다
    '@valenced/components/_': 'valenced.hidden.components',
    '@valenced/discord/_/modules/settings': 'valenced.hidden.discord.settings',
    '@valenced/plugins/_': 'valenced.hidden.plugins.internal',
    '@valenced/plugins/_/repositories': 'valenced.hidden.plugins.repositories',
}
const DEFAULT = {
    '@valenced/components/FormSwitch': 'valenced.components.FormSwitch',
    '@valenced/components/Page': 'valenced.components.Page',
    '@valenced/components/SearchInput': 'valenced.components.SearchInput',
    '@valenced/components/TableRowAssetIcon': 'valenced.components.TableRowAssetIcon',
}
const CJS = {
    react: 'valenced.react.React',
    'react-native': 'valenced.react.ReactNative',
    zustand: 'valenced.externals.Zustand.Zustand',
    'zustand/vanilla': 'valenced.externals.Zustand.ZustandVanilla',
    'zustand/react': 'valenced.externals.Zustand.ZustandReact',
    '@shopify/flash-list': 'valenced.externals.Shopify.FlashList',
    '@react-native-clipboard/clipboard': 'valenced.externals.ReactNativeClipboard.Clipboard',
    '@react-navigation/stack': 'valenced.externals.ReactNavigation.ReactNavigationStack',
    '@react-navigation/native': 'valenced.externals.ReactNavigation.ReactNavigationNative',
}

function targetOf(spec) {
    if (spec in NAMESPACE) return { global: NAMESPACE[spec], interop: 'namespace' }
    if (spec in DEFAULT) return { global: DEFAULT[spec], interop: 'default' }
    if (spec in CJS) return { global: CJS[spec], interop: 'cjs' }
    if (spec.startsWith('@valenced/') || spec === 'react/jsx-runtime') throw new Error(`알 수 없는 외부 모듈: ${spec}`)
    return null
}

// ── TS 변환: 외부 import를 valenced.* 접근으로 바꾸기 ─────────────────────
function externalImportsTransformer(checker) {
    return context => {
        const f = context.factory
        const access = path => {
            const [head, ...rest] = path.split('.')
            return rest.reduce((e, name) => f.createPropertyAccessExpression(e, name), f.createIdentifier(head))
        }
        return sourceFile => {
            const map = new Map() // import된 지역 심볼 → 전역 경로
            for (const st of sourceFile.statements) {
                if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
                const target = targetOf(st.moduleSpecifier.text)
                if (!target) continue
                const clause = st.importClause
                if (!clause || clause.isTypeOnly) continue
                const add = (nameNode, path) => {
                    const sym = checker.getSymbolAtLocation(nameNode)
                    if (sym) map.set(sym, path)
                }
                if (clause.name) add(clause.name, target.interop === 'namespace' ? `${target.global}.default` : target.global)
                const nb = clause.namedBindings
                if (nb && ts.isNamespaceImport(nb)) {
                    if (target.interop === 'default') throw new Error(`${st.moduleSpecifier.text}는 default로만 가져올 수 있습니다`)
                    add(nb.name, target.global)
                } else if (nb) {
                    for (const el of nb.elements) {
                        if (el.isTypeOnly) continue
                        const imported = (el.propertyName ?? el.name).text
                        if (target.interop === 'default' && imported !== 'default') throw new Error(`${st.moduleSpecifier.text}에서 ${imported}를 가져올 수 없습니다`)
                        add(el.name, target.interop === 'default' ? target.global : `${target.global}.${imported}`)
                    }
                }
            }

            const pathFor = id => {
                const sym = checker.getSymbolAtLocation(id)
                return sym ? map.get(sym) : undefined
            }

            const visit = node => {
                if (ts.isImportDeclaration(node)) return node
                if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return node
                if (ts.isShorthandPropertyAssignment(node)) {
                    const sym = checker.getShorthandAssignmentValueSymbol(node)
                    const path = sym && map.get(sym)
                    if (path) return f.createPropertyAssignment(node.name.text, access(path))
                    return node
                }
                if (ts.isIdentifier(node)) {
                    const parent = node.parent
                    // 선언 이름·속성 이름 자리는 건드리지 않는다
                    if (
                        parent &&
                        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                            (ts.isPropertyAssignment(parent) && parent.name === node) ||
                            (ts.isJsxAttribute(parent) && parent.name === node) ||
                            (ts.isBindingElement(parent) && parent.propertyName === node) ||
                            (ts.isMethodDeclaration(parent) && parent.name === node) ||
                            (ts.isPropertyDeclaration(parent) && parent.name === node) ||
                            (ts.isVariableDeclaration(parent) && parent.name === node) ||
                            (ts.isFunctionDeclaration(parent) && parent.name === node) ||
                            (ts.isClassDeclaration(parent) && parent.name === node) ||
                            (ts.isParameter(parent) && parent.name === node))
                    )
                        return node
                    const path = pathFor(node)
                    return path ? access(path) : node
                }
                return ts.visitEachChild(node, visit, context)
            }

            const out = ts.visitEachChild(sourceFile, visit, context)
            const statements = out.statements.filter(
                st => !(ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && targetOf(st.moduleSpecifier.text)),
            )
            return f.updateSourceFile(out, statements)
        }
    }
}

const ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.ts', 'js/index.tsx', 'js/index.ts', 'index.tsx', 'index.ts']

function listSources(dir) {
    const out = []
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) {
            if (ent.name !== 'build' && ent.name !== 'node_modules') out.push(...listSources(p))
        } else if (/\.tsx?$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p)
    }
    return out
}

async function buildPlugin(name) {
    const dir = resolve('plugins', name)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    if (manifest.format !== 1 || !manifest.dist?.script) return
    const entry = ENTRY_CANDIDATES.map(c => join(dir, c)).find(existsSync)
    if (!entry) throw new Error(`${name}: 진입 파일(src/index.ts 등)이 없습니다`)

    const srcRoot = dirname(entry)
    const files = listSources(srcRoot)
    const tmp = mkdtempSync(join(tmpdir(), `valenced-build-${name}-`))

    const options = {
        target: ts.ScriptTarget.ES5,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'valenced.react.React.createElement',
        jsxFragmentFactory: 'valenced.react.React.Fragment',
        downlevelIteration: true,
        ignoreDeprecations: '6.0',
        lib: ['lib.es2022.d.ts'],
        noLib: false,
        noResolve: true,
        isolatedModules: false,
        removeComments: true,
        rootDir: srcRoot,
        outDir: tmp,
        sourceMap: false,
        noEmitOnError: false,
        types: [],
        skipLibCheck: true,
    }
    const program = ts.createProgram(files, options)
    const emitted = program.emit(undefined, undefined, undefined, false, { before: [externalImportsTransformer(program.getTypeChecker())] })
    const errors = emitted.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error)
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, ts.createCompilerHost(options)))

    const jsEntry = join(tmp, relative(srcRoot, entry)).replace(/\.tsx?$/, '.js')
    const result = await esbuild.build({
        entryPoints: [jsEntry],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: '__valencedPlugin',
        platform: 'neutral',
        target: 'es5',
        minify: true,
        legalComments: 'none',
        charset: 'utf8',
        logLevel: 'silent',
        // 코드에서 __PLUGIN_VERSION__ 으로 자기 버전을 안다
        define: { __PLUGIN_VERSION__: JSON.stringify(String(manifest.version ?? '')) },
    })
    rmSync(tmp, { recursive: true, force: true })

    let code = result.outputFiles[0].text.trim()
    const prefix = 'var __valencedPlugin='
    if (!code.startsWith(prefix)) throw new Error(`${name}: 예상과 다른 번들 형식`)
    // `return <식>`으로 평가되므로 변수 선언을 떼고 식만 남긴다
    code = code.slice(prefix.length).replace(/;$/, '')
    for (const bad of [/\bclass\s+[A-Za-z_$]/, /=>/, /\b(let|const)\s/]) {
        if (bad.test(code)) throw new Error(`${name}: 낮추지 못한 문법이 남음 (${bad})`)
    }

    const outDir = join(dir, 'build', 'js')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'index.js'), `${code}\n`)
    console.log(`✓ ${manifest.id}: ${relative(process.cwd(), join(outDir, 'index.js'))} (${code.length} bytes)`)
}

const names = process.argv.slice(2)
for (const name of names.length ? names : readdirSync('plugins')) {
    if (!existsSync(join('plugins', name, 'manifest.json'))) continue
    try {
        await buildPlugin(name)
    } catch (e) {
        console.error(`✗ ${name}:`, e?.message ?? e)
        process.exitCode = 1
    }
}
