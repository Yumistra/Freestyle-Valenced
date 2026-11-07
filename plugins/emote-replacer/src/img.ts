import { inflate, deflate } from './pako'

/**
 * 이모트 그림 다루기: PNG, GIF 읽기 → 크기 맞추기, 효과 → GIF 또는 PNG 로 다시 쓰기.
 * 원래 플러그인은 Rust(WASM) 로 하던 것을 작은 그림(32~128px)만 다루니 JS 로 한다.
 */

export interface Frame {
    rgba: Uint8ClampedArray
    /** 1/100 초 */
    delay: number
}
export interface Img {
    w: number
    h: number
    frames: Frame[]
}

// ── base64 ────────────────────────────────────────────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64I = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i

export function fromBase64(s: string): Uint8Array {
    s = s.replace(/[^A-Za-z0-9+/]/g, '')
    const out = new Uint8Array(Math.floor((s.length * 3) / 4))
    let o = 0
    for (let i = 0; i + 1 < s.length; i += 4) {
        const a = B64I[s.charCodeAt(i)]
        const b = B64I[s.charCodeAt(i + 1)]
        const c = i + 2 < s.length ? B64I[s.charCodeAt(i + 2)] : -1
        const d = i + 3 < s.length ? B64I[s.charCodeAt(i + 3)] : -1
        out[o++] = (a << 2) | (b >> 4)
        if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2)
        if (d >= 0) out[o++] = ((c & 3) << 6) | d
    }
    return out.subarray(0, o)
}

export function toBase64(bytes: Uint8Array): string {
    let out = ''
    const n = bytes.length
    for (let i = 0; i < n; i += 3) {
        const a = bytes[i]
        const b = i + 1 < n ? bytes[i + 1] : 0
        const c = i + 2 < n ? bytes[i + 2] : 0
        const v = (a << 16) | (b << 8) | c
        out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + (i + 2 < n ? B64[v & 63] : '=')
    }
    return out
}

// ── PNG 읽기 ──────────────────────────────────────────────────────────────
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0

function decodePng(b: Uint8Array): Img {
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

// ── GIF 읽기 ──────────────────────────────────────────────────────────────
function lzwDecode(minCode: number, data: Uint8Array, count: number): Uint8Array {
    const out = new Uint8Array(count)
    const clear = 1 << minCode
    const end = clear + 1
    let size = minCode + 1
    let next = end + 1
    const prefix = new Int32Array(4096)
    const suffix = new Uint8Array(4096)
    const stack = new Uint8Array(4097)
    for (let k = 0; k < clear; k++) suffix[k] = k
    let old = -1
    let first = 0
    let o = 0
    let bits = 0
    let acc = 0
    let p = 0
    while (o < count) {
        while (bits < size && p < data.length) {
            acc |= data[p++] << bits
            bits += 8
        }
        if (bits < size) break
        let code = acc & ((1 << size) - 1)
        acc >>>= size
        bits -= size
        if (code === clear) {
            size = minCode + 1
            next = end + 1
            old = -1
            continue
        }
        if (code === end) break
        if (old === -1) {
            out[o++] = suffix[code]
            old = code
            first = code
            continue
        }
        const inCode = code
        let sp = 0
        if (code >= next) {
            stack[sp++] = first
            code = old
        }
        while (code >= clear) {
            stack[sp++] = suffix[code]
            code = prefix[code]
        }
        first = suffix[code]
        stack[sp++] = first
        while (sp > 0 && o < count) out[o++] = stack[--sp]
        if (next < 4096) {
            prefix[next] = old
            suffix[next] = first
            next++
            if (next === 1 << size && size < 12) size++
        }
        old = inCode
    }
    return out
}

function decodeGif(b: Uint8Array): Img {
    const w = b[6] | (b[7] << 8)
    const h = b[8] | (b[9] << 8)
    const flags = b[10]
    let i = 13
    let gct: Uint8Array | undefined
    if (flags & 0x80) {
        const n = 3 * (1 << ((flags & 7) + 1))
        gct = b.subarray(i, i + n)
        i += n
    }
    const frames: Frame[] = []
    const canvas = new Uint8ClampedArray(w * h * 4)
    let delay = 10
    let transparent = -1
    let disposal = 0
    while (i < b.length) {
        const block = b[i++]
        if (block === 0x3b) break
        if (block === 0x21) {
            const label = b[i++]
            if (label === 0xf9) {
                const packed = b[i + 1]
                disposal = (packed >> 2) & 7
                delay = b[i + 2] | (b[i + 3] << 8)
                transparent = packed & 1 ? b[i + 4] : -1
            }
            while (b[i] !== 0 && i < b.length) i += b[i] + 1
            i++
            continue
        }
        if (block !== 0x2c) break
        const fx = b[i] | (b[i + 1] << 8)
        const fy = b[i + 2] | (b[i + 3] << 8)
        const fw = b[i + 4] | (b[i + 5] << 8)
        const fh = b[i + 6] | (b[i + 7] << 8)
        const fflags = b[i + 8]
        i += 9
        let table = gct
        if (fflags & 0x80) {
            const n = 3 * (1 << ((fflags & 7) + 1))
            table = b.subarray(i, i + n)
            i += n
        }
        const interlaced = !!(fflags & 0x40)
        const minCode = b[i++]
        const parts: number[] = []
        while (i < b.length && b[i] !== 0) {
            const n = b[i++]
            for (let k = 0; k < n; k++) parts.push(b[i + k])
            i += n
        }
        i++
        const idx = lzwDecode(minCode, Uint8Array.from(parts), fw * fh)
        const before = disposal === 3 ? canvas.slice() : undefined
        const rows: number[] = []
        if (interlaced) {
            for (const [start, step] of [
                [0, 8],
                [4, 8],
                [2, 4],
                [1, 2],
            ])
                for (let y = start; y < fh; y += step) rows.push(y)
        } else for (let y = 0; y < fh; y++) rows.push(y)
        for (let r = 0; r < fh; r++) {
            const y = rows[r] + fy
            if (y >= h) continue
            for (let x = 0; x < fw; x++) {
                const k = idx[r * fw + x]
                if (k === transparent || x + fx >= w) continue
                const o4 = (y * w + x + fx) * 4
                canvas[o4] = table?.[k * 3] ?? 0
                canvas[o4 + 1] = table?.[k * 3 + 1] ?? 0
                canvas[o4 + 2] = table?.[k * 3 + 2] ?? 0
                canvas[o4 + 3] = 255
            }
        }
        frames.push({ rgba: canvas.slice(), delay: Math.max(2, delay || 10) })
        if (disposal === 2) {
            for (let y = fy; y < Math.min(h, fy + fh); y++) for (let x = fx; x < Math.min(w, fx + fw); x++) canvas.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4)
        } else if (disposal === 3 && before) canvas.set(before)
        transparent = -1
        disposal = 0
        delay = 10
    }
    return { w, h, frames: frames.length ? frames : [{ rgba: canvas, delay: 10 }] }
}

export function decode(bytes: Uint8Array): Img {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePng(bytes)
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return decodeGif(bytes)
    throw new Error('Unsupported image')
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
function crcTable() {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
}
const CRC = crcTable()
function crc32(b: Uint8Array) {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}
class Bytes {
    a: number[] = []
    push(...v: number[]) {
        for (const x of v) this.a.push(x & 255)
    }
    u16(v: number) {
        this.push(v, v >> 8)
    }
    str(s: string) {
        for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i))
    }
    bytes(b: ArrayLike<number>) {
        for (let i = 0; i < b.length; i++) this.a.push(b[i])
    }
    out() {
        return Uint8Array.from(this.a)
    }
}

export function encodePng(img: Img): Uint8Array {
    const { w, h } = img
    const rgba = img.frames[0].rgba
    const raw = new Uint8Array((w * 4 + 1) * h)
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0
        raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
    }
    const out = new Bytes()
    out.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    const chunk = (type: string, data: Uint8Array) => {
        const td = new Uint8Array(4 + data.length)
        for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i)
        td.set(data, 4)
        const n = data.length
        out.push(n >>> 24, n >>> 16, n >>> 8, n)
        out.bytes(td)
        const c = crc32(td)
        out.push(c >>> 24, c >>> 16, c >>> 8, c)
    }
    chunk('IHDR', Uint8Array.from([w >>> 24, w >>> 16, w >>> 8, w, h >>> 24, h >>> 16, h >>> 8, h, 8, 6, 0, 0, 0]))
    chunk('IDAT', deflate(raw))
    chunk('IEND', new Uint8Array(0))
    return out.out()
}

/** 모든 프레임의 색을 255 개 이하로 줄인다 (0 번은 투명) */
function palette(img: Img): { table: number[]; index: (r: number, g: number, b: number) => number } {
    const counts = new Map<number, number>()
    for (const f of img.frames) {
        const p = f.rgba
        for (let i = 0; i < p.length; i += 4) {
            if (p[i + 3] < 128) continue
            const key = ((p[i] >> 3) << 10) | ((p[i + 1] >> 3) << 5) | (p[i + 2] >> 3)
            counts.set(key, (counts.get(key) ?? 0) + 1)
        }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255)
    const table: number[] = [0, 0, 0]
    for (const [k] of top) table.push(((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4)
    const cache = new Map<number, number>()
    const index = (r: number, g: number, b: number) => {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
        const hit = cache.get(key)
        if (hit !== undefined) return hit
        let best = 1
        let bd = Infinity
        for (let k = 1; k * 3 < table.length; k++) {
            const dr = table[k * 3] - r
            const dg = table[k * 3 + 1] - g
            const db = table[k * 3 + 2] - b
            const d = dr * dr * 2 + dg * dg * 4 + db * db * 3
            if (d < bd) {
                bd = d
                best = k
            }
        }
        cache.set(key, best)
        return best
    }
    return { table, index }
}

function lzwEncode(minCode: number, idx: Uint8Array, out: Bytes) {
    const clear = 1 << minCode
    const end = clear + 1
    let size = minCode + 1
    let next = end + 1
    let dict = new Map<number, number>()
    const sub: number[] = []
    let acc = 0
    let bits = 0
    const emit = (code: number) => {
        acc |= code << bits
        bits += size
        while (bits >= 8) {
            sub.push(acc & 255)
            acc >>>= 8
            bits -= 8
        }
    }
    out.push(minCode)
    emit(clear)
    let cur = idx[0]
    for (let i = 1; i < idx.length; i++) {
        const k = idx[i]
        const key = (cur << 8) | k
        const found = dict.get(key)
        if (found !== undefined) {
            cur = found
            continue
        }
        emit(cur)
        if (next < 4096) {
            dict.set(key, next++)
            if (next > 1 << size && size < 12) size++
        } else {
            emit(clear)
            dict = new Map()
            size = minCode + 1
            next = end + 1
        }
        cur = k
    }
    emit(cur)
    emit(end)
    if (bits > 0) sub.push(acc & 255)
    for (let i = 0; i < sub.length; i += 255) {
        const n = Math.min(255, sub.length - i)
        out.push(n)
        for (let j = 0; j < n; j++) out.a.push(sub[i + j])
    }
    out.push(0)
}

export function encodeGif(img: Img): Uint8Array {
    const { w, h } = img
    const { table, index } = palette(img)
    let bitsPer = 1
    while (1 << bitsPer < table.length / 3) bitsPer++
    const size = 1 << bitsPer
    const out = new Bytes()
    out.str('GIF89a')
    out.u16(w)
    out.u16(h)
    out.push(0x80 | (bitsPer - 1), 0, 0)
    for (let k = 0; k < size; k++) out.push(table[k * 3] ?? 0, table[k * 3 + 1] ?? 0, table[k * 3 + 2] ?? 0)
    if (img.frames.length > 1) {
        out.push(0x21, 0xff, 11)
        out.str('NETSCAPE2.0')
        out.push(3, 1, 0, 0, 0)
    }
    const minCode = Math.max(2, bitsPer)
    for (const f of img.frames) {
        out.push(0x21, 0xf9, 4, (2 << 2) | 1)
        out.u16(Math.max(2, Math.round(f.delay)))
        out.push(0, 0)
        out.push(0x2c)
        out.u16(0)
        out.u16(0)
        out.u16(w)
        out.u16(h)
        out.push(0)
        const idx = new Uint8Array(w * h)
        const p = f.rgba
        for (let i = 0, j = 0; i < p.length; i += 4, j++) idx[j] = p[i + 3] < 128 ? 0 : index(p[i], p[i + 1], p[i + 2])
        lzwEncode(minCode, idx, out)
    }
    out.push(0x3b)
    return out.out()
}

// ── 그리기 도구 ────────────────────────────────────────────────────────────
/** 원본 프레임에서 (u, v) 위치 색 (선형 보간) */
function sampleAt(src: Uint8ClampedArray, w: number, h: number, u: number, v: number, out: number[]) {
    if (u < -0.5 || v < -0.5 || u > w - 0.5 || v > h - 0.5) {
        out[0] = out[1] = out[2] = out[3] = 0
        return
    }
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(u)))
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(v)))
    const x1 = Math.min(w - 1, x0 + 1)
    const y1 = Math.min(h - 1, y0 + 1)
    const fx = Math.max(0, Math.min(1, u - x0))
    const fy = Math.max(0, Math.min(1, v - y0))
    for (let c = 0; c < 4; c++) {
        const a = src[(y0 * w + x0) * 4 + c]
        const b = src[(y0 * w + x1) * 4 + c]
        const d = src[(y1 * w + x0) * 4 + c]
        const e = src[(y1 * w + x1) * 4 + c]
        out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy
    }
}

/** 프레임마다 (출력 x, y) → 원본 (u, v) 로 다시 그린다 */
function remap(img: Img, w: number, h: number, map: (x: number, y: number, f: number) => [number, number] | null, frames?: number): Img {
    const n = frames ?? img.frames.length
    const out: Frame[] = []
    const px = [0, 0, 0, 0]
    for (let f = 0; f < n; f++) {
        const sf = img.frames[f % img.frames.length]
        const rgba = new Uint8ClampedArray(w * h * 4)
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const m = map(x + 0.5, y + 0.5, f)
                if (!m) continue
                sampleAt(sf.rgba, img.w, img.h, m[0] - 0.5, m[1] - 0.5, px)
                const o = (y * w + x) * 4
                rgba[o] = px[0]
                rgba[o + 1] = px[1]
                rgba[o + 2] = px[2]
                rgba[o + 3] = px[3]
            }
        out.push({ rgba, delay: sf.delay })
    }
    return { w, h, frames: out }
}

export function resize(img: Img, w: number, h: number): Img {
    if (w === img.w && h === img.h) return img
    // 크게 줄일 때는 몇 칸씩 평균을 내서 (깨짐 방지)
    const sx = img.w / w
    const sy = img.h / h
    if (sx <= 1.5 && sy <= 1.5) return remap(img, w, h, (x, y) => [x * sx, y * sy])
    const frames = img.frames.map(f => {
        const rgba = new Uint8ClampedArray(w * h * 4)
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                let r = 0,
                    g = 0,
                    b = 0,
                    a = 0,
                    n = 0
                const x0 = Math.floor(x * sx)
                const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
                const y0 = Math.floor(y * sy)
                const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
                for (let yy = y0; yy < Math.min(img.h, y1); yy++)
                    for (let xx = x0; xx < Math.min(img.w, x1); xx++) {
                        const o = (yy * img.w + xx) * 4
                        const al = f.rgba[o + 3]
                        r += f.rgba[o] * al
                        g += f.rgba[o + 1] * al
                        b += f.rgba[o + 2] * al
                        a += al
                        n++
                    }
                const o = (y * w + x) * 4
                if (a > 0) {
                    rgba[o] = r / a
                    rgba[o + 1] = g / a
                    rgba[o + 2] = b / a
                }
                rgba[o + 3] = n ? a / n : 0
            }
        return { rgba, delay: f.delay }
    })
    return { w, h, frames }
}

/** 긴 쪽을 size 에 맞춘다 */
export function fit(img: Img, size: number): Img {
    const s = size / Math.max(img.w, img.h)
    return resize(img, Math.max(1, Math.round(img.w * s)), Math.max(1, Math.round(img.h * s)))
}

// ── 효과 ──────────────────────────────────────────────────────────────────
const SPEED: Record<string, number> = { '': 1, fast: 2, faster: 3, hyper: 6 }
const speedOf = (arg: string) => SPEED[arg] ?? 1

/** 움직이는 효과의 프레임 수: 원본이 움직이면 그 길이에 맞춘다 */
function loopFrames(img: Img, base: number) {
    const n = img.frames.length
    if (n <= 1) return base
    return Math.min(120, Math.max(n, Math.round(base / n) * n))
}

function withDelay(img: Img, delay: number): Img {
    return { ...img, frames: img.frames.map(f => ({ ...f, delay })) }
}

function hueShift(rgba: Uint8ClampedArray, deg: number) {
    const out = new Uint8ClampedArray(rgba.length)
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    // YIQ 회전
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i]
        const g = rgba[i + 1]
        const b = rgba[i + 2]
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        const ii = 0.596 * r - 0.274 * g - 0.322 * b
        const q = 0.211 * r - 0.523 * g + 0.312 * b
        const i2 = ii * c - q * s
        const q2 = ii * s + q * c
        out[i] = y + 0.956 * i2 + 0.621 * q2
        out[i + 1] = y - 0.272 * i2 - 0.647 * q2
        out[i + 2] = y - 1.106 * i2 + 1.703 * q2
        out[i + 3] = rgba[i + 3]
    }
    return out
}

export interface Modifier {
    name: string
    info: string
    args?: string[]
}

export const MODIFIERS: Modifier[] = [
    { name: 'flip', info: 'Flip horizontally' },
    { name: 'flap', info: 'Flip vertically' },
    { name: 'rotate', info: 'Rotate by x degrees', args: ['90', '180', '270'] },
    { name: 'speed', info: 'Frame delay in 1/100 seconds', args: ['2', '5', '10'] },
    { name: 'hyperspeed', info: 'Skip every other frame, fastest' },
    { name: 'reverse', info: 'Play backwards' },
    { name: 'spin', info: 'Spin clockwise', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'spinrev', info: 'Spin counter-clockwise', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'slide', info: 'Slide right to left', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'sliderev', info: 'Slide left to right', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'shake', info: 'Shake', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'rainbow', info: 'Rainbow colors', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'infinite', info: 'Pulse outwards', args: ['', 'fast', 'faster', 'hyper'] },
    { name: 'wiggle', info: 'Wiggle', args: ['', 'big', 'bigger', 'huge'] },
    { name: 'wide', info: 'Make it wider', args: ['', 'big', 'huge', 'extreme'] },
    { name: 'resize', info: 'Size, small, medium, large or 32 to 128', args: ['small', 'medium', 'large'] },
    { name: 'rain', info: 'Add rain', args: ['', 'glitter'] },
]
export const MODIFIER_NAMES = new Set(MODIFIERS.map(m => m.name))

/** ".spin-fast" 같은 효과 목록을 읽는다 */
export function parseModifiers(text: string): Array<[string, string]> {
    return text
        .split('.')
        .filter(Boolean)
        .map(p => {
            const at = p.indexOf('-')
            return (at < 0 ? [p, ''] : [p.slice(0, at), p.slice(at + 1)]) as [string, string]
        })
        .filter(([n]) => MODIFIER_NAMES.has(n))
}

/** 효과 중 크기를 정하는 것 (resize) 을 먼저 본다 */
export function sizeFrom(mods: Array<[string, string]>, base: number) {
    let size = base
    for (const [n, a] of mods)
        if (n === 'resize') {
            const named: Record<string, number> = { small: 32, medium: 64, large: 128 }
            const v = named[a] ?? parseInt(a, 10)
            if (Number.isFinite(v)) size = Math.max(16, Math.min(128, v))
        }
    return size
}

export function applyModifier(img: Img, name: string, arg: string): Img {
    const { w, h } = img
    const cx = w / 2
    const cy = h / 2
    switch (name) {
        case 'flip':
            return remap(img, w, h, (x, y) => [w - x, y])
        case 'flap':
            return remap(img, w, h, (x, y) => [x, h - y])
        case 'rotate': {
            const a = ((parseFloat(arg) || 0) * Math.PI) / 180
            const c = Math.cos(-a)
            const s = Math.sin(-a)
            return remap(img, w, h, (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c])
        }
        case 'speed': {
            const d = parseInt(arg, 10)
            return Number.isFinite(d) ? withDelay(img, Math.max(2, d)) : img
        }
        case 'hyperspeed': {
            const frames = img.frames.filter((_, i) => i % 2 === 0)
            return withDelay({ ...img, frames: frames.length ? frames : img.frames }, 2)
        }
        case 'reverse':
            return { ...img, frames: [...img.frames].reverse() }
        case 'spin':
        case 'spinrev': {
            const n = loopFrames(img, Math.round(24 / Math.sqrt(speedOf(arg))))
            const dir = name === 'spin' ? 1 : -1
            const res = remap(
                img,
                w,
                h,
                (x, y, f) => {
                    const a = (-dir * 2 * Math.PI * f) / n
                    const c = Math.cos(a)
                    const s = Math.sin(a)
                    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]
                },
                n,
            )
            return img.frames.length > 1 ? res : withDelay(res, Math.max(2, Math.round(8 / speedOf(arg))))
        }
        case 'slide':
        case 'sliderev': {
            const n = loopFrames(img, Math.round(24 / Math.sqrt(speedOf(arg))))
            const dir = name === 'slide' ? 1 : -1
            const res = remap(img, w, h, (x, y, f) => [(((x + (dir * w * f) / n) % w) + w) % w, y], n)
            return img.frames.length > 1 ? res : withDelay(res, Math.max(2, Math.round(8 / speedOf(arg))))
        }
        case 'shake': {
            const offs = [
                [0, 0],
                [-1, 1],
                [1, -1],
                [-1, -1],
                [1, 1],
                [0, 1],
                [1, 0],
                [-1, 0],
            ]
            const amp = Math.max(1, Math.round(w * 0.06))
            const n = loopFrames(img, offs.length)
            const res = remap(
                img,
                w,
                h,
                (x, y, f) => {
                    const [dx, dy] = offs[f % offs.length]
                    return [x + dx * amp, y + dy * amp]
                },
                n,
            )
            return img.frames.length > 1 ? res : withDelay(res, Math.max(2, Math.round(6 / speedOf(arg))))
        }
        case 'rainbow': {
            const n = loopFrames(img, 16)
            const frames = Array.from({ length: n }, (_, f) => ({ rgba: hueShift(img.frames[f % img.frames.length].rgba, (360 * f) / n), delay: img.frames.length > 1 ? img.frames[f % img.frames.length].delay : Math.max(2, Math.round(8 / speedOf(arg))) }))
            return { w, h, frames }
        }
        case 'infinite': {
            const n = loopFrames(img, 16)
            const copies = 3
            const frames: Frame[] = []
            const px = [0, 0, 0, 0]
            for (let f = 0; f < n; f++) {
                const src = img.frames[f % img.frames.length]
                const rgba = new Uint8ClampedArray(w * h * 4)
                for (let k = copies - 1; k >= 0; k--) {
                    const scale = ((k + f / n) / copies) * 2
                    if (scale <= 0.05) continue
                    for (let y = 0; y < h; y++)
                        for (let x = 0; x < w; x++) {
                            sampleAt(src.rgba, w, h, cx + (x + 0.5 - cx) / scale - 0.5, cy + (y + 0.5 - cy) / scale - 0.5, px)
                            if (px[3] < 128) continue
                            const o = (y * w + x) * 4
                            rgba[o] = px[0]
                            rgba[o + 1] = px[1]
                            rgba[o + 2] = px[2]
                            rgba[o + 3] = 255
                        }
                }
                frames.push({ rgba, delay: img.frames.length > 1 ? src.delay : Math.max(2, Math.round(8 / speedOf(arg))) })
            }
            return { w, h, frames }
        }
        case 'wiggle': {
            const amps: Record<string, number> = { '': 0.06, big: 0.1, bigger: 0.15, huge: 0.22 }
            const amp = w * (amps[arg] ?? 0.06)
            const n = loopFrames(img, 12)
            const res = remap(img, w, h, (x, y, f) => [x + Math.sin((y / h) * Math.PI * 2 + (2 * Math.PI * f) / n) * amp, y], n)
            return img.frames.length > 1 ? res : withDelay(res, 5)
        }
        case 'wide': {
            const named: Record<string, number> = { '': 2, big: 3, huge: 4, extreme: 8 }
            const k = Math.max(2, Math.min(8, named[arg] ?? (parseInt(arg, 10) || 2)))
            return resize(img, Math.min(512, Math.round(w * k)), h)
        }
        case 'rain': {
            const glitter = arg === 'glitter'
            const n = loopFrames(img, 12)
            const drops = Array.from({ length: Math.max(6, Math.round((w * h) / 120)) }, (_, i) => ({ x: (i * 37) % w, y: (i * 53) % h, c: glitter ? [(i * 70) % 255, (i * 140) % 255, (i * 210) % 255] : [80, 150, 255] }))
            const frames = Array.from({ length: n }, (_, f) => {
                const src = img.frames[f % img.frames.length]
                const rgba = src.rgba.slice()
                for (const d of drops) {
                    const y0 = Math.floor((d.y + (h * f) / n) % h)
                    for (let t = 0; t < (glitter ? 1 : 3); t++) {
                        const y = (y0 + t) % h
                        const o = (y * w + d.x) * 4
                        rgba[o] = d.c[0]
                        rgba[o + 1] = d.c[1]
                        rgba[o + 2] = d.c[2]
                        rgba[o + 3] = 255
                    }
                }
                return { rgba, delay: img.frames.length > 1 ? src.delay : 6 }
            })
            return { w, h, frames }
        }
    }
    return img
}

/** 그림 + 효과 → 보낼 파일 (base64, 확장자) */
export function render(bytes: Uint8Array, mods: Array<[string, string]>, size: number): { b64: string; ext: 'png' | 'gif' } {
    let img = fit(decode(bytes), sizeFrom(mods, size))
    for (const [n, a] of mods) if (n !== 'resize') img = applyModifier(img, n, a)
    if (img.frames.length > 1) return { b64: toBase64(encodeGif(img)), ext: 'gif' }
    return { b64: toBase64(encodePng(img)), ext: 'png' }
}
