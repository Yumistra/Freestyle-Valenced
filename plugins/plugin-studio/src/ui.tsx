import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import {
    allVars,
    buildManifest,
    buildScript,
    bump,
    clone,
    fillDefaults,
    find,
    findIn,
    lines,
    N,
    newDoc,
    parseScript,
    problems,
    renameRefs,
    reseq,
    S,
    SHOW_FIELDS,
    stateDefs,
    summary,
    T,
    uniqueVar,
    varName,
    walk,
    type Doc,
    type Field,
    type Node,
} from './model'
import { RUNTIME_SRC } from './runtimeSource'

declare const valenced: any

const NS = 'yumistra.plugin-studio'
const unwrap = (r: any) => (r && typeof r === 'object' && 'result' in r ? r.result : r)
async function nat(m: string, args: any[]) {
    return unwrap(await (callNativeMethod as any)(`${NS}.${m}`, args))
}
let toastSeq = 0
function toast(text: string) {
    try {
        ToastActionCreators.open(`plugin-studio-${Date.now()}-${toastSeq++}`, { text })
    } catch {}
}
const D = () => Design as any
const BLURPLE = '#5865f2'
const MUTED = 'rgba(148,155,164,0.3)'

const ICONS = ['TrashIcon', 'PencilIcon', 'BellIcon', 'BellSlashIcon', 'ClockIcon', 'ClockXIcon', 'ChatIcon', 'ChatXIcon', 'SettingsIcon', 'UserIcon', 'GroupIcon', 'ImageIcon', 'VideoIcon', 'LinkIcon', 'CopyIcon', 'EyeIcon', 'EyeSlashIcon', 'LockIcon', 'StarIcon', 'HeartIcon', 'DownloadIcon', 'UploadIcon', 'RetryIcon', 'MagnifyingGlassIcon', 'FiltersHorizontalIcon', 'CircleInformationIcon', 'WarningIcon', 'PaintPaletteIcon', 'ServerIcon', 'TextIcon', 'MicrophoneIcon', 'GlobeEarthIcon', 'ShieldIcon', 'CheckmarkLargeIcon', 'XSmallIcon', 'PlusSmallIcon', 'PinIcon', 'BookmarkIcon', 'GiftIcon', 'NitroWheelIcon', 'FileIcon', 'FolderIcon', 'BugIcon', 'PaperIcon', 'SparklesIcon', 'RobotIcon', 'WrenchIcon', 'HashmarkIcon']

// ── 실행기 (만든 플러그인과 같은 것으로 미리보기를 그린다) ──
let maker: any
function make() {
    if (!maker) maker = new Function('return (' + RUNTIME_SRC + ')')()
    return maker
}

// ── 원래 설정 화면의 부품 이름 ──
const HOST_DESIGN = ['TableRow', 'TableSwitchRow', 'TableCheckboxRow', 'TableRadioRow', 'TableRadioGroup', 'TableRowGroup', 'Button', 'Text', 'TextInput', 'TextArea', 'TextField', 'Stack', 'Card', 'Slider', 'IconButton', 'ActionSheetRow', 'FormSwitch', 'SegmentedControl', 'TableRowIcon', 'TableRow.TrailingText', 'TableRow.Icon', 'TableRow.Arrow', 'ActionSheetRow.Group', 'ActionSheetRow.Icon']
const HOST_RN = ['View', 'ScrollView', 'Pressable', 'Text', 'Image', 'TouchableOpacity', 'TouchableHighlight', 'FlatList', 'SectionList', 'SafeAreaView', 'KeyboardAvoidingView', 'TextInput', 'Switch', 'ActivityIndicator']
let hostNames: Map<any, string> | null = null
function hosts() {
    if (hostNames) return hostNames
    const m = new Map<any, string>()
    for (const k of HOST_DESIGN) {
        try {
            let c: any = D()
            for (const part of k.split('.')) c = c?.[part]
            if (c) m.set(c, 'Design.' + k)
        } catch {}
    }
    for (const k of HOST_RN) {
        try {
            const c = (valenced.react.ReactNative as any)[k]
            if (c && !m.has(c)) m.set(c, 'RN.' + k)
        } catch {}
    }
    try {
        m.set(TableRowAssetIcon, 'components.TableRowAssetIcon')
    } catch {}
    hostNames = m
    return m
}
const short = (t: string) => String(t || '').replace(/^Design\./, '').replace(/^RN\./, '').replace(/^components\./, '')
const ROWISH = /^(TableRow|TableSwitchRow|TableCheckboxRow|TableRadioRow|ActionSheetRow)$/
const GROUPISH = /^(TableRowGroup|TableRadioGroup|ActionSheetRow\.Group)$/
const textOf = (v: any): string => (v == null || v === false || v === true ? '' : typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(textOf).join('') : v.props ? textOf(v.props.children) : '')
interface Part {
    path: string
    t: string
    vals: Record<string, string>
    plain: Record<string, boolean>
}
/** 바꿀 수 있는 글자 [속성, 이름표] */
function partFields(t: string): Array<[string, string]> {
    const s = short(t)
    if (ROWISH.test(s)) return [['label', '이름표'], ['subLabel', '설명']]
    if (GROUPISH.test(s)) return [['title', '제목'], ['description', '아래 설명']]
    if (s === 'Button') return [['text', '버튼 글자']]
    if (t === 'Design.Text' || t === 'RN.Text') return [['children', '글자']]
    if (/^(TextInput|TextArea|TextField)$/.test(s)) return [['label', '이름표'], ['placeholder', '안내 글자'], ['description', '도움말']]
    return []
}
function partOf(path: string, el: any): Part | null {
    const t = hosts().get(el.type)
    if (!t) return null
    const fields = partFields(t)
    if (!fields.length) return null
    const vals: Record<string, string> = {},
        plain: Record<string, boolean> = {}
    for (const [k] of fields) {
        const v = el.props?.[k]
        vals[k] = textOf(v)
        plain[k] = typeof v === 'string'
    }
    return { path, t, vals, plain }
}
const ovList = (v: any): any[] => (!v ? [] : Array.isArray(v) ? v : [v])
const ovMatch = (list: any, part: Part) => ovList(list).find(e => e.t === part.t && Object.entries(e.o || {}).every(([k, v]) => !part.plain[k] || part.vals[k] === v))

// ── 저장 ──
interface Project {
    doc: Doc
    updated: number
}
interface Store {
    projects: Record<string, Project>
}
function storeOf(api: any): Store {
    const c = api?.jsonStorage?.cache
    if (c && typeof c === 'object' && c.projects) return c
    return { projects: {} }
}
function writeStore(api: any, s: Store) {
    try {
        api.jsonStorage.set({ ...(api.jsonStorage.cache || {}), projects: s.projects }, true)
    } catch {}
}
/** 깔린 플러그인 읽기 (원래 코드, 디자인, 나머지 파일) */
async function readInstalled(dir: string) {
    const r = JSON.parse(String((await nat('read', [dir])) ?? '{}'))
    if (r.error) throw new Error(r.error)
    const manifest = JSON.parse(r.manifest)
    const script = String(r.script || '').trim()
    const { design, orig } = parseScript(script)
    return { manifest, scriptPath: r.scriptPath as string, script, design, orig: design ? orig : script.replace(/;\s*$/, ''), files: (r.files || {}) as Record<string, string> }
}

// ── 작은 부품 ──
function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress(): void; key?: string }) {
    const { Text } = D()
    return (
        <Pressable onPress={onPress} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', borderWidth: 1, borderColor: on ? BLURPLE : MUTED, backgroundColor: on ? 'rgba(88,101,242,0.25)' : 'transparent' }}>
            <Text variant="text-sm/medium" color="text-normal">
                {label}
            </Text>
        </Pressable>
    )
}
function Chips({ items, value, onPick }: { items: Array<[string, string]>; value: any; onPick(v: string): void }) {
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
            <View style={{ flexDirection: 'row', gap: 6 }}>
                {items.map(([v, l]) => (
                    <Chip key={v || '_'} label={l} on={v === value} onPress={() => onPick(v)} />
                ))}
            </View>
        </ScrollView>
    )
}
function Label({ children }: { children: any }) {
    const { Text } = D()
    return (
        <Text variant="text-sm/semibold" color="text-muted" style={{ marginBottom: 6 }}>
            {children}
        </Text>
    )
}
function Hint({ children }: { children: any }) {
    const { Text } = D()
    return (
        <Text variant="text-sm/normal" color="text-muted">
            {children}
        </Text>
    )
}
function Btn({ text, onPress, variant, disabled, grow }: { text: string; onPress(): void; variant?: string; disabled?: boolean; grow?: boolean; key?: string }) {
    const { Button } = D()
    return (
        <View style={grow ? { flex: 1 } : undefined}>
            <Button text={text} variant={variant || 'secondary'} size="sm" disabled={disabled} onPress={onPress} />
        </View>
    )
}
function Row({ children }: { children: any }) {
    return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>
}
function IconPick({ value, onPick }: { value: string; onPick(v: string): void }) {
    const { Text } = D()
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <Pressable onPress={() => onPick('')} style={{ height: 40, paddingHorizontal: 10, borderRadius: 10, justifyContent: 'center', borderWidth: 1, borderColor: !value ? BLURPLE : MUTED }}>
                    <Text variant="text-xs/semibold" color="text-muted">
                        없음
                    </Text>
                </Pressable>
                {ICONS.map(k => (
                    <Pressable key={k} onPress={() => onPick(k)} style={{ width: 44, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: k === value ? BLURPLE : MUTED }}>
                        <TableRowAssetIcon name={k as any} />
                    </Pressable>
                ))}
            </View>
        </ScrollView>
    )
}

/** 글자 칸. 입력 중에는 자체 상태로 들고 있다가 바로 알린다 (부모가 다시 그려도 커서가 튀지 않게) */
function TextBox({ label, value, onChange, onDone, multiline, placeholder }: { label: string; value: string; onChange(v: string): void; onDone?(): void; multiline?: boolean; placeholder?: string }) {
    const { TextInput, TextArea } = D()
    const [v, setV] = useState(value)
    const last = useRef(value)
    if (value !== last.current) {
        last.current = value
        if (value !== v) setV(value)
    }
    const C = multiline && TextArea ? TextArea : TextInput
    return (
        <C
            label={label}
            value={v}
            placeholder={placeholder}
            onChange={(x: string) => {
                setV(x)
                last.current = x
                onChange(x)
            }}
            onBlur={onDone}
        />
    )
}

// ── 편집기 ──
type Tab = 'add' | 'layers' | 'edit' | 'plugin'

function Editor({ pid, project, api, onSave, onClose, onDelete }: { pid: string; project: Project; api: any; onSave(doc: Doc): void; onClose(): void; onDelete(): void; key?: string }) {
    const { Text, Stack, TableRowGroup, TableSwitchRow } = D()
    const [doc, setDocState] = useState<Doc>(() => {
        const d = JSON.parse(JSON.stringify(project.doc))
        reseq(d)
        return d
    })
    const [cur, setCur] = useState<string>(project.doc.start)
    const [sel, setSel] = useState<string | null>(null)
    const [osel, setOsel] = useState<string | null>(null)
    const [tab, setTab] = useState<Tab>('add')
    const [reset, setReset] = useState(0)
    const [, tick] = useState(0)
    const past = useRef<string[]>([])
    const [clip, setClip] = useState<string | null>(null)
    const [saved, setSaved] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    // 원래 플러그인 (깔린 플러그인을 바탕으로 할 때)
    const [base, setBase] = useState<null | Awaited<ReturnType<typeof readInstalled>>>(null)
    const [Orig, setOrig] = useState<any>(null)
    const [baseErr, setBaseErr] = useState<string | null>(null)
    const parts = useRef(new Map<string, Part>())
    const partSig = useRef('')
    const [partList, setPartList] = useState<Part[]>([])

    useEffect(() => {
        if (!doc.base?.dir) return
        let gone = false
        readInstalled(doc.base.dir)
            .then(b => {
                if (gone) return
                setBase(b)
                try {
                    const mod = new Function('valenced', 'plugin', 'return ' + b.orig)(valenced, (o: any) => o)
                    const C = mod?.default?.SettingsComponent
                    if (typeof C === 'function') setOrig(() => C)
                } catch (e: any) {
                    setBaseErr(String(e?.message ?? e))
                }
            })
            .catch(e => !gone && setBaseErr(String(e?.message ?? e)))
        return () => {
            gone = true
        }
    }, [doc.base?.dir])

    // 원래 화면 부품 목록은 미리보기가 그릴 때 모으고, 바뀌었을 때만 다시 보여 준다
    useEffect(() => {
        if (!doc.base) return
        const t = setInterval(() => {
            const list = [...parts.current.values()].sort((a, b) => cmpPath(a.path, b.path))
            const sig = list.map(p => p.path + p.t + JSON.stringify(p.vals)).join('|')
            if (sig !== partSig.current) {
                partSig.current = sig
                setPartList(list)
            }
        }, 600)
        return () => clearInterval(t)
    }, [!!doc.base])

    const setDoc = (next: Doc, keepHistory = false) => {
        if (!keepHistory) {
            past.current.push(JSON.stringify(doc))
            if (past.current.length > 60) past.current.shift()
        }
        setDocState(next)
        onSave(next)
    }
    /** 고치기: 복사본을 바꾸고 저장 */
    const edit = (f: (d: Doc) => void) => {
        const d: Doc = JSON.parse(JSON.stringify(doc))
        f(d)
        setDoc(d)
    }
    const undo = () => {
        const p = past.current.pop()
        if (!p) return
        const d = JSON.parse(p)
        setDocState(d)
        onSave(d)
        if (!d.screens.some((s: Node) => s.props.name === cur)) setCur(d.start)
    }
    const screen = (d: Doc = doc) => d.screens.find(s => s.props.name === cur) || d.screens[0]

    // 미리보기 데이터 (한 객체를 고쳐 가며 쓴다)
    const P = useRef<any>({}).current
    P.screens = doc.screens
    P.start = cur
    P.states = stateDefs(doc)
    P.base = doc.base
    P.expandAll = !!doc.base
    P.isHost = (t: any) => hosts().has(t)
    P.onEl = doc.base
        ? (path: string, el: any) => {
              if (path === '') parts.current.clear()
              const p = partOf(path, el)
              if (p) parts.current.set(path, p)
          }
        : undefined
    P.onExp = (path: string, name: string) => {
        if (!name || !doc.base) return
        const snap = (doc.base.snap ||= {})
        const exp = (snap.exp ||= {})
        if (!exp[path] || typeof exp[path] !== 'object') exp[path] = {}
        exp[path][name] = 1
    }
    const Preview = useMemo(() => {
        try {
            return make()(valenced, P, Orig, false)
        } catch {
            return null
        }
    }, [Orig])
    const defsKey = JSON.stringify(P.states.map(s => [s.name, s.def]))
    const memApi = useMemo(() => {
        const mem: any = { cache: {}, get: async () => mem.cache, set: (v: any) => (mem.cache = v), update() {}, delete() {} }
        return { ...(api || {}), jsonStorage: mem }
    }, [reset])

    const selR = sel ? find(doc, sel) : null
    const addPart = (type: string) =>
        edit(d => {
            const n = N(type)
            if (T[type].st) n.props.id = uniqueVar(d, T[type].base!)
            const s = screen(d)
            const r = sel ? findIn(sel, s, null) : null
            if (!r) s.children!.push(n)
            else if (T[r.node.type].box) r.node.children!.push(n)
            else r.parent!.children!.splice(r.index + 1, 0, n)
            setSel(n.id)
            setOsel(null)
            setTab('edit')
            toast(`${T[type].name} 추가함`)
        })
    const act = (kind: string) =>
        edit(d => {
            const r = sel ? find(d, sel) : null
            if (!r || !r.parent) return
            const sib = r.parent.children!,
                i = r.index
            if (kind === 'up' && i > 0) [sib[i - 1], sib[i]] = [sib[i], sib[i - 1]]
            else if (kind === 'down' && i < sib.length - 1) [sib[i + 1], sib[i]] = [sib[i], sib[i + 1]]
            else if (kind === 'dup') {
                const c = clone(d, r.node)
                sib.splice(i + 1, 0, c)
                setSel(c.id)
            } else if (kind === 'del') {
                sib.splice(i, 1)
                setSel(null)
            } else if (kind === 'into') {
                const prev = sib[i - 1]
                if (prev && T[prev.type].box) {
                    sib.splice(i, 1)
                    prev.children!.push(r.node)
                } else toast('바로 위에 묶음, 스택, 카드나 박스가 있어야 해요')
            } else if (kind === 'out') {
                const g = find(d, r.parent.id)
                if (g && g.parent) {
                    sib.splice(i, 1)
                    g.parent.children!.splice(g.index + 1, 0, r.node)
                } else toast('이미 가장 바깥이에요')
            } else if (kind === 'copy') {
                setClip(JSON.stringify(r.node))
                toast('복사함')
            } else if (kind === 'paste' && clip) {
                const c = clone(d, JSON.parse(clip))
                if (T[r.node.type].box) r.node.children!.push(c)
                else sib.splice(i + 1, 0, c)
                setSel(c.id)
            }
        })

    // ── 저장 (zip) ──
    const saveZip = async () => {
        const probs = problems(doc)
        if (probs.length) return toast(probs[0])
        setBusy(true)
        try {
            let b = base
            if (doc.base?.dir) b = await readInstalled(doc.base.dir)
            if (doc.base && !b?.orig) throw new Error(`${doc.base.name}의 원래 코드를 못 읽었어요`)
            const manifest = buildManifest(doc, doc.base ? b!.manifest : null, doc.base ? b!.scriptPath : undefined)
            const entries: any[] = [
                { path: 'manifest.json', text: JSON.stringify(manifest, null, '\t') + '\n' },
                { path: manifest.dist.script, text: buildScript(doc, RUNTIME_SRC, doc.base ? b!.orig : null) },
            ]
            if (doc.base && b) for (const [path, b64] of Object.entries(b.files)) entries.push({ path, b64 })
            const name = `${doc.plugin.name} ${doc.plugin.version} (Valenced).zip`.replace(/[\\/:*?"<>|]/g, '_')
            const r = JSON.parse(String((await nat('save', [name, JSON.stringify(entries)])) ?? '{}'))
            if (r.error) throw new Error(r.error)
            setSaved(r.where)
            toast(`${r.where}에 저장함`)
        } catch (e: any) {
            toast(`저장 못 함: ${e?.message ?? e}`)
        } finally {
            setBusy(false)
        }
    }
    const install = async () => {
        try {
            await (callNativeMethod as any)('valenced.plugins.installFile', [])
        } catch (e: any) {
            toast(`설치 창을 못 열었어요: ${e?.message ?? e}`)
        }
    }

    // ── 칸 ──
    const fieldView = (n: Node, f: Field, apply: (k: string, v: any, done?: boolean) => void) => {
        const p = n.props,
            v = p[f.k]
        if (f.when && !f.when(p)) return null
        const key = n.id + f.k + (f.l || '')
        switch (f.t) {
            case 'text':
            case 'var':
            case 'color':
                return (
                    <View key={key}>
                        <TextBox label={f.l} value={String(v ?? '')} onChange={x => apply(f.k, f.t === 'var' ? varName(x) : x)} onDone={() => apply(f.k, p[f.k], true)} />
                    </View>
                )
            case 'lines':
            case 'code':
                return (
                    <View key={key}>
                        <TextBox label={f.l} multiline value={String(v ?? '')} onChange={x => apply(f.k, x)} onDone={() => apply(f.k, p[f.k], true)} placeholder={f.t === 'code' ? "toast('안녕 ' + state.text)" : undefined} />
                        {f.t === 'code' ? <Hint>state, set(이름, 값), go(화면), back(), toast(글자), api, valenced 를 쓸 수 있어요. var 와 function 으로 쓰세요.</Hint> : null}
                    </View>
                )
            case 'num':
                return (
                    <View key={key}>
                        <TextBox label={f.l} value={String(v ?? 0)} onChange={x => apply(f.k, x === '' || isNaN(+x) ? 0 : +x)} />
                    </View>
                )
            case 'bool':
                return (
                    <TableRowGroup key={key}>
                        <TableSwitchRow label={f.l} value={!!v} onValueChange={(x: boolean) => apply(f.k, x, true)} />
                    </TableRowGroup>
                )
            case 'sel': {
                const o = (typeof f.o === 'function' ? f.o(doc) : f.o || []).map(x => (Array.isArray(x) ? x : [x, x])) as Array<[string, string]>
                return (
                    <View key={key}>
                        <Label>{f.l}</Label>
                        <Chips items={o} value={v} onPick={x => apply(f.k, x, true)} />
                    </View>
                )
            }
            case 'icon':
                return (
                    <View key={key}>
                        <Label>{`${f.l}${v ? `, ${v}` : ''}`}</Label>
                        <IconPick value={v} onPick={x => apply(f.k, x, true)} />
                    </View>
                )
        }
        return null
    }
    const editStart = useRef<Record<string, any>>({})
    const applyTo = (id: string | null) => {
        return (k: string, v: any, done?: boolean) => {
            const d: Doc = JSON.parse(JSON.stringify(doc))
            const n = id ? find(d, id)?.node : screen(d)
            if (!n) return
            const before = n.props[k]
            const sk = (id || 'screen:' + cur) + '/' + k
            if (!(sk in editStart.current)) editStart.current[sk] = before
            const pendingFrom = editStart.current[sk]
            if (k === 'id' && T[n.type].st && done) {
                const taken = allVars(d)
                taken.delete(before)
                if (taken.has(v)) v = uniqueVar(d, v, taken)
            }
            if (k === 'name' && n.type === 'screen' && done) {
                const taken = new Set(d.screens.filter(s => s !== n).map(s => s.props.name))
                if (taken.has(v)) v = uniqueVar(d, v, taken)
            }
            n.props[k] = v
            if (done) {
                fillDefaults(d, n, k, cur)
                if (k === 'id' && T[n.type].st) renameRefs(d, 'state', pendingFrom, v)
                if (k === 'name' && n.type === 'screen') {
                    renameRefs(d, 'screen', pendingFrom, v)
                    if (cur === pendingFrom) setCur(v)
                }
                delete editStart.current[sk]
            }
            setDoc(d, before !== pendingFrom && !done)
        }
    }

    // ── 탭 ──
    const tabAdd = () => {
        const cats: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(T)) if (v.cat && (k !== 'original' || doc.base)) (cats[v.cat] ||= []).push(k)
        const where = selR ? (T[selR.node.type].box ? `${summary(selR.node)} 안에` : `${summary(selR.node)} 뒤에`) : `${screen().props.title} 맨 끝에`
        return (
            <Stack spacing={14}>
                <Hint>{`누르면 ${where} 추가돼요. 구조 탭에서 항목을 고르면 그 안이나 뒤에 들어가요.`}</Hint>
                {Object.entries(cats).map(([c, ks]) => (
                    <View key={c}>
                        <Label>{c}</Label>
                        <Row>
                            {ks.map(k => (
                                <Btn key={k} text={T[k].name} onPress={() => addPart(k)} />
                            ))}
                        </Row>
                    </View>
                ))}
            </Stack>
        )
    }
    const actionsBar = () =>
        selR && selR.parent ? (
            <Row>
                <Btn text="위로" onPress={() => act('up')} disabled={selR.index === 0} />
                <Btn text="아래로" onPress={() => act('down')} disabled={selR.index === selR.parent.children!.length - 1} />
                <Btn text="위 항목 안으로" onPress={() => act('into')} />
                <Btn text="밖으로" onPress={() => act('out')} disabled={selR.parent.type === 'screen'} />
                <Btn text="복제" onPress={() => act('dup')} />
                <Btn text="복사" onPress={() => act('copy')} />
                <Btn text="붙여넣기" onPress={() => act('paste')} disabled={!clip} />
                <Btn text="삭제" variant="destructive" onPress={() => act('del')} />
            </Row>
        ) : null
    const tabLayers = () => {
        const rows: any[] = []
        const rec = (n: Node, depth: number) => {
            const isScreen = n.type === 'screen'
            const on = isScreen ? !sel : sel === n.id && osel == null
            rows.push(
                <Pressable
                    key={n.id}
                    onPress={() => {
                        setSel(isScreen ? null : n.id)
                        setOsel(null)
                    }}
                    style={{ paddingVertical: 10, paddingLeft: 10 + depth * 16, paddingRight: 10, borderRadius: 10, borderWidth: 1, borderColor: on ? BLURPLE : 'transparent', backgroundColor: on ? 'rgba(88,101,242,0.18)' : 'transparent' }}
                >
                    <Text variant="text-md/medium" color="text-normal">
                        {isScreen ? `${n.props.title} (화면)` : summary(n)}
                    </Text>
                    <Text variant="text-xs/medium" color="text-muted">
                        {[T[n.type].name, n.props.showIf ? `조건: ${n.props.showIf}` : '', T[n.type].act && n.props.act !== 'none' ? (n.props.act === 'go' ? `→ ${n.props.actScreen}` : n.props.act) : ''].filter(Boolean).join(', ')}
                    </Text>
                </Pressable>,
            )
            if (n.type === 'original') {
                for (const part of partList) {
                    const o = ovMatch(n.props.ov?.[part.path], part)
                    const d = part.path.split('.').length - 1
                    rows.push(
                        <Pressable
                            key={n.id + part.path}
                            onPress={() => {
                                setSel(n.id)
                                setOsel(part.path)
                                setTab('edit')
                            }}
                            style={{ paddingVertical: 8, paddingLeft: 10 + (depth + 1 + Math.min(d, 4)) * 12, paddingRight: 10, borderRadius: 10, borderWidth: 1, borderColor: sel === n.id && osel === part.path ? BLURPLE : 'transparent', opacity: o?.hide ? 0.45 : 1 }}
                        >
                            <Text variant="text-sm/medium" color="text-normal">
                                {(o?.set && Object.values(o.set)[0]) || Object.values(part.vals).find(Boolean) || short(part.t)}
                            </Text>
                            <Text variant="text-xs/medium" color="text-muted">
                                {[short(part.t), o?.hide ? '숨김' : '', o && Object.keys(o.set || {}).length ? '바꿈' : ''].filter(Boolean).join(', ')}
                            </Text>
                        </Pressable>,
                    )
                }
            }
            for (const c of n.children || []) rec(c, depth + 1)
        }
        rec(screen(), 0)
        return (
            <Stack spacing={10}>
                {actionsBar() || <Hint>항목을 고르면 옮기거나 복사, 삭제할 수 있어요. 원래 설정 화면 안 항목을 고르면 글자를 바꾸거나 숨길 수 있어요.</Hint>}
                <View>{rows}</View>
            </Stack>
        )
    }
    const tabEditOriginal = (n: Node, part: Part) => {
        const fields = partFields(part.t)
        const all = n.props.ov || {}
        const cur0 = ovMatch(all[part.path], part)
        const save = (set: Record<string, string>, hide: boolean) =>
            edit(d => {
                const node = find(d, n.id)!.node
                const ov = (node.props.ov = { ...(node.props.ov || {}) })
                const o: Record<string, string> = {}
                for (const [k] of fields) if (part.plain[k]) o[k] = part.vals[k]
                const old = ovMatch(ov[part.path], part)
                const list = ovList(ov[part.path]).filter(e => e !== old)
                if (Object.keys(set).length || hide) list.push({ t: part.t, o, set, hide })
                if (list.length) ov[part.path] = list
                else delete ov[part.path]
            })
        const setOf = () => ({ ...(cur0?.set || {}) })
        return (
            <Stack spacing={12}>
                <Text variant="heading-md/semibold" color="header-primary">
                    {`${short(part.t)}, 원래 설정 화면 안`}
                </Text>
                <Hint>플러그인 원래 코드가 그리는 부분이에요. 글자를 바꾸거나 숨길 수 있고, 누르면 하는 일은 원래대로예요.</Hint>
                {fields.map(([k, l]) => (
                    <View key={part.path + k}>
                        <TextBox
                            label={l}
                            value={cur0?.set?.[k] ?? part.vals[k] ?? ''}
                            onChange={x => {
                                const s = setOf()
                                if (x === (part.vals[k] ?? '')) delete s[k]
                                else s[k] = x
                                save(s, !!cur0?.hide)
                            }}
                        />
                        <Hint>{`원래: ${part.vals[k] || '(없음)'}`}</Hint>
                    </View>
                ))}
                <TableRowGroup>
                    <TableSwitchRow label="이 부분 숨기기" value={!!cur0?.hide} onValueChange={(x: boolean) => save(setOf(), x)} />
                </TableRowGroup>
                {Object.values(part.plain).some(x => !x) || /\d/.test(Object.values(part.vals).join('')) ? <Hint>숫자처럼 상황에 따라 바뀌는 글자는, 글자가 지금과 달라지면 바꾼 게 적용되지 않아요.</Hint> : null}
                {cur0 ? <Btn text="원래대로" onPress={() => save({}, false)} /> : null}
            </Stack>
        )
    }
    const tabEdit = () => {
        if (selR && selR.node.type === 'original' && osel != null) {
            const part = partList.find(p => p.path === osel)
            if (part) return tabEditOriginal(selR.node, part)
        }
        const n = selR ? selR.node : screen()
        const def = T[n.type]
        const apply = applyTo(selR ? n.id : null)
        return (
            <Stack spacing={12}>
                {actionsBar()}
                <Text variant="heading-md/semibold" color="header-primary">
                    {selR ? def.name : `${n.props.title} (화면 설정)`}
                </Text>
                {!selR ? <Hint>고른 항목이 없어서 이 화면 설정이 나와요. 구조 탭에서 항목을 고르세요.</Hint> : null}
                {def.fields.map(f => fieldView(n, f, apply))}
                {selR && n.type === 'original' ? <Hint>구조 탭에서 원래 설정 화면 안 항목을 고르면 글자를 바꿀 수 있어요.</Hint> : null}
                {selR ? (
                    <>
                        <Label>보이는 조건</Label>
                        {SHOW_FIELDS.map(f => fieldView(n, f, apply))}
                    </>
                ) : (
                    <Row>
                        <Btn
                            text="첫 화면으로 만들기"
                            disabled={n.props.name === doc.start}
                            onPress={() =>
                                edit(d => {
                                    d.start = n.props.name
                                })
                            }
                        />
                        <Btn
                            text="화면 삭제"
                            variant="destructive"
                            disabled={doc.screens.length < 2}
                            onPress={() =>
                                edit(d => {
                                    d.screens = d.screens.filter(s => s.props.name !== n.props.name)
                                    if (d.start === n.props.name) d.start = d.screens[0].props.name
                                    setCur(d.start)
                                })
                            }
                        />
                    </Row>
                )}
            </Stack>
        )
    }
    const tabPlugin = () => {
        const p = doc.plugin
        const setP = (k: string, v: string) =>
            edit(d => {
                ;(d.plugin as any)[k] = v
            })
        const probs = problems(doc)
        return (
            <Stack spacing={12}>
                {doc.base ? <Hint>{`${doc.base.name} 기반이에요. 원래 코드와 파일은 그대로 들어가고, 설정 화면만 여기서 만든 화면으로 바뀌어요.${baseErr ? ` (원래 화면을 못 불러왔어요: ${baseErr})` : ''}`}</Hint> : null}
                <TextBox label="이름" value={p.name} onChange={x => setP('name', x)} />
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                    <View style={{ flex: 1 }}>
                        <TextBox label="버전" value={p.version} onChange={x => setP('version', x)} />
                    </View>
                    <Btn text="+1" onPress={() => setP('version', bump(p.version))} />
                </View>
                <Hint>플러그인을 바꾸면 올려 주세요. 그래야 Valenced가 업데이트로 알아봐요.</Hint>
                <TextBox label="ID" value={p.id} onChange={x => setP('id', x)} />
                <Hint>ID가 같으면 깔려 있는 플러그인이 업데이트되고, 다르면 따로 하나 더 깔려요.</Hint>
                <TextBox label="만든 사람" value={p.author} onChange={x => setP('author', x)} />
                <TextBox label="설명" multiline value={p.description} onChange={x => setP('description', x)} />
                <View>
                    <Label>{`아이콘${p.icon ? `, ${p.icon}` : ''}`}</Label>
                    <IconPick value={p.icon} onPick={x => setP('icon', x)} />
                </View>
                {probs.length ? <Hint>{probs[0]}</Hint> : null}
                <Btn text={busy ? '저장 중…' : '다운로드에 zip 저장'} variant="primary" disabled={busy || !!probs.length} onPress={saveZip} />
                {saved ? (
                    <>
                        <Hint>{`${saved}에 저장했어요. 아래 버튼을 누르고 그 파일을 고르면 설치돼요.`}</Hint>
                        <Btn text="Valenced로 설치하기" variant="primary" onPress={install} />
                    </>
                ) : null}
                <Btn text="이 작업 삭제" variant="destructive" onPress={onDelete} />
            </Stack>
        )
    }

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 64 }} keyboardShouldPersistTaps="handled">
            <Stack spacing={14}>
                <Row>
                    <Btn text="← 목록" onPress={onClose} />
                    <Btn text="되돌리기" onPress={undo} disabled={!past.current.length} />
                    <Btn text="처음부터" onPress={() => setReset(r => r + 1)} />
                </Row>
                <Text variant="heading-lg/bold" color="header-primary">
                    {doc.plugin.name}
                </Text>
                <Chips
                    items={[...doc.screens.map((s): [string, string] => [s.props.name, `${s.props.name === doc.start ? '시작, ' : ''}${s.props.title || s.props.name}`]), ['__add', '+ 화면']]}
                    value={cur}
                    onPick={v => {
                        if (v === '__add')
                            return edit(d => {
                                const name = uniqueVar(d, 'screen', new Set(d.screens.map(s => s.props.name)))
                                d.screens.push(S(name, '새 화면', [N('button', { text: '뒤로', variant: 'secondary', act: 'back' })], { spacing: 16 }))
                                setCur(name)
                                setSel(null)
                                toast('화면을 추가했어요. 버튼에서 "화면으로 이동"으로 연결하세요')
                            })
                        setCur(v)
                        setSel(null)
                        setOsel(null)
                    }}
                />
                <View style={{ height: 440, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: MUTED }}>
                    {Preview ? <Preview key={`${reset}-${cur}-${defsKey}`} api={memApi} /> : <Hint>미리보기를 못 그렸어요.</Hint>}
                </View>
                <Hint>미리보기는 실제로 눌러 볼 수 있어요. 처음부터를 누르면 값이 처음대로 돌아가요.</Hint>
                <Chips
                    items={[
                        ['add', '추가'],
                        ['layers', '구조'],
                        ['edit', '수정'],
                        ['plugin', '플러그인'],
                    ]}
                    value={tab}
                    onPick={v => setTab(v as Tab)}
                />
                {tab === 'add' ? tabAdd() : tab === 'layers' ? tabLayers() : tab === 'edit' ? tabEdit() : tabPlugin()}
            </Stack>
        </ScrollView>
    )
}
function cmpPath(a: string, b: string) {
    const x = a.split('.').slice(1).map(Number),
        y = b.split('.').slice(1).map(Number)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] === undefined) return -1
        if (y[i] === undefined) return 1
        if (x[i] !== y[i]) return x[i] - y[i]
    }
    return 0
}

// ── 목록 ──
interface Installed {
    id: string
    name: string
    version: string
    description: string
    dir: string
}
export function Studio({ api }: { api?: any }) {
    const { Text, Stack, TableRowGroup, TableRow } = D()
    const [store, setStoreState] = useState<Store>(() => storeOf(api))
    const [open, setOpen] = useState<string | null>(null)
    const [picking, setPicking] = useState<Installed[] | null>(null)
    useEffect(() => {
        api?.jsonStorage
            ?.get?.()
            .then((c: any) => c?.projects && setStoreState({ projects: c.projects }))
            .catch(() => {})
    }, [])
    const setStore = (s: Store) => {
        setStoreState(s)
        writeStore(api, s)
    }
    const saveDoc = (pid: string, doc: Doc) => setStore({ projects: { ...store.projects, [pid]: { doc, updated: Date.now() } } })
    const create = (doc: Doc) => {
        const pid = 'p' + Date.now().toString(36)
        setStore({ projects: { ...store.projects, [pid]: { doc, updated: Date.now() } } })
        setOpen(pid)
    }
    const pick = async () => {
        try {
            const list: Installed[] = JSON.parse(String((await nat('list', [])) ?? '[]'))
            setPicking(list.filter(p => p.id !== 'yumistra.plugin-studio').sort((a, b) => a.name.localeCompare(b.name)))
        } catch (e: any) {
            toast(`플러그인 목록을 못 읽었어요: ${e?.message ?? e}`)
        }
    }
    const openInstalled = async (p: Installed) => {
        try {
            const b = await readInstalled(p.dir)
            let doc: Doc
            if (b.design) {
                doc = b.design
                if (doc.base) doc.base = { ...doc.base, id: p.id, dir: p.dir }
            } else {
                const hasSettings = /SettingsComponent/.test(b.orig || '')
                doc = { v: 2, plugin: { id: p.id, name: p.name, description: p.description, author: '', version: p.version, icon: '' }, base: { name: p.name, hasSettings, id: p.id, dir: p.dir, snap: { exp: {} } }, start: 'main', screens: [S('main', '설정', hasSettings ? [N('original')] : [], { spacing: 16 })] }
            }
            doc.plugin = { ...doc.plugin, id: b.manifest.id, name: b.manifest.name, description: b.manifest.description ?? '', author: b.manifest.author ?? '', version: b.manifest.version, icon: b.manifest.icon ?? '' }
            setPicking(null)
            create(doc)
            toast(b.design ? `${p.name} 열었어요. Studio로 만든 거라 전부 수정할 수 있어요` : `${p.name} 열었어요. 원래 설정 화면 글자는 구조 탭에서 바꿀 수 있어요`)
        } catch (e: any) {
            toast(`못 열었어요: ${e?.message ?? e}`)
        }
    }

    if (open && store.projects[open])
        return (
            <Editor
                key={open}
                pid={open}
                project={store.projects[open]}
                api={api}
                onSave={doc => saveDoc(open, doc)}
                onClose={() => setOpen(null)}
                onDelete={() => {
                    const { [open]: _, ...rest } = store.projects
                    setStore({ projects: rest })
                    setOpen(null)
                    toast('작업을 지웠어요')
                }}
            />
        )
    const list = (Object.entries(store.projects) as Array<[string, Project]>).sort((a, b) => b[1].updated - a[1].updated)
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <Stack spacing={20}>
                <Hint>디스코드 부품으로 플러그인 화면을 만들고, 다운로드에 zip으로 저장해서 Valenced로 설치해요.</Hint>
                <Row>
                    <Btn text="새 플러그인 만들기" variant="primary" onPress={() => create(newDoc())} />
                    <Btn text="깔린 플러그인 열기" onPress={pick} />
                </Row>
                {picking ? (
                    <TableRowGroup title="깔린 플러그인">
                        {picking.map(p => (
                            <TableRow key={p.dir} label={p.name} subLabel={`${p.version}, ${p.id}`} arrow onPress={() => openInstalled(p)} />
                        ))}
                        <TableRow label="닫기" onPress={() => setPicking(null)} />
                    </TableRowGroup>
                ) : null}
                <TableRowGroup title="내 작업">
                    {list.length ? (
                        list.map(([pid, pr]) => <TableRow key={pid} label={pr.doc.plugin.name} subLabel={`${pr.doc.plugin.version}, ${pr.doc.base ? `${pr.doc.base.name} 기반` : '새 플러그인'}, ${pr.doc.screens.length}개 화면`} arrow onPress={() => setOpen(pid)} />)
                    ) : (
                        <TableRow label="아직 없어요" subLabel="새 플러그인을 만들거나 깔린 플러그인을 열어 보세요." />
                    )}
                </TableRowGroup>
            </Stack>
        </ScrollView>
    )
}
void lines
void walk
