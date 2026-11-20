import { memo, useEffect, useState } from 'react'
import { FlatList, Image, Pressable, ScrollView, View } from 'react-native'
import { avatarUrl, me, toast } from '../data'
import { Avatar, Icon, T } from '../parts'
import { type Category, decorationUrl, fetchOwned, fetchShop, type Product, wearDecoration } from '../store'
import { C, R, shadow } from '../theme'
import { Frame, leaveTo } from './Frame'
import { Chips, Note } from './Tools'

/**
 * 상점: 꾸미기 아이템을 Stella 카드로 보여 주고, 내 아바타에 씌워 미리 본다.
 * 사는 것(결제)만 디스코드 상점 화면으로 연다. 가진 아바타 꾸미기는 바로 쓸 수 있다.
 */

const TYPE_LABEL: Record<number, string> = { 0: '아바타 꾸미기', 1: '프로필 효과', 2: '이름표', 3: '묶음', 1000: '묶음' }

const buy = () => leaveTo('shop')

/** 아바타에 꾸미기를 씌운 미리보기 */
function Preview({ p, size }: { p: Product; size: number }) {
    const deco = p.items.find(i => i.type === 0 && i.asset)
    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Avatar uri={avatarUrl(me(), 128)} size={Math.round(size * 0.72)} ring="transparent" />
            {deco ? <Image source={{ uri: decorationUrl(deco.asset!) }} style={{ position: 'absolute', width: size * 0.86, height: size * 0.86 }} /> : null}
            {!deco ? (
                <View style={{ position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: 14, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon names={['SparklesIcon', 'StarIcon']} color={C.white} size={16} />
                </View>
            ) : null}
        </View>
    )
}

const ProductCard = memo(function ProductCard({ p, width, onPress }: { p: Product; width: number; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`product ${p.name}`} style={({ pressed }) => [{ margin: 6, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
            <View style={[{ width, padding: 12, borderRadius: 18, backgroundColor: C.white, alignItems: 'center', gap: 6 }, shadow(3)]}>
                <Preview p={p} size={Math.min(120, width - 24)} />
                <T size={14} weight="800" lines={2} style={{ textAlign: 'center' }}>
                    {p.name}
                </T>
                <T size={12} color={p.owned ? C.green : C.tealDeep} weight="800">
                    {p.owned ? '가지고 있음' : (p.price ?? TYPE_LABEL[p.type] ?? '')}
                </T>
            </View>
        </Pressable>
    )
})

function Detail({ p, onClose }: { p: Product; onClose: () => void }) {
    const deco = p.items.find(i => i.type === 0)
    return (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.shade, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={onClose} accessibilityLabel="Close product" />
            <View style={[{ width: '100%', maxWidth: 420, padding: 20, borderRadius: R.panel, backgroundColor: C.panel, alignItems: 'center', gap: 10 }, shadow(10)]}>
                <Preview p={p} size={180} />
                <T size={20} weight="800" style={{ textAlign: 'center' }}>
                    {p.name}
                </T>
                <T size={14} color={C.muted} style={{ textAlign: 'center' }}>
                    {p.summary}
                </T>
                <T size={13} weight="800" color={C.tealDeep}>
                    {[TYPE_LABEL[p.type], p.price, p.nitroPrice ? `Nitro ${p.nitroPrice}` : ''].filter(Boolean).join(', ')}
                </T>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    {p.owned && deco ? (
                        <Chips<string>
                            options={[
                                ['wear', '쓰기'],
                                ['off', '벗기'],
                            ]}
                            value={undefined}
                            onChange={async v => {
                                if (await wearDecoration(v === 'wear' ? deco : null)) toast(v === 'wear' ? '아바타 꾸미기를 썼어요' : '아바타 꾸미기를 벗었어요')
                            }}
                        />
                    ) : !p.owned ? (
                        <Pressable onPress={buy} accessibilityRole="button" accessibilityLabel="사기">
                            <View style={[{ height: 44, paddingHorizontal: 28, borderRadius: 12, backgroundColor: C.teal, justifyContent: 'center' }, shadow(3)]}>
                                <T size={15} color={C.white} weight="800">
                                    사기 (디스코드 결제)
                                </T>
                            </View>
                        </Pressable>
                    ) : null}
                </View>
            </View>
        </View>
    )
}

export function ShopScreen({ width }: { width: number }) {
    const [cats, setCats] = useState<Category[] | null>(null)
    const [owned, setOwned] = useState<Product[]>([])
    const [error, setError] = useState('')
    const [tab, setTab] = useState<string>('')
    const [open, setOpen] = useState<Product | null>(null)
    useEffect(() => {
        fetchShop()
            .then(c => {
                setCats(c)
                setTab(t => t || c[0]?.skuId || 'owned')
            })
            .catch(e => setError(String(e?.body?.message ?? e?.message ?? e)))
        fetchOwned().then(setOwned)
    }, [])
    const ownedSkus = new Set(owned.map(p => p.skuId))
    const list = tab === 'owned' ? owned : (cats?.find(c => c.skuId === tab)?.products ?? []).map(p => (ownedSkus.has(p.skuId) ? { ...p, owned: true } : p))
    const cat = cats?.find(c => c.skuId === tab)
    const inner = Math.min(width, 1100) - 24
    const cols = Math.max(2, Math.floor(inner / 190))
    const cardW = Math.floor(inner / cols) - 12
    return (
        <Frame title="상점" width={width}>
            {error ? (
                <Note text={`상점을 불러오지 못했어요: ${error}`} />
            ) : !cats ? (
                <Note text="불러오는 중…" />
            ) : (
                <View style={{ flex: 1 }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
                        {[{ skuId: 'owned', name: `가진 것 ${owned.length}` }, ...cats].map(c => (
                            <Pressable key={c.skuId} onPress={() => setTab(c.skuId)} accessibilityRole="tab" accessibilityLabel={c.name} accessibilityState={{ selected: tab === c.skuId }}>
                                <View style={{ height: 36, paddingHorizontal: 14, borderRadius: R.pill, justifyContent: 'center', backgroundColor: tab === c.skuId ? C.teal : 'rgba(255,255,255,0.92)' }}>
                                    <T size={13} weight="800" color={tab === c.skuId ? C.white : C.ink} lines={1}>
                                        {c.name}
                                    </T>
                                </View>
                            </Pressable>
                        ))}
                    </ScrollView>
                    <FlatList
                        key={`${tab}/${cols}`}
                        data={list}
                        numColumns={cols}
                        keyExtractor={p => p.skuId}
                        renderItem={({ item }) => <ProductCard p={item} width={cardW} onPress={() => setOpen(item)} />}
                        ListHeaderComponent={
                            cat?.banner ? (
                                <View style={[{ marginHorizontal: 6, marginBottom: 6, borderRadius: 18, overflow: 'hidden', backgroundColor: C.navy }, shadow(3)]}>
                                    <Image source={{ uri: cat.banner }} style={{ width: '100%', height: 120 }} resizeMode="cover" />
                                    {cat.summary ? (
                                        <T size={13} color={C.white} weight="700" style={{ padding: 10 }} lines={2}>
                                            {cat.summary}
                                        </T>
                                    ) : null}
                                </View>
                            ) : null
                        }
                        ListEmptyComponent={<Note text={tab === 'owned' ? '가진 꾸미기가 없어요' : '아이템이 없어요'} />}
                        initialNumToRender={12}
                        windowSize={7}
                        contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 24 }}
                    />
                </View>
            )}
            {open ? <Detail p={open} onClose={() => setOpen(null)} /> : null}
        </Frame>
    )
}
