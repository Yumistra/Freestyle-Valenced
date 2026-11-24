// Message Logger 를 디스코드 없이 시험한다.
// 빌드된 index.js 를 가짜 디스코드(스토어, 플럭스 이벤트, 네이티브 함수) 위에서 돌리고, 로그 화면은 진짜 React 로 그린다.
// 사용법: node scripts/build.mjs everything-logger && node tests/everything-logger.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { install } from './lib/fakedom.mjs'

const require = createRequire(import.meta.url)
const doc = install()
const React = require('react')
const { createRoot } = require('react-dom/client')
const h = React.createElement
const { act } = React
const consoleError = console.error
console.error = (...a) => (String(a[0]).includes('not wrapped in act') ? undefined : consoleError(...a))

let fails = 0
const results = []
function check(name, ok, extra = '') {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : `  (${String(extra).slice(0, 400)})`}`)
    if (!ok) fails++
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── 가짜 react-native ───────────────────────────────────────────────────
const presses = new Map()
const inputs = new Map()
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
const View = ({ children }) => h('div', null, children)
const Pressable = ({ children, onPress, onLongPress, accessibilityLabel }) => {
    useRegister(presses, onPress ? accessibilityLabel : '', onPress)
    useRegister(presses, onLongPress ? `long:${accessibilityLabel}` : '', onLongPress)
    return h('div', { 'data-press': accessibilityLabel ?? '' }, typeof children === 'function' ? children({ pressed: false }) : children)
}
const TextInput = ({ value, placeholder, onChangeText, onSubmitEditing }) => {
    useRegister(inputs, placeholder ?? '', { onChangeText, onSubmitEditing, value })
    return h('input', { 'data-value': value ?? '', 'data-placeholder': placeholder ?? '' })
}
const Image = ({ source }) => h('img', { 'data-src': source?.uri ?? '' })
const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent }) => h('div', null, ListHeaderComponent ?? null, (data ?? []).map((item, index) => h(React.Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index }))))
const processColor = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? (0xff000000 | parseInt(c.slice(1), 16)) >>> 0 : 0xff888888)
const picked = { file: '' }
const ReactNative = {
    View,
    Text: ({ children }) => h('span', null, children),
    Image,
    Pressable,
    TextInput,
    FlatList,
    ScrollView: View,
    processColor,
    LayoutAnimation: { configureNext() {}, Presets: { easeInEaseOut: {} } },
    AppState: { addEventListener: () => ({ remove() {} }) },
    NativeModules: { RNDocumentPicker: { pick: async () => [{ uri: 'content://x', fileCopyUri: 'file:///cache/import.json' }] } },
}

// ── 가짜 디스코드 ───────────────────────────────────────────────────────
const ME = '1'
const users = {
    1: { id: '1', username: 'me', globalName: 'Me' },
    2: { id: '2', username: 'seina', globalName: 'Seina' },
    3: { id: '3', username: 'nazna', globalName: 'Nazna' },
    9: { id: '9', username: 'bot', globalName: 'Bot', bot: true },
}
const channelsById = {
    dm: { id: 'dm', type: 1, recipients: ['2'] },
    gen: { id: 'gen', type: 0, name: 'general', guild_id: 'g1' },
    side: { id: 'side', type: 0, name: 'side', guild_id: 'g2' },
    th: { id: 'th', type: 11, name: 'a thread', guild_id: 'g1', parent_id: 'gen' },
}
const rec = (id, c, author, content, extra = {}) => ({ id, channel_id: c, author: users[author], content, state: 'SENT', flags: 0, attachments: [], mentions: [], timestamp: new Date(), ...extra })
const store = {}
const put = m => ((store[m.channel_id] ??= {})[m.id] = m)
const Stores = {
    AuthenticationStore: { getId: () => ME },
    UserStore: { getUser: id => users[id], getCurrentUser: () => users[ME] },
    ChannelStore: { getChannel: id => channelsById[id], getDMFromUserId: id => (id === '2' ? 'dm' : undefined) },
    GuildStore: { getGuild: id => ({ g1: { id: 'g1', name: 'Guild One' }, g2: { id: 'g2', name: 'Guild Two' } })[id], getGuilds: () => ({ g1: { id: 'g1', name: 'Guild One' }, g2: { id: 'g2', name: 'Guild Two' } }) },
    SortedGuildStore: { getFlattenedGuildIds: () => ['g1', 'g2'] },
    MessageStore: { getMessage: (c, id) => store[c]?.[id], getMessages: c => ({ toArray: () => Object.values(store[c] ?? {}) }) },
    RelationshipStore: { isFriend: id => id === '3' },
    ThemeStore: { theme: 'dark' },
    LocaleStore: { locale: 'en-US' },
}
const handlers = {}
const native = []
let companionLines = ''
const designCache = {}
const Design = new Proxy(
    {},
    {
        // 같은 이름은 같은 컴포넌트 (아니면 매번 새로 마운트된다)
        get: (_t, name) => (designCache[name] ??= props => {
            if (name === 'Button') return h(Pressable, { accessibilityLabel: props.text, onPress: props.onPress }, h('span', null, props.text))
            if (name === 'TableSwitchRow') return h(Pressable, { accessibilityLabel: props.label, onPress: () => props.onValueChange(!props.value) }, h('span', null, `${props.label}:${props.value ? 'on' : 'off'}`))
            if (name === 'RowButton') return h(Pressable, { accessibilityLabel: props.label, onPress: props.onPress }, h('span', null, props.label))
            if (name === 'TableRow') return h(Pressable, { accessibilityLabel: props.label, onPress: props.onPress }, h('span', null, props.label), h('span', null, props.subLabel ?? ''))
            if (name === 'Text') return h('span', null, props.children)
            return h('section', { 'data-title': props.title ?? '' }, props.title ? h('b', null, props.title) : null, props.children)
        }),
    },
)
const storage = { cache: {}, set(v) { this.cache = v }, get() { return this.cache } }
const files = { '/cache/import.json': '' }
globalThis.valenced = {
    react: { React, ReactNative },
    components: { TableRowAssetIcon: () => null },
    discord: {
        actions: { ActionSheetActionCreators: { hideActionSheet() {} } },
        common: { constants: { Constants: {} }, flux: { Dispatcher: { dispatch: () => {} } }, tokens: { Tokens: { default: { colors: {}, internal: { resolveSemanticColor: () => undefined } } } } },
        design: { Design },
        flux: { Stores, onFluxEventDispatched: (type, f) => ((handlers[type] ??= []).push(f), () => (handlers[type] = handlers[type].filter(x => x !== f))) },
        modules: { settings: { registerSettingsItem: () => () => {}, refreshSettings() {} } },
        native: { FileModule: { getConstants: () => ({ DocumentsDirPath: '/docs' }), writeFile: async () => {} } },
    },
    externals: { ReactNavigation: { ReactNavigationNative: { useNavigation: () => ({ navigate() {}, canGoBack: () => false }) } } },
    modules: {
        finders: { getModules: () => () => {}, lookupModule: () => [], filters: { withName: () => () => false, withProps: () => () => false } },
        native: {
            callNativeMethod: async (name, args) => {
                native.push([name, args])
                if (name.endsWith('.takeCompanion')) {
                    const t = companionLines
                    companionLines = ''
                    return { result: t }
                }
                if (name.endsWith('.export')) return { result: `Download/MessageLogger/${args[0]}` }
                if (name.endsWith('.status')) return { result: '{}' }
                return { result: name.endsWith('.tray') || name.endsWith('.takePushed') ? '' : 'ok' }
            },
            fs: { readFile: async p => files[p] ?? '', rm: async () => {} },
        },
    },
    patcher: { instead: () => () => {} },
    utils: { discord: { lookupGeneratedIconComponent: () => null } },
}
globalThis.plugin = d => d

const src = readFileSync(new URL('../plugins/everything-logger/build/js/index.js', import.meta.url), 'utf8')
const X = new Function(`return ${src}`)()
const cleanups = []
X.default.start({ cleanup: (...f) => cleanups.push(...f), jsonStorage: storage })
await tick()

/** 플럭스 이벤트를 우리 가로채기에 통과시킨다 (돌려준 새 payload) */
function fire(type, payload) {
    let p = payload
    for (const f of handlers[type] ?? []) {
        const r = f(p)
        if (r !== undefined) p = r
    }
    return p
}
const set = patch => X._setSettings(patch)
const notifies = () => native.filter(c => c[0].endsWith('.notify'))

// ── 지운 메시지 + 알림 ──────────────────────────────────────────────────
put(rec('100', 'dm', '2', 'secret in dm'))
fire('MESSAGE_DELETE', { id: '100', channelId: 'dm' })
await tick()
check('DM delete is logged', !!X._logs()['100']?.d)
check('DM delete sends a phone notification with a link', notifies().length === 1 && notifies()[0][1][0].includes('Seina deleted a message') && notifies()[0][1][1] === 'secret in dm' && notifies()[0][1][2] === 'https://discord.com/channels/@me/dm/100', JSON.stringify(notifies()))

put(rec('101', 'gen', '2', 'hello all'))
fire('MESSAGE_DELETE', { id: '101', channelId: 'gen', guildId: 'g1' })
await tick()
check('server message without a mention: logged, no notification', !!X._logs()['101']?.d && notifies().length === 1)

put(rec('102', 'gen', '3', `hey <@${ME}>`, { mentions: [ME] }))
fire('MESSAGE_DELETE', { id: '102', channelId: 'gen', guildId: 'g1' })
await tick()
check('deleted mention notifies with the channel', notifies().length === 2 && notifies()[1][1][0] === 'Nazna deleted a message in #general' && notifies()[1][1][2] === 'https://discord.com/channels/g1/gen/102')

set({ notifyDeletes: false })
put(rec('103', 'dm', '2', 'quiet'))
fire('MESSAGE_DELETE', { id: '103', channelId: 'dm' })
await tick()
check('notifications can be turned off', notifies().length === 2 && !!X._logs()['103']?.d)
set({ notifyDeletes: true })

put(rec('104', 'dm', ME, 'mine'))
fire('MESSAGE_DELETE', { id: '104', channelId: 'dm' })
await tick()
check('my own deletes never notify', notifies().length === 2)

// ── DM 끄기, 고른 서버만 ────────────────────────────────────────────────
set({ logDms: false })
put(rec('110', 'dm', '2', 'no log'))
fire('MESSAGE_DELETE', { id: '110', channelId: 'dm' })
check('DM logging off', !X._logs()['110'])
set({ logDms: true, onlyServersOn: true, onlyServers: ['g1'] })
put(rec('111', 'side', '2', 'other server'))
fire('MESSAGE_DELETE', { id: '111', channelId: 'side', guildId: 'g2' })
put(rec('112', 'gen', '2', 'chosen server'))
fire('MESSAGE_DELETE', { id: '112', channelId: 'gen', guildId: 'g1' })
put(rec('113', 'dm', '2', 'dm still'))
fire('MESSAGE_DELETE', { id: '113', channelId: 'dm' })
check('only chosen servers, DMs unaffected', !X._logs()['111'] && !!X._logs()['112'] && !!X._logs()['113'])
set({ onlyServersOn: false, onlyServers: [] })

// ── 수정, 글자 비교 ─────────────────────────────────────────────────────
put(rec('120', 'gen', '2', 'the quick brown fox'))
fire('MESSAGE_UPDATE', { guildId: 'g1', message: { id: '120', channel_id: 'gen', content: 'the slow brown fox' } })
store.gen['120'] = { ...store.gen['120'], content: 'the slow brown fox' }
check('edit logged', X._logs()['120']?.e?.[0]?.t === 'the quick brown fox')
const d = X.diff('the quick brown fox', 'the slow brown dog')
check('word diff marks removed and added words', JSON.stringify(d) === JSON.stringify([{ t: 'the ', k: 'same' }, { t: 'quick', k: 'del' }, { t: 'slow', k: 'add' }, { t: ' brown ', k: 'same' }, { t: 'fox', k: 'del' }, { t: 'dog', k: 'add' }]), JSON.stringify(d))
check('diff of equal and empty text', X.diff('a', 'a').length === 1 && X.diff('', 'x')[0].k === 'add' && X.diff('x', '')[0].k === 'del')

// ── 반응 ────────────────────────────────────────────────────────────────
fire('MESSAGE_REACTION_REMOVE', { channelId: 'gen', messageId: '130', userId: '3', emoji: { name: '👍' } })
fire('MESSAGE_REACTION_REMOVE', { channelId: 'gen', messageId: '130', userId: ME, emoji: { name: '❤️' } })
fire('MESSAGE_REACTION_REMOVE', { channelId: 'gen', messageId: '130', userId: '3', emoji: { name: '👀' }, optimistic: true })
fire('MESSAGE_REACTION_REMOVE', { channelId: 'gen', messageId: '130', userId: '9', emoji: { name: '🤖' } })
const reactions = X._events().filter(e => e.k === 'r')
check('removed reactions logged (not mine, not bots, not optimistic)', reactions.length === 1 && reactions[0].em.name === '👍' && reactions[0].u === '3' && reactions[0].g === 'g1')

// ── 채팅 줄 꾸미기 ──────────────────────────────────────────────────────
const gen = a => ({ message: { content: [{ type: 'text', content: a.message.content }], timestamp: undefined } })
const row = (id, content) => ({ type: 1, message: { id, content: [{ type: 'text', content }], timestampColor: 1, editedColor: 2 } })
X.setNative(false)
const r130 = row('130', 'nice')
X.styleRow(r130, { message: { content: 'nice' } }, gen)
check('removed reaction shows under a message without a log', JSON.stringify(r130.message.content).includes('Removed reaction: 👍 Nazna'), JSON.stringify(r130.message.content))

set({ seconds: true, clock12: true })
const r112 = row('112', 'chosen server')
X.styleRow(r112, { message: { content: 'chosen server' } }, gen)
const tail = JSON.stringify(r112.message.content)
check('deleted message shows deletion time (seconds, 12-hour)', /deleted \d{1,2}:\d\d:\d\d (AM|PM)/.test(tail), tail)
check('deleted row is red by theme color', typeof r112.message.textColor === 'number' && typeof r112.backgroundHighlight?.backgroundColor === 'number')
set({ deletedColor: '#00a8fc', colorDeletedNames: true, showDeleteTime: false })
const r112b = row('112', 'chosen server')
X.styleRow(r112b, { message: { content: 'chosen server' } }, gen)
check('custom deleted color and colored name', r112b.message.textColor === processColor('#00a8fc') && r112b.message.usernameColor === processColor('#00a8fc'))
check('deletion time can be hidden', !JSON.stringify(r112b.message.content).includes('deleted '))
set({ deletedColor: '', colorDeletedNames: false, showDeleteTime: true, seconds: false, clock12: false })

const r120 = row('120', 'the slow brown fox')
X.styleRow(r120, { message: { content: 'the slow brown fox' } }, gen)
check('previous version shown in chat', JSON.stringify(r120.message.content).includes('the quick brown fox'))
set({ showHistoryInChat: false })
const r120b = row('120', 'the slow brown fox')
X.styleRow(r120b, { message: { content: 'the slow brown fox' } }, gen)
check('previous versions can be hidden in chat', !JSON.stringify(r120b.message.content).includes('quick'))
set({ showHistoryInChat: true })

// 꾸밈(네이티브)이 있으면 가로줄(\uE008)로 수정 기록끼리, 지금 내용, 지워짐 표시를 나눈다
X.setNative(true)
const D = '\uE008'
const r120n = row('120', 'the slow brown fox')
X.styleRow(r120n, { message: { content: 'the slow brown fox' } }, gen)
const n120 = r120n.message.content.map(n => n.content)
const iOld = n120.findIndex(c => typeof c === 'string' && c.includes('the quick brown fox'))
const iNow = n120.lastIndexOf('the slow brown fox')
const iDiv = n120.indexOf(D)
check('edit history and current text are split by a divider line', iOld >= 0 && iDiv > iOld && iNow > iDiv && n120[iDiv - 1] === '\n' && n120[iDiv + 1] === '\n', JSON.stringify(n120))
const again = { type: 1, message: { id: '120', content: r120n.message.content.slice(), timestampColor: 1, editedColor: 2 } }
X.styleRow(again, { message: { content: 'the slow brown fox' } }, gen)
check('styling twice does not double the history (divider lines are stripped too)', JSON.stringify(again.message.content).split('the quick brown fox').length === 2 && again.message.content.filter(n => n.content === D).length === n120.filter(c => c === D).length, JSON.stringify(again.message.content.map(n => n.content)))
const r112n = row('112', 'chosen server')
X.styleRow(r112n, { message: { content: 'chosen server' } }, gen)
const n112 = r112n.message.content.map(n => n.content)
const iDel = n112.findIndex(c => typeof c === 'string' && c.includes('deleted '))
check('deleted label sits under a divider line', iDel > 0 && n112[iDel - 2] === D && n112[iDel - 1] === '\n', JSON.stringify(n112))
X.setNative(false)

// ── 채널, 스레드 삭제 ───────────────────────────────────────────────────
put(rec('140', 'th', '2', 'last words'))
fire('THREAD_DELETE', { channel: channelsById.th })
fire('CHANNEL_DELETE', { channel: channelsById.dm })
const chans = X._events().filter(e => e.k === 'c')
check('deleted thread kept with its last messages, closed DMs ignored', chans.length === 1 && chans[0].name === 'a thread' && chans[0].msgs[0]?.content === 'last words')

// ── 프로필 ──────────────────────────────────────────────────────────────
fire('PRESENCE_UPDATES', { updates: [{ user: { id: '3', username: 'nazna', global_name: 'Nazna', avatar: 'a1' }, activities: [{ type: 4, state: 'busy' }] }] })
check('first sight only remembers', !X._events().some(e => e.k === 'p'))
fire('PRESENCE_UPDATES', { updates: [{ user: { id: '3', username: 'nazna', global_name: 'Naz', avatar: 'a2' }, activities: [{ type: 4, state: 'free' }] }] })
const prof = X._events().filter(e => e.k === 'p')
check('friend profile changes: name, avatar, status', prof.length === 3 && prof.some(e => e.field === 'name' && e.from === 'Nazna' && e.to === 'Naz') && prof.some(e => e.field === 'avatar' && e.to === 'a2') && prof.some(e => e.field === 'status' && e.to === 'free'), JSON.stringify(prof))
fire('PRESENCE_UPDATES', { updates: [{ user: { id: '7', username: 'stranger', global_name: 'S' } }, { user: { id: '7', username: 'stranger', global_name: 'S2' } }] })
check('strangers are not watched', !X._events().some(e => e.k === 'p' && e.u === '7'))
fire('PRESENCE_UPDATES', { updates: [{ user: { id: '3' } }] })
check('partial updates change nothing', X._events().filter(e => e.k === 'p').length === 3)

// ── 통계 ────────────────────────────────────────────────────────────────
const st = X.stats()
check('stats count logs and rank people', st.deleted >= 6 && st.edited === 1 && st.reactions === 1 && st.channels === 1 && st.profiles === 3 && st.deleters[0]?.id === '2' && st.days[6] >= 7, JSON.stringify({ ...st, deleters: st.deleters.map(x => [x.id, x.n]) }))

// ── 내보내기, 가져오기 ──────────────────────────────────────────────────
const text = X.exportText()
const data = JSON.parse(text)
check('export has logs and events', data.format === 'yumistra.everything-logger' && Object.keys(data.logs).length >= 7 && data.events.length === 5)
const saved = JSON.parse(text)
for (const k of Object.keys(X._logs())) delete X._logs()[k]
X._events().splice(0)
const added = X.mergeData(saved)
check('import merges everything back', added >= 12 && !!X._logs()['100']?.d && X._events().length === 5)
check('importing again adds nothing', X.mergeData(saved) === 0)
let bad = ''
try {
    X.mergeData({ hello: 1 })
} catch (e) {
    bad = String(e.message)
}
check('import rejects other files', bad.includes('Not an Everything Logger file'))

// ── 알림 앱이 보낸 기록 합치기 ──────────────────────────────────────────
companionLines = [
    JSON.stringify({ t: 'delete', at: 1700000000000, g: 'g1', m: { id: '150', channel_id: 'gen', content: 'while away', author: { id: '2', username: 'seina' } } }),
    JSON.stringify({ t: 'edit', at: 1700000001000, g: 'g1', m: { id: '151', channel_id: 'gen', content: 'new', author: { id: '3', username: 'nazna' } }, before: 'old' }),
    JSON.stringify({ t: 'delete', at: 1700000002000, m: { id: '152', channel_id: 'gen', content: 'bot', author: { id: '9', bot: true } } }),
    'not json',
].join('\n')
const n = await X.pullCompanion()
check('companion deletes and edits merged (bots skipped, junk ignored)', n === 2 && X._logs()['150']?.d === 1700000000000 && X._logs()['150'].away === 1 && X._logs()['151']?.e?.[0]?.t === 'old' && !X._logs()['152'], `${n}`)
check('nothing left to pull', (await X.pullCompanion()) === 0)

// ── 로그 화면 ───────────────────────────────────────────────────────────
const host = doc.createElement('div')
const root = createRoot(host)
async function render(el) {
    await act(async () => root.render(el))
    await act(async () => tick())
    return host.textContent
}
async function press(label) {
    const list = presses.get(label)
    if (!list?.length) throw new Error(`nothing to press: ${label}\n${[...presses.keys()].join(', ')}`)
    await act(async () => list.at(-1).get()())
    await act(async () => tick())
}
let view = await render(h(X.LogsView))
check('logs view has kind tabs', ['Messages', 'Reactions', 'Channels', 'Profiles', 'Stats'].every(t => view.includes(t)))
check('messages tab lists logs', view.includes('secret in dm') && view.includes('log(s)'))
await press('Compare')
view = host.textContent
check('compare shows the changed words', view.includes('1 → 2') && view.includes('quick') && view.includes('slow'), view.slice(0, 300))
await press('Reactions')
check('reactions tab', host.textContent.includes('Nazna removed 👍'))
await press('Channels')
check('channels tab', host.textContent.includes('Thread #a thread deleted') && host.textContent.includes('1 message(s) kept'))
await press('channel ' + X._events().find(e => e.k === 'c').id)
check('channel card opens its last messages', host.textContent.includes('last words'))
await press('Profiles')
check('profiles tab', host.textContent.includes('Nazna changed display name') && host.textContent.includes('Naz'))
await press('Stats')
check('stats tab', host.textContent.includes('TOTAL') && host.textContent.includes('LAST 7 DAYS') && host.textContent.includes('MOST DELETED'))
await press('Messages')
await act(async () => inputs.get('Search logs').at(-1).get().onChangeText('secret'))
await act(async () => tick())
check('search filters', host.textContent.includes('1 of'), host.textContent.slice(0, 300))
await press('Save search')
await act(async () => inputs.get('Name this search').at(-1).get().onChangeText('dm secrets'))
await act(async () => inputs.get('Name this search').at(-1).get().onSubmitEditing())
await act(async () => tick())
check('search saved', X._settings().searches.some(s => s.name === 'dm secrets' && s.q === 'secret'))
await act(async () => inputs.get('Search logs').at(-1).get().onChangeText(''))
await act(async () => tick())
await press('saved dm secrets')
check('saved search applies', host.textContent.includes('1 of'))

// 날짜 필터: 아주 먼 미래부터 → 없음
await act(async () => inputs.get('Search logs').at(-1).get().onChangeText(''))
check('date inputs hidden until filters open', !inputs.get('From YYYY-MM-DD')?.length)

// ── 설정 화면 ───────────────────────────────────────────────────────────
view = await render(h(X.SettingsPage, { api: { jsonStorage: storage } }))
check('settings main page lists the groups', ['View logs', 'What to log', 'Who and where', 'In chat', 'Notifications', 'Storage', 'Advanced'].every(t => view.includes(t)), view.slice(0, 500))
const screens = Object.fromEntries(X.groupScreens().map(g => [g.key, g.Screen]))
view = await render(h(screens.log))
check('what to log screen', ['Log DMs and group DMs', 'Removed reactions', 'Deleted channels and threads', 'Profile changes'].every(t => view.includes(t)), view.slice(0, 400))
await press('Log DMs and group DMs')
check('switch writes the setting', X._settings().logDms === false)
view = await render(h(screens.chat))
check('in chat screen', ['Show previous versions', 'Show deletion time', 'Use a 12-hour clock', 'Colors', 'Deleted messages'].every(t => view.includes(t)), view.slice(0, 400))
view = await render(h(screens.storage))
check('storage screen', ['Keep logs for', 'Export logs', 'Import logs', 'Clear all logs'].every(t => view.includes(t)), view.slice(0, 400))
await press('Export logs')
for (let i = 0; i < 3; i++) await act(async () => tick())
check('export goes to Download/EverythingLogger', native.some(c => c[0].endsWith('.export') && c[1][0].startsWith('everything-logger-') && c[1][1].startsWith('{"format"')))
files['/cache/import.json'] = JSON.stringify({ format: 'yumistra.message-logger', v: 1, logs: { 999: { c: 'gen', g: 'g1', d: 1, at: Date.now(), m: { id: '999', channel_id: 'gen', content: 'imported', author: { id: '2' } } } }, events: [] })
await press('Import logs')
for (let i = 0; i < 5; i++) await act(async () => tick())
check('import an old Message Logger file', host.textContent.includes('Added 1 log(s)') && X._logs()['999']?.m?.content === 'imported', host.textContent.slice(-200))

await act(async () => root.unmount())
cleanups.forEach(f => typeof f === 'function' && f())
check('cleanup removes every event hook', Object.values(handlers).every(l => l.length === 0), Object.entries(handlers).filter(([, l]) => l.length).map(([k]) => k).join())

console.log(results.join('\n'))
console.log(`fails: ${fails}`)
process.exit(fails ? 1 : 0)
