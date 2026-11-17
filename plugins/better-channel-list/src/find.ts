import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

/**
 * 모듈 찾기 (props 로). 찾은 것은 기억하고, 못 찾은 것은 2 초에 한 번만 다시 찾는다.
 * 채널 줄마다 lookupModule 을 부르면 목록을 그릴 때 수십 ms 가 든다.
 */
const hits = new Map<string, any>()
const misses = new Map<string, number>()
export let lookups = 0

export function find(...props: string[]): any {
    const key = props.join('\u0000')
    if (hits.has(key)) return hits.get(key)
    const last = misses.get(key)
    if (last != null && Date.now() - last < 2000) return undefined
    lookups++
    let mod: any
    try {
        mod = (lookupModule(withProps(...props) as any) as any)?.[0]
    } catch {}
    if (mod) {
        hits.set(key, mod)
        misses.delete(key)
    } else misses.set(key, Date.now())
    return mod
}
