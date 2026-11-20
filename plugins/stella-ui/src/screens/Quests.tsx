import { memo, useCallback, useEffect, useState } from 'react'
import { FlatList, Image, Pressable, View } from 'react-native'
import { toast } from '../data'
import { formatTime } from '../markdown'
import { T } from '../parts'
import { enrollQuest, fetchQuests, type Quest, taskLabel } from '../store'
import { C, shadow } from '../theme'
import { Frame, leaveTo } from './Frame'
import { Note } from './Tools'

/**
 * 임무(디스코드 퀘스트): 받을 수 있는 퀘스트, 진행 상황, 보상. 받기는 여기서 하고,
 * 진행(영상 보기, 게임하기)과 보상 받기(보안 확인)는 디스코드 퀘스트 화면에서 한다.
 */

const openQuests = () => leaveTo('quests')

const QuestCard = memo(function QuestCard({ q, onEnroll }: { q: Quest; onEnroll: (id: string) => void }) {
    const t = q.task
    const ratio = t && t.target ? Math.min(1, t.value / t.target) : q.completed ? 1 : 0
    const state = q.claimed ? '보상 받음' : q.completed ? '완료, 보상 받기' : q.enrolled ? '진행하기' : '받기'
    const action = q.claimed ? undefined : q.enrolled || q.completed ? openQuests : () => onEnroll(q.id)
    return (
        <View style={[{ marginHorizontal: 12, marginVertical: 8, borderRadius: 18, overflow: 'hidden', backgroundColor: C.white }, shadow(4)]}>
            {q.hero ? <Image source={{ uri: q.hero }} style={{ width: '100%', height: 140, backgroundColor: C.navy }} resizeMode="cover" /> : null}
            <View style={{ padding: 14, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {q.logo ? <Image source={{ uri: q.logo }} style={{ width: 90, height: 28 }} resizeMode="contain" /> : null}
                    <T size={12} color={C.muted} weight="700" style={{ flex: 1, textAlign: 'right' }} lines={1}>
                        {q.expiresAt ? `${formatTime(q.expiresAt / 1000, 'd')} 까지` : ''}
                    </T>
                </View>
                <T size={17} weight="800">
                    {q.name}
                </T>
                <T size={13} color={C.muted}>
                    {[q.game, q.publisher].filter(Boolean).join(', ')}
                </T>
                {q.reward ? (
                    <T size={14} weight="800" color={C.tealDeep}>
                        {`보상: ${q.reward}`}
                    </T>
                ) : null}
                {t ? (
                    <View style={{ gap: 4 }}>
                        <T size={12} color={C.ink} weight="700">
                            {`${taskLabel(t.kind)}${t.target ? `, ${Math.floor(t.value / 60)}/${Math.ceil(t.target / 60)}분` : ''}`}
                        </T>
                        <View style={{ height: 8, borderRadius: 4, backgroundColor: C.blueSoft, overflow: 'hidden' }}>
                            <View style={{ width: `${Math.round(ratio * 100)}%`, height: 8, borderRadius: 4, backgroundColor: q.completed ? C.green : C.teal }} />
                        </View>
                    </View>
                ) : null}
                <Pressable onPress={action} disabled={!action} accessibilityRole="button" accessibilityLabel={`${state} ${q.id}`} style={({ pressed }) => [{ marginTop: 4, opacity: !action ? 0.5 : pressed ? 0.85 : 1 }]}>
                    <View style={{ height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: q.completed && !q.claimed ? C.green : q.enrolled ? C.navy : C.teal }}>
                        <T size={15} color={C.white} weight="800">
                            {state}
                        </T>
                    </View>
                </Pressable>
            </View>
        </View>
    )
})

export function QuestsScreen({ width }: { width: number }) {
    const [list, setList] = useState<Quest[] | null>(null)
    const [error, setError] = useState('')
    const load = useCallback(() => {
        fetchQuests()
            .then(setList)
            .catch(e => setError(String(e?.body?.message ?? e?.message ?? e)))
    }, [])
    useEffect(load, [load])
    const enroll = useCallback(
        async (id: string) => {
            if (await enrollQuest(id)) {
                toast('퀘스트를 받았어요')
                load()
            }
        },
        [load],
    )
    return (
        <Frame title="임무" width={width}>
            {error ? (
                <Note text={`퀘스트를 불러오지 못했어요: ${error}`} />
            ) : !list ? (
                <Note text="불러오는 중…" />
            ) : (
                <FlatList
                    data={list}
                    keyExtractor={q => q.id}
                    renderItem={({ item }) => <QuestCard q={item} onEnroll={enroll} />}
                    ListEmptyComponent={<Note text="지금 받을 수 있는 퀘스트가 없어요" />}
                    contentContainerStyle={{ paddingBottom: 24 }}
                    initialNumToRender={4}
                    windowSize={5}
                />
            )}
        </Frame>
    )
}
