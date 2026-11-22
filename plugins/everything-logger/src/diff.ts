/**
 * 두 글의 차이 (낱말 단위). 빠진 것은 del, 새로 생긴 것은 add, 그대로는 same.
 * 아주 긴 글은 계산이 무거워서 통째로 바뀐 것으로 본다.
 */
export interface Part {
    t: string
    k: 'same' | 'del' | 'add'
}

const MAX = 600

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? []

export function diff(a: string, b: string): Part[] {
    if (a === b) return a ? [{ t: a, k: 'same' }] : []
    const x = tokens(a)
    const y = tokens(b)
    if (x.length * y.length > MAX * MAX) return [...(a ? [{ t: a, k: 'del' as const }] : []), ...(b ? [{ t: b, k: 'add' as const }] : [])]
    // 앞뒤 같은 부분은 빼고 가운데만 비교
    let start = 0
    while (start < x.length && start < y.length && x[start] === y[start]) start++
    let endX = x.length
    let endY = y.length
    while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
        endX--
        endY--
    }
    const xs = x.slice(start, endX)
    const ys = y.slice(start, endY)
    const n = xs.length
    const m = ys.length
    // 가장 긴 공통 부분 (LCS)
    const dp: number[][] = []
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    const out: Part[] = []
    const add = (t: string, k: Part['k']) => {
        const last = out[out.length - 1]
        if (last && last.k === k) last.t += t
        else out.push({ t, k })
    }
    if (start) add(x.slice(0, start).join(''), 'same')
    let i = 0
    let j = 0
    while (i < n && j < m) {
        if (xs[i] === ys[j]) {
            add(xs[i], 'same')
            i++
            j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) add(xs[i++], 'del')
        else add(ys[j++], 'add')
    }
    while (i < n) add(xs[i++], 'del')
    while (j < m) add(ys[j++], 'add')
    if (endX < x.length) add(x.slice(endX).join(''), 'same')
    return out
}
