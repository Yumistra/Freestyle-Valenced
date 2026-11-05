// 디자인(화면, 부품, 동작) 모델. 웹 Valenced UI Studio 와 같은 형식이라 서로 열 수 있다

export interface Node {
    id: string
    type: string
    props: Record<string, any>
    children?: Node[]
}
export interface Doc {
    v: 2
    plugin: { id: string; name: string; description: string; author: string; version: string; icon: string }
    /** 깔린 플러그인을 바탕으로 만들 때 */
    base: null | { name: string; hasSettings: boolean; id?: string; dir?: string; snap?: { exp?: Record<string, Record<string, 1>> } }
    start: string
    screens: Node[]
}
export interface Field {
    k: string
    t: 'text' | 'var' | 'lines' | 'code' | 'num' | 'bool' | 'sel' | 'color' | 'icon'
    l: string
    o?: Array<string | [string, string]> | ((doc: Doc) => Array<string | [string, string]>)
    when?: (p: Record<string, any>) => any
}
export interface PartType {
    name: string
    box?: boolean
    cat?: string
    st?: 'bool' | 'text' | 'num' | 'list'
    base?: string
    act?: boolean
    def?: Record<string, any>
    fields: Field[]
}

export const lines = (s: any) =>
    String(s ?? '')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean)
export const csv = (s: any) =>
    String(s ?? '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
export function parseVal(v: any) {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v !== '' && v != null && !isNaN(Number(v))) return Number(v)
    return v
}

const TEXT_VARIANTS = ['heading-xl/bold', 'heading-lg/bold', 'heading-md/semibold', 'heading-sm/semibold', 'text-lg/medium', 'text-md/normal', 'text-md/medium', 'text-md/semibold', 'text-sm/normal', 'text-sm/medium', 'text-sm/semibold', 'text-xs/normal', 'text-xs/medium', 'text-xs/semibold', 'text-xs/bold']
const TEXT_COLORS = ['text-normal', 'text-muted', 'header-primary', 'header-secondary', 'text-link', 'text-danger', 'text-positive', 'custom']
const ALIGN = ['stretch', 'flex-start', 'center', 'flex-end']
const JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']
const ACTS: Array<[string, string]> = [
    ['none', '아무것도 안 함'],
    ['go', '화면으로 이동'],
    ['back', '뒤로 가기'],
    ['toggle', '스위치 켜고 끄기'],
    ['set', '값 바꾸기'],
    ['toast', '토스트 띄우기'],
    ['link', '링크 열기'],
    ['code', '코드 실행'],
]
const screenOpts = (doc: Doc): Array<[string, string]> => doc.screens.map(s => [s.props.name, s.props.title || s.props.name])
const KIND_LABEL: Record<string, string> = { bool: '켜기/끄기', text: '글자', num: '숫자', list: '목록' }
const stateOpts =
    (kind?: string) =>
    (doc: Doc): Array<[string, string]> => {
        const l = stateDefs(doc)
            .filter(s => !kind || s.kind === kind)
            .map((s): [string, string] => [s.name, `${s.name} (${s.label})`])
        return l.length ? l : [['', '아직 스위치나 값이 없음']]
    }
const ACTION_FIELDS: Field[] = [
    { k: 'act', t: 'sel', l: '눌렀을 때', o: ACTS },
    { k: 'actScreen', t: 'sel', l: '화면', o: screenOpts, when: p => p.act === 'go' },
    { k: 'actState', t: 'sel', l: '스위치', o: stateOpts('bool'), when: p => p.act === 'toggle' },
    { k: 'actState', t: 'sel', l: '값', o: stateOpts(), when: p => p.act === 'set' },
    { k: 'actValue', t: 'text', l: '새 값 (true, false, 숫자나 글자)', when: p => p.act === 'set' },
    { k: 'actText', t: 'text', l: '토스트 글자', when: p => p.act === 'toast' },
    { k: 'actUrl', t: 'text', l: '링크 (https://…)', when: p => p.act === 'link' },
    { k: 'onPress', t: 'code', l: '코드', when: p => p.act === 'code' },
]
const ACT_DEF = { act: 'none', actScreen: '', actState: '', actValue: '', actText: '', actUrl: '', onPress: '' }
export const SHOW_FIELDS: Field[] = [
    { k: 'showIf', t: 'sel', l: '보이기', o: doc => [['', '항상'], ...stateDefs(doc).map((s): [string, string] => [s.name, `${s.name} 이(가) …일 때만`])] },
    { k: 'showIs', t: 'sel', l: '조건', o: [['on', '켜져 있거나 값이 있음'], ['off', '꺼져 있거나 비어 있음'], ['equals', '이 값이거나 포함함'], ['not', '이 값이 아님']], when: p => p.showIf },
    { k: 'showVal', t: 'text', l: '비교할 값', when: p => p.showIf && (p.showIs === 'equals' || p.showIs === 'not') },
]
const F: Record<string, Field> = {
    label: { k: 'label', t: 'text', l: '이름표' },
    subLabel: { k: 'subLabel', t: 'text', l: '설명 (선택)' },
    icon: { k: 'icon', t: 'icon', l: '아이콘' },
    id: { k: 'id', t: 'var', l: '이름 (동작과 코드에서 씀)' },
}
export const T: Record<string, PartType> = {
    screen: { name: '화면', box: true, fields: [{ k: 'title', t: 'text', l: '제목' }, { k: 'name', t: 'var', l: '화면 이름 ("화면으로 이동"에서 씀)' }, { k: 'padding', t: 'num', l: '안쪽 여백' }, { k: 'spacing', t: 'num', l: '항목 사이 간격' }] },
    group: { name: '줄 묶음', box: true, cat: '줄', def: { title: '묶음', description: '' }, fields: [{ k: 'title', t: 'text', l: '제목' }, { k: 'description', t: 'text', l: '묶음 아래 설명' }] },
    row: { name: '줄', cat: '줄', act: true, def: { label: '줄', subLabel: '', icon: '', arrow: true, trailingText: '', variant: 'default', ...ACT_DEF }, fields: [F.label, F.subLabel, F.icon, { k: 'arrow', t: 'bool', l: '화살표 보이기' }, { k: 'trailingText', t: 'text', l: '오른쪽 글자' }, { k: 'variant', t: 'sel', l: '스타일', o: ['default', 'danger'] }, ...ACTION_FIELDS] },
    switch: { name: '스위치 줄', cat: '줄', st: 'bool', base: 'enabled', def: { label: '스위치', subLabel: '', icon: '', value: true }, fields: [F.label, F.subLabel, F.icon, { k: 'value', t: 'bool', l: '처음에 켜짐' }, F.id] },
    check: { name: '체크박스 줄', cat: '줄', st: 'bool', base: 'checked', def: { label: '체크박스', subLabel: '', icon: '', value: false }, fields: [F.label, F.subLabel, F.icon, { k: 'value', t: 'bool', l: '처음에 체크' }, F.id] },
    radio: { name: '라디오 묶음', cat: '줄', st: 'text', base: 'choice', def: { title: '하나 고르기', options: '선택지 A\n선택지 B\n선택지 C', value: 0 }, fields: [{ k: 'title', t: 'text', l: '제목' }, { k: 'options', t: 'lines', l: '선택지 (한 줄에 하나씩)' }, { k: 'value', t: 'num', l: '처음에 고른 것 (0이 첫 번째)' }, F.id] },
    button: { name: '버튼', cat: '컨트롤', act: true, def: { text: '버튼', variant: 'primary', size: 'md', grow: false, disabled: false, ...ACT_DEF }, fields: [{ k: 'text', t: 'text', l: '글자' }, { k: 'variant', t: 'sel', l: '스타일', o: ['primary', 'secondary', 'tertiary', 'destructive'] }, { k: 'size', t: 'sel', l: '크기', o: ['sm', 'md', 'lg'] }, { k: 'grow', t: 'bool', l: '가로 스택에서 너비 채우기' }, { k: 'disabled', t: 'bool', l: '비활성화' }, ...ACTION_FIELDS] },
    input: { name: '글자 입력', cat: '컨트롤', st: 'text', base: 'text', def: { label: '이름', placeholder: '여기에 입력', description: '', value: '', multiline: false }, fields: [{ k: 'label', t: 'text', l: '이름표' }, { k: 'placeholder', t: 'text', l: '안내 글자' }, { k: 'description', t: 'text', l: '아래 도움말' }, { k: 'value', t: 'text', l: '처음 글자' }, { k: 'multiline', t: 'bool', l: '여러 줄' }, F.id] },
    slider: { name: '슬라이더', cat: '컨트롤', st: 'num', base: 'amount', def: { min: 0, max: 100, step: 1, value: 50 }, fields: [{ k: 'min', t: 'num', l: '최소' }, { k: 'max', t: 'num', l: '최대' }, { k: 'step', t: 'num', l: '단위' }, { k: 'value', t: 'num', l: '처음 값' }, F.id] },
    chips: { name: '칩', cat: '컨트롤', st: 'list', base: 'picked', def: { items: '전체\n지운 것\n수정한 것', value: '', multi: false }, fields: [{ k: 'items', t: 'lines', l: '칩 (한 줄에 하나씩)' }, { k: 'multi', t: 'bool', l: '여러 개 고르기' }, { k: 'value', t: 'text', l: '처음에 고른 것 (이름, 쉼표로 구분)' }, F.id] },
    text: { name: '글자', cat: '내용', def: { text: '글자', variant: 'text-md/normal', color: 'text-normal', custom: '#ffffff', align: 'left' }, fields: [{ k: 'text', t: 'lines', l: '글자' }, { k: 'variant', t: 'sel', l: '크기와 굵기', o: TEXT_VARIANTS }, { k: 'color', t: 'sel', l: '색', o: TEXT_COLORS }, { k: 'custom', t: 'color', l: '직접 고른 색', when: p => p.color === 'custom' }, { k: 'align', t: 'sel', l: '정렬', o: ['left', 'center', 'right'] }] },
    message: { name: '메시지 (모양만)', cat: '내용', def: { author: '누군가', time: '오늘 오후 11:32', content: '안녕하세요', deleted: false }, fields: [{ k: 'author', t: 'text', l: '이름' }, { k: 'time', t: 'text', l: '시간' }, { k: 'content', t: 'lines', l: '메시지' }, { k: 'deleted', t: 'bool', l: '지운 메시지로 보이기 (빨간색)' }] },
    image: { name: '이미지', cat: '내용', def: { uri: '', width: 64, height: 64, radius: 32 }, fields: [{ k: 'uri', t: 'text', l: '이미지 주소 (https://…)' }, { k: 'width', t: 'num', l: '너비' }, { k: 'height', t: 'num', l: '높이' }, { k: 'radius', t: 'num', l: '모서리 둥글기' }] },
    divider: { name: '구분선', cat: '내용', def: {}, fields: [] },
    spacer: { name: '빈 공간', cat: '내용', def: { size: 16 }, fields: [{ k: 'size', t: 'num', l: '크기' }] },
    stack: { name: '스택', box: true, cat: '레이아웃', def: { direction: 'vertical', spacing: 8, align: 'stretch', justify: 'flex-start' }, fields: [{ k: 'direction', t: 'sel', l: '방향', o: ['vertical', 'horizontal'] }, { k: 'spacing', t: 'num', l: '항목 사이 간격' }, { k: 'align', t: 'sel', l: '안쪽 정렬', o: ALIGN }, { k: 'justify', t: 'sel', l: '배치', o: JUSTIFY }] },
    card: { name: '카드', box: true, cat: '레이아웃', def: { variant: 'primary', border: 'none', spacing: 8 }, fields: [{ k: 'variant', t: 'sel', l: '배경', o: ['primary', 'secondary', 'transparent'] }, { k: 'border', t: 'sel', l: '테두리', o: ['none', 'faint', 'normal', 'strong'] }, { k: 'spacing', t: 'num', l: '항목 사이 간격' }] },
    box: { name: '박스 (View)', box: true, cat: '레이아웃', def: { direction: 'column', gap: 8, padding: 12, bg: '#27282e', useBg: false, radius: 12, borderWidth: 0, borderColor: '#5865f2', align: 'stretch', justify: 'flex-start', wrap: false, scroll: false }, fields: [{ k: 'direction', t: 'sel', l: '방향', o: ['column', 'row'] }, { k: 'gap', t: 'num', l: '간격' }, { k: 'padding', t: 'num', l: '안쪽 여백' }, { k: 'useBg', t: 'bool', l: '배경색 쓰기' }, { k: 'bg', t: 'color', l: '배경', when: p => p.useBg }, { k: 'radius', t: 'num', l: '모서리 둥글기' }, { k: 'borderWidth', t: 'num', l: '테두리 두께' }, { k: 'borderColor', t: 'color', l: '테두리 색', when: p => p.borderWidth > 0 }, { k: 'align', t: 'sel', l: '안쪽 정렬', o: ALIGN }, { k: 'justify', t: 'sel', l: '배치', o: JUSTIFY }, { k: 'wrap', t: 'bool', l: '다음 줄로 넘기기', when: p => p.direction === 'row' }, { k: 'scroll', t: 'bool', l: '옆으로 스크롤', when: p => p.direction === 'row' }] },
    original: { name: '원래 설정 화면', cat: '플러그인', def: {}, fields: [] },
}

let seq = 1
export const uid = () => 'n' + (seq++).toString(36) + Math.random().toString(36).slice(2, 5)
const COMMON = { showIf: '', showIs: 'on', showVal: '' }
export function N(type: string, props?: Record<string, any>, children?: Node[]): Node {
    const n: Node = { id: uid(), type, props: Object.assign({}, type === 'screen' ? {} : COMMON, T[type].def || {}, props || {}) }
    if (T[type].box) n.children = children || []
    return n
}
export const S = (name: string, title: string, kids: Node[], extra?: Record<string, any>) => N('screen', Object.assign({ name, title, padding: 16, spacing: 24 }, extra || {}), kids)
export const PLUGIN_DEF = { id: 'yumistra.my-plugin', name: '내 플러그인', description: 'Plugin Studio로 만듦.', author: 'Yumistra', version: '1.0.0', icon: 'SparklesIcon' }

export function newDoc(): Doc {
    return {
        v: 2,
        plugin: { ...PLUGIN_DEF, id: `yumistra.my-plugin-${Date.now().toString(36)}` },
        base: null,
        start: 'main',
        screens: [
            S('main', '설정', [
                N('group', { title: '일반' }, [N('switch', { label: '사용', subLabel: '플러그인 전체를 켜고 끕니다.', icon: 'SettingsIcon', value: true, id: 'enabled' })]),
                N('group', { title: '더 보기' }, [N('row', { label: '고급', subLabel: '다른 화면을 엽니다', icon: 'WrenchIcon', arrow: true, act: 'go', actScreen: 'advanced' })]),
            ]),
            S('advanced', '고급', [N('group', { title: '디버그' }, [N('check', { label: '자세한 로그', value: false, id: 'verbose' })]), N('button', { text: '뒤로', variant: 'secondary', act: 'back' })]),
        ],
    }
}

export function walk(n: Node, f: (n: Node, parent?: Node) => void, parent?: Node) {
    f(n, parent)
    for (const c of n.children || []) walk(c, f, n)
}
export function walkAll(doc: Doc, f: (n: Node) => void) {
    for (const s of doc.screens) walk(s, f)
}
export function findIn(id: string, n: Node, parent: Node | null): { node: Node; parent: Node | null; index: number } | null {
    if (n.id === id) return { node: n, parent, index: parent ? parent.children!.indexOf(n) : -1 }
    for (const c of n.children || []) {
        const r = findIn(id, c, n)
        if (r) return r
    }
    return null
}
export function find(doc: Doc, id: string) {
    for (const s of doc.screens) {
        const r = findIn(id, s, null)
        if (r) return r
    }
    return null
}
export function reseq(doc: Doc) {
    walkAll(doc, n => {
        const m = /^n([0-9a-z]+)/.exec(n.id)
        if (m) seq = Math.max(seq, parseInt(m[1], 36) + 1)
    })
}
export const varName = (v: any) => {
    v = String(v ?? '').replace(/[^A-Za-z0-9_$]/g, '')
    if (!v || /^\d/.test(v)) v = 'v' + v
    return v as string
}
export function allVars(doc: Doc) {
    const s = new Set<string>()
    walkAll(doc, n => {
        if (n.props.id && T[n.type].st) s.add(n.props.id)
    })
    return s
}
export function uniqueVar(doc: Doc, base: string, taken?: Set<string>) {
    base = varName(base).replace(/\d+$/, '') || 'value'
    const s = taken || allVars(doc)
    if (!s.has(base)) return base
    let i = 2
    while (s.has(base + i)) i++
    return base + i
}
export function clone(doc: Doc, n: Node): Node {
    const c: Node = JSON.parse(JSON.stringify(n))
    walk(c, x => {
        x.id = uid()
        if (x.props.id && T[x.type].st) x.props.id = uniqueVar(doc, x.props.id)
    })
    return c
}
export interface StateDef {
    name: string
    kind: string
    label: string
    def: any
}
export function stateDefs(doc: Doc): StateDef[] {
    const out: StateDef[] = []
    walkAll(doc, n => {
        const t = T[n.type],
            p = n.props
        if (!t?.st || !p.id) return
        let def: any
        if (t.st === 'bool') def = !!p.value
        else if (n.type === 'radio') {
            const o = lines(p.options)
            def = o[Math.max(0, Math.min(o.length - 1, +p.value || 0))] ?? ''
        } else if (t.st === 'num') def = +p.value || 0
        else if (t.st === 'list') {
            const it = lines(p.items)
            def = csv(p.value).filter(x => it.includes(x))
        } else def = String(p.value ?? '')
        out.push({ name: p.id, kind: t.st, label: KIND_LABEL[t.st], def })
    })
    return out
}
export function renameRefs(doc: Doc, kind: 'state' | 'screen', from: string, to: string) {
    if (!from || from === to) return
    walkAll(doc, n => {
        const p = n.props
        if (kind === 'state') {
            if (p.actState === from) p.actState = to
            if (p.showIf === from) p.showIf = to
        } else if (p.actScreen === from) p.actScreen = to
    })
    if (kind === 'screen' && doc.start === from) doc.start = to
}
export function fillDefaults(doc: Doc, n: Node, k: string, cur: string) {
    const p = n.props
    if (k !== 'act') return
    if (p.act === 'go' && !doc.screens.some(s => s.props.name === p.actScreen)) p.actScreen = (doc.screens.find(s => s.props.name !== cur) || doc.screens[0]).props.name
    const defs = stateDefs(doc)
    if (p.act === 'toggle' && !defs.some(s => s.name === p.actState && s.kind === 'bool')) p.actState = defs.find(s => s.kind === 'bool')?.name || ''
    if (p.act === 'set' && !defs.some(s => s.name === p.actState)) p.actState = defs[0]?.name || ''
}
export function migrate(d: any): Doc | null {
    if (!d) return null
    if (d.root && !d.screens) {
        d.root.props.name = 'main'
        d = { v: 2, plugin: { ...PLUGIN_DEF }, base: null, start: 'main', screens: [d.root] }
    }
    if (!Array.isArray(d.screens) || !d.screens.length) return null
    d.plugin = { ...PLUGIN_DEF, ...(d.plugin || {}) }
    for (const s of d.screens)
        walk(s, n => {
            if (!T[n.type]) n.type = 'text'
            if (n.type !== 'screen') n.props = Object.assign({}, COMMON, T[n.type].def || {}, n.props)
        })
    if (!d.screens.some((s: Node) => s.props.name === d.start)) d.start = d.screens[0].props.name
    delete d.states
    return d
}
export function bump(v: string) {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(String(v || ''))
    if (!m) return '1.0.0'
    const parts = m[1].split('.')
    parts[parts.length - 1] = String(+parts[parts.length - 1] + 1)
    return parts.join('.')
}
export function summary(n: Node) {
    const p = n.props
    return p.label || p.title || p.text || p.author || (n.type === 'chips' ? lines(p.items).join(', ') : '') || T[n.type].name
}

// ── 플러그인 스크립트 ──
export const MARK = 'var __VUS__=',
    MARK_END = ';/*__VUS_END__*/',
    ORIG = '/*__VUS_ORIG__*/(',
    ORIG_END = ')/*__VUS_ORIG_END__*/'

/** 스크립트 안의 디자인과 원래 코드 꺼내기 */
export function parseScript(script: string): { design: Doc | null; orig: string | null } {
    let design: Doc | null = null,
        orig: string | null = null
    const a = script.indexOf(MARK),
        b = script.indexOf(MARK_END)
    if (a >= 0 && b > a) {
        try {
            design = migrate(JSON.parse(script.slice(a + MARK.length, b)))
        } catch {}
    }
    const oa = script.indexOf(ORIG),
        ob = script.lastIndexOf(ORIG_END)
    if (oa >= 0 && ob > oa) orig = script.slice(oa + ORIG.length, ob)
    return { design, orig }
}
export function buildScript(doc: Doc, runtime: string, orig: string | null) {
    const data = { ...doc, states: stateDefs(doc) }
    const json = JSON.stringify(data).split('\u2028').join('\\u2028').split('\u2029').join('\\u2029')
    if (doc.base && orig) return `(function(){${MARK}${json}${MARK_END}\nvar make=${runtime};\nvar mod=${ORIG}${orig}${ORIG_END};\nvar o=mod&&mod["default"];if(o){o.SettingsComponent=make(valenced,__VUS__,o.SettingsComponent||null,false)}return mod})()\n`
    return `(function(){${MARK}${json}${MARK_END}\nvar make=${runtime};\nreturn {"default":{jsonStorage:{load:true,"default":{}},start:function(){},SettingsComponent:make(valenced,__VUS__,null,true)}}})()\n`
}
export function buildManifest(doc: Doc, baseManifest: any, scriptPath?: string) {
    const base = baseManifest ? JSON.parse(JSON.stringify(baseManifest)) : { format: 1, dependencies: { 'valenced.api': {}, discord: {} }, dist: { script: 'index.js' } }
    const p = doc.plugin
    Object.assign(base, { format: 1, id: p.id, name: p.name, description: p.description, author: p.author, version: p.version })
    if (p.icon) base.icon = p.icon
    else delete base.icon
    base.dist = { ...(base.dist || {}), script: scriptPath || base.dist?.script || 'index.js' }
    base.dependencies = { 'valenced.api': {}, discord: {}, ...(base.dependencies || {}) }
    return base
}
export function problems(doc: Doc) {
    const p = doc.plugin,
        out: string[] = []
    if (!/^[a-zA-Z0-9.-]+$/.test(p.id || '')) out.push('ID에는 영문, 숫자, 점(.), 하이픈(-)만 쓸 수 있어요.')
    if (!/^\d+(\.\d+)*(-[a-z0-9]+)?$/.test(p.version || '')) out.push('버전은 1.0.0 같은 모양이어야 해요.')
    if (!p.name) out.push('플러그인 이름을 넣어 주세요.')
    return out
}
