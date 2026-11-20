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
const opened = []
const clean = props => {
    const out = {}
    for (const [k, v] of Object.entries(props)) if (k.startsWith('data-')) out[k] = v
    return out
}
const View = ({ children, pointerEvents, ...p }) => h('div', clean(p), children)
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
const Pressable = ({ children, onPress, accessibilityLabel, disabled, style }) => {
    if (typeof style === 'function') style({ pressed: false })
    useRegister(presses, onPress ? accessibilityLabel : '', disabled ? () => {} : onPress)
    return h('div', { 'data-press': accessibilityLabel ?? '' }, typeof children === 'function' ? children({ pressed: false }) : children)
}
const TextInput = ({ value, placeholder, onChangeText }) => {
    useRegister(inputs, placeholder ?? '', { onChangeText, value })
    return h('input', { 'data-value': value ?? '', 'data-placeholder': placeholder ?? '' })
}
const FlatList = ({ data, renderItem, keyExtractor, ListEmptyComponent }) =>
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
    Keyboard: { addListener: () => ({ remove() {} }) },
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
    talk: { id: 'talk', type: 2, name: 'talk', guild_id: 'g1', parent_id: 'cat2', position: 0 },
    forum: { id: 'forum', type: 15, name: 'help', guild_id: 'g1', parent_id: 'cat2', position: 2 },
    777: { id: '777', type: 0, name: 'general' },
    top: { id: 'top', type: 0, name: 'welcome', guild_id: 'g1', position: 5 },
}
const guilds = {
    g1: { id: 'g1', name: 'Valenced', icon: 'i1', banner: 'b1', getIconURL: size => `https://cdn/icons/g1.png?size=${size}` },
    g2: { id: 'g2', name: 'Codex', icon: null },
}
const msg = (id, author, content, extra = {}) => ({ id, author: users[author], content, type: 0, timestamp: new Date(Date.UTC(2026, 10, 20, 10, 0, Number(id.replace(/\D/g, '')) || 0)), attachments: [], embeds: [], channel_id: extra.channel_id, ...extra })
const messages = {
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
                ? { SELECTABLE: ['rules', 'news', 'chat', 'forum', 'top'].map(id => ({ channel: channels[id] })), VOCAL: [{ channel: channels.talk }] }
                : { SELECTABLE: [], VOCAL: [] },
    }),
    GuildMemberStore: store({ getNick: (g, id) => (g === 'g1' && id === '3' ? 'NaznaNick' : null), getMember: (g, id) => (id === '3' ? { colorString: '#ff8800' } : null) }),
    GuildRoleStore: store({ getRole: () => null }),
    VoiceStateStore: store({ getVoiceStatesForChannel: id => (id === 'talk' ? { a: {}, b: {} } : {}) }),
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
    externals: { ReactNativeSafeAreaContext: { ReactNativeSafeAreaContext: { useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) } } },
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
check('voice channels after text in a category', text.indexOf('help') < text.indexOf('talk'))
check('voice shows people count', html().includes('talk') && text.includes('2'))
check('nothing chosen yet', text.includes('채널을 선택하세요.'))
check('place chip shows the server', html().includes('LocationIcon') && text.split('Valenced').length > 2)

// 채팅
text = await press('chat')
check('channel opens a chat', state().channelId === 'chat' && text.includes('first') && text.includes('second'))
check('server chat shows names, nickname', text.includes('NaznaNick'))
check('join message as a system line', text.includes('NaznaNick 님이 들어왔어요'))
check('reply line shows the original', text.includes('NaznaNick: first'))
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

// 음성, 포럼
await press('talk')
check('voice channel → join', calls.some(c => c[0] === 'selectVoiceChannel' && c[1] === 'talk') && toasts.some(t => t.includes('talk')))
await press('help')
check('forum → opens in Discord', calls.some(c => c[0] === 'transitionToGuild' && c[1] === 'g1' && c[2] === 'forum') && state().visible === false)
await press('Open Stella UI')

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
await press('text:https://example.com/a')
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
const pieces = exported.parseContent('a <@2> <@!3> <@&9> <#777> <a:dance:55> http://x.y/z) end', 'g1')
check('parse: mentions, roles, channels, animated emoji, links', JSON.stringify(pieces.map(p => p.t)) === JSON.stringify(['text', 'mention', 'text', 'mention', 'text', 'mention', 'text', 'mention', 'text', 'emoji', 'text', 'link', 'text']), JSON.stringify(pieces))
check('parse: nickname for mentions in a server', pieces[3]?.v === '@NaznaNick')
check('parse: link stops before )', pieces[11]?.v === 'http://x.y/z')
check('plain text', exported.plainText('hi   <:a:1>\nthere') === 'hi :a: there')
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
