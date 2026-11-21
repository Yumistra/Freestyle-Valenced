import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Image, Pressable, TextInput, View } from 'react-native'
import { avatarUrl, channel, displayName, emojiUrl, S, toast, useStores, user } from '../data'
import { createPost, forumPosts, forumStatus, loadFirst, loadMore, type Post, useForumVersion } from '../forum'
import { formatTime, plainText, previewText } from '../markdown'
import { Avatar, Icon, PillButton, T } from '../parts'
import { go } from '../state'
import { C, R, shadow } from '../theme'
import { mediaUrl } from './Rich'
import { tr } from '../i18n'

/**
 * 포럼: 글을 카드로. 누르면 그 글(스레드)을 말풍선 채팅으로 연다. 위에서 새 글을 쓸 수 있다.
 */

export interface Tag {
    id: string
    name: string
    emojiId?: string
    emojiName?: string
}

export function forumTags(forum: any): Tag[] {
    return (forum?.availableTags ?? forum?.available_tags ?? []).map((t: any) => ({ id: t.id, name: t.name, emojiId: t.emojiId ?? t.emoji_id ?? undefined, emojiName: t.emojiName ?? t.emoji_name ?? undefined }))
}

function TagChip({ tag, on, onPress }: { tag: Tag; on?: boolean; onPress?: () => void }) {
    const body = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 24, borderRadius: R.pill, backgroundColor: on ? C.blue : C.blueSoft }}>
            {tag.emojiId ? <Image source={{ uri: emojiUrl(tag.emojiId, false, 32) }} style={{ width: 14, height: 14 }} /> : tag.emojiName ? <T size={12}>{tag.emojiName}</T> : null}
            <T size={12} color={on ? C.white : C.navy} weight="700">
                {tag.name}
            </T>
        </View>
    )
    return onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`tag ${tag.name}`}>
            {body}
        </Pressable>
    ) : (
        body
    )
}

/** 첫 메시지의 그림 (작은 그림으로) */
function firstImage(m: any): string | undefined {
    const a = (m?.attachments ?? []).find((f: any) => /^image\//.test(f.content_type ?? '') || f.width)
    if (a) return a.proxy_url ?? a.url
    for (const e of m?.embeds ?? []) {
        const u = mediaUrl(e.image) ?? mediaUrl(e.thumbnail)
        if (u) return u
    }
}

const PostCard = memo(function PostCard({ post, tags, guildId }: { post: Post; tags: Map<string, Tag>; guildId?: string }) {
    useEffect(() => {
        if (!post.first && !post.archived) loadFirst(post.id)
    }, [post.id])
    const author = post.first?.author ?? user(post.ownerId)
    const name = author ? displayName(S().UserStore?.getUser?.(author.id) ?? author, guildId) : ''
    const preview = previewText(post.first, guildId)
    const pic = firstImage(post.first)
    return (
        <Pressable onPress={() => go.channel(post.id)} accessibilityRole="button" accessibilityLabel={post.name} style={({ pressed }) => [{ marginHorizontal: 12, marginVertical: 6, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
            <View style={[{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 16, backgroundColor: C.white }, shadow(3)]}>
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {author ? <Avatar uri={avatarUrl(author, 48, guildId)} size={22} ring="transparent" /> : null}
                        <T size={12} color={C.muted} weight="700" lines={1} style={{ flexShrink: 1 }}>
                            {[name, post.last ? formatTime(post.last / 1000, 'R') : ''].filter(Boolean).join(', ')}
                        </T>
                        {post.pinned ? <Icon names={['PinIcon']} color={C.teal} size={14} /> : null}
                        {post.archived ? (
                            <T size={11} color={C.muted} weight="700">
                                보관됨
                            </T>
                        ) : null}
                    </View>
                    <T size={16} weight="800" lines={2}>
                        {post.name}
                    </T>
                    {preview ? (
                        <T size={13} color={C.muted} weight="600" lines={2}>
                            {preview}
                        </T>
                    ) : null}
                    {post.tags.length ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {post.tags.map(id => (tags.get(id) ? <TagChip key={id} tag={tags.get(id)!} /> : null))}
                        </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Icon names={['ChatIcon']} color={C.muted} size={14} />
                        <T size={12} color={C.muted} weight="700">
                            {post.count}
                        </T>
                    </View>
                </View>
                {pic ? <Image source={{ uri: pic }} style={{ width: 84, height: 84, borderRadius: 12, backgroundColor: C.blueSoft }} /> : null}
            </View>
        </Pressable>
    )
})

// ── 새 글 ───────────────────────────────────────────────────────────────
function NewPost({ forumId, tags, onClose }: { forumId: string; tags: Tag[]; onClose: () => void }) {
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [picked, setPicked] = useState<string[]>([])
    const [busy, setBusy] = useState(false)
    const required = !!(channel(forumId)?.flags & 16) // REQUIRE_TAG
    const ok = title.trim() && body.trim() && (!required || picked.length) && !busy
    const submit = async () => {
        if (!ok) return
        setBusy(true)
        const id = await createPost(forumId, title, body, picked)
        setBusy(false)
        if (!id) return toast('글을 올리지 못했어요')
        onClose()
        go.channel(id)
    }
    const field = { borderRadius: 12, backgroundColor: C.white, borderWidth: 1.5, borderColor: C.line, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: C.ink, fontWeight: '600' as const }
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, justifyContent: 'center', padding: 16 }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose} accessibilityLabel="Close new post" />
            <View style={[{ alignSelf: 'center', width: '100%', maxWidth: 560, borderRadius: R.panel, backgroundColor: C.panel, overflow: 'hidden' }, shadow(10)]}>
                <View style={{ height: 48, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.teal }}>
                    <T size={17} color={C.white} weight="800">
                        새 글
                    </T>
                    <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
                        <Icon names={['XLargeIcon', 'CloseIcon']} color={C.white} size={22} />
                    </Pressable>
                </View>
                <View style={{ padding: 16, gap: 10 }}>
                    <TextInput value={title} onChangeText={setTitle} placeholder={tr('제목')} placeholderTextColor={C.muted} maxLength={100} style={field} />
                    <TextInput value={body} onChangeText={setBody} placeholder={tr('내용')} placeholderTextColor={C.muted} multiline style={{ ...field, minHeight: 110, maxHeight: 220, textAlignVertical: 'top' }} />
                    {tags.length ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                            {tags.map(t => (
                                <TagChip key={t.id} tag={t} on={picked.includes(t.id)} onPress={() => setPicked(p => (p.includes(t.id) ? p.filter(x => x !== t.id) : p.length < 5 ? [...p, t.id] : p))} />
                            ))}
                        </View>
                    ) : null}
                    {required && !picked.length ? (
                        <T size={12} color={C.red} weight="700">
                            태그를 하나 이상 골라야 해요
                        </T>
                    ) : null}
                    <View style={{ alignItems: 'flex-end' }}>
                        <PillButton label={busy ? '올리는 중' : '올리기'} onPress={submit} />
                    </View>
                </View>
            </View>
        </View>
    )
}

// ── 포럼 전체 ───────────────────────────────────────────────────────────
export function ForumView({ forumId, compact, onList }: { forumId: string; compact: boolean; onList?: () => void }) {
    const v = useForumVersion()
    // 스레드 목록, 메시지가 바뀌어도 다시 계산
    const storeTick = useStores(['ChannelStore', 'ActiveThreadsStore', 'ActiveJoinedThreadsStore'], () => S().ChannelStore?.getChannel?.(forumId), [forumId])
    const forum = channel(forumId)
    const tags = useMemo(() => forumTags(forum), [forum])
    const tagMap = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])
    const [filter, setFilter] = useState<string | null>(null)
    const [writing, setWriting] = useState(false)
    const posts = useMemo(() => forumPosts(forumId).filter(p => !filter || p.tags.includes(filter)), [forumId, v, storeTick, filter])
    const status = forumStatus(forumId)
    useEffect(() => {
        loadMore(forumId)
    }, [forumId])
    const renderItem = useCallback(({ item }: { item: Post }) => <PostCard post={item} tags={tagMap} guildId={forum?.guild_id} />, [tagMap, forum?.guild_id])

    return (
        <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 8 : 14, paddingHorizontal: compact ? 12 : 18, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.25)' }}>
                <View style={{ width: compact ? 40 : 48, height: compact ? 40 : 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.9)', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon names={['ForumIcon', 'TextIcon']} color={C.navy} size={compact ? 22 : 26} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={compact ? 18 : 22} color={C.white} weight="800" lines={1}>
                        {forum?.name ?? ''}
                    </T>
                    {forum?.topic ? (
                        <T size={13} color="rgba(255,255,255,0.85)" weight="600" lines={2} style={{ marginTop: 2 }}>
                            {plainText(String(forum.topic), forum.guild_id)}
                        </T>
                    ) : null}
                </View>
                <PillButton label="글 쓰기" small onPress={() => setWriting(true)} />
                {onList ? <PillButton label="리스트" kind="white" small onPress={onList} /> : null}
            </View>
            {tags.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingTop: 10 }}>
                    <TagChip tag={{ id: '', name: '전체' }} on={!filter} onPress={() => setFilter(null)} />
                    {tags.map(t => (
                        <TagChip key={t.id} tag={t} on={filter === t.id} onPress={() => setFilter(f => (f === t.id ? null : t.id))} />
                    ))}
                </View>
            ) : null}
            <FlatList
                data={posts}
                keyExtractor={p => p.id}
                renderItem={renderItem}
                onEndReached={() => loadMore(forumId)}
                onEndReachedThreshold={0.5}
                initialNumToRender={8}
                windowSize={7}
                removeClippedSubviews
                contentContainerStyle={{ paddingVertical: 8 }}
                ListEmptyComponent={
                    <View style={{ alignItems: 'center', padding: 32 }}>
                        <T size={14} color="rgba(255,255,255,0.85)">
                            {status.loading ? '불러오는 중' : status.error ? '글을 불러오지 못했어요' : '아직 글이 없어요'}
                        </T>
                    </View>
                }
                ListFooterComponent={status.loading && posts.length ? <T size={13} color="rgba(255,255,255,0.85)" style={{ textAlign: 'center', padding: 12 }}>불러오는 중</T> : null}
            />
            {writing ? <NewPost forumId={forumId} tags={tags} onClose={() => setWriting(false)} /> : null}
        </View>
    )
}
