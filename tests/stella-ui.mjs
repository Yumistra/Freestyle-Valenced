// Stella UI 를 디스코드 없이 시험한다.
// 빌드된 index.js 를 진짜 React(react-dom/client, 가짜 DOM 위) 로 그려서 효과(useEffect), 구독, 누르기까지 돌린다.
// 가짜 디스코드 스토어, 모듈은 진짜와 같은 이름, 같은 인자를 쓴다.
// 사용법: node scripts/build.mjs stella-ui && NODE_PATH=/opt/npm-tools/node_modules node tests/stella-ui.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { install } from './lib/fakedom.mjs'

const require = createRequire(import.meta.url)
const doc = install()
const React = require(process.env.REACT ?? 'react')
const { createRoot } = require(process.env.REACT_DOM_CLIENT ?? 'react-dom/client')
const h = React.createElement
const { act } = React
// act 경고는 시험 장치의 소리라 숨긴다 (진짜 오류는 남긴다)
const consoleError = console.error
console.error = (...a) => (String(a[0]).includes('not wrapped in act') ? undefined : consoleError(...a))

let fails = 0
const results = []
function check(name, ok, extra = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : `  (${String(extra).slice(0, 300)})`}`)
    if (!ok) fails++
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── 가짜 react-native ───────────────────────────────────────────────────
let win = { width: 1280, height: 800 }
const presses = new Map()
const inputs = new Map()
const backHandlers = new Set()
const kbListeners = []
const copied = []
const opened = []
const clean = props => {
    const out = {}
    for (const [k, v] of Object.entries(props)) if (k.startsWith('data-')) out[k] = v
    return out
}
const flatStyle = st => (Array.isArray(st) ? Object.assign({}, ...st.map(flatStyle)) : st && typeof st === 'object' ? st : {})
/** 키보드 시험용: 채팅 칸의 창 안 위치 */
const layout = { y: 0, h: 800 }
const View = ({ children, pointerEvents, ref, onLayout, style, ...p }) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: cb => cb(0, layout.y, 100, layout.h) }))
    const pb = flatStyle(style).paddingBottom
    return h('div', { ...clean(p), ...(ref && pb !== undefined ? { 'data-pb': pb } : {}) }, children)
}
/** 그려져 있는 동안만 누를 수 있게 등록한다 (memo 로 다시 안 그려져도 남는다) */
function useRegister(map, key, value) {
    const ref = React.useRef(value)
    ref.current = value
    React.useEffect(() => {
        if (!key) return
        const entry = { get: () => ref.current }
        map.set(key, [...(map.get(key) ?? []), entry])
        return () => map.set(key, (map.get(key) ?? []).filter(e => e !== entry))
    }, [key])
}
const Text = ({ children, onPress, ...p }) => {
    useRegister(presses, onPress ? `text:${typeof children === 'string' ? children : ''}` : '', onPress)
    return h('span', clean(p), children)
}
const Image = ({ source }) => h('img', { 'data-src': source?.uri ?? '' })
const Pressable = ({ children, onPress, onLongPress, accessibilityLabel, disabled, style }) => {
    useRegister(presses, onLongPress ? `long:${accessibilityLabel}` : '', onLongPress)
    if (typeof style === 'function') style({ pressed: false })
    useRegister(presses, onPress ? accessibilityLabel : '', disabled ? () => {} : onPress)
    return h('div', { 'data-press': accessibilityLabel ?? '' }, typeof children === 'function' ? children({ pressed: false }) : children)
}
const TextInput = ({ value, placeholder, onChangeText }) => {
    useRegister(inputs, placeholder ?? '', { onChangeText, value })
    return h('input', { 'data-value': value ?? '', 'data-placeholder': placeholder ?? '' })
}
const scrolled = []
const FlatList = ({ data, renderItem, keyExtractor, ListEmptyComponent, ref }) =>
    (React.useImperativeHandle(ref, () => ({ scrollToIndex: o => scrolled.push(o), scrollToOffset() {} })), 0) ||
    h('div', { 'data-list': data?.length ?? 0 }, data?.length ? data.map((item, index) => h(React.Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index }))) : ListEmptyComponent ?? null)
class AnimValue {
    constructor(v) {
        this.v = v
    }
    setValue(v) {
        this.v = v
    }
    interpolate() {
        return this
    }
}
const ReactNative = {
    View,
    Text,
    Image,
    Pressable,
    TextInput,
    FlatList,
    Animated: { View, Value: AnimValue, timing: (v, cfg) => ({ start: cb => (v.setValue(cfg.toValue), cb?.({ finished: true })), stop() {} }) },
    BackHandler: { addEventListener: (_t, f) => (backHandlers.add(f), { remove: () => backHandlers.delete(f) }) },
    Keyboard: { addListener: (t, f) => (kbListeners.push([t, f]), { remove: () => kbListeners.splice(kbListeners.findIndex(x => x[1] === f), 1) }) },
    Linking: { openURL: url => (opened.push(url), Promise.resolve()) },
    Dimensions: { get: () => win },
    useWindowDimensions: () => win,
}

// ── 가짜 디스코드 스토어 ────────────────────────────────────────────────
function store(methods) {
    const ls = new Set()
    return { ...methods, addChangeListener: f => ls.add(f), removeChangeListener: f => ls.delete(f), emit: () => ls.forEach(f => f()), listeners: ls }
}
const user = (id, name, extra = {}) => ({ id, username: name.toLowerCase(), globalName: name, avatar: `av${id}`, getAvatarURL: (_g, size) => `https://cdn/avatars/${id}.png?size=${size}`, ...extra })
const users = { 1: user('1', 'DeStinY'), 2: user('2', 'Seina'), 3: user('3', 'Nazna'), 4: user('4', 'Tillia'), 5: user('5', 'Hotaru') }
const channels = {
    dm1: { id: 'dm1', type: 1, recipients: ['2'] },
    dm2: { id: 'dm2', type: 1, recipients: ['3'] },
    'dm-new': { id: 'dm-new', type: 1, recipients: ['4'] },
    gdm: { id: 'gdm', type: 3, name: 'Party', recipients: ['2', '3'] },
    cat1: { id: 'cat1', type: 4, name: 'Info', guild_id: 'g1', position: 0 },
    cat2: { id: 'cat2', type: 4, name: 'General', guild_id: 'g1', position: 1 },
    rules: { id: 'rules', type: 0, name: 'rules', guild_id: 'g1', parent_id: 'cat1', position: 0 },
    news: { id: 'news', type: 5, name: 'news', guild_id: 'g1', parent_id: 'cat1', position: 1 },
    chat: { id: 'chat', type: 0, name: 'chat', guild_id: 'g1', parent_id: 'cat2', position: 0, topic: 'Read  me\nfirst' },
    logs: { id: 'logs', type: 0, name: 'logs', guild_id: 'g1', parent_id: 'cat2', position: 1 },
    talk: { id: 'talk', type: 2, name: 'talk', guild_id: 'g1', parent_id: 'cat2', position: 0 },
    forum: { id: 'forum', type: 15, name: 'help', guild_id: 'g1', parent_id: 'cat2', position: 2, topic: 'Ask here', availableTags: [{ id: 't1', name: 'Bug' }, { id: 't2', name: 'Idea', emojiName: '💡' }] },
    p1: { id: 'p1', type: 11, name: 'Active post', guild_id: 'g1', parent_id: 'forum', ownerId: '3', messageCount: 4, lastMessageId: '1300000000000000000', appliedTags: ['t1'], flags: 2 },
    th1: { id: 'th1', type: 11, name: 'side talk', guild_id: 'g1', parent_id: 'chat' },
    777: { id: '777', type: 0, name: 'general' },
    top: { id: 'top', type: 0, name: 'welcome', guild_id: 'g1', position: 5 },
}
const guilds = {
    g1: { id: 'g1', name: 'Valenced', icon: 'i1', banner: 'b1', getIconURL: size => `https://cdn/icons/g1.png?size=${size}` },
    g2: { id: 'g2', name: 'Codex', icon: null },
}
const msg = (id, author, content, extra = {}) => ({ id, author: users[author], content, type: 0, timestamp: new Date(Date.UTC(2026, 10, 20, 10, 0, Number(id.replace(/\D/g, '')) || 0)), attachments: [], embeds: [], channel_id: extra.channel_id, ...extra })
const messages = {
    logs: {
        ready: true,
        _array: [
            msg('l1', '4', '', {
                channel_id: 'logs',
                embeds: [
                    {
                        type: 'rich',
                        color: 0x00ff88,
                        author: { name: 'Logger', iconProxyURL: 'https://cdn/author.png' },
                        rawTitle: 'Member Joined',
                        url: 'https://example.com/m',
                        rawDescription: 'Bot <@2> was **added** by <@3>',
                        fields: [
                            { rawName: 'Id', rawValue: '`575`', inline: true },
                            { rawName: 'Roles', rawValue: '<@&9>', inline: true },
                            { rawName: 'Note', rawValue: '> quoted line', inline: false },
                        ],
                        thumbnail: { url: 'https://x/t.png', proxyURL: 'https://media/t.png', width: 80, height: 80 },
                        image: { url: 'https://x/i.png', proxyURL: 'https://media/i.png', width: 600, height: 300 },
                        footer: { text: 'Footer here' },
                        timestamp: '2026-11-20T10:00:00Z',
                    },
                    { type: 'image', thumbnail: { url: 'https://x/only.png', proxyURL: 'https://media/only.png', width: 100, height: 100 } },
                ],
                reactions: [{ emoji: { id: null, name: '👍' }, count: 3, me: true }, { emoji: { id: '42', name: 'cat', animated: false }, count: 1, me: false }],
            }),
            msg('l2', '4', '', {
                channel_id: 'logs',
                components: [
                    {
                        type: 17,
                        accent_color: 0xff0000,
                        components: [
                            { type: 10, content: '# Update\nNew **version** out' },
                            { type: 12, items: [{ media: { url: 'https://x/g1.png', width: 200, height: 100 } }] },
                            { type: 14, divider: true },
                            { type: 9, components: [{ type: 10, content: 'Section text' }], accessory: { type: 11, media: { url: 'https://x/acc.png' } } },
                            { type: 1, components: [{ type: 2, style: 5, label: 'Open site', url: 'https://example.com/site' }] },
                        ],
                    },
                ],
            }),
            msg('l3', '4', '', { channel_id: 'logs', embeds: [{ type: 'rich' }] }),
            msg('l4', '1', 'my **own** line', { channel_id: 'logs' }),
        ],
    },
    dm1: {
        ready: true,
        _array: [msg('m1', '2', 'Hi <@1>, see <#777> <:wave:111> https://example.com/a.', { channel_id: 'dm1' }), msg('m2', '1', 'hello back', { channel_id: 'dm1' }), msg('m3', '1', '', { channel_id: 'dm1', attachments: [{ id: 'a1', filename: 'pic.png', content_type: 'image/png', width: 400, height: 200, url: 'https://cdn/pic.png', proxy_url: 'https://media/pic.png' }] })],
    },
    chat: {
        ready: true,
        hasMoreBefore: true,
        _array: [
            msg('c1', '3', 'joined', { type: 7, channel_id: 'chat' }),
            msg('c2', '3', 'first', { channel_id: 'chat' }),
            msg('c3', '3', 'second', { channel_id: 'chat' }),
            msg('c4', '4', 'reply here', { channel_id: 'chat', messageReference: { channel_id: 'chat', message_id: 'c2' }, editedTimestamp: 1 }),
        ],
    },
}
let readState = { dm1: { unread: true, mentions: 0 }, dm2: { unread: true, mentions: 2 }, chat: { unread: true, mentions: 1 } }
let relations = { 5: 3, 2: 1, 3: 1, 4: 1 }
let presence = { 2: 'offline', 3: 'online', 4: 'idle' }
const media = { mute: false, deaf: false }
const Stores = {
    UserStore: store({ getCurrentUser: () => users[1], getUser: id => users[id] }),
    ChannelStore: store({ getChannel: id => channels[id], getDMFromUserId: id => Object.values(channels).find(c => c.type === 1 && c.id !== 'dm-new' && c.recipients[0] === id)?.id }),
    PrivateChannelSortStore: store({ getPrivateChannelIds: () => ['dm1', 'dm2', 'gdm'] }),
    ReadStateStore: store({ hasUnread: id => !!readState[id]?.unread, getMentionCount: id => readState[id]?.mentions ?? 0, lastMessageId: id => messages[id]?._array.at(-1)?.id }),
    GuildReadStateStore: store({ hasUnread: id => id === 'g1', getMentionCount: id => (id === 'g1' ? 3 : 0) }),
    MessageStore: store({ getMessages: id => messages[id], getMessage: (c, id) => messages[c]?._array.find(m => m.id === id) }),
    RelationshipStore: store({ getRelationships: () => relations }),
    PresenceStore: store({ getStatus: id => presence[id] ?? 'offline' }),
    SortedGuildStore: store({ getFlattenedGuildIds: () => ['g1', 'g2'] }),
    GuildStore: store({ getGuild: id => guilds[id], getGuilds: () => guilds }),
    GuildChannelStore: store({
        getChannels: gid =>
            gid === 'g1'
                ? { SELECTABLE: ['rules', 'news', 'chat', 'logs', 'forum', 'top'].map(id => ({ channel: channels[id] })), VOCAL: [{ channel: channels.talk }] }
                : { SELECTABLE: [], VOCAL: [] },
    }),
    GuildMemberStore: store({ getNick: (g, id) => (g === 'g1' && id === '3' ? 'NaznaNick' : null), getMember: (g, id) => (id === '3' ? { colorString: '#ff8800' } : null) }),
    GuildRoleStore: store({ getRole: () => null }),
    VoiceStateStore: store({ getVoiceStatesForChannel: id => (id === 'talk' ? { a: {}, b: {} } : {}) }),
    ActiveThreadsStore: store({ getThreadsForParent: (g, p) => (p === 'forum' ? { p1: {} } : {}) }),
    ActiveJoinedThreadsStore: store({ getActiveJoinedThreadsForParent: (g, p) => (p === 'chat' ? { th1: {} } : {}) }),
    MediaEngineStore: store({ isSelfMute: () => media.mute, isSelfDeaf: () => media.deaf }),
    ThemeStore: store({ theme: 'dark' }),
}

// ── 가짜 디스코드 모듈 ──────────────────────────────────────────────────
const calls = []
const record = name => (...args) => (calls.push([name, ...args]), name === 'fetchMessages' ? Promise.resolve() : undefined)
const modules = [
    { fetchMessages: record('fetchMessages'), sendMessage: record('sendMessage'), receiveMessage() {} },
    { selectVoiceChannel: record('selectVoiceChannel') },
    { transitionToGuild: record('transitionToGuild') },
    { acceptFriendRequest: record('acceptFriendRequest'), addRelationship() {}, cancelFriendRequest: record('cancelFriendRequest') },
    { getOrEnsurePrivateChannel: async id => (calls.push(['getOrEnsurePrivateChannel', id]), 'dm-new') },
    { openCollectiblesShopMobile: record('openCollectiblesShopMobile') },
    { openQuestHome: record('openQuestHome') },
    { openUserSettings: record('openUserSettings') },
    { editMessage: record('editMessage'), deleteMessage: record('deleteMessage') },
    { addReaction: record('addReaction'), removeReaction: record('removeReaction') },
    {
        HTTP: {
            get: async o => {
                calls.push(['GET', o.url, o.query])
                if (o.url === '/channels/forum/threads/search')
                    return {
                        body: {
                            threads: [{ id: 'p2', name: 'Old post', owner_id: '2', message_count: 2, applied_tags: ['t2'], last_message_id: '1200000000000000000', thread_metadata: { archived: true } }],
                            first_messages: [{ id: 'p2', channel_id: 'p2', content: 'old **first**', author: { id: '2', username: 'seina' }, attachments: [{ url: 'https://x/p2.png', proxy_url: 'https://media/p2.png', content_type: 'image/png', width: 10, height: 10 }] }],
                            has_more: false,
                        },
                    }
                if (o.url === '/channels/p1/messages/p1') return { body: { id: 'p1', channel_id: 'p1', content: 'active first', author: { id: '3' } } }
                throw new Error('404')
            },
            post: async o => (calls.push(['POST', o.url, o.body]), { body: { id: 'p3', name: o.body.name, owner_id: '1', message_count: 0, applied_tags: o.body.applied_tags } }),
        },
    },
    { toggleSelfMute: () => ((media.mute = !media.mute), Stores.MediaEngineStore.emit()), toggleSelfDeaf: () => ((media.deaf = !media.deaf), Stores.MediaEngineStore.emit()) },
]
const toasts = []
const dispatched = []
const navigated = []
const MISSING_ICONS = new Set(['ScreenArrowIcon', 'PowerIcon'])
const iconCache = new Map()
const lookupGeneratedIconComponent = name => {
    if (MISSING_ICONS.has(name)) return undefined
    if (!iconCache.has(name)) iconCache.set(name, () => h('i', { 'data-icon': name }))
    return iconCache.get(name)
}
const toastHost = { default: function AppToastContainer() {
    return h('div', { 'data-toasts': toasts.length })
} }
const toastOriginal = toastHost.default
let toastLoaded = false
const waiting = []
let picked = 'content://picked.png'

let cache = {}
const storageListeners = new Set()
const storage = {
    get cache() {
        return cache
    },
    get: async () => cache,
    set: (v, replace) => {
        cache = replace ? v : { ...cache, ...v }
        storageListeners.forEach(f => f())
    },
    use: () => React.useSyncExternalStore(f => (storageListeners.add(f), () => storageListeners.delete(f)), () => cache, () => cache),
}

const D = name => ({ children, label, title, subLabel, value, onPress, onValueChange, onChange, placeholder }) => {
    if (onPress && label) presses.set(`row:${label}`, onPress)
    if (onChange && label) inputs.set(`field:${label}`, { onChange })
    if (onValueChange && label) presses.set(`switch:${label}`, onValueChange)
    return h('section', { 'data-d': name, 'data-label': label ?? title ?? '', 'data-sub': subLabel ?? '', 'data-value': String(value ?? '') }, children)
}
globalThis.valenced = {
    react: { React, ReactNative },
    components: { Page: ({ children }) => h('main', null, children) },
    discord: {
        actions: { ToastActionCreators: { open: (key, o) => toasts.push(o.text) } },
        common: { flux: { Dispatcher: { dispatch: e => dispatched.push(e) } } },
        design: { Design: { Stack: D('Stack'), TableRowGroup: D('Group'), TableSwitchRow: D('Switch'), TableRow: D('Row'), TextInput: D('TextInput') } },
        flux: { Stores },
        modules: { mainTabsV2: { RootNavigationRef: { getRootNavigationRef: () => ({ isReady: () => true, navigate: (...a) => navigated.push(a) }) } } },
        utils: {
            modules: {
                finders: {
                    getModuleWithImportedPath: (path, cb) => (cb(path.includes('AppToastContainer') && toastLoaded ? toastHost : undefined), () => {}),
                    waitForModuleWithImportedPath: (path, cb) => (waiting.push([path, cb]), () => {}),
                    lookupModuleWithImportedPath: path => (path === 'modules/image/native/ImagePicker.tsx' ? { default: { launchImageLibraryAsync: async () => (picked ? { assets: [{ uri: picked }] } : { didCancel: true }) } } : undefined),
                },
            },
        },
    },
    externals: { ReactNativeClipboard: { Clipboard: { setString: t => copied.push(t) } }, ReactNativeSafeAreaContext: { ReactNativeSafeAreaContext: { useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) } } },
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
            return () => {
                obj[key] = orig
            }
        },
    },
    utils: { discord: { lookupGeneratedIconComponent } },
}
globalThis.plugin = d => d

const src = readFileSync(new URL('../plugins/stella-ui/build/js/index.js', import.meta.url), 'utf8')
const exported = new Function(`return ${src}`)()
const def = exported.default

// ── 그리기 ──────────────────────────────────────────────────────────────
const host = doc.createElement('div')
doc.body.appendChild(host)
const root = createRoot(host)
function App() {
    return h(toastHost.default)
}
async function render() {
    await act(async () => root.render(h(App)))
    await act(async () => {
        await tick()
    })
    return host.textContent
}
const html = () => {
    const walk = n => (n.nodeType === 3 ? n.nodeValue : `<${n.nodeName} ${Object.entries(n.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}>${n.childNodes.map(walk).join('')}</${n.nodeName}>`)
    return walk(host)
}
async function press(label, i = 0) {
    const list = presses.get(label)
    const f = Array.isArray(list) ? list[i]?.get() : list
    if (!f) console.log(results.join('\n') + '\n--- ' + host.textContent.slice(0, 600))
    if (!f) throw new Error(`no button "${label}" (have: ${[...presses.keys()].join(', ')})`)
    await act(async () => {
        await f()
        await tick()
    })
    return render()
}
const state = () => exported.getState()

// ── 시험 ────────────────────────────────────────────────────────────────
const cleanups = []
def.start({ cleanup: f => cleanups.push(f), jsonStorage: storage })
check('waits for the toast host when it is not loaded yet', waiting.some(([p]) => p.includes('AppToastContainer')))
toastLoaded = true
waiting.splice(0).forEach(([p, cb]) => cb(toastHost))
check('patches the toast host', toastHost.default !== toastOriginal)
await tick()
check('opens the lobby on start', state().visible === true && state().route === 'lobby')

let text = await render()
check('toasts still drawn on top', html().indexOf('data-toasts') > html().indexOf('출발'))
check('lobby: start, heart chat, quests, shop buttons', ['출발', '하트챗', '임무', '구매'].every(t => text.includes(t)), text.slice(0, 300))
check('lobby: my name', text.includes('DeStinY'))
check('lobby: friends online (idle counts), unread DMs, mentions: 2, 2, 3', /FriendsIcon.*?<SPAN >2<\/SPAN>.*?ChatIcon.*?<SPAN >2<\/SPAN>.*?AtIcon.*?<SPAN >3<\/SPAN>/.test(html()), html().slice(0, 1500))
check('lobby: greeting mentions unread DMs', text.includes('안 읽은 대화가 2개 있어요.'), text)
check('lobby: default picture is my avatar', html().includes('https://cdn/avatars/1.png?size=512'))
check('lobby: missing icons do not crash', !html().includes('data-icon="ScreenArrowIcon"'))

// 말풍선 바꾸기
await press('Character')
check('tapping the character changes the line', !host.textContent.includes('안 읽은 대화가 2개 있어요.'))

// 마이크
await press('Mute')
check('mute button toggles and redraws from the store', media.mute === true && !!presses.get('Unmute')?.length)
await press('Unmute')

// 메뉴
await press('Menu')
check('menu opens', state().menu === true && host.textContent.includes('메뉴'))
await press('설정')
check('menu → settings hides the game screen', state().visible === false && state().menu === false)
await new Promise(r => setTimeout(r, 80))
check('menu → settings opens Discord settings', calls.some(c => c[0] === 'openUserSettings'))
text = await render()
check('edge tab shows when hidden', !!presses.get('Open Stella UI')?.length && !text.includes('출발'))
await press('Open Stella UI')
check('edge tab brings the lobby back', state().visible === true)

await press('알림')
await new Promise(r => setTimeout(r, 80))
check('mail → Discord notifications', navigated.some(a => a[0] === 'notifications') && state().visible === false)
await press('Open Stella UI')
await press('임무')
await new Promise(r => setTimeout(r, 80))
check('quests → openQuestHome', calls.some(c => c[0] === 'openQuestHome'))
await press('Open Stella UI')
await press('구매')
await new Promise(r => setTimeout(r, 80))
check('shop → openCollectiblesShopMobile with a source', calls.some(c => c[0] === 'openCollectiblesShopMobile' && c[1]?.analyticsSource))
await press('Open Stella UI')

// 출발
text = await press('출발')
check('start → server list', state().route === 'depart' && text.includes('Valenced') && text.includes('Codex'))
check('server card uses the banner', html().includes('https://cdn.discordapp.com/banners/g1/b1.png?size=512'))
check('server without picture shows its first letter', text.includes('C'))
check('server with mentions has a badge', text.includes('!'))
text = await press('Valenced')
check('server card → channel screen', state().route === 'guild' && state().guildId === 'g1')
check('channels grouped by category', text.indexOf('INFO') < text.indexOf('rules') && text.indexOf('GENERAL') < text.indexOf('chat'))
check('channels without a category come first', text.indexOf('welcome') < text.indexOf('INFO'))
check('voice channels after text in a category', text.indexOf('help') < text.lastIndexOf('talk'))
check('voice shows people count', html().includes('talk') && text.includes('2'))
check('nothing chosen yet', text.includes('채널을 선택하세요.'))
check('place chip shows the server', html().includes('LocationIcon') && text.split('Valenced').length > 2)

// 채팅
text = await press('chat')
check('channel opens a chat', state().channelId === 'chat' && text.includes('first') && text.includes('second'))
check('server chat shows names, nickname', text.includes('NaznaNick'))
check('join message as a system line', text.includes('NaznaNick 님이 들어왔어요'))
check('reply shows the original inside the bubble, no arrow', /NaznaNickfirstreplyhere/.test(text.replace(/\s/g, '')) && !html().includes('ArrowAngleRightUpIcon'), text)
await press('reply to c2')
check('tapping the reply jumps to the original', scrolled.some(o => o.index === exported.buildRows(messages.chat._array, '1').findIndex(r => r.m.id === 'c2')), JSON.stringify(scrolled))
check('edited mark', text.includes('(수정됨)'))
check('marks the channel read while open', dispatched.some(e => e.type === 'BULK_ACK' && e.channels[0].channelId === 'chat'))
check('does not refetch a ready channel', !calls.some(c => c[0] === 'fetchMessages' && c[1]?.channelId === 'chat' && !c[1].before))
check('topic shown as one line', text.includes('Read me first'))

// 새 메시지가 오면 다시 그린다
messages.chat = { ...messages.chat, _array: [...messages.chat._array, msg('c9', '4', 'live message', { channel_id: 'chat' })] }
await act(async () => Stores.MessageStore.emit())
check('new message appears', host.textContent.includes('live message'))

// 보내기
const box = [...inputs.entries()].find(([k, v]) => k.includes('chat') && v.length)
check('composer placeholder names the channel', !!box, [...inputs.keys()].join('|'))
await act(async () => box[1][0].get().onChangeText('  hi there  '))
await render()
await press('Send')
const sent = calls.find(c => c[0] === 'sendMessage')
check('send trims and uses Discord sendMessage(channelId, message, undefined, options)', sent && sent[1] === 'chat' && sent[2].content === 'hi there' && sent[2].tts === false && sent[3] === undefined)
check('composer clears after sending', box[1][0].get().value === '')

// 임베드, 컴포넌트, 반응
text = await press('logs')
check('embed: author, title, description with mentions and bold', text.includes('Logger') && text.includes('Member Joined') && text.includes('Bot @Seina was added by @NaznaNick') && !text.includes('**'), text)
check('embed: fields in a row, code and role, quote', text.includes('Id') && text.includes('575') && text.includes('@역할') && text.includes('quoted line'))
check('embed: thumbnail, image, footer', html().includes('https://media/t.png') && html().includes('https://media/i.png') && text.includes('Footer here'))
check('image-only link embed shows the picture', html().includes('https://media/only.png'))
check('components v2: heading, bold, gallery, section, button', text.includes('Update') && text.includes('New version out') && html().includes('https://x/g1.png') && text.includes('Section text') && html().includes('https://x/acc.png') && text.includes('Open site'))
check('nothing to show → a short note, not an empty bubble', text.includes('[표시할 수 없는 메시지]'))
check('my markdown in a blue bubble', text.includes('my own line') && !text.includes('**own**'))
check('reactions with counts', text.includes('👍') && text.includes('3') && html().includes('emojis/42.webp'))
await press('reaction 👍')
check('my reaction → remove', calls.some(c => c[0] === 'removeReaction' && c[1] === 'logs' && c[2] === 'l1' && c[3].name === '👍'))
await press('reaction cat')
check('other reaction → add with the custom emoji', calls.some(c => c[0] === 'addReaction' && c[3].id === '42' && c[3].name === 'cat'))
await press('Open site')
check('link button opens', opened.includes('https://example.com/site'))

// 꾹 누르기 메뉴
await press('long:message l1')
check('long press opens the message menu', host.textContent.includes('답장') && host.textContent.includes('Logger') === true)
await press('react 🔥')
check('quick reaction adds', calls.some(c => c[0] === 'addReaction' && c[3].name === '🔥' && c[3].id === null))
await press('long:message l1')
await press('답장')
check('reply bar shows who', host.textContent.includes('Tillia 에게 답장'))
const logBox = () => [...inputs.entries()].find(([k, v]) => k.includes('logs') && v.length)[1][0].get()
await act(async () => logBox().onChangeText('a reply'))
await press('Send')
const replied = calls.filter(c => c[0] === 'sendMessage').at(-1)
check('reply sends a message reference', replied[1] === 'logs' && replied[4]?.messageReference?.message_id === 'l1' && replied[4].messageReference.guild_id === 'g1')
check('reply bar closes after sending', !host.textContent.includes('에게 답장'))
await press('long:message l4')
check('my message: edit, delete, copy', ['수정', '삭제', '글 복사'].every(t => host.textContent.includes(t)))
await press('글 복사')
check('copy puts the text on the clipboard', copied.includes('my **own** line'))
await press('long:message l4')
await press('수정')
check('edit fills the composer', logBox().value === 'my **own** line' && host.textContent.includes('메시지 수정 중'))
await act(async () => logBox().onChangeText('fixed'))
await press('Send')
check('edit uses editMessage(channel, id, { content })', calls.some(c => c[0] === 'editMessage' && c[1] === 'logs' && c[2] === 'l4' && c[3].content === 'fixed'))
await press('long:message l4')
await press('삭제')
check('delete asks once more', host.textContent.includes('정말 지울까요') && !calls.some(c => c[0] === 'deleteMessage'))
await press('정말 지울까요? 한 번 더 누르세요')
check('delete on the second press', calls.some(c => c[0] === 'deleteMessage' && c[1] === 'logs' && c[2] === 'l4'))
await press('long:message l1')
check('others cannot edit or delete', !host.textContent.includes('수정') && !host.textContent.includes('삭제'))
await press('Close message menu')

// 키보드: 화면이 줄지 않으면 가려진 만큼만, 줄어들면 0
const pb = () => Number(html().match(/data-pb="(\d+)"/)?.[1] ?? -1)
const kbShow = async y => {
    await act(async () => kbListeners.filter(([t]) => t === 'keyboardDidShow').forEach(([, f]) => f({ endCoordinates: { screenY: y, height: 800 - y } })))
    await act(async () => new Promise(r => setTimeout(r, 90)))
}
layout.y = 0
layout.h = 800
await kbShow(500)
check('keyboard over an unresized screen → pad by what is covered', pb() === 300, pb())
layout.h = 500
await kbShow(500)
check('screen already shrunk → no extra gap', pb() === 0, pb())
await act(async () => kbListeners.filter(([t]) => t === 'keyboardDidHide').forEach(([, f]) => f()))
check('keyboard hidden → no pad', pb() === 0)
layout.h = 800
await press('chat')

// 음성, 포럼
await press('talk')
check('voice channel → join', calls.some(c => c[0] === 'selectVoiceChannel' && c[1] === 'talk') && toasts.some(t => t.includes('talk')))
// 스레드: 채널 아래 내가 들어간 스레드
check('joined thread under its channel', host.textContent.indexOf('side talk') > host.textContent.indexOf('chat'))
text = await press('side talk')
check('thread opens as a chat with its parent as subtitle', state().channelId === 'th1' && text.includes('#chat'))

// 포럼
text = await press('help')
check('forum opens in Stella, not Discord', state().visible === true && state().channelId === 'forum' && text.includes('Ask here'))
check('forum loads archived posts with the search API', calls.some(c => c[0] === 'GET' && c[1] === '/channels/forum/threads/search' && c[2].archived === true && c[2].offset === 0))
text = host.textContent
check('pinned active post first, then archived', text.indexOf('Active post') < text.indexOf('Old post') && text.includes('보관됨'))
check('post cards: preview without markdown, image, tags, counts', text.includes('old first') && html().includes('https://media/p2.png') && text.includes('Bug') && text.includes('Idea') && text.includes('4'))
check('active post first message fetched once', calls.filter(c => c[0] === 'GET' && c[1] === '/channels/p1/messages/p1').length === 1 && text.includes('active first'))
await press('tag Idea')
check('tag filter', !host.textContent.includes('Active post') && host.textContent.includes('Old post'))
await press('tag 전체')
text = await press('Old post')
check('archived post opens as a chat', state().channelId === 'p2' && text.includes('Old post') && text.includes('#help') && calls.some(c => c[0] === 'fetchMessages' && c[1]?.channelId === 'p2'))
await act(async () => [...backHandlers][0]())
check('back from a post → the forum', state().channelId === 'forum')
await press('글 쓰기')
await act(async () => inputs.get('제목')[0].get().onChangeText('New idea'))
await act(async () => inputs.get('내용')[0].get().onChangeText('details'))
await render()
await press('tag Idea', 1)
await press('올리기')
await act(async () => tick())
check('new post: POST threads with name, message and tags', calls.some(c => c[0] === 'POST' && c[1] === '/channels/forum/threads' && c[2].name === 'New idea' && c[2].message.content === 'details' && c[2].applied_tags.includes('t2')))
check('new post opens', state().channelId === 'p3')
await act(async () => [...backHandlers][0]())

// 뒤로 가기 (넓은 화면): 서버 → 출발 → 로비
check('back handler registered while visible', backHandlers.size === 1)
await act(async () => [...backHandlers][0]())
check('hardware back: server → start', state().route === 'depart')
await act(async () => [...backHandlers][0]())
check('hardware back: start → lobby', state().route === 'lobby')

// 하트챗
text = await press('하트챗')
check('heart chat: contacts in recent order', state().route === 'heart' && text.indexOf('Seina') < text.indexOf('Nazna') && text.includes('Party'))
check('heart chat: last message preview (file)', text.includes('[파일]'))
check('heart chat: empty state', text.includes('연락처를 선택해 대화를 시작하세요.'))
text = await press('Seina')
check('contact → chat', state().dmId === 'dm1' && text.includes('hello back'))
check('mention, channel, link parsed', text.includes('@DeStinY') && text.includes('#general') && !text.includes('<#') && html().includes('emojis/111.webp'))
check('my image attachment drawn', html().includes('https://media/pic.png'))
await press('text:')
check('links open', opened.includes('https://example.com/a'))
text = await press('Nazna')
check('dm without messages loads them', calls.some(c => c[0] === 'fetchMessages' && c[1]?.channelId === 'dm2' && c[1].limit === 50))

// 신청, 친구
text = await press('Lobby')
check('power button → lobby', state().route === 'lobby')
await press('친구') // 위 아이콘 줄의 친구 (신청이 있으면 신청 탭)
check('friends icon opens requests when there are some', state().route === 'heart' && state().heartTab === 'requests')
text = await render()
check('requests list', text.includes('Hotaru'))
await press('Accept')
check('accept uses acceptFriendRequest({ userId, context })', calls.some(c => c[0] === 'acceptFriendRequest' && c[1].userId === '5' && c[1].context))
await press('Decline')
check('decline uses cancelFriendRequest', calls.some(c => c[0] === 'cancelFriendRequest' && c[1] === '5'))
relations = { 2: 1, 3: 1, 4: 1 }
await act(async () => Stores.RelationshipStore.emit())
check('request list updates', host.textContent.includes('받은 친구 신청이 없어요'))
await press('친구')
text = host.textContent
check('friends sorted online, idle, offline', text.indexOf('Nazna') < text.indexOf('Tillia') && text.indexOf('Tillia') < text.indexOf('Seina'), text)
await press('Tillia')
check('friend without a DM → creates one and opens it', calls.some(c => c[0] === 'getOrEnsurePrivateChannel' && c[1] === '4') && state().dmId === 'dm-new' && state().heartTab === 'contacts')

// 좁은 화면
win = { width: 600, height: 900 }
await render()
check('narrow: only the chat when a DM is open', !host.textContent.includes('연락처를 선택해') && !!presses.get('리스트')?.length)
await press('리스트')
check('narrow: list button goes back to contacts', state().dmId === undefined && host.textContent.includes('Seina'))
win = { width: 1280, height: 800 }

// 설정 화면
const pageHost = doc.createElement('div')
const pageRoot = createRoot(pageHost)
await act(async () => pageRoot.render(h(def.SettingsComponent)))
check('settings: rows', ['row:Character', 'row:Background', 'switch:Open on start', 'row:Open the lobby'].every(k => presses.has(k)))
await act(async () => presses.get('row:Character')())
await act(async () => tick())
check('choose character from the gallery', cache.character === 'content://picked.png')
picked = undefined
await act(async () => presses.get('row:Background')())
check('cancel keeps the old picture', !cache.background)
inputs.get('field:Character lines').onChange('안녕\n\n반가워')
check('lines are not saved on every key', !cache.lines)
await act(async () => new Promise(r => setTimeout(r, 600)))
check('custom lines saved after a pause', exported.greetings(cache.lines, 9, 0).join('|') === '안녕|반가워')
check('default lines by time', exported.greetings('', 8, 0)[0].includes('아침') && exported.greetings('', 23, 0)[0].includes('하루'))
await act(async () => presses.get('switch:Open on start')(false))
check('open on start can be turned off', cache.openOnStart === false)
await act(async () => pageRoot.unmount())

// 직접 고른 그림이 로비에 나온다
await press('Lobby')
check('character picture used in the lobby', html().includes('content://picked.png'))

// 그리다 오류가 나면 디스코드 화면으로 돌아가고, 다시 열면 다시 그린다
const getMe = Stores.UserStore.getCurrentUser
Stores.UserStore.getCurrentUser = () => {
    throw new Error('boom')
}
const quiet = console.error
console.error = () => {}
await press('출발')
await press('Lobby')
console.error = quiet
check('render error → back to Discord with a toast', state().visible === false && toasts.some(t => t.includes('문제가 생겨')))
Stores.UserStore.getCurrentUser = getMe
await press('Open Stella UI')
check('opening again draws the lobby', state().visible === true && host.textContent.includes('출발'))

// 좁은 로비
win = { width: 400, height: 860 }
text = await render()
check('narrow lobby renders', text.includes('출발') && text.includes('하트챗'))
win = { width: 1280, height: 800 }

// 순수 함수
const md = (t, g) => exported.blocks(t, g)
const kinds = nodes => nodes.map(n => n.t).join(',')
check('inline: bold, italic, underline, strike, spoiler, code', kinds(exported.inline('**b** *i* __u__ ~~s~~ ||x|| `c`')) === 'b,text,i,text,u,text,s,text,spoiler,text,code', kinds(exported.inline('**b** *i* __u__ ~~s~~ ||x|| `c`')))
check('inline: nested bold in link label', JSON.stringify(exported.inline('[**hi**](https://a.b/c)')[0]).includes('"t":"b"'))
const ins = exported.inline('a <@2> <@!3> <@&9> <#777> <a:dance:55> http://x.y/z) end', 'g1')
check('inline: mentions, role, channel, emoji, link', kinds(ins) === 'text,mention,text,mention,text,mention,text,mention,text,emoji,text,link,text', kinds(ins))
check('inline: nickname, link stops before )', ins[3].v === '@NaznaNick' && ins[11].url === 'http://x.y/z')
check('inline: unknown user', exported.inline('<@999>')[0].v === '@알 수 없는 사용자')
check('inline: snake_case words stay plain', kinds(exported.inline('my_var_name ok')) === 'text')
check('inline: lone asterisks stay plain', kinds(exported.inline('2 * 3 * 4')) === 'text')
check('blocks: heading, subtext, list, quote, code block', kinds(md('# T\n-# small\n- a\n> q1\n> q2\ntext\n```js\nx = 1\n```')) === 'h,sub,li,quote,p,codeblock', kinds(md('# T\n-# small\n- a\n> q1\n> q2\ntext\n```js\nx = 1\n```')))
check('blocks: >>> quotes the rest', md('a\n>>> b\nc')[1].t === 'quote' && md('a\n>>> b\nc')[1].c.length === 1)
check('blocks: code block keeps markdown as is', md('```**x**```')[0].v === '**x**')
check('plain text drops markers', exported.plainText('**hi**   <:a:1>\n> there `x`') === 'hi :a: there x')
check('timestamps', exported.formatTime(0, 'R', 3600 * 1000) === '1시간 전' && exported.inline('<t:0:d>')[0].t === 'time')
check('preview: embed title when no text', exported.previewText({ content: '', embeds: [{ rawTitle: '**Hi**' }] }) === 'Hi')
check('embed color from number and string', exported.embedColor({ color: 255 }) === '#0000ff' && exported.embedColor({ color: '#ABCDEF' }) === '#ABCDEF' && exported.embedColor({}) === undefined)
const rowsBuilt = exported.buildRows(messages.chat._array, '4')
check('rows newest first, grouping', rowsBuilt[0].m.id === 'c9' && rowsBuilt.find(r => r.m.id === 'c3').head === false && rowsBuilt.find(r => r.m.id === 'c2').head === true)
check('rows mark my messages', rowsBuilt.find(r => r.m.id === 'c9').mine === true)
check('empty guild has no sections', exported.guildSections('g2').length === 0)

// 끄기
await act(async () => root.unmount())
cleanups.forEach(f => typeof f === 'function' && f())
check('cleanup restores the toast host', toastHost.default === toastOriginal)
check('cleanup removes listeners', Object.values(Stores).every(s => s.listeners.size === 0), Object.entries(Stores).filter(([, s]) => s.listeners.size).map(([k, s]) => `${k}:${s.listeners.size}`).join(','))
check('cleanup hides and resets', state().visible === false && state().route === 'lobby')

console.log(results.join('\n'))
console.log(`fails: ${fails}`)
process.exit(fails ? 1 : 0)
