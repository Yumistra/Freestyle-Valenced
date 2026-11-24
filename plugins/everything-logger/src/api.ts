import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'

/** 아직 불러오지 않은 디스코드 모듈도 찾는다 */
export function findMod(...props: string[]): any {
    try {
        const a = (lookupModule(withProps(...(props as [string])) as any) as any)?.[0]
        if (a) return a
    } catch {}
    try {
        return ((lookupModule as any)(withProps(...(props as [string])) as any, { uninitialized: true, initialize: true }) as any)?.[0]
    } catch {}
}

let http: any
/** 디스코드의 요청 함수 (HTTP.get 등) */
export function api(): any {
    if (!http) {
        const a = findMod('HTTP')?.HTTP
        http = a?.get ? a : findMod('getAPIBaseURL', 'get')
    }
    return http
}

/** 요청을 한 번에 하나씩, 사이를 두고 (요청 제한에 걸리지 않게) */
let queue: Promise<any> = Promise.resolve()
export function later<T>(gapMs: number, job: () => Promise<T>): Promise<T | undefined> {
    const p = queue.then(() => new Promise(done => setTimeout(done, gapMs))).then(job)
    queue = p.catch(() => {})
    return p.catch(() => undefined)
}
