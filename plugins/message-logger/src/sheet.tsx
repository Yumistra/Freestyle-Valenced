import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { addTo, inList, nameOf, removeFrom } from './filters'
import { hideInChat, removeOne } from './logger'
import { logs } from './store'

/**
 * 메시지를 길게 눌렀을 때 나오는 메뉴 맨 밑에, 디스코드 버튼들과 떨어진 묶음으로
 *  - "… (keep in logs)": 채팅에서만 지운다 (View logs 에는 남는다)
 *  - "… and delete log": 채팅과 로그 둘 다에서 지운다 (View logs 의 Delete log 와 같다)
 * 를 넣는다. 지운 메시지면 Remove from chat, 수정 기록이면 Clear edit history.
 *
 * 메뉴는 LongPressMessageActionSheet 가 그린다. 이 컴포넌트는
 * <AnalyticsLocationProvider><ActionSheet>{묶음들}</ActionSheet></…> 를 바로 돌려주므로,
 * 그 결과에서 ActionSheet 를 찾아 children 맨 뒤에 우리 묶음을 넣는다.
 */

type El = { type?: unknown; props?: { children?: unknown; showGradient?: unknown; [k: string]: unknown } }

function icon(name: string) {
    const { ActionSheetRow } = Design as any
    const C = lookupGeneratedIconComponent(name as any) ?? lookupGeneratedIconComponent('TrashIcon' as any)
    return <ActionSheetRow.Icon IconComponent={C} />
}

function done() {
    try {
        ActionSheetActionCreators.hideActionSheet()
    } catch {}
}

/** 보낸 사람을 블랙리스트에 넣거나 빼기 */
function FilterRow({ author }: { author?: any }) {
    const { ActionSheetRow } = Design as any
    const uid = author?.id ? String(author.id) : undefined
    if (!uid) return null
    const blocked = inList('block', uid)
    const name = author.globalName ?? author.global_name ?? author.username ?? nameOf(uid)
    return (
        <ActionSheetRow
            icon={icon(blocked ? 'UserPlusIcon' : 'UserMinusIcon')}
            label={blocked ? `Log ${name} again` : `Stop logging ${name}`}
            onPress={() => {
                done()
                if (blocked) removeFrom('block', uid)
                else addTo('block', uid)
            }}
        />
    )
}

function Actions({ id, author }: { id: string; author?: any; key?: string }) {
    const e = logs()[id]
    const { ActionSheetRow } = Design as any
    if (!e || e.h || (!e.d && !e.e?.length))
        return (
            <ActionSheetRow.Group>
                <FilterRow author={author} />
            </ActionSheetRow.Group>
        )
    const what = e.d ? 'Remove from chat' : 'Clear edit history'
    return (
        <ActionSheetRow.Group>
            <ActionSheetRow
                icon={icon(e.d ? 'EyeSlashIcon' : 'ClockXIcon')}
                label={what}
                onPress={() => {
                    done()
                    hideInChat(id)
                }}
            />
            <ActionSheetRow
                icon={icon('TrashIcon')}
                label={`${what} and delete log`}
                variant="danger"
                onPress={() => {
                    done()
                    removeOne(id)
                }}
            />
            <FilterRow author={author} />
        </ActionSheetRow.Group>
    )
}

function findSheet(node: unknown): El | undefined {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const c of node) {
            const f = findSheet(c)
            if (f) return f
        }
        return
    }
    const el = node as El
    if (!el.props) return
    let AS: unknown
    try {
        AS = (Design as any).ActionSheet
    } catch {}
    if ((AS && el.type === AS) || 'showGradient' in el.props) return el
    return findSheet(el.props.children)
}

export function patchSheet(cleanup: (...f: Array<() => void>) => void) {
    cleanup(
        getModules(
            withName('LongPressMessageActionSheet') as any,
            (mod: any) => {
                if (typeof mod?.default !== 'function') return
                cleanup(
                    instead(mod, 'default', function (this: unknown, args: any[], orig: (...a: any[]) => any) {
                        const tree = orig.apply(this, args)
                        try {
                            const msg = args[0]?.message
                            const id = msg?.id
                            if (id && msg?.author?.id) {
                                const sheet = findSheet(tree)
                                if (sheet?.props) {
                                    const children = [sheet.props.children].flat().filter(Boolean)
                                    children.push(<Actions key="message-logger" id={String(id)} author={msg.author} />)
                                    sheet.props.children = children
                                }
                            }
                        } catch {}
                        return tree
                    }),
                )
            },
            { returnNamespace: true } as any,
        ) as any,
    )
}
