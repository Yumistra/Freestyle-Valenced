import { settings } from './store'

const pad = (n: number) => String(n).padStart(2, '0')

/** 초나 12시간제를 골랐을 때의 시각 글자 ("오후 3:04:05" 대신 "3:04:05 PM"). 안 골랐으면 undefined (디스코드 모양 그대로) */
export function formatClock(at: number, withDate = false): string | undefined {
    const s = settings()
    if (!s.seconds && !s.clock12) return
    const d = new Date(at)
    if (!Number.isFinite(d.getTime())) return
    let h = d.getHours()
    let ampm = ''
    if (s.clock12) {
        ampm = h < 12 ? ' AM' : ' PM'
        h = h % 12 || 12
    }
    const time = `${s.clock12 ? h : pad(h)}:${pad(d.getMinutes())}${s.seconds ? `:${pad(d.getSeconds())}` : ''}${ampm}`
    return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time
}

/** 로그 화면용 날짜와 시각 */
export function when(ms: number): string {
    if (!ms) return ''
    return formatClock(ms, true) ?? new Date(ms).toLocaleString()
}

/** 짧게: 오늘이면 시각만, 아니면 날짜와 시각 (한 줄에 들어가게) */
export function shortWhen(ms: number): string {
    if (!ms) return ''
    const d = new Date(ms)
    if (!Number.isFinite(d.getTime())) return ''
    const today = new Date().toDateString() === d.toDateString()
    const s = settings()
    let h = d.getHours()
    let ampm = ''
    if (s.clock12 || !s.seconds) {
        ampm = h < 12 ? ' AM' : ' PM'
        h = h % 12 || 12
    }
    const time = `${h}:${pad(d.getMinutes())}${s.seconds ? `:${pad(d.getSeconds())}` : ''}${ampm}`
    return today ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}
