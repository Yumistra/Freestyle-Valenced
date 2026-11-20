// Desktop UI 를 디스코드 없이 시험한다. 빌드된 index.js 를 진짜 React(서버 렌더링) 와 가짜 디스코드 모듈 위에서 돌린다.
// 가짜 모듈은 이 APK 의 진짜 모듈과 같은 경로, 같은 내보내기 이름, 같은 props 를 쓴다.
// 사용법: node scripts/build.mjs desktop-ui && NODE_PATH=/opt/npm-tools/node_modules node tests/desktop-ui.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require(process.env.REACT ?? 'react')
const { renderToStaticMarkup } = require(process.env.REACT_DOM_SERVER ?? 'react-dom/server')

let fails = 0
const results = []
function check(name, ok, extra = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : `  (${extra})`}`)
    if (!ok) fails++
}

// ── 가짜 react-native ──
let screen = 411
const View = ({ style, children, ...rest }) =>
    React.createElement('div', { 'data-style': JSON.stringify(style ?? null), ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [`data-${k.toLowerCase()}`, String(v)])) }, children)
const ReactNative = {
    View,
    Dimensions: { get: () => ({ width: screen, height: 800 }) },
    useWindowDimensions: () => {
        // 진짜처럼 훅이다
        React.useState(0)
        return { width: screen, height: 800 }
    },
}

// ── 가짜 디스코드 모듈 (같은 경로, 같은 내보내기) ──
const calledOrig = { layout: 0, drawer: 0, chatWidth: 0 }
const mods = {
    'modules/chat/native/useChatLayout.tsx': {
        default: function useChatLayout() {
            calledOrig.layout++
            return React.useMemo(() => ({ isChatBesideChannelList: false, isChatLockedOpen: false }), [])
        },
        getChatLayout: () => ({ isChatBesideChannelList: false, isChatLockedOpen: false }),
    },
    'modules/screen/native/drawer/useDrawerWidth.tsx': {
        DRAWER_LEFT_WIDTH_MIN: 260,
        useDrawerWidth: function useDrawerWidth() {
            calledOrig.drawer++
            const [w] = React.useState(260)
            return w
        },
        getDrawerWidth: () => 260,
    },
    'modules/chat/native/useChatWidth.tsx': {
        default: function useChatWidth() {
            calledOrig.chatWidth++
            React.useContext(React.createContext(null))
            return screen - 260
        },
        getChatWidth: () => screen - 260,
    },
    'modules/main_tabs_v2/native/channel/SwipeForMemberListWrapper.tsx': {
        default: function SwipeForMemberListWrapper({ channelId, children }) {
            const [n] = React.useState(1)
            return React.createElement('section', { 'data-chat': channelId, 'data-n': n }, children)
        },
    },
    'modules/main_tabs_v2/native/shared_components/user_list/GuildChannelUserList.tsx': {
        default: React.memo(({ channelId, guildId }) => React.createElement('aside', { 'data-members': 'guild', 'data-channel': channelId, 'data-guild': guildId })),
    },
    'modules/main_tabs_v2/native/shared_components/user_list/PrivateChannelUserList.tsx': {
        default: React.memo(({ channelId }) => React.createElement('aside', { 'data-members': 'private', 'data-channel': channelId })),
    },
    'modules/main_tabs_v2/native/shared_components/user_list/ThreadChannelUserList.tsx': {
        default: ({ channelId, guildId }) => React.createElement('aside', { 'data-members': 'thread', 'data-channel': channelId, 'data-guild': guildId }),
    },
}
const originals = Object.fromEntries(Object.entries(mods).map(([p, m]) => [p, { ...m }]))

const channels = {
    text: { id: 'text', guild_id: 'g', type: 0 },
    voice: { id: 'voice', guild_id: 'g', type: 2 },
    thread: { id: 'thread', guild_id: 'g', type: 11 },
    group: { id: 'group', type: 3, isGroupDM: () => true },
    dm: { id: 'dm', type: 1, isGroupDM: () => false },
}

// ── 가짜 valenced ──
let cache = {}
const listeners = new Set()
const storage = {
    get cache() {
        return cache
    },
    set: (v, replace) => {
        cache = replace ? v : { ...cache, ...v }
        listeners.forEach(f => f())
    },
    use: () => React.useSyncExternalStore(f => (listeners.add(f), () => listeners.delete(f)), () => cache, () => cache),
}
const valenced = {
    react: { React, ReactNative },
    components: { Page: ({ children }) => React.createElement('main', null, children), TableRowAssetIcon: () => null },
    discord: {
        design: {
            Design: {
                Stack: ({ children }) => React.createElement('div', null, children),
                TableRowGroup: ({ children }) => React.createElement('div', null, children),
                TableSwitchRow: ({ label, value }) => React.createElement('label', { 'data-on': String(value) }, label),
                TextInput: ({ label, value }) => React.createElement('input', { 'aria-label': label, value, readOnly: true }),
                TableRadioGroup: ({ title, children }) => React.createElement('fieldset', { title }, children),
                TableRadioRow: ({ label, value }) => React.createElement('option', { value }, label),
                Text: ({ children }) => React.createElement('p', null, children),
            },
        },
        flux: { Stores: { ChannelStore: { getChannel: id => channels[id] } } },
        utils: {
            modules: {
                finders: {
                    getModuleWithImportedPath: (path, cb) => {
                        cb(mods[path])
                        return () => {}
                    },
                },
            },
        },
    },
    patcher: {
        instead: (obj, key, cb) => {
            const orig = obj[key]
            obj[key] = function (...args) {
                return cb.call(this, args, orig)
            }
            return () => {
                obj[key] = orig
            }
        },
    },
}
globalThis.valenced = valenced
globalThis.plugin = d => d
const src = readFileSync(new URL('../plugins/desktop-ui/build/js/index.js', import.meta.url), 'utf8')
const exported = new Function(`return ${src}`)()
const def = exported.default

// ── 디스코드 화면을 흉내 낸 앱: 진짜처럼 모듈 속성을 그릴 때마다 읽는다 ──
const L = mods['modules/chat/native/useChatLayout.tsx']
const DW = mods['modules/screen/native/drawer/useDrawerWidth.tsx']
const CW = mods['modules/chat/native/useChatWidth.tsx']
const W = mods['modules/main_tabs_v2/native/channel/SwipeForMemberListWrapper.tsx']
function App({ channelId }) {
    const layout = L.default()
    const drawer = DW.useDrawerWidth()
    const chat = CW.default()
    return React.createElement(
        'div',
        { 'data-beside': String(layout.isChatBesideChannelList), 'data-locked': String(layout.isChatLockedOpen), 'data-drawer': drawer, 'data-chatwidth': chat },
        React.createElement(W.default, { channelId }, 'messages'),
    )
}
const render = channelId => renderToStaticMarkup(React.createElement(App, { channelId })).replaceAll('&quot;', '"')
const attr = (html, name) => html.match(new RegExp(`data-${name}="([^"]*)"`))?.[1]

// ── 시험 ──
const cleanups = []
def.start({ cleanup: f => cleanups.push(f), jsonStorage: storage })

check('patches layout, widths and the chat wrapper', L.default !== originals[Object.keys(mods)[0]].default && DW.useDrawerWidth !== originals['modules/screen/native/drawer/useDrawerWidth.tsx'].useDrawerWidth && W.default !== originals['modules/main_tabs_v2/native/channel/SwipeForMemberListWrapper.tsx'].default)

// 폰 세로 (411dp)
screen = 411
let html = render('text')
check('phone: chat beside channel list, locked open', attr(html, 'beside') === 'true' && attr(html, 'locked') === 'true', html.slice(0, 120))
const w411 = exported.widths(411)
check('phone: widths add up', w411.channel + w411.members + w411.chat === 411 && w411.chat >= exported.MIN_CHAT, JSON.stringify(w411))
check('phone: drawer width from the plugin', Number(attr(html, 'drawer')) === w411.channel, attr(html, 'drawer'))
check('phone: chat width leaves room for members', Number(attr(html, 'chatwidth')) === w411.chat, attr(html, 'chatwidth'))
check('original hooks still run (hook order kept)', calledOrig.layout > 0 && calledOrig.drawer > 0 && calledOrig.chatWidth > 0)
check('chat is still rendered inside the original wrapper', html.includes('data-chat="text"') && html.includes('messages'))
check('phone, auto: member column folded so the chat stays readable', w411.members === 0 && !html.includes('data-members'), JSON.stringify(w411))
storage.set({ ...cache, members: 'always' }, true)
html = render('text')
const a411 = exported.widths(411)
check('phone, always: guild member list beside the chat', html.includes('data-members="guild"') && html.includes('data-channel="text"') && html.includes('data-guild="g"'), html)
check('phone, always: member column has its width and chat keeps 120dp', html.includes(`"width":${a411.members}`) && a411.chat >= 120 && a411.channel + a411.members + a411.chat === 411, JSON.stringify(a411))
storage.set({ ...cache, members: 'auto' }, true)

// 좁은 폰 (360dp): 채팅이 너무 좁아지면 멤버 칸을 접는다
screen = 360
html = render('text')
const w360 = exported.widths(360)
check('narrow phone: member column hidden, chat gets the rest', w360.members === 0 && !html.includes('data-members') && w360.channel + w360.chat === 360, JSON.stringify(w360))

// 태블릿 (1000dp)
screen = 1000
const w1000 = exported.widths(1000)
check('tablet: widths capped', w1000.channel === 300 && w1000.members === 240 && w1000.chat === 460, JSON.stringify(w1000))

// 채널 종류
screen = 900
check('voice channel uses the guild member list', render('voice').includes('data-members="guild"'))
check('thread uses the thread member list', render('thread').includes('data-members="thread"'))
check('group DM uses the private member list', render('group').includes('data-members="private"'))
check('1:1 DM gets no member column', !render('dm').includes('data-members'))
check('unknown channel gets no member column', !render('nope').includes('data-members'))

// 설정
storage.set({ ...cache, members: 'off' }, true)
check('member list off', !render('text').includes('data-members'))
storage.set({ ...cache, members: 'auto', lockOpen: false }, true)
html = render('text')
check('lock open off: still beside, not locked', attr(html, 'beside') === 'true' && attr(html, 'locked') === 'false')
storage.set({ ...cache, lockOpen: true, channelWidth: 220, memberWidth: 180 }, true)
html = render('text')
check('custom widths', attr(html, 'drawer') === '220' && html.includes('"width":180') && attr(html, 'chatwidth') === String(900 - 220 - 180), html.slice(0, 200))
storage.set({ ...cache, channelWidth: 5000 }, true)
check('silly width is clamped', exported.widths(900).channel === 780, JSON.stringify(exported.widths(900)))
storage.set({ ...cache, channelWidth: 0, memberWidth: 0 }, true)
check('same layout object every time', L.getChatLayout() === L.getChatLayout())
check('non-React getters follow settings', L.getChatLayout().isChatLockedOpen === true && DW.getDrawerWidth() === exported.widths(screen).channel && CW.getChatWidth() === exported.widths(screen).chat)

// 설정 화면
const page = renderToStaticMarkup(React.createElement(exported.SettingsPage, { api: { jsonStorage: storage } }))
check('settings page renders', page.includes('Always show channels') && page.includes('Member list') && page.includes('Auto') && page.includes('Channel list width') && page.includes('Now: channels'))
storage.set({ ...cache, members: false }, true)
check('old on/off setting still understood', exported.widths(900).members === 0)

// 끄면 원래대로
cleanups.forEach(f => typeof f === 'function' && f())
const restored = Object.entries(originals).every(([p, m]) => Object.entries(m).every(([k, v]) => mods[p][k] === v))
check('cleanup restores every module', restored)
check('after cleanup the layout is the original', render('text').includes('data-beside="false"') && !render('text').includes('data-members'))

console.log(results.join('\n'))
console.log(`fails: ${fails}`)
process.exit(fails ? 1 : 0)
