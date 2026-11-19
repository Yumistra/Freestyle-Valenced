// Voice Tools 를 디스코드 없이 시험한다: 빌드된 index.js 를 가짜 valenced, 디스코드 저장소, 화면 부품, 요청 모듈 위에서 돌린다.
// 사용법: node scripts/build.mjs voice-tools && node tests/voice-tools.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const results = []
function check(name, ok, extra = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : `  (${extra})`}`)
    if (!ok) fails++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 가짜 React ──
function createElement(type, props, ...children) {
    const p = { ...(props ?? {}) }
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { type, props: p, key: props?.key ?? null }
}
const React = { createElement, Fragment: 'Fragment' }

// ── 가짜 디스코드 화면 부품 ──
const ActionSheetRow = function ActionSheetRow() {}
ActionSheetRow.Group = function ActionSheetRowGroup() {}
ActionSheetRow.Icon = function ActionSheetRowIcon() {}
const ActionSheet = function ActionSheet() {}
const Design = {
    ActionSheetRow,
    ActionSheet,
    AlertModal: function AlertModal() {},
    AlertActionButton: function AlertActionButton() {},
    Text: function Text() {},
    TableRowGroup: function TableRowGroup() {},
    TableSwitchRow: function TableSwitchRow() {},
}

// ── 가짜 저장소 ──
const G = 'g1'
const ME = 'me'
const PERMS = { MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n, CONNECT: 1n << 20n, VIEW_CHANNEL: 1n << 10n }
const channels = {
    v1: { id: 'v1', guild_id: G, type: 2, name: 'General voice', parent_id: 'cat1', position: 0 },
    v2: { id: 'v2', guild_id: G, type: 2, name: 'Second', parent_id: 'cat1', position: 1 },
    v3: { id: 'v3', guild_id: G, type: 2, name: 'Locked', parent_id: 'cat1', position: 2 },
    s1: { id: 's1', guild_id: G, type: 13, name: 'Stage', parent_id: 'cat2', position: 0 },
    t1: { id: 't1', guild_id: G, type: 0, name: 'text', parent_id: 'cat1', position: 0 },
    cat1: { id: 'cat1', guild_id: G, type: 4, name: 'Voice', position: 1 },
    cat2: { id: 'cat2', guild_id: G, type: 4, name: 'Events', position: 0 },
}
// 채널마다 가진 권한
let granted = {}
const allPerms = () => {
    granted = {}
    for (const id of Object.keys(channels)) granted[id] = new Set(Object.values(PERMS))
    granted.v3.delete(PERMS.CONNECT)
}
allPerms()
let voice = {}
const resetVoice = () => {
    voice = {
        v1: {
            me: { mute: false, deaf: false },
            a: { mute: true, deaf: false },
            b: { mute: false, deaf: true },
            c: { mute: false, deaf: false },
        },
        v2: { x: {} },
    }
}
resetVoice()
const Stores = {
    PermissionStore: { can: (p, ch) => !!granted[ch?.id]?.has(BigInt(p)) },
    VoiceStateStore: { getVoiceStatesForChannel: id => voice[id] ?? {} },
    UserStore: { getCurrentUser: () => ({ id: ME }) },
    ChannelStore: {
        getChannel: id => channels[id],
        getMutableGuildChannelsForGuild: g => (g === G ? { ...channels } : {}),
    },
}

// ── 가짜 요청 모듈: 바뀐 내용을 기록하고, 정한 사람에게는 오류를 낸다 ──
let calls = []
let errors = {}
const HTTP = {
    get: async () => ({ body: {} }),
    patch: async req => {
        calls.push(req)
        const plan = errors[req.url]
        if (plan?.length) {
            const e = plan.shift()
            throw e
        }
        return { body: {} }
    },
}
const modules = [{ HTTP }, { Permissions: PERMS, ChannelTypes: {} }]

// ── 가짜 valenced ──
const toasts = []
const alerts = []
const hidden = []
let lazyOpened = []
const patches = []
const valenced = {
    react: { React, ReactNative: { View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' } },
    discord: {
        design: { Design },
        flux: { Stores },
        actions: {
            ToastActionCreators: { open: (key, o) => toasts.push(o.text) },
            AlertActionCreators: {
                openAlert: (key, el) => alerts.push({ key, el, open: true }),
                dismissAlert: key => alerts.filter(a => a.key === key).forEach(a => (a.open = false)),
            },
            ActionSheetActionCreators: {
                hideActionSheet: key => hidden.push(key),
                openLazy: (promise, key, props) => {
                    lazyOpened.push({ promise, key, props })
                },
            },
        },
        utils: {
            modules: {
                finders: {
                    getModuleWithImportedPath: (path, cb) => {
                        cb(path === 'modules/channel/native/ChannelLongPressActionSheet.tsx' ? sheetModule : undefined)
                        return () => {}
                    },
                    waitForModuleWithImportedPath: () => () => {},
                },
            },
        },
    },
    modules: {
        finders: {
            lookupModule: filter => {
                const m = modules.find(filter)
                return m ? [m] : []
            },
            filters: { withProps: (...props) => m => props.every(p => p in m) },
        },
    },
    patcher: {
        instead: (obj, key, cb) => {
            const orig = obj[key]
            obj[key] = function (...args) {
                return cb.call(this, args, orig)
            }
            patches.push(key)
            return () => {
                obj[key] = orig
            }
        },
    },
    utils: { discord: { lookupGeneratedIconComponent: name => Object.assign(() => null, { iconName: name }) } },
    components: { Page: function Page() {}, TableRowAssetIcon: function TableRowAssetIcon() {} },
}

// 채널 꾹 누르기 창: 디스코드처럼 ActionSheet 안에 줄 묶음이 있다
const original = props =>
    createElement(ActionSheet, { header: 'header', showGradient: true }, createElement(ActionSheetRow.Group, { key: 'discord' }, createElement(ActionSheetRow, { label: 'Mark as read' })))
const sheetModule = { default: original }

globalThis.valenced = valenced
globalThis.plugin = def => def
const src = readFileSync(new URL('../plugins/voice-tools/build/js/index.js', import.meta.url), 'utf8')
const def = new Function(`return ${src}`)().default

// ── 도우미 ──
const cleanups = []
let storageCache = { includeMe: false }
const storage = {
    get cache() {
        return storageCache
    },
    set: v => (storageCache = v),
}
const groupOf = tree => {
    const kids = [].concat(tree?.props?.children ?? [])
    return kids.find(k => k?.key === 'voice-tools')
}
const rowsOf = tree => [].concat(groupOf(tree)?.props?.children ?? []).filter(Boolean)
const rowByLabel = (tree, label) => rowsOf(tree).find(r => r.props.label === label)
const render = channel => sheetModule.default({ channel, onClose: () => hidden.push('onClose') })
const reset = () => {
    calls = []
    errors = {}
    toasts.length = 0
    alerts.length = 0
    hidden.length = 0
}
/** apply 가 끝날 때까지 */
const settle = async () => {
    for (let i = 0; i < 100; i++) {
        await sleep(50)
        if (toasts.some(t => /^(Muted|Unmuted|Deafened|Undeafened|Disconnected|Moved|Nobody|Still)/.test(t))) return
    }
}

// ── 시험 ──
def.start({ cleanup: f => cleanups.push(f), jsonStorage: storage })
check('patches the sheet module and openLazy', sheetModule.default !== original && patches.includes('openLazy'))

{
    const tree = render(channels.t1)
    check('text channel gets no rows', !groupOf(tree))
}
{
    const tree = render(channels.v1)
    const labels = rowsOf(tree).map(r => `${r.props.label}:${r.props.subLabel}`)
    check(
        'voice channel rows and counts (me excluded)',
        JSON.stringify(labels) ===
            JSON.stringify(['Mute everyone:2 people', 'Unmute everyone:1 person', 'Deafen everyone:2 people', 'Undeafen everyone:1 person', 'Move everyone:3 people', 'Disconnect everyone:3 people']),
        labels.join(', '),
    )
    check("Discord's own rows are kept", [].concat(tree.props.children).some(k => k?.key === 'discord'))
    check('rows go first', [].concat(tree.props.children)[0]?.key === 'voice-tools')
    check('every row has an icon', rowsOf(tree).every(r => r.props.icon))
}
{
    granted.v1 = new Set([PERMS.MUTE_MEMBERS, PERMS.VIEW_CHANNEL, PERMS.CONNECT])
    const labels = rowsOf(render(channels.v1)).map(r => r.props.label)
    check('only mute rows with only mute permission', JSON.stringify(labels) === JSON.stringify(['Mute everyone', 'Unmute everyone']), labels.join(', '))
    granted.v1 = new Set()
    check('no rows without permissions', !groupOf(render(channels.v1)))
    allPerms()
}
{
    voice.v1 = { me: {} }
    const subs = rowsOf(render(channels.v1)).map(r => r.props.subLabel)
    check('rows still show when only you are there', subs.length === 6 && subs.every(x => x === 'Nobody to change'), subs.join(','))
    reset()
    rowByLabel(render(channels.v1), 'Mute everyone').props.onPress()
    await settle()
    check('pressing with nobody there says so', toasts.at(-1) === 'Nobody to change' && calls.length === 0, toasts.join(' | '))
    resetVoice()
}

// 모두 음소거
reset()
rowByLabel(render(channels.v1), 'Mute everyone').props.onPress()
check('pressing closes the sheet', hidden.includes('onClose') && hidden.includes('ChannelLongPress-v1'), hidden.join(','))
await settle()
check(
    'mute sends PATCH for b and c only',
    JSON.stringify(calls) === JSON.stringify([{ url: '/guilds/g1/members/b', body: { mute: true } }, { url: '/guilds/g1/members/c', body: { mute: true } }]),
    JSON.stringify(calls),
)
check('mute toast', toasts.at(-1) === 'Muted 2', toasts.join(' | '))

// 너무 빠름(429) 은 기다렸다 다시, 권한 없음은 실패로
reset()
errors['/guilds/g1/members/a'] = [{ status: 429, body: { retry_after: 0.05 } }]
errors['/guilds/g1/members/b'] = [{ status: 403, body: { message: 'Missing Permissions' } }]
rowByLabel(render(channels.v1), 'Disconnect everyone').props.onPress()
await sleep(400)
const confirmAlert = alerts.at(-1)
check('disconnect asks first', !!confirmAlert && calls.length === 0)
const go = [].concat(confirmAlert?.el?.props?.actions ?? []).find(a => a?.props?.text === 'Disconnect')
go?.props?.onPress()
await settle()
const urls = calls.map(c => c.url.split('/').pop())
check('429 is retried', JSON.stringify(urls) === JSON.stringify(['a', 'a', 'b', 'c']), urls.join(','))
check('disconnect body', calls.every(c => c.body.channel_id === null))
check('failure is reported', toasts.at(-1) === 'Disconnected 2, 1 failed, Missing Permissions', toasts.at(-1))

// 다른 채널로 옮기기
reset()
rowByLabel(render(channels.v1), 'Move everyone').props.onPress()
await sleep(400)
const picker = alerts.at(-1)
const list = [].concat(picker?.el?.props?.extraContent?.props?.children ?? [])
const names = list.map(p => p?.key)
check('move picker lists other channels you can join, stage first by category', JSON.stringify(names) === JSON.stringify(['s1', 'v2']), names.join(','))
list.find(p => p.key === 'v2')?.props?.onPress()
check('picking closes the picker', picker && picker.open === false)
await settle()
check('move body', calls.length === 3 && calls.every(c => c.body.channel_id === 'v2'), JSON.stringify(calls))
check('move toast', toasts.at(-1) === 'Moved to Second 3', toasts.at(-1))

// 하나가 끝나기 전에 또 누르면
reset()
// 첫 번째가 오래 걸리게 (429 로 0.5초 기다림)
errors['/guilds/g1/members/a'] = [{ status: 429, body: { retry_after: 0.5 } }]
const t = render(channels.v1)
rowByLabel(t, 'Unmute everyone').props.onPress()
rowByLabel(t, 'Deafen everyone').props.onPress()
await sleep(1200)
check('second action waits for the first', toasts.includes('Still working on the last one') && toasts.includes('Unmuted 1') && !toasts.some(x => x.startsWith('Deafened')), toasts.join(' | '))

// 나도 포함
reset()
storageCache = { includeMe: true }
const withMe = rowsOf(render(channels.v1)).map(r => r.props.subLabel)
check('include yourself counts you', withMe[0] === '3 people', withMe.join(','))
storageCache = { includeMe: false }

// 바깥 컴포넌트가 안쪽 컴포넌트 하나만 돌려주는 창
{
    const Inner = props => original(props)
    const outerMod = { default: props => createElement(Inner, props) }
    valenced.discord.actions.ActionSheetActionCreators.openLazy(Promise.resolve(outerMod), 'ChannelLongPress-v1', {})
    const opened = lazyOpened.at(-1)
    const mod = await opened.promise
    const el = mod.default({ channel: channels.v1 })
    const out = el.type(el.props)
    check('openLazy sheets are patched, inner component wrapped', !!groupOf(out))
}

// 끄면 원래대로
cleanups.forEach(f => typeof f === 'function' && f())
check('cleanup restores the sheet', sheetModule.default === original)

console.log(results.join('\n'))
console.log(`fails: ${fails}`)
process.exit(fails ? 1 : 0)
