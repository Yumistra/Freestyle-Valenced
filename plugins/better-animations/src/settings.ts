import { DEFAULT_ID, type Direction, type EasingKey, type ModuleKey, type Position } from './effects'

export interface ModuleSettings {
    effect: string
    /** ms */
    duration: number
    easing: EasingKey
    /** 나갈 때 효과 ('same' = 나타날 때와 같게) */
    exit?: string
    direction?: Direction
    position?: Position
    /** 메시지: 한꺼번에 나타날 때 차례로 보여 줄 간격 (ms) */
    stagger?: number
    /** 메시지: 채널을 열 때 보이는 메시지에도 */
    onOpen?: boolean
    /** 메시지: 메시지가 추가·삭제될 때 나머지가 부드럽게 밀리기 */
    shift?: boolean
    /** 메시지: 밀리는 시간 (ms) */
    shiftDuration?: number
    /** 목록 끝에서 iOS 처럼 튕기기 (설정은 messages 에 둔다. 네이티브가 여기서 읽는다) */
    bounce?: boolean
    /** 튕기기: 채팅뿐 아니라 모든 목록에서 */
    bounceAll?: boolean
    /** 목록 스크롤: 스크롤할 때뿐 아니라 목록이 처음 나타날 때도 */
    always?: boolean
    /** 화면 전환: 설정 같은 모달 화면에도 */
    modals?: boolean
    /** 서버 바꾸기: 서버 목록에서 위·아래 어느 쪽 서버로 가는지에 따라 세로 방향을 뒤집음 */
    follow?: boolean
    /** 배경: 진하기 (0~1, 디스코드 기본 대비) */
    amount?: number
}

export interface Settings {
    enabled: boolean
    modules: Record<ModuleKey, ModuleSettings>
}

export const MODULE_KEYS: ModuleKey[] = [
    'messages',
    'lists',
    'stack',
    'push',
    'modal',
    'panel',
    'channelList',
    'servers',
    'folder',
    'sheet',
    'menu',
    'alert',
    'backdrop',
    'toast',
    'notice',
    'subtle',
    'press',
    'media',
]

export const DEFAULTS: Settings = {
    enabled: true,
    modules: {
        messages: { effect: 'rise', duration: 320, easing: 'out', exit: 'same', direction: 'auto', position: 'auto', stagger: 30, onOpen: true, shift: true, shiftDuration: 200, bounce: true, bounceAll: true },
        lists: { effect: 'default', duration: 500, easing: 'out', always: false },
        stack: { effect: 'slip', duration: 280, easing: 'out', exit: 'same', direction: 'auto', position: 'auto', modals: true },
        push: { effect: 'default', duration: 300, easing: 'out' },
        modal: { effect: 'default', duration: 300, easing: 'out' },
        panel: { effect: 'default', duration: 260, easing: 'expo' },
        channelList: { effect: 'default', duration: 200, easing: 'smooth' },
        servers: { effect: 'default', duration: 260, easing: 'out', exit: 'same', direction: 'auto', position: 'auto', follow: true },
        folder: { effect: 'drop', duration: 380, easing: 'spring', exit: 'same', direction: 'auto', position: 'auto' },
        sheet: { effect: 'default', duration: 380, easing: 'spring' },
        menu: { effect: 'pop', duration: 300, easing: 'back', exit: 'same', direction: 'auto', position: 'auto' },
        alert: { effect: 'zoom', duration: 380, easing: 'spring', exit: 'same', direction: 'auto', position: 'auto' },
        backdrop: { effect: 'default', duration: 300, easing: 'out', amount: 0.6 },
        toast: { effect: 'slide', duration: 380, easing: 'back', exit: 'same', direction: 'auto', position: 'auto' },
        notice: { effect: 'default', duration: 300, easing: 'out', direction: 'auto', position: 'auto' },
        subtle: { effect: 'default', duration: 260, easing: 'spring' },
        press: { effect: 'default', duration: 260, easing: 'spring' },
        media: { effect: 'default', duration: 320, easing: 'out', exit: 'default', direction: 'auto', position: 'auto' },
    },
}

let storage: any
/** 설정이 바뀔 때마다 올라간다. 애니메이션 설정 객체 캐시의 열쇠로 쓴다 */
export let version = 0

export const hasStorage = () => !!storage

export function bindStorage(s: any) {
    storage = s
    version++
    // 저장된 설정은 플러그인이 시작된 뒤에 늦게 불러와진다. 다 불러오면 캐시를 버리고 다시 적용한다
    if (!s?.cache && typeof s?.get === 'function') {
        Promise.resolve(s.get())
            .then(() => {
                if (storage !== s) return
                version++
                notify()
            })
            .catch((e: unknown) => report('storage', e))
    }
}

/** 저장 파일 내용 (아직 안 불러왔으면 불러와서). 덮어쓰기 전에 꼭 이걸로 읽는다 */
async function current(): Promise<Record<string, any>> {
    if (!storage) return {}
    if (storage.cache) return storage.cache
    try {
        return (await storage.get()) ?? {}
    } catch {
        return {}
    }
}

// 렌더링마다 여러 번 불리므로 저장 내용이 그대로면 만든 걸 다시 쓴다
let cachedFrom: unknown
let cachedVersion = -1
let cached: Settings | undefined

export function settings(): Settings {
    const saved = storage?.cache ?? {}
    if (cached && cachedFrom === saved && cachedVersion === version) return cached
    const modules = { ...DEFAULTS.modules }
    for (const key of MODULE_KEYS) modules[key] = { ...DEFAULTS.modules[key], ...(saved.modules?.[key] ?? {}) }
    cached = { enabled: saved.enabled ?? DEFAULTS.enabled, modules }
    cachedFrom = saved
    cachedVersion = version
    return cached
}

/** 이 부분을 바꿔야 하는지. 꺼져 있거나 "기본"이면 디스코드 그대로 둔다 */
export function active(key: ModuleKey): ModuleSettings | undefined {
    const s = settings()
    if (!s.enabled) return
    const m = s.modules[key]
    return m.effect === DEFAULT_ID ? undefined : m
}

/** 설정 말고 같은 파일에 같이 두는 값 (네이티브용으로 풀어 둔 효과 등) */
export const storedExtra = (key: string) => storage?.cache?.[key]

/** 저장된 설정을 다 불러올 때까지 기다린다 */
export async function ready() {
    await current()
}

export async function setExtra(key: string, value: unknown) {
    if (!storage) return
    const cur = await current()
    await storage.set({ ...cur, [key]: value }, true)
}

const listeners = new Set<() => void>()
/** 설정이 바뀌면 부를 함수 (상수 바꿔치기처럼 미리 적용해 둬야 하는 것들) */
export function onSettingsChange(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

export async function save(next: Settings) {
    version++
    // 같이 두는 값(native 등)은 지우지 않는다
    const extra = { ...(await current()) }
    delete extra.enabled
    delete extra.modules
    await storage?.set({ ...extra, ...next }, true)
    notify()
}

function notify() {
    for (const fn of listeners) {
        try {
            fn()
        } catch (e) {
            report('listener', e)
        }
    }
}

/** 작동 확인용 숫자 */
export const status = {
    screens: 0,
    nativeScreens: 0,
    screenExits: 0,
    stack: 0,
    sheets: 0,
    menus: 0,
    alerts: 0,
    backdrops: 0,
    toasts: 0,
    notices: 0,
    media: 0,
    presses: 0,
    folders: 0,
    layouts: 0,
    listCells: 0,
    /** 네이티브(메시지) 부분: null = 아직 확인 전 */
    native: null as null | boolean,
    /** 네이티브가 큰 화면 전환을 맡는지 */
    nativeScreenHook: false,
    nativePlayed: 0,
    /** 네이티브 버전 (안 실렸으면 '') */
    nativeVersion: '',
    /** 채팅 목록을 찾았는지 (옛 네이티브는 null) */
    nativeChat: null as null | boolean,
    nativeProblems: '',
    constants: [] as string[],
    found: {} as Record<string, boolean>,
    lastError: '',
}

export function report(where: string, e: unknown) {
    status.lastError = `${where}: ${String((e as any)?.message ?? e)}`
}
