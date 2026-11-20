import { useSyncExternalStore } from 'react'
import { channel, http, idTime, S, threadsOf } from './data'

/**
 * 포럼 글 목록. 열린 글은 디스코드가 이미 가진 스레드, 보관된 글은 디스코드의 검색 API 로 더 불러온다.
 * 글 첫 메시지(미리보기)는 보관된 글은 검색 결과에, 열린 글은 필요할 때 한 번 받아 온다.
 */

export interface Post {
    id: string
    name: string
    ownerId?: string
    count: number
    /** 마지막 활동 (밀리초) */
    last: number
    tags: string[]
    archived: boolean
    pinned: boolean
    /** 첫 메시지 (디스코드 메시지 레코드 또는 API 의 날 메시지) */
    first?: any
}

interface ForumState {
    archived: Map<string, Post>
    offset: number
    hasMore: boolean
    loading: boolean
    error: boolean
}

const forums = new Map<string, ForumState>()
const firsts = new Map<string, any>()
const askedFirst = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => {
    version++
    listeners.forEach(f => f())
}

export function resetForums() {
    forums.clear()
    firsts.clear()
    askedFirst.clear()
    emit()
}

const stateOf = (id: string): ForumState => {
    let s = forums.get(id)
    if (!s) forums.set(id, (s = { archived: new Map(), offset: 0, hasMore: true, loading: false, error: false }))
    return s
}

const PINNED = 2

/** 디스코드 스레드 레코드나 API 의 날 스레드를 글로 */
export function toPost(t: any, archived = false): Post {
    const meta = t.threadMetadata ?? t.thread_metadata ?? {}
    const lastId = t.lastMessageId ?? t.last_message_id
    const created = meta.createTimestamp ?? meta.create_timestamp
    const last = Math.max(idTime(lastId), created ? Date.parse(created) || 0 : 0, idTime(t.id))
    return {
        id: t.id,
        name: t.name ?? '',
        ownerId: t.ownerId ?? t.owner_id,
        count: Number(t.messageCount ?? t.message_count ?? 0) || 0,
        last,
        tags: t.appliedTags ?? t.applied_tags ?? [],
        archived: archived || !!(meta.archived ?? false),
        pinned: ((t.flags ?? 0) & PINNED) !== 0,
    }
}

/** 지금 보여 줄 글 (고정 글 먼저, 그다음 최근 활동 순) */
export function forumPosts(forumId: string): Post[] {
    const ch = channel(forumId)
    const st = stateOf(forumId)
    const byId = new Map<string, Post>()
    for (const id of threadsOf(ch?.guild_id, forumId)) byId.set(id, toPost(channel(id)))
    for (const [id, p] of st.archived) if (!byId.has(id)) byId.set(id, p)
    const list = [...byId.values()]
    for (const p of list) p.first = firsts.get(p.id) ?? S().MessageStore?.getMessage?.(p.id, p.id)
    return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last)
}

/** 보관된 글 더 불러오기 */
export async function loadMore(forumId: string): Promise<void> {
    const st = stateOf(forumId)
    if (st.loading || !st.hasMore) return
    const h = http()
    if (typeof h?.get !== 'function') {
        st.hasMore = false
        st.error = true
        return emit()
    }
    st.loading = true
    st.error = false
    emit()
    try {
        const res = await h.get({ url: `/channels/${forumId}/threads/search`, query: { archived: true, sort_by: 'last_message_time', sort_order: 'desc', limit: 25, offset: st.offset } })
        const body = res?.body ?? {}
        const threads: any[] = body.threads ?? []
        for (const t of threads) st.archived.set(t.id, toPost(t, true))
        for (const m of body.first_messages ?? []) if (m?.channel_id) firsts.set(m.channel_id, m)
        st.offset += threads.length
        st.hasMore = !!body.has_more && threads.length > 0
    } catch {
        st.error = true
        st.hasMore = false
    }
    st.loading = false
    emit()
}

/** 열린 글의 첫 메시지 (미리보기용, 한 번만) */
export async function loadFirst(threadId: string) {
    if (firsts.has(threadId) || askedFirst.has(threadId) || S().MessageStore?.getMessage?.(threadId, threadId)) return
    askedFirst.add(threadId)
    try {
        const res = await http()?.get?.({ url: `/channels/${threadId}/messages/${threadId}` })
        if (res?.body?.id) {
            firsts.set(threadId, res.body)
            emit()
        }
    } catch {}
}

/** 새 글 올리기. 성공하면 새 글 ID */
export async function createPost(forumId: string, name: string, content: string, tags: string[]): Promise<string | undefined> {
    try {
        const res = await http()?.post?.({ url: `/channels/${forumId}/threads`, body: { name: name.trim(), message: { content: content.trim() }, applied_tags: tags } })
        const id = res?.body?.id
        if (id) {
            stateOf(forumId).archived.set(id, toPost(res.body))
            emit()
        }
        return id
    } catch {}
}

export function forumStatus(forumId: string) {
    const st = stateOf(forumId)
    return { loading: st.loading, hasMore: st.hasMore, error: st.error }
}

/** 포럼 데이터가 바뀌면 다시 그린다 */
export function useForumVersion(): number {
    return useSyncExternalStore(
        f => (listeners.add(f), () => void listeners.delete(f)),
        () => version,
        () => version,
    )
}

/** 디스코드가 아직 모르는 (보관된) 글을 채널처럼 */
export function knownThread(id: string | undefined): any {
    if (!id) return
    for (const [forumId, st] of forums) {
        const p = st.archived.get(id)
        if (p) return { id, name: p.name, type: 11, parent_id: forumId, guild_id: channel(forumId)?.guild_id }
    }
}
