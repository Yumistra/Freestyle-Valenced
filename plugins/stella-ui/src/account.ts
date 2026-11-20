import { find, http, S, toast } from './data'

/**
 * 설정 화면이 쓰는 것: 디스코드 사용자 설정(상태 등), 프로필, 연결, 기기, 앱, 차단 목록.
 * 비밀번호, 이메일, 2단계 인증, 결제는 디스코드 화면에서 한다(보안 확인).
 */

const errText = (e: any) => e?.body?.message ?? e?.message ?? String(e ?? '')

// ── 디스코드 사용자 설정 (StatusSetting 등) ─────────────────────────────
function settingsModule(): any {
    return find('StatusSetting', 'CustomStatusSetting')
}
export function readSetting(name: string): any {
    try {
        return settingsModule()?.[name]?.getSetting?.()
    } catch {
        return undefined
    }
}
export function writeSetting(name: string, value: any): boolean {
    try {
        const s = settingsModule()?.[name]
        if (typeof s?.updateSetting !== 'function') {
            toast('이 설정은 디스코드 화면에서 바꿔 주세요')
            return false
        }
        const r = s.updateSetting(value)
        Promise.resolve(r).catch((e: any) => toast(`설정을 바꾸지 못했어요: ${errText(e)}`))
        return true
    } catch (e) {
        toast(`설정을 바꾸지 못했어요: ${errText(e)}`)
        return false
    }
}
export const hasSettings = () => !!settingsModule()

export const STATUSES: [string, string, string][] = [
    ['online', '온라인', '#3fbf72'],
    ['idle', '자리 비움', '#f6c445'],
    ['dnd', '방해 금지', '#ef4b5f'],
    ['invisible', '오프라인 표시', '#7f8fba'],
]

export function setCustomStatus(text: string, hours: number): boolean {
    const t = text.trim()
    if (!t) return writeSetting('CustomStatusSetting', undefined)
    return writeSetting('CustomStatusSetting', { text: t, emojiId: '0', emojiName: '', expiresAtMs: hours > 0 ? String(Date.now() + hours * 3600 * 1000) : '0', createdAtMs: String(Date.now()) })
}

/** 켜고 끄는 설정 (값이 참/거짓인 것만 보여 준다) */
export const TOGGLES: [string, string][] = [
    ['InlineEmojiSuggestionsSetting', '입력할 때 이모지 추천'],
    ['TypingIndicatorSetting', '입력 중 표시 보내기'],
    ['InAppNotificationsSetting', '앱 안 알림'],
    ['InAppMessageSoundsSetting', '앱 안 메시지 소리'],
    ['MessagePreviewSetting', '알림에 메시지 미리보기'],
    ['ContactSyncSuggestionsSetting', '연락처로 친구 추천'],
    ['UseDataForQuestsSponsoredContentSetting', '퀘스트 맞춤 추천에 데이터 쓰기'],
]

// ── REST ────────────────────────────────────────────────────────────────
async function call(method: 'get' | 'post' | 'patch' | 'del', url: string, body?: any, fail?: string): Promise<any> {
    const h = http()
    const f = h?.[method] ?? (method === 'del' ? h?.delete : undefined)
    if (typeof f !== 'function') throw new Error('no http')
    try {
        return (await f.call(h, { url, ...(body !== undefined ? { body } : {}) }))?.body
    } catch (e) {
        if (fail) toast(`${fail}: ${errText(e)}`)
        throw e
    }
}

export const updateMe = (body: any) => call('patch', '/users/@me', body, '바꾸지 못했어요').then(() => true, () => false)
export const updateProfile = (body: any) => call('patch', '/users/@me/profile', body, '프로필을 바꾸지 못했어요').then(() => true, () => false)
export async function fetchMyProfile(id: string): Promise<{ bio: string; pronouns: string }> {
    try {
        const b = await call('get', `/users/${id}/profile`)
        return { bio: b?.user_profile?.bio ?? b?.user?.bio ?? '', pronouns: b?.user_profile?.pronouns ?? '' }
    } catch {
        const p = S().UserProfileStore?.getUserProfile?.(id)
        return { bio: p?.bio ?? '', pronouns: p?.pronouns ?? '' }
    }
}

/** 고른 그림을 data: 주소로 (아바타, 배너 올리기) */
export async function toDataUrl(uri: string): Promise<string | undefined> {
    try {
        const res = await fetch(uri)
        const blob = await res.blob()
        return await new Promise<string>((resolve, reject) => {
            const r = new (globalThis as any).FileReader()
            r.onload = () => resolve(String(r.result))
            r.onerror = reject
            r.readAsDataURL(blob)
        })
    } catch {
        toast('그림을 읽지 못했어요')
    }
}

export interface Connection {
    type: string
    id: string
    name: string
    visible: boolean
}
export async function fetchConnections(): Promise<Connection[]> {
    const b = await call('get', '/users/@me/connections')
    return (Array.isArray(b) ? b : []).map(c => ({ type: String(c.type), id: String(c.id), name: String(c.name ?? ''), visible: c.visibility === 1 }))
}
export const removeConnection = (c: Connection) => call('del', `/users/@me/connections/${c.type}/${c.id}`, undefined, '연결을 끊지 못했어요').then(() => true, () => false)
export const showConnection = (c: Connection, visible: boolean) => call('patch', `/users/@me/connections/${c.type}/${c.id}`, { visibility: visible ? 1 : 0 }, '바꾸지 못했어요').then(() => true, () => false)

export interface Session {
    id: string
    os: string
    platform: string
    location: string
    lastUsed: number
}
export async function fetchSessions(): Promise<Session[]> {
    const b = await call('get', '/auth/sessions')
    return (b?.user_sessions ?? []).map((s: any) => ({ id: String(s.id_hash), os: s.client_info?.os ?? '', platform: s.client_info?.platform ?? '', location: s.client_info?.location ?? '', lastUsed: Date.parse(s.approx_last_used_time ?? '') || 0 }))
}
export const logoutSession = (id: string) => call('post', '/auth/sessions/logout', { session_id_hashes: [id] }, '로그아웃하지 못했어요').then(() => true, () => false)

export interface AppToken {
    id: string
    name: string
    icon?: string
    scopes: string[]
}
export async function fetchApps(): Promise<AppToken[]> {
    const b = await call('get', '/oauth2/tokens')
    return (Array.isArray(b) ? b : []).map(t => ({
        id: String(t.id),
        name: String(t.application?.name ?? ''),
        icon: t.application?.icon ? `https://cdn.discordapp.com/app-icons/${t.application.id}/${t.application.icon}.png?size=64` : undefined,
        scopes: t.scopes ?? [],
    }))
}
export const removeApp = (id: string) => call('del', `/oauth2/tokens/${id}`, undefined, '앱 승인을 끊지 못했어요').then(() => true, () => false)

export function blockedIds(): string[] {
    try {
        const rel = S().RelationshipStore?.getRelationships?.() ?? {}
        return Object.keys(rel).filter(id => rel[id] === 2)
    } catch {
        return []
    }
}
export const unblock = (id: string) => call('del', `/users/@me/relationships/${id}`, undefined, '차단을 풀지 못했어요').then(() => true, () => false)
