/** RGBA → PNG (base64). Sticker With Text 와 같은 코드 */
const CRC = (() => {
    const t: number[] = []
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()
function crc32(bytes: number[]) {
    let c = 0xffffffff
    for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function chunk(type: string, data: number[]) {
    const t = type.split('').map(c => c.charCodeAt(0))
    return [...u32(data.length), ...t, ...data, ...u32(crc32([...t, ...data]))]
}
function toBase64(bytes: number[]) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
        const n = (a << 16) | (b << 8) | c
        out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=')
    }
    return out
}
/** RGBA → PNG (base64) */
export function encodePng(rgba: Uint8Array, size: number) {
    const raw: number[] = []
    for (let y = 0; y < size; y++) {
        raw.push(0)
        for (let x = 0; x < size * 4; x++) raw.push(rgba[y * size * 4 + x])
    }
    // 압축 없이 (stored) deflate
    const z: number[] = [0x78, 0x01]
    for (let i = 0; i < raw.length; i += 65535) {
        const part = raw.slice(i, i + 65535)
        const last = i + 65535 >= raw.length ? 1 : 0
        z.push(last, part.length & 255, (part.length >> 8) & 255, ~part.length & 255, (~part.length >> 8) & 255)
        for (let j = 0; j < part.length; j++) z.push(part[j])
    }
    let a = 1
    let b = 0
    for (const v of raw) {
        a = (a + v) % 65521
        b = (b + a) % 65521
    }
    z.push(...u32(((b << 16) | a) >>> 0))
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(size), ...u32(size), 8, 6, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]
    return toBase64(png)
}

