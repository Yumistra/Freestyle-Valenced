import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { ReactNavigationNative } from '@valenced/externals/react-navigation'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useState } from 'react'
import { Image, Pressable, ScrollView, View } from 'react-native'
import { removeOne } from './logger'
import { logs, seen, type Entry } from './store'

/**
 * 로그 보기: 채팅 메시지와 같은 모양(아바타, 이름, 시간, 내용)으로 보여 주고,
 * 누르면 설정을 닫고 그 메시지가 있는 곳으로 간다 (디스코드 transitionToMessage).
 */

const PAGE = 40
const RED = '#f23f43'

/** 디스코드 이동 함수 (transitionToMessage(channelId, messageId)) */
let toMessage: ((channelId: string, messageId: string, opts?: any) => void) | undefined
export function bindNavigation(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(withProps('transitionToMessage') as any, (mod: any) => {
            if (typeof mod?.transitionToMessage === 'function') toMessage = mod.transitionToMessage.bind(mod)
        }) as any,
    )
}

function authorOf(id: string, e: Entry): any {
    const S: any = Stores
    return e.m?.author ?? S.MessageStore?.getMessage?.(e.c, id)?.author ?? (seen() as any)[id]?.m?.author
}

function avatarUrl(a: any) {
    if (a?.id && a.avatar) return `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.png?size=96`
    let n = 0
    try {
        n = Number((BigInt(a?.id ?? '0') >> BigInt(22)) % BigInt(6))
    } catch {}
    return `https://cdn.discordapp.com/embed/avatars/${n}.png`
}

/** 스노플레이크에서 보낸 시각 */
const sentAt = (id: string) => {
    try {
        return Number(BigInt(id) >> BigInt(22)) + 1420070400000
    } catch {
        return 0
    }
}

/** 디스코드 언어에 맞춘 "(수정됨)" */
function editedWord() {
    try {
        const l = String((Stores as any).LocaleStore?.locale ?? (Stores as any).UserSettingsStore?.locale ?? '')
        if (l.startsWith('ko')) return '(수정됨)'
        if (l.startsWith('ja')) return '(編集済)'
    } catch {}
    return '(edited)'
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : '')

function where(e: Entry) {
    try {
        const S: any = Stores
        const ch = S.ChannelStore?.getChannel?.(e.c)
        if (!ch) return ''
        const guild = e.g ? S.GuildStore?.getGuild?.(e.g)?.name : ''
        return ch.name ? `${guild ? `${guild}, ` : ''}#${ch.name}` : 'DM'
    } catch {
        return ''
    }
}

/** 설정 화면들을 닫는다 (안쪽 목록부터 맨 처음 화면까지) */
function closeSettings(nav: any) {
    let n = nav
    let guard = 0
    while (n && guard++ < 8) {
        try {
            if (n.canGoBack?.()) n.popToTop?.() ?? n.goBack?.()
        } catch {}
        n = n.getParent?.()
    }
}

function Row({ id, e, onOpen, onDelete }: { id: string; e: Entry; onOpen(): void; onDelete(): void; key?: string }) {
    const { Text, Button } = Design as any
    const S: any = Stores
    const a = authorOf(id, e)
    const name = a?.globalName ?? a?.global_name ?? a?.username ?? 'Unknown'
    const now = S.MessageStore?.getMessage?.(e.c, id)
    const current = e.d ? String(e.m?.content ?? now?.content ?? '') : String(now?.content ?? '')
    const files = (e.m?.attachments ?? now?.attachments ?? []).length
    const deleted = !!e.d
    return (
        <Pressable
            onPress={onOpen}
            style={{
                flexDirection: 'row',
                paddingVertical: 8,
                paddingHorizontal: 12,
                marginVertical: 2,
                borderLeftWidth: 2,
                borderLeftColor: deleted ? RED : 'rgba(148,155,164,0.9)',
                backgroundColor: deleted ? 'rgba(242,63,67,0.08)' : 'rgba(148,155,164,0.08)',
            }}
        >
            <Image source={{ uri: avatarUrl(a) }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} />
            <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Text variant="text-md/semibold" color="header-primary">
                        {name}
                    </Text>
                    <Text variant="text-xs/medium" color="text-muted" style={{ marginLeft: 6 }}>
                        {when(sentAt(id))}
                    </Text>
                </View>
                {!deleted &&
                    (e.e ?? []).map((h, i) => (
                        <Text key={i} variant="text-md/normal" color="text-muted" style={{ opacity: 0.75 }}>
                            {h.t || ' '}
                            <Text variant="text-xs/medium" color="text-muted">
                                {`  ${editedWord()} ${when(h.at)}`}
                            </Text>
                        </Text>
                    ))}
                <Text variant="text-md/normal" color={deleted ? undefined : 'text-normal'} style={deleted ? { color: RED } : undefined}>
                    {current || (files ? '' : ' ')}
                    {!deleted && now?.editedTimestamp ? (
                        <Text variant="text-xs/medium" color="text-muted">
                            {`  ${editedWord()}`}
                        </Text>
                    ) : null}
                </Text>
                {files ? (
                    <Text variant="text-sm/medium" color="text-muted">
                        {`${files} attachment${files > 1 ? 's' : ''}`}
                    </Text>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                    <Text variant="text-xs/medium" color="text-muted" style={{ flex: 1 }}>
                        {[deleted ? `Deleted ${when(e.d!)}` : `Edited ${e.e?.length ?? 0} time(s)`, where(e)].filter(Boolean).join(', ')}
                    </Text>
                    <Button text="Delete log" variant="destructive" size="sm" onPress={onDelete} />
                </View>
            </View>
        </Pressable>
    )
}

export function LogsView({ onBack }: { onBack(): void }) {
    const { Text, Button, Stack } = Design as any
    const [shown, setShown] = useState(PAGE)
    const [, force] = useState(0)
    let nav: any
    try {
        nav = (ReactNavigationNative as any)?.useNavigation?.()
    } catch {}
    const entries = Object.entries(logs())
        .filter(([, e]) => e.d || e.e?.length)
        .sort((a, b) => (b[1].d ?? b[1].at) - (a[1].d ?? a[1].at))
    const open = (id: string, e: Entry) => {
        closeSettings(nav)
        setTimeout(() => {
            try {
                toMessage?.(e.c, id)
            } catch {}
        }, 350)
    }
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 12, paddingBottom: 48 }}>
            <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
                <Stack spacing={8}>
                    <Button text="Back to settings" variant="secondary" size="md" onPress={onBack} />
                    <Text variant="text-sm/medium" color="text-muted">
                        {entries.length ? `${entries.length} log(s). Tap a message to go to it.` : 'No logs yet.'}
                    </Text>
                </Stack>
            </View>
            {entries.slice(0, shown).map(([id, e]) => (
                <Row
                    key={id}
                    id={id}
                    e={e}
                    onOpen={() => open(id, e)}
                    onDelete={() => {
                        removeOne(id)
                        force(n => n + 1)
                    }}
                />
            ))}
            {entries.length > shown ? (
                <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
                    <Button text={`Show more (${entries.length - shown} left)`} variant="secondary" size="md" onPress={() => setShown(n => n + PAGE)} />
                </View>
            ) : null}
        </ScrollView>
    )
}
