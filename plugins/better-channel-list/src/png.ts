import { inflate } from './pako'

/** 서버 이모지 그림에서 바탕색 고르기 (원래 플러그인처럼 디스코드 채널 색 12가지 중 하나) */

interface Frame {
    rgba: Uint8ClampedArray
    delay: number
}
interface Img {
    w: number
    h: number
    frames: Frame[]
}

// ── PNG 읽기 ──────────────────────────────────────────────────────────────
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0

export function decodePng(b: Uint8Array): Img {
    let i = 8
    let w = 0
    let h = 0
    let depth = 8
    let type = 6
    let interlace = 0
    let palette: Uint8Array | undefined
    let trns: Uint8Array | undefined
    const idat: Uint8Array[] = []
    while (i < b.length) {
        const len = u32(b, i)
        const t = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
        const d = b.subarray(i + 8, i + 8 + len)
        if (t === 'IHDR') {
            w = u32(d, 0)
            h = u32(d, 4)
            depth = d[8]
            type = d[9]
            interlace = d[12]
        } else if (t === 'PLTE') palette = d
        else if (t === 'tRNS') trns = d
        else if (t === 'IDAT') idat.push(d)
        else if (t === 'IEND') break
        i += 12 + len
    }
    if (interlace) throw new Error('Interlaced PNG')
    let total = 0
    for (const p of idat) total += p.length
    const z = new Uint8Array(total)
    let o = 0
    for (const p of idat) {
        z.set(p, o)
        o += p.length
    }
    const raw = inflate(z)
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0] ?? 4
    const bpp = Math.max(1, (channels * depth) >> 3)
    const stride = Math.ceil((w * channels * depth) / 8)
    const px = new Uint8Array(stride * h)
    let prev = new Uint8Array(stride)
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)]
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
        const cur = px.subarray(y * stride, (y + 1) * stride)
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0
            const up = prev[x]
            const c = x >= bpp ? prev[x - bpp] : 0
            let v = line[x]
            if (f === 1) v += a
            else if (f === 2) v += up
            else if (f === 3) v += (a + up) >> 1
            else if (f === 4) {
                const p = a + up - c
                const pa = Math.abs(p - a)
                const pb = Math.abs(p - up)
                const pc = Math.abs(p - c)
                v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c
            }
            cur[x] = v & 255
        }
        prev = cur
    }
    const rgba = new Uint8ClampedArray(w * h * 4)
    const sample = (row: Uint8Array, idx: number): number => {
        if (depth === 8) return row[idx]
        if (depth === 16) return row[idx * 2]
        const per = 8 / depth
        const byte = row[Math.floor(idx / per)]
        const shift = 8 - depth * ((idx % per) + 1)
        return (byte >> shift) & ((1 << depth) - 1)
    }
    const scale = depth < 8 && type !== 3 ? 255 / ((1 << depth) - 1) : 1
    for (let y = 0; y < h; y++) {
        const row = px.subarray(y * stride, (y + 1) * stride)
        for (let x = 0; x < w; x++) {
            const o4 = (y * w + x) * 4
            if (type === 3) {
                const k = sample(row, x)
                rgba[o4] = palette?.[k * 3] ?? 0
                rgba[o4 + 1] = palette?.[k * 3 + 1] ?? 0
                rgba[o4 + 2] = palette?.[k * 3 + 2] ?? 0
                rgba[o4 + 3] = trns && k < trns.length ? trns[k] : 255
            } else if (type === 0 || type === 4) {
                const g = sample(row, x * channels) * scale
                rgba[o4] = rgba[o4 + 1] = rgba[o4 + 2] = g
                rgba[o4 + 3] = type === 4 ? sample(row, x * channels + 1) : 255
            } else {
                rgba[o4] = sample(row, x * channels)
                rgba[o4 + 1] = sample(row, x * channels + 1)
                rgba[o4 + 2] = sample(row, x * channels + 2)
                rgba[o4 + 3] = type === 6 ? sample(row, x * channels + 3) : 255
            }
        }
    }
    return { w, h, frames: [{ rgba, delay: 10 }] }
}


/** 디스코드 채널 이모지 바탕색 (ChannelEmojiConstants 의 CHANNEL_THEME_COLOR_PALETTE) */
const PALETTE = ['#5865F2', '#9B59B6', '#206694', '#3498DB', '#11806A', '#1ABC9C', '#992D22', '#E91E63', '#E74C3C', '#E67E22', '#F1C40F', '#607D8B']
const rgbOf = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))

/** 불투명하고 색이 뚜렷한 점들의 대표 색 → 가장 가까운 팔레트 색 */
export function paletteColor(img: Img): string {
    const px = img.frames[0].rgba
    // 색상환을 12칸으로 나눠 가장 많은 칸의 평균 색을 쓴다
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
    let colorful = 0
    let opaque = 0
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue
        opaque++
        const r = px[i] / 255
        const g = px[i + 1] / 255
        const b = px[i + 2] / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const s = max === 0 ? 0 : (max - min) / max
        if (s < 0.25 || max < 0.2) continue
        colorful++
        let h = 0
        const d = max - min
        if (max === r) h = ((g - b) / d) % 6
        else if (max === g) h = (b - r) / d + 2
        else h = (r - g) / d + 4
        h = (h * 60 + 360) % 360
        const bin = bins[Math.floor(h / 30) % 12]
        const w = s * max
        bin.w += w
        bin.r += px[i] * w
        bin.g += px[i + 1] * w
        bin.b += px[i + 2] * w
    }
    if (!opaque || colorful < opaque * 0.1) return '#607D8B'
    const best = bins.reduce((a, c) => (c.w > a.w ? c : a))
    const c = [best.r / best.w, best.g / best.w, best.b / best.w]
    let pick = PALETTE[PALETTE.length - 1]
    let dist = Infinity
    for (const p of PALETTE.slice(0, -1)) {
        const q = rgbOf(p)
        const d = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2
        if (d < dist) {
            dist = d
            pick = p
        }
    }
    return pick
}

const pending = new Set<string>()

/** 서버 이모지 바탕색을 구한다. 다 구하면 done(색) */
export async function emojiColor(id: string, done: (color: string) => void) {
    if (pending.has(id)) return
    pending.add(id)
    try {
        const res = await fetch(`https://cdn.discordapp.com/emojis/${id}.png?size=32`)
        const buf = new Uint8Array(await res.arrayBuffer())
        done(paletteColor(decodePng(buf)))
    } catch {
        done('#607D8B')
    }
}
