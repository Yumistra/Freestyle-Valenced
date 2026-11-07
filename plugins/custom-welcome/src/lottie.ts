/**
 * 아주 작은 Lottie 그리기: 움직이는(Lottie) 스티커의 한 장면을 PNG 로 만든다.
 * 디스코드 서버는 Lottie 스티커의 정지 그림을 주지 않으므로, 스티커 JSON 을 받아
 * 모양 레이어(채우기, 선, 그룹, 변형, 부모, 프리컴프)만 직접 그린다.
 * 마스크, 매트, 효과, 글자 레이어는 건너뛴다 (미리보기용이라 대충 비슷하면 된다).
 */

type M = [number, number, number, number, number, number] // x' = a x + c y + e, y' = b x + d y + f
const I: M = [1, 0, 0, 1, 0, 0]
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]]
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

// ── 값 읽기 (움직이는 값은 그 프레임에서) ─────────────────────────────────────
function lerp(a: any, b: any, t: number): any {
    if (typeof a === 'number') return typeof b === 'number' ? a + (b - a) * t : a
    if (Array.isArray(a)) return a.map((v, i) => lerp(v, Array.isArray(b) ? b[i] : v, t))
    if (a && typeof a === 'object') {
        const o: any = {}
        for (const k of Object.keys(a)) o[k] = lerp(a[k], b?.[k], t)
        return o
    }
    return a
}
function value(prop: any, f: number, fallback?: any): any {
    if (!prop) return fallback
    const k = prop.k
    if (!prop.a || !Array.isArray(k) || !k.length || typeof k[0] !== 'object' || !('t' in k[0])) return k ?? fallback
    if (f <= k[0].t) return unwrap(k[0].s ?? fallback)
    for (let i = 0; i < k.length - 1; i++) {
        const a = k[i]
        const b = k[i + 1]
        if (f < b.t) {
            const s = a.s
            if (a.h === 1) return unwrap(s)
            const e = a.e ?? b.s ?? s
            const t = b.t > a.t ? (f - a.t) / (b.t - a.t) : 0
            return unwrap(lerp(s, e, t))
        }
    }
    const last = k[k.length - 1]
    return unwrap(last.s ?? k[k.length - 2]?.e ?? fallback)
}
/** 모양 키프레임은 [ {i,o,v,c} ] 처럼 한 겹 싸여 있다 */
const unwrap = (v: any) => (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' && 'v' in v[0] ? v[0] : v)
const num = (v: any, d = 0) => (Array.isArray(v) ? Number(v[0] ?? d) : typeof v === 'number' ? v : d)

function transform(ks: any, f: number): { m: M; o: number } {
    if (!ks) return { m: I, o: 1 }
    let px = 0
    let py = 0
    if (ks.p?.s) {
        px = num(value(ks.p.x, f))
        py = num(value(ks.p.y, f))
    } else {
        const p = value(ks.p, f, [0, 0])
        px = p?.[0] ?? 0
        py = p?.[1] ?? 0
    }
    const a = value(ks.a, f, [0, 0]) ?? [0, 0]
    const s = value(ks.s, f, [100, 100]) ?? [100, 100]
    const r = (num(value(ks.r ?? ks.rz, f)) * Math.PI) / 180
    const o = num(value(ks.o, f, 100), 100) / 100
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const sx = (s[0] ?? 100) / 100
    const sy = (s[1] ?? 100) / 100
    // T(p) · R · S · T(-a)
    const m: M = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0]
    const [ax, ay] = apply(m, -(a[0] ?? 0), -(a[1] ?? 0))
    m[4] = ax + px
    m[5] = ay + py
    return { m, o }
}

// ── 모양 → 점 목록 ────────────────────────────────────────────────────────
interface Poly {
    pts: number[] // x,y,x,y...
    closed: boolean
}
function bezier(out: number[], x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x1: number, y1: number) {
    const n = 12
    for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        out.push(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1)
    }
}
function pathPoly(sh: any): Poly | undefined {
    const v: number[][] = sh?.v ?? []
    const ii: number[][] = sh?.i ?? []
    const oo: number[][] = sh?.o ?? []
    if (!v.length) return
    const pts: number[] = [v[0][0], v[0][1]]
    const n = v.length
    const segs = sh.c ? n : n - 1
    for (let j = 0; j < segs; j++) {
        const a = v[j]
        const b = v[(j + 1) % n]
        const o = oo[j] ?? [0, 0]
        const i = ii[(j + 1) % n] ?? [0, 0]
        bezier(pts, a[0], a[1], a[0] + o[0], a[1] + o[1], b[0] + i[0], b[1] + i[1], b[0], b[1])
    }
    return { pts, closed: !!sh.c }
}
function ellipsePoly(p: number[], s: number[]): Poly {
    const pts: number[] = []
    const n = 40
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        pts.push(p[0] + (Math.cos(a) * s[0]) / 2, p[1] + (Math.sin(a) * s[1]) / 2)
    }
    return { pts, closed: true }
}
function rectPoly(p: number[], s: number[], r: number): Poly {
    const w = s[0] / 2
    const h = s[1] / 2
    const rr = Math.min(r, w, h)
    if (rr <= 0) return { pts: [p[0] - w, p[1] - h, p[0] + w, p[1] - h, p[0] + w, p[1] + h, p[0] - w, p[1] + h], closed: true }
    const pts: number[] = []
    const corner = (cx: number, cy: number, start: number) => {
        for (let i = 0; i <= 6; i++) {
            const a = start + (i / 6) * (Math.PI / 2)
            pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
        }
    }
    corner(p[0] + w - rr, p[1] - h + rr, -Math.PI / 2)
    corner(p[0] + w - rr, p[1] + h - rr, 0)
    corner(p[0] - w + rr, p[1] + h - rr, Math.PI / 2)
    corner(p[0] - w + rr, p[1] - h + rr, Math.PI)
    return { pts, closed: true }
}
const xform = (poly: Poly, m: M): Poly => {
    const pts = new Array(poly.pts.length)
    for (let i = 0; i < poly.pts.length; i += 2) {
        const [x, y] = apply(m, poly.pts[i], poly.pts[i + 1])
        pts[i] = x
        pts[i + 1] = y
    }
    return { pts, closed: poly.closed }
}

// ── 그리기 목록 만들기 ─────────────────────────────────────────────────────
interface Op {
    polys: Poly[]
    color: number[] // r,g,b 0..1
    alpha: number
    stroke?: number // 선 굵기 (화면 좌표)
    evenOdd?: boolean
}

function colorOf(c: any): number[] {
    const v = Array.isArray(c) ? c : [0, 0, 0]
    // 예전 파일은 0..255
    const big = v.some((x: number) => x > 1)
    return [0, 1, 2].map(i => Math.max(0, Math.min(1, (v[i] ?? 0) / (big ? 255 : 1))))
}
function gradientColor(it: any, f: number): number[] {
    const n = it.g?.p ?? 0
    const k = value(it.g?.k, f, []) ?? []
    if (!n || !k.length) return [0.5, 0.5, 0.5]
    // 색 멈춤들의 평균
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < n; i++) {
        r += k[i * 4 + 1] ?? 0
        g += k[i * 4 + 2] ?? 0
        b += k[i * 4 + 3] ?? 0
    }
    return colorOf([r / n, g / n, b / n])
}
const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1

/** 그룹 안의 항목들 → 그리기 목록(위에 있는 것이 먼저), 그리고 이 그룹의 모양(부모 스타일용) */
function group(items: any[], f: number, m: M, opacity: number): { ops: Op[]; geom: Poly[] } {
    const list = (items ?? []).filter((x: any) => x && !x.hd)
    const tr = list.find((x: any) => x.ty === 'tr')
    const t = tr ? transform(tr, f) : { m: I, o: 1 }
    const gm = mul(m, t.m)
    const op = opacity * t.o
    const geom: Poly[] = []
    const ops: Op[] = []
    for (const it of list) {
        switch (it.ty) {
            case 'sh': {
                const p = pathPoly(value(it.ks, f))
                if (p) geom.push(xform(p, gm))
                break
            }
            case 'el':
                geom.push(xform(ellipsePoly(value(it.p, f, [0, 0]), value(it.s, f, [0, 0])), gm))
                break
            case 'rc':
                geom.push(xform(rectPoly(value(it.p, f, [0, 0]), value(it.s, f, [0, 0]), num(value(it.r, f))), gm))
                break
            case 'gr': {
                const g = group(it.it, f, gm, op)
                ops.push(...g.ops)
                geom.push(...g.geom)
                break
            }
            case 'fl':
            case 'gf':
                ops.push({ polys: geom.slice(), color: it.ty === 'fl' ? colorOf(value(it.c, f)) : gradientColor(it, f), alpha: (num(value(it.o, f, 100), 100) / 100) * op, evenOdd: it.r === 2 })
                break
            case 'st':
            case 'gs':
                ops.push({
                    polys: geom.slice(),
                    color: it.ty === 'st' ? colorOf(value(it.c, f)) : gradientColor(it, f),
                    alpha: (num(value(it.o, f, 100), 100) / 100) * op,
                    stroke: Math.max(0.5, num(value(it.w, f, 1), 1) * scaleOf(gm)),
                })
                break
        }
    }
    return { ops, geom }
}

function layerOps(layers: any[], assets: any[], f: number, parentM: M, opacity: number, depth = 0): Op[] {
    if (!Array.isArray(layers) || depth > 6) return []
    const byInd = new Map<number, any>()
    for (const l of layers) if (typeof l?.ind === 'number') byInd.set(l.ind, l)
    const matrixOf = (l: any, seen = 0): M => {
        const own = transform(l.ks, f).m
        const p = typeof l.parent === 'number' ? byInd.get(l.parent) : undefined
        return p && seen < 20 ? mul(matrixOf(p, seen + 1), own) : own
    }
    const out: Op[] = []
    // 앞에 있는 레이어가 위 → 그리기 목록도 앞이 위
    for (const l of layers) {
        if (!l || l.hd || l.td) continue // 매트로 쓰이는 레이어는 그리지 않는다
        if (f < (l.ip ?? -Infinity) || f >= (l.op ?? Infinity)) continue
        const m = mul(parentM, matrixOf(l))
        const o = opacity * transform(l.ks, f).o
        if (o <= 0) continue
        if (l.ty === 4) out.push(...group([...(l.shapes ?? [])], f, m, o).ops)
        else if (l.ty === 1 && l.sw && l.sh) out.push({ polys: [xform(rectPoly([l.sw / 2, l.sh / 2], [l.sw, l.sh], 0), m)], color: hexColor(l.sc), alpha: o })
        else if (l.ty === 0) {
            const asset = assets.find(a => a?.id === l.refId)
            const inner = ((f - (l.st ?? 0)) / (l.sr ?? 1)) as number
            out.push(...layerOps(asset?.layers ?? [], assets, inner, m, o, depth + 1))
        }
    }
    return out
}
function hexColor(h: any): number[] {
    const m = /^#?([0-9a-f]{6})/i.exec(String(h ?? ''))
    if (!m) return [0.5, 0.5, 0.5]
    const n = parseInt(m[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// ── 칠하기 ───────────────────────────────────────────────────────────────
/** 선을 굵기만큼의 사각형들 + 꼭짓점 원으로 바꾼다 */
function strokePolys(poly: Poly, w: number): Poly[] {
    const out: Poly[] = []
    const p = poly.pts
    const n = p.length / 2
    const h = w / 2
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
        const dx = x1 - x0
        const dy = y1 - y0
        const len = Math.hypot(dx, dy) || 1
        const nx = (-dy / len) * h
        const ny = (dx / len) * h
        out.push({ pts: [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], closed: true })
    }
    for (let i = 0; i < n - 1; i++) seg(p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3])
    if (poly.closed && n > 2) seg(p[n * 2 - 2], p[n * 2 - 1], p[0], p[1])
    // 이음새를 둥글게 (너무 많으면 건너뛴다)
    const step = Math.max(1, Math.floor(n / 24))
    for (let i = 0; i < n; i += step) out.push(ellipsePoly([p[i * 2], p[i * 2 + 1]], [w, w]))
    return out
}

/** 다각형들을 칸(mask)에 칠한다 (1 = 안쪽) */
function raster(mask: Uint8Array, size: number, polys: Poly[], evenOdd: boolean) {
    const edges: number[] = [] // x0,y0,x1,y1,dir
    let minY = Infinity
    let maxY = -Infinity
    for (const poly of polys) {
        const p = poly.pts
        const n = p.length / 2
        if (n < 3) continue
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const y0 = p[i * 2 + 1]
            const y1 = p[j * 2 + 1]
            if (y0 === y1) continue
            edges.push(p[i * 2], y0, p[j * 2], y1, y1 > y0 ? 1 : -1)
            if (y0 < minY) minY = y0
            if (y1 < minY) minY = y1
            if (y0 > maxY) maxY = y0
            if (y1 > maxY) maxY = y1
        }
    }
    if (!edges.length) return
    const ya = Math.max(0, Math.floor(minY))
    const yb = Math.min(size - 1, Math.ceil(maxY))
    const xs: number[] = []
    const ds: number[] = []
    for (let y = ya; y <= yb; y++) {
        const sy = y + 0.5
        xs.length = 0
        ds.length = 0
        for (let e = 0; e < edges.length; e += 5) {
            const ay = edges[e + 1]
            const by = edges[e + 3]
            if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
                xs.push(edges[e] + ((edges[e + 2] - edges[e]) * (sy - ay)) / (by - ay))
                ds.push(edges[e + 4])
            }
        }
        if (xs.length < 2) continue
        const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
        let wind = 0
        for (let k = 0; k < order.length - 1; k++) {
            wind += evenOdd ? 1 : ds[order[k]]
            if (evenOdd ? wind % 2 === 0 : wind === 0) continue
            const xa = Math.max(0, Math.round(xs[order[k]]))
            const xb = Math.min(size, Math.round(xs[order[k + 1]]))
            const row = y * size
            for (let x = xa; x < xb; x++) mask[row + x] = 1
        }
    }
}

/** 칸(mask) 위에 색을 덮는다 (미리 곱한 색, source-over) */
function blend(buf: Float32Array, mask: Uint8Array, color: number[], a: number) {
    if (a <= 0) return
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue
        const i = p * 4
        buf[i] = color[0] * a + buf[i] * (1 - a)
        buf[i + 1] = color[1] * a + buf[i + 1] * (1 - a)
        buf[i + 2] = color[2] * a + buf[i + 2] * (1 - a)
        buf[i + 3] = a + buf[i + 3] * (1 - a)
    }
}

/**
 * Lottie JSON → RGBA (size × size, 0..255).
 * 2배로 크게 그린 뒤 줄여서 가장자리를 부드럽게 한다.
 */
export function renderLottie(json: any, size = 160, at = 0.4): Uint8Array | undefined {
    const w = Number(json?.w) || 512
    const h = Number(json?.h) || 512
    const ip = Number(json?.ip) || 0
    const op = Number(json?.op) || ip + 1
    const f = Math.floor(ip + (op - ip) * at)
    const SS = 2
    const big = size * SS
    const k = big / Math.max(w, h)
    const base: M = [k, 0, 0, k, (big - w * k) / 2, (big - h * k) / 2]
    const ops = layerOps(json?.layers ?? [], json?.assets ?? [], f, base, 1)
    if (!ops.length) return
    const buf = new Float32Array(big * big * 4)
    const mask = new Uint8Array(big * big)
    // 목록 앞이 위 → 뒤에서부터 칠한다
    for (let i = ops.length - 1; i >= 0; i--) {
        const o = ops[i]
        if (o.alpha <= 0) continue
        mask.fill(0)
        // 선은 조각마다 따로 칠해 합친다 (조각끼리 방향이 달라 서로 지워지지 않게)
        if (o.stroke) for (const p of o.polys) for (const piece of strokePolys(p, o.stroke)) raster(mask, big, [piece], false)
        else raster(mask, big, o.polys, !!o.evenOdd)
        blend(buf, mask, o.color, o.alpha)
    }
    // 2×2 평균으로 줄이고, 미리 곱한 색을 원래 색으로
    const out = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let r = 0
            let g = 0
            let b = 0
            let a = 0
            for (let dy = 0; dy < SS; dy++)
                for (let dx = 0; dx < SS; dx++) {
                    const i = ((y * SS + dy) * big + (x * SS + dx)) * 4
                    r += buf[i]
                    g += buf[i + 1]
                    b += buf[i + 2]
                    a += buf[i + 3]
                }
            const n = SS * SS
            a /= n
            const j = (y * size + x) * 4
            out[j] = a > 0 ? Math.round(Math.min(1, r / n / a) * 255) : 0
            out[j + 1] = a > 0 ? Math.round(Math.min(1, g / n / a) * 255) : 0
            out[j + 2] = a > 0 ? Math.round(Math.min(1, b / n / a) * 255) : 0
            out[j + 3] = Math.round(a * 255)
        }
    // 거의 다 비었으면 실패로 본다
    let seen = 0
    for (let i = 3; i < out.length; i += 4) if (out[i] > 20) seen++
    return seen > 50 ? out : undefined
}
