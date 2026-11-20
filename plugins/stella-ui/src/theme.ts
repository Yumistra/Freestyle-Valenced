/**
 * 색과 크기. 게임 화면처럼 밝은 하늘색, 흰 패널, 남색 글자, 청록 버튼.
 * (게임에서 그림을 가져오지 않고 직접 정한 값이다)
 */
export const C = {
    navy: '#27377a',
    navyDeep: '#1c2a63',
    ink: '#2b3a6b',
    muted: '#7f8fba',
    line: '#d7e0f2',
    panel: '#f5f8fd',
    white: '#ffffff',
    blue: '#4a6fd8',
    blueSoft: '#dfe7fb',
    teal: '#19c3cb',
    tealDeep: '#0fa3ab',
    orange: '#f5a03a',
    red: '#ef4b5f',
    green: '#3fbf72',
    gold: '#f6c445',
    shade: 'rgba(20,32,74,0.45)',
    skyTop: '#6fb2ea',
    skyMid: '#a9d4f5',
    skyLow: '#e3f2fc',
}

export const R = { panel: 22, pill: 999 }

/** 그림자 (안드로이드는 elevation) */
export const shadow = (e = 4) => ({ elevation: e, shadowColor: '#1c2a63', shadowOpacity: 0.18, shadowRadius: e * 1.5, shadowOffset: { width: 0, height: e / 2 } })

/** 서버 카드 색 (배너가 없을 때) */
const CARD_COLORS = ['#7b6fd8', '#3fa9a0', '#e0507a', '#d99a2b', '#8f9fd8', '#e07a3f', '#4a6fd8', '#5bb36a']
export function cardColor(id: string | undefined): string {
    let h = 0
    for (const ch of id ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return CARD_COLORS[h % CARD_COLORS.length]
}
