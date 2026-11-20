import { http, toast } from './data'

/**
 * 상점(꾸미기 아이템)과 퀘스트. 디스코드 API 를 바로 읽는다. 결제와 보상 받기(보안 확인)는 디스코드 화면에서 한다.
 */

const CDN = 'https://cdn.discordapp.com'
/** 디스코드 꾸미기 상점의 앱 번호 (배너 그림 주소에 쓴다) */
const SHOP_APP = '1096190356233670716'
const errText = (e: any) => e?.body?.message ?? e?.message ?? String(e ?? '')

// ── 상점 ────────────────────────────────────────────────────────────────
export interface ShopItem {
    type: number
    id?: string
    skuId: string
    asset?: string
    label?: string
}
export interface Product {
    skuId: string
    name: string
    summary: string
    type: number
    price?: string
    nitroPrice?: string
    items: ShopItem[]
    /** 가지고 있는지 */
    owned?: boolean
}
export interface Category {
    skuId: string
    name: string
    summary: string
    banner?: string
    products: Product[]
}

export const decorationUrl = (asset: string, size = 160) => `${CDN}/avatar-decoration-presets/${asset}.png?size=${size}&passthrough=true`
const bannerUrl = (asset?: string) => (asset ? (/^https?:/.test(asset) ? asset : `${CDN}/app-assets/${SHOP_APP}/${asset}.png?size=1024`) : undefined)

function money(p: any): string | undefined {
    const price = p?.country_prices?.prices?.[0] ?? p?.prices?.[0] ?? p
    const amount = Number(price?.amount)
    if (!Number.isFinite(amount)) return
    const exp = Number(price?.exponent ?? 2)
    const cur = String(price?.currency ?? 'usd').toUpperCase()
    const v = amount / Math.pow(10, exp)
    return `${cur === 'USD' ? '$' : cur === 'KRW' ? '₩' : `${cur} `}${cur === 'KRW' ? Math.round(v).toLocaleString() : v.toFixed(2)}`
}

function toProduct(p: any): Product {
    return {
        skuId: String(p?.sku_id ?? p?.id ?? ''),
        name: String(p?.name ?? ''),
        summary: String(p?.summary ?? ''),
        type: Number(p?.type ?? 0),
        price: money(p?.prices?.['0'] ?? p?.prices?.[0]),
        nitroPrice: money(p?.prices?.['4'] ?? p?.prices?.[4]),
        items: (p?.items ?? []).map((i: any) => ({ type: Number(i?.type ?? 0), id: i?.id, skuId: String(i?.sku_id ?? ''), asset: i?.asset, label: i?.label })),
    }
}

export async function fetchShop(): Promise<Category[]> {
    const h = http()
    if (!h) throw new Error('no http')
    let body: any
    try {
        body = (await h.get({ url: '/collectibles-categories/v2', query: { include_bundles: true, variants_return_style: 2 } }))?.body
    } catch {
        body = (await h.get({ url: '/collectibles-categories', query: { include_bundles: true } }))?.body
    }
    const list: any[] = Array.isArray(body) ? body : (body?.categories ?? [])
    return list
        .map(c => ({ skuId: String(c?.sku_id ?? ''), name: String(c?.name ?? ''), summary: String(c?.summary ?? ''), banner: bannerUrl(c?.banner ?? c?.banner_asset?.static), products: (c?.products ?? []).map(toProduct).filter((p: Product) => p.name) }))
        .filter(c => c.products.length)
}

/** 내가 가진 꾸미기 */
export async function fetchOwned(): Promise<Product[]> {
    const h = http()
    if (!h) return []
    try {
        const body = (await h.get({ url: '/users/@me/collectibles-purchases' }))?.body
        return (Array.isArray(body) ? body : []).map(p => ({ ...toProduct(p), owned: true }))
    } catch {
        return []
    }
}

/** 아바타 꾸미기 쓰기 (null 이면 벗기) */
export async function wearDecoration(item: ShopItem | null): Promise<boolean> {
    const h = http()
    if (!h?.patch) return false
    try {
        await h.patch({ url: '/users/@me', body: item ? { avatar_decoration_id: item.id ?? item.skuId, avatar_decoration_sku_id: item.skuId } : { avatar_decoration_id: null, avatar_decoration_sku_id: null } })
        return true
    } catch (e) {
        toast(`꾸미기를 바꾸지 못했어요: ${errText(e)}`)
        return false
    }
}

// ── 퀘스트 ──────────────────────────────────────────────────────────────
export interface Quest {
    id: string
    name: string
    game: string
    publisher: string
    reward: string
    expiresAt: number
    hero?: string
    logo?: string
    /** 할 일과 목표 (초 단위 등) */
    task?: { kind: string; target: number; value: number }
    enrolled: boolean
    completed: boolean
    claimed: boolean
}

const TASK_LABEL: Record<string, string> = {
    WATCH_VIDEO: '영상 보기',
    WATCH_VIDEO_ON_MOBILE: '휴대폰으로 영상 보기',
    PLAY_ON_DESKTOP: 'PC 에서 게임하기',
    PLAY_ON_XBOX: 'Xbox 에서 게임하기',
    PLAY_ON_PLAYSTATION: 'PlayStation 에서 게임하기',
    STREAM_ON_DESKTOP: 'PC 에서 방송하기',
    PLAY_ACTIVITY: '활동 하기',
    ACHIEVEMENT_IN_GAME: '게임 업적 달성',
    ACHIEVEMENT_IN_ACTIVITY: '활동 업적 달성',
}
export const taskLabel = (kind: string) => TASK_LABEL[kind] ?? kind

function questAsset(id: string, a?: string): string | undefined {
    if (!a) return
    if (/^https?:/.test(a)) return a
    return `${CDN}/${a.startsWith('quests/') ? a : `quests/${id}/${a}`}`
}

function toQuest(q: any): Quest {
    const c = q?.config ?? {}
    const id = String(q?.id ?? c.id ?? '')
    const tasks = c.task_config_v2?.tasks ?? c.task_config?.tasks ?? {}
    const kind = Object.keys(tasks)[0]
    const progress = q?.user_status?.progress ?? {}
    const reward = c.rewards_config?.rewards?.[0]?.messages
    return {
        id,
        name: String(c.messages?.quest_name ?? c.messages?.questName ?? ''),
        game: String(c.messages?.game_title ?? c.application?.name ?? ''),
        publisher: String(c.messages?.game_publisher ?? ''),
        reward: String(reward?.name_with_article ?? reward?.name ?? ''),
        expiresAt: Date.parse(c.expires_at ?? '') || 0,
        hero: questAsset(id, c.assets?.hero ?? c.assets?.quest_bar_hero),
        logo: questAsset(id, c.assets?.logotype_light ?? c.assets?.logotype ?? c.assets?.game_tile_light ?? c.assets?.game_tile),
        task: kind ? { kind, target: Number(tasks[kind]?.target) || 0, value: Number(progress?.[kind]?.value ?? q?.user_status?.stream_progress_seconds ?? 0) || 0 } : undefined,
        enrolled: !!q?.user_status?.enrolled_at,
        completed: !!q?.user_status?.completed_at,
        claimed: !!q?.user_status?.claimed_at,
    }
}

export async function fetchQuests(): Promise<Quest[]> {
    const h = http()
    if (!h) throw new Error('no http')
    const body = (await h.get({ url: '/quests/@me' }))?.body
    const list: any[] = Array.isArray(body) ? body : (body?.quests ?? [])
    const now = Date.now()
    return list
        .map(toQuest)
        .filter(q => q.name && (!q.expiresAt || q.expiresAt > now || (q.completed && !q.claimed)))
        .sort((a, b) => Number(a.claimed) - Number(b.claimed) || Number(b.enrolled) - Number(a.enrolled) || a.expiresAt - b.expiresAt)
}

export async function enrollQuest(id: string): Promise<boolean> {
    const h = http()
    if (!h?.post) return false
    try {
        await h.post({ url: `/quests/${id}/enroll`, body: { location: 11, is_targeted: false, metadata_raw: null } })
        return true
    } catch (e) {
        toast(`퀘스트를 받지 못했어요: ${errText(e)}`)
        return false
    }
}
