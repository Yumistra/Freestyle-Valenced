/**
 * 애니메이션 종류 정의.
 *
 * 효과는 "숨은 상태"(hidden)만 적는다. 보이는 상태는 항상 원래 모습(투명도 1, 이동 0, 크기 1, 회전 0)이고,
 * 나타날 땐 hidden → 원래 모습, 사라질 땐 원래 모습 → (나갈 때 효과의) hidden 으로 움직인다.
 * 화면 전환은 아래에 깔리는 화면이 어떻게 변하는지(under)와 어둡게 덮는 정도(dim)도 적을 수 있다.
 */

export type ModuleKey =
    | 'messages'
    | 'lists'
    | 'stack'
    | 'push'
    | 'modal'
    | 'panel'
    | 'channelList'
    | 'servers'
    | 'folder'
    | 'sheet'
    | 'menu'
    | 'alert'
    | 'backdrop'
    | 'toast'
    | 'notice'
    | 'subtle'
    | 'media'
    | 'press'

export interface Hidden {
    /** 투명도 */
    o?: number
    /** 이동(px) */
    tx?: number
    ty?: number
    /** 이동(너비·높이 비율) */
    txW?: number
    tyH?: number
    /** 크기 / 세로 크기 */
    s?: number
    sy?: number
    /** 회전(도) / X축 뒤집기(도) / Y축 뒤집기(도) */
    r?: number
    rx?: number
    ry?: number
    /** 팝업 메뉴: 누른 위치 쪽 모서리를 기준으로 커지고 작아짐 */
    anchor?: boolean
    /** 토스트·폴더: 화면(또는 폴더) 가장자리 밖에서 들어옴 */
    edge?: boolean
}

export interface Effect {
    id: string
    label: string
    hidden?: Hidden
    under?: Hidden
    dim?: number
    /** 뒤로 가기 스와이프 방향 */
    gesture?: 'horizontal' | 'vertical'
    /** "나갈 때 같게"면 들어온 반대쪽으로 지나가며 나감 (아래에서 들어오면 위로 나감) */
    through?: boolean
}

export const DEFAULT_ID = 'default'
/** "나갈 때"에서 나타날 때와 같은 효과 */
export const SAME_ID = 'same'
/** "나갈 때"에서 들어온 반대쪽으로 지나가기 */
export const THROUGH_ID = 'through'

export const NORMAL: Required<Omit<Hidden, 'anchor' | 'edge'>> = { o: 1, tx: 0, ty: 0, txW: 0, tyH: 0, s: 1, sy: 1, r: 0, rx: 0, ry: 0 }

export type Normalized = ReturnType<typeof normalize>

export function normalize(h: Hidden | undefined) {
    return { ...NORMAL, anchor: false, edge: false, ...(h ?? {}) }
}

// ── 메시지 (채팅에서 메시지가 나타나고 지워질 때, 네이티브) ─────────────────
// 실제 값은 네이티브(Kotlin)에 같은 이름으로 있다. 여기 hidden 은 미리보기용 (px ≈ dp)
export const MESSAGE_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'rise', label: 'Rise', hidden: { o: 0, ty: 28 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, tx: 40 } },
    { id: 'slide', label: 'Slide', hidden: { txW: 1 } },
    { id: 'side', label: 'From left', hidden: { o: 0, tx: -48 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.9 } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.6 } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.2 } },
    { id: 'drop', label: 'Drop', hidden: { o: 0, ty: 40, s: 0.92 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 70 } },
    { id: 'blur', label: 'Blur', hidden: { o: 0, s: 1.04 } },
    { id: 'circle', label: 'Circle', hidden: { o: 0.3, s: 0.4 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { txW: 0.9, s: 1.25, r: 4 } },
    { id: 'wave', label: 'Wave', hidden: { o: 0, ty: 22, r: -5 } },
    { id: 'none', label: 'None' },
]

// ── Cask 3 (iOS 목록 스크롤 애니메이션) ─────────────────────────────
// https://github.com/ryannair05/Cask-3 의 15가지 효과. id 는 "cask.<이름>"
// hidden 은 미리보기·지워질 때용 근사치. 실제 움직임은 네이티브(Cask.kt)와 JS(CaskCell)가 원본대로 그린다
export const CASK_STYLES: Array<{ name: string; label: string; hidden: Hidden }> = [
    { name: 'fade', label: 'Fade', hidden: { o: 0 } },
    { name: 'flip', label: 'Flip', hidden: { rx: 180 } },
    { name: 'bounce', label: 'Bounce', hidden: { s: 1, sy: 1, o: 0.2 } },
    { name: 'color', label: 'Color', hidden: { o: 0.6 } },
    { name: 'permanentColor', label: 'Permanent color', hidden: { o: 0.6 } },
    { name: 'glitch', label: 'Glitch', hidden: { s: 0.4 } },
    { name: 'helix', label: 'Helix', hidden: { ry: 180 } },
    { name: 'rotate', label: 'Rotate', hidden: { r: 106 } },
    { name: 'zoom', label: 'Zoom', hidden: { s: 5 } },
    { name: 'drop', label: 'Drop', hidden: { ty: -150 } },
    { name: 'stretch', label: 'Stretch', hidden: { o: 0.2 } },
    { name: 'slide', label: 'Slide', hidden: { txW: 1 } },
    { name: 'shake', label: 'Shake', hidden: { tx: 10 } },
    { name: 'swing', label: 'Swing', hidden: { tx: 40 } },
    { name: 'jiggle', label: 'Jiggle', hidden: { r: 4 } },
]

const caskEffects = (prefix: string): Effect[] => CASK_STYLES.map(c => ({ id: `cask.${c.name}`, label: `${prefix}${c.label}`, hidden: c.hidden }))

export const caskStyleOf = (id: string | undefined) => (id?.startsWith('cask.') ? id.slice(5) : undefined)

// ── 목록 스크롤 (스크롤해서 새로 보이는 줄) ─────────────────────────────
export const LIST_EFFECTS: Effect[] = [{ id: 'default', label: 'Default' }, ...caskEffects('')]

// ── 설정·메뉴 화면 (디스코드 안쪽 화면 전환) ─────────────────────────────
export const STACK_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'slip', label: 'Slip', hidden: { o: 0, txW: 0.25 }, under: { txW: -0.08 } },
    { id: 'slide', label: 'Slide', hidden: { txW: 1 }, under: { txW: -0.3 }, dim: 0.25 },
    { id: 'drawer', label: 'Drawer', hidden: { txW: 1 }, under: { s: 0.9, o: 0.5 }, dim: 0.35 },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.86 }, under: { s: 1.06, o: 0 } },
    { id: 'zoom', label: 'Zoom', hidden: { o: 0, s: 1.18 }, under: { s: 0.9, o: 0 } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.15 }, under: { o: 0.4, s: 0.96 } },
    { id: 'circleScale', label: 'Circle scale', hidden: { o: 0, s: 0.01 }, under: { s: 0.92 }, dim: 0.3 },
    { id: 'slideUp', label: 'From bottom', hidden: { tyH: 1 }, under: { s: 0.94 }, dim: 0.3, gesture: 'vertical' },
    { id: 'rise', label: 'Rise', hidden: { o: 0, tyH: 0.12 }, under: { o: 0.4 }, gesture: 'vertical' },
    { id: 'flip', label: 'Flip', hidden: { o: 0, ry: 75 }, under: { o: 0, ry: -75 } },
    { id: 'rotate', label: 'Rotate', hidden: { o: 0, r: 10, tyH: 0.12, s: 0.92 }, under: { o: 0.3, s: 0.96 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { txW: 1.15, s: 1.3, r: 6 }, under: { txW: -0.2, s: 0.92 }, dim: 0.2 },
    { id: 'none', label: 'None' },
]

// ── 큰 화면 (채널·프로필 등, 안드로이드 네이티브 전환) ──────────────────────
// id가 react-native-screens 의 stackAnimation 값 그대로다. hidden/under는 미리보기용 근사치
export const NATIVE_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'fade_from_bottom', label: 'Fade up', hidden: { o: 0, tyH: 0.08 } },
    { id: 'slide_from_right', label: 'From right', hidden: { txW: 1 }, under: { txW: -1 } },
    { id: 'slide_from_left', label: 'From left', hidden: { txW: -1 }, under: { txW: 1 } },
    { id: 'slide_from_bottom', label: 'From bottom', hidden: { tyH: 1 } },
    { id: 'ios_from_right', label: 'iOS right', hidden: { txW: 1 }, under: { txW: -0.3 }, dim: 0.2 },
    { id: 'ios_from_left', label: 'iOS left', hidden: { txW: -1 }, under: { txW: 0.3 }, dim: 0.2 },
    { id: 'none', label: 'None' },
]

// ── 아래 창 (길게 눌러 뜨는 액션시트) ───────────────────────────────────
export const SHEET_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'custom', label: 'Custom', hidden: { tyH: 1 } },
]

// ── 팝업 메뉴 (⋯ 메뉴) ────────────────────────────────────────────
export const MENU_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05, anchor: true } },
    { id: 'corner', label: 'Corner', hidden: { o: 0, s: 0.5, anchor: true } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.15, anchor: true } },
    { id: 'drop', label: 'Unfold', hidden: { o: 0, sy: 0.2, anchor: true } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, ty: -18 } },
    { id: 'slide', label: 'Side', hidden: { o: 0, tx: 60 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.85 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: -80, anchor: true, s: 0.9 } },
]

// ── 확인창 (가운데 뜨는 알림창) ─────────────────────────────────────
export const ALERT_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'zoom', label: 'Scale', hidden: { o: 0, s: 0.7, ty: 50 } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05 } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.15 } },
    { id: 'shrink', label: 'Shrink', hidden: { o: 0, s: 1.3 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, ty: 40 } },
    { id: 'slideUp', label: 'From bottom', hidden: { o: 0, tyH: 0.55 } },
    { id: 'slideDown', label: 'From top', hidden: { o: 0, tyH: -0.55 } },
    { id: 'side', label: 'Side', hidden: { o: 0, txW: 1 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 80, s: 0.9 } },
    { id: 'rotate', label: 'Rotate', hidden: { o: 0, r: -14, s: 0.6 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { tyH: 1.1, r: -10, s: 1.2 } },
]

// ── 배경 (확인창·팝업 메뉴 뒤를 어둡게 덮는 막) ───────────────────────────
export const BACKDROP_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'solid', label: 'Solid' },
    { id: 'none', label: 'None' },
]

// ── 토스트 (화면 위아래 작은 알림) ─────────────────────────────────────
export const TOAST_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'slide', label: 'Slide in', hidden: { o: 0, edge: true } },
    { id: 'drop', label: 'Drop', hidden: { o: 0, edge: true, ty: 36, s: 0.9 } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, ty: 16 } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05 } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.15 } },
    { id: 'zoom', label: 'Scale', hidden: { o: 0, s: 0.6 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'side', label: 'Side', hidden: { o: 0, txW: -1 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 90 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { txW: 1.1, r: 8 } },
]

// ── 알림 배너 (다른 채널 메시지가 오면 화면 위에 뜨는 알림) ──────────────────
export const NOTICE_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'slide', label: 'Slide in', hidden: { o: 0, edge: true } },
    { id: 'drop', label: 'Drop', hidden: { o: 0, edge: true, ty: 30, s: 0.9 } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, ty: 20 } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05 } },
    { id: 'point', label: 'Point', hidden: { o: 0, s: 0.15 } },
    { id: 'zoom', label: 'Scale', hidden: { o: 0, s: 0.6 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'side', label: 'Side', hidden: { o: 0, txW: -1 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 90 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { txW: 1.1, r: 8 } },
]

// ── 채널 화면 밀기 (채널 목록 ↔ 채팅) ──────────────────────────────
export const PANEL_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'custom', label: 'Custom', hidden: { txW: 0.82 } },
]

// ── 채널 목록 (카테고리 접기·펼치기) ─────────────────────────────────
export const CHANNEL_LIST_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'smooth', label: 'Fade', hidden: { o: 0 } },
    { id: 'slip', label: 'Slip', hidden: { o: 0, tx: -24 } },
    { id: 'drop', label: 'Drop', hidden: { o: 0, ty: -14 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.6 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 70 } },
]

// ── 서버 바꾸기 (서버를 누르면 채널 목록이 바뀔 때) ────────────────────────
export const SERVER_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'rise', label: 'Rise through', hidden: { o: 0, ty: 36 }, through: true },
    { id: 'slip', label: 'Slip', hidden: { o: 0, ty: 28 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.92 } },
    { id: 'zoom', label: 'Zoom', hidden: { o: 0, s: 1.08 } },
    { id: 'side', label: 'Side', hidden: { o: 0, tx: -40 } },
    { id: 'slideUp', label: 'From bottom', hidden: { o: 0, tyH: 0.25 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 35 } },
    { id: 'none', label: 'None' },
]

// ── 서버 폴더 열고 닫기 ──────────────────────────────────────────
export const FOLDER_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'drop', label: 'Drop', hidden: { o: 0, edge: true, s: 0.5 } },
    { id: 'slide', label: 'Slide out', hidden: { o: 0, edge: true } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'side', label: 'Side', hidden: { o: 0, tx: -48 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 90 } },
    { id: 'rotate', label: 'Rotate', hidden: { o: 0, r: -120, s: 0.3 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { tx: -120, s: 1.4 } },
]

// ── 작은 움직임 (체크박스·라디오·버튼 등 디스코드 공통 스프링) ─────────────
// ── 사진·동영상 보기 (누른 사진·동영상이 커지며 열림) ─────────────────────
// zoom = 디스코드처럼 누른 자리에서 커짐 (속도·곡선만 바꿈)
export const MEDIA_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'zoom', label: 'Zoom', hidden: { s: 0.3 } },
    { id: 'grow', label: 'Smooth zoom', hidden: { s: 0.3 } },
    { id: 'fade', label: 'Fade', hidden: { o: 0 } },
    { id: 'scale', label: 'Scale', hidden: { o: 0, s: 0.9 } },
    { id: 'pop', label: 'Pop', hidden: { o: 0, s: 0.05 } },
    { id: 'slideUp', label: 'From bottom', hidden: { o: 0, tyH: 0.3 } },
    { id: 'drop', label: 'Drop', hidden: { o: 0, ty: -60, s: 0.9 } },
    { id: 'flip', label: 'Flip', hidden: { o: 0, rx: 70 } },
    { id: 'rotate', label: 'Rotate', hidden: { o: 0, r: -14, s: 0.6 } },
    { id: 'outOfBounds', label: 'Out of bounds', hidden: { tyH: 1.1, r: -10, s: 1.2 } },
    { id: 'none', label: 'None' },
]

export const SUBTLE_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'custom', label: 'Custom', hidden: { o: 0, s: 0.5 } },
]

// ── 버튼 누르기 (hidden = 누르고 있는 모습) ─────────────────────────────
export const PRESS_EFFECTS: Effect[] = [
    { id: 'default', label: 'Default' },
    { id: 'shrink', label: 'Shrink', hidden: { s: 0.92 } },
    { id: 'deep', label: 'Deep', hidden: { s: 0.82 } },
    { id: 'grow', label: 'Grow', hidden: { s: 1.08 } },
    { id: 'squish', label: 'Squish', hidden: { s: 1.06, sy: 0.84 } },
    { id: 'sink', label: 'Sink', hidden: { ty: 3, s: 0.96 } },
    { id: 'tilt', label: 'Tilt', hidden: { rx: 24, s: 0.96 } },
    { id: 'wobble', label: 'Wobble', hidden: { r: -5, s: 0.94 } },
    { id: 'dim', label: 'Dim', hidden: { o: 0.5 } },
    { id: 'none', label: 'None' },
]

MESSAGE_EFFECTS.splice(MESSAGE_EFFECTS.length - 1, 0, ...caskEffects('Cask · '))

export const EFFECTS: Record<ModuleKey, Effect[]> = {
    messages: MESSAGE_EFFECTS,
    lists: LIST_EFFECTS,
    panel: PANEL_EFFECTS,
    channelList: CHANNEL_LIST_EFFECTS,
    servers: SERVER_EFFECTS,
    folder: FOLDER_EFFECTS,
    subtle: SUBTLE_EFFECTS,
    media: MEDIA_EFFECTS,
    press: PRESS_EFFECTS,
    stack: STACK_EFFECTS,
    push: NATIVE_EFFECTS,
    modal: NATIVE_EFFECTS,
    sheet: SHEET_EFFECTS,
    menu: MENU_EFFECTS,
    alert: ALERT_EFFECTS,
    backdrop: BACKDROP_EFFECTS,
    toast: TOAST_EFFECTS,
    notice: NOTICE_EFFECTS,
}

export const effectOf = (module: ModuleKey, id: string): Effect => EFFECTS[module].find(e => e.id === id) ?? EFFECTS[module][0]

/** 나갈 때 효과로 고를 수 있는 것: "같게" + 기본·없음을 뺀 효과들 */
export function exitChoices(module: ModuleKey): Effect[] {
    const through = THROUGH_MODULES.has(module) ? [{ id: THROUGH_ID, label: 'Through' }] : []
    // 사진·동영상은 디스코드 닫기(밀어 닫기)를 그대로 둘 수 있게
    const keep = module === 'media' ? [{ id: DEFAULT_ID, label: 'Default' }] : []
    return [...keep, { id: SAME_ID, label: 'Same' }, ...through, ...EFFECTS[module].filter(e => e.id !== DEFAULT_ID && e.id !== 'none' && e.hidden)]
}

/** "반대쪽으로 지나가기"를 고를 수 있는 곳 (옛 것과 새 것이 같이 보이는 곳) */
const THROUGH_MODULES = new Set<ModuleKey>(['servers'])

/** 들어온 반대쪽 (이동·회전 부호만 바꿈) */
export function mirror(h: Normalized): Normalized {
    return { ...h, tx: -h.tx, ty: -h.ty, txW: -h.txW, tyH: -h.tyH, r: -h.r, rx: -h.rx, ry: -h.ry }
}

/** 나갈 때 모습 (방향·위치까지 푼 것) */
export function exitPoseOf(module: ModuleKey, enter: string, exit: string | undefined, move: MoveOptions | undefined, W: number, H: number): Normalized {
    const e = effectOf(module, enter)
    if (exit === THROUGH_ID || ((!exit || exit === SAME_ID) && e.through)) return mirror(applyMove(e.hidden, move, W, H))
    return applyMove(exitEffectOf(module, enter, exit).hidden, move, W, H)
}

/** 나갈 때 쓸 효과. "같게"이거나 모르는 값이면 나타날 때 효과 */
export function exitEffectOf(module: ModuleKey, enter: string, exit: string | undefined): Effect {
    if (!exit || exit === SAME_ID) return effectOf(module, enter)
    return EFFECTS[module].find(e => e.id === exit) ?? effectOf(module, enter)
}

/** 미리보기에서 "기본"을 보여 줄 때 쓰는 디스코드 기본 동작의 근사치 */
export const DEFAULT_PREVIEW: Record<ModuleKey, { effect: string; duration: number; easing: EasingKey }> = {
    messages: { effect: 'none', duration: 0, easing: 'linear' },
    lists: { effect: 'none', duration: 0, easing: 'linear' },
    stack: { effect: 'slide', duration: 350, easing: 'out' },
    push: { effect: 'fade_from_bottom', duration: 300, easing: 'out' },
    modal: { effect: 'slide_from_bottom', duration: 350, easing: 'out' },
    sheet: { effect: 'custom', duration: 400, easing: 'out' },
    menu: { effect: 'corner', duration: 250, easing: 'out' },
    alert: { effect: 'zoom', duration: 400, easing: 'spring' },
    backdrop: { effect: 'solid', duration: 300, easing: 'out' },
    toast: { effect: 'slide', duration: 250, easing: 'linear' },
    notice: { effect: 'zoom', duration: 300, easing: 'out' },
    panel: { effect: 'custom', duration: 250, easing: 'out' },
    channelList: { effect: 'none', duration: 0, easing: 'linear' },
    servers: { effect: 'none', duration: 0, easing: 'linear' },
    folder: { effect: 'drop', duration: 350, easing: 'smooth' },
    subtle: { effect: 'custom', duration: 220, easing: 'smooth' },
    media: { effect: 'zoom', duration: 300, easing: 'out' },
    press: { effect: 'shrink', duration: 250, easing: 'spring' },
}

// ── 방향 · 위치 (BetterDiscord 의 Direction / Position) ─────────────────

export type Direction = 'auto' | 'up' | 'down' | 'left' | 'right' | 'toward' | 'away'
export type Position = 'auto' | 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br'

export const DIRECTIONS: Array<{ id: Direction; label: string }> = [
    { id: 'auto', label: 'Auto' },
    { id: 'up', label: 'Up' },
    { id: 'down', label: 'Down' },
    { id: 'left', label: 'Left' },
    { id: 'right', label: 'Right' },
    { id: 'toward', label: 'Toward' },
    { id: 'away', label: 'Away' },
]

export const POSITIONS: Array<{ id: Position; label: string }> = [
    { id: 'auto', label: 'Auto' },
    { id: 'tl', label: '↖' },
    { id: 't', label: '↑' },
    { id: 'tr', label: '↗' },
    { id: 'l', label: '←' },
    { id: 'c', label: 'Center' },
    { id: 'r', label: '→' },
    { id: 'bl', label: '↙' },
    { id: 'b', label: '↓' },
    { id: 'br', label: '↘' },
]

const POS_XY: Record<Exclude<Position, 'auto'>, [number, number]> = {
    tl: [-1, -1],
    t: [0, -1],
    tr: [1, -1],
    l: [-1, 0],
    c: [0, 0],
    r: [1, 0],
    bl: [-1, 1],
    b: [0, 1],
    br: [1, 1],
}

export interface MoveOptions {
    direction?: Direction
    position?: Position
}

/**
 * 효과의 숨은 상태에 방향·위치 설정을 덧씌운다.
 *  - 방향: 효과의 이동(또는 뒤집기)을 고른 쪽으로 돌린다. "위로" = 아래에서 위로 올라오며 나타남.
 *    이동이 없는 효과(페이드 등)는 조금 이동을 더한다. 다가오기/멀어지기는 크기로.
 *  - 위치: 커지고 작아지는 기준점. (W, H) 는 움직이는 대상의 크기
 */
export function applyMove(hidden: Hidden | undefined, opts: MoveOptions | undefined, W: number, H: number): Normalized {
    const h = normalize(hidden)
    const dir = opts?.direction ?? 'auto'
    const pos = opts?.position ?? 'auto'
    if (dir !== 'auto') {
        if (dir === 'toward' || dir === 'away') {
            const d = Math.abs(1 - h.s) || 0.15
            h.s = dir === 'toward' ? Math.max(0.01, 1 - d) : 1 + d
        } else {
            const flip = (h.rx || h.ry) && !h.tx && !h.ty && !h.txW && !h.tyH
            if (flip) {
                const m = Math.max(Math.abs(h.rx), Math.abs(h.ry))
                h.rx = dir === 'up' ? m : dir === 'down' ? -m : 0
                h.ry = dir === 'left' ? -m : dir === 'right' ? m : 0
            } else {
                // 비율로 적힌 이동은 비율로, px 로 적힌 이동은 px 로 유지한다
                const fr = Math.max(Math.abs(h.txW), Math.abs(h.tyH))
                const px = Math.max(Math.abs(h.tx), Math.abs(h.ty)) || (fr ? 0 : 30)
                const vertical = dir === 'up' || dir === 'down'
                // "위로" 나타나려면 아래(+)에서 출발
                const sign = dir === 'up' || dir === 'left' ? 1 : -1
                h.txW = vertical ? 0 : sign * fr
                h.tyH = vertical ? sign * fr : 0
                h.tx = vertical ? 0 : sign * px
                h.ty = vertical ? sign * px : 0
            }
        }
    }
    if (pos !== 'auto') {
        // (px, py) 를 기준으로 s 배 = 가운데 기준 s 배 + (px, py)·(1 - s) 만큼 이동
        const [ox, oy] = POS_XY[pos]
        h.tx += (ox * W) / 2 * (1 - h.s)
        h.ty += (oy * H) / 2 * (1 - h.s * h.sy)
        h.anchor = false
    }
    return h
}

// ── 움직임(가속 곡선) ────────────────────────────────────────────
// 미리 만든 것: out, expo, smooth, linear, back, spring, bounce, elastic
// 직접 만든 것: "c:<종류>:<방향>:<모양>:<세기>"  (BetterDiscord Easing 과 같은 구성)
export type EasingKey = string

export const EASINGS: Array<{ id: EasingKey; label: string }> = [
    { id: 'out', label: 'Ease out' },
    { id: 'expo', label: 'Expo' },
    { id: 'smooth', label: 'Smooth' },
    { id: 'linear', label: 'Linear' },
    { id: 'back', label: 'Back' },
    { id: 'spring', label: 'Spring' },
    { id: 'bounce', label: 'Bounce' },
    { id: 'elastic', label: 'Elastic' },
]

export type EasingType = 'linear' | 'ease' | 'back' | 'elastic' | 'steps'
export type EasingBezier = 'in' | 'out' | 'inOut'
export type EasingStyle = 'sine' | 'quad' | 'cubic' | 'quart' | 'quint' | 'circ' | 'expo' | 'bounce'

export interface CustomEasing {
    type: EasingType
    bezier: EasingBezier
    style: EasingStyle
    /** back: 튕기는 정도, elastic: 출렁임, steps: 단계 수 */
    amount: number
}

export const EASING_TYPES: Array<{ id: EasingType; label: string }> = [
    { id: 'linear', label: 'Linear' },
    { id: 'ease', label: 'Curve' },
    { id: 'back', label: 'Back' },
    { id: 'elastic', label: 'Elastic' },
    { id: 'steps', label: 'Steps' },
]
export const EASING_BEZIERS: Array<{ id: EasingBezier; label: string }> = [
    { id: 'in', label: 'In' },
    { id: 'out', label: 'Out' },
    { id: 'inOut', label: 'In Out' },
]
export const EASING_STYLES: Array<{ id: EasingStyle; label: string }> = [
    { id: 'sine', label: 'Sine' },
    { id: 'quad', label: 'Quad' },
    { id: 'cubic', label: 'Cubic' },
    { id: 'quart', label: 'Quart' },
    { id: 'quint', label: 'Quint' },
    { id: 'circ', label: 'Circ' },
    { id: 'expo', label: 'Expo' },
    { id: 'bounce', label: 'Bounce' },
]

export const AMOUNT_RANGE: Record<'back' | 'elastic' | 'steps', { min: number; max: number; step: number; def: number }> = {
    back: { min: 0.5, max: 4, step: 0.1, def: 1.7 },
    elastic: { min: 0.3, max: 3, step: 0.1, def: 1 },
    steps: { min: 2, max: 20, step: 1, def: 5 },
}

export const isCustomEasing = (key: EasingKey) => typeof key === 'string' && key.startsWith('c:')

export function encodeEasing(c: CustomEasing): EasingKey {
    return `c:${c.type}:${c.bezier}:${c.style}:${Math.round(c.amount * 100) / 100}`
}

/** 미리 만든 것도 직접 만든 형태로 풀어 준다 (편집기 처음 값) */
export function decodeEasing(key: EasingKey): CustomEasing {
    if (isCustomEasing(key)) {
        const [, type, bezier, style, amount] = key.split(':')
        return {
            type: (EASING_TYPES.some(t => t.id === type) ? type : 'ease') as EasingType,
            bezier: (EASING_BEZIERS.some(b => b.id === bezier) ? bezier : 'out') as EasingBezier,
            style: (EASING_STYLES.some(s => s.id === style) ? style : 'cubic') as EasingStyle,
            amount: Number(amount) || 1,
        }
    }
    switch (key) {
        case 'linear':
            return { type: 'linear', bezier: 'out', style: 'cubic', amount: 1 }
        case 'smooth':
            return { type: 'ease', bezier: 'inOut', style: 'cubic', amount: 1 }
        case 'expo':
            return { type: 'ease', bezier: 'out', style: 'expo', amount: 1 }
        case 'back':
            return { type: 'back', bezier: 'out', style: 'cubic', amount: 1.7 }
        case 'bounce':
            return { type: 'ease', bezier: 'out', style: 'bounce', amount: 1 }
        case 'elastic':
            return { type: 'elastic', bezier: 'out', style: 'cubic', amount: 1.1 }
        default:
            return { type: 'ease', bezier: 'out', style: 'cubic', amount: 1 }
    }
}

export function easingLabel(key: EasingKey) {
    const preset = EASINGS.find(e => e.id === key)
    if (preset) return preset.label
    const c = decodeEasing(key)
    if (c.type === 'linear') return 'Custom · Linear'
    if (c.type === 'steps') return `Custom · Steps ${c.amount}`
    const bez = c.bezier === 'inOut' ? 'In Out' : c.bezier === 'in' ? 'In' : 'Out'
    const name = c.type === 'ease' ? EASING_STYLES.find(s => s.id === c.style)?.label : c.type === 'back' ? 'Back' : 'Elastic'
    return `Custom · ${name} ${bez}`
}

/** 스프링만 쓸 수 있는 곳에서 고른 움직임을 감쇠비로 바꾼다 (작을수록 출렁임) */
export function zetaOf(key: EasingKey) {
    if (isCustomEasing(key)) {
        const c = decodeEasing(key)
        if (c.type === 'back') return 0.7
        if (c.type === 'elastic') return Math.max(0.12, 0.3 / c.amount)
        if (c.type === 'ease' && c.style === 'bounce') return 0.35
        return 1
    }
    switch (key) {
        case 'spring':
            return 0.55
        case 'back':
            return 0.7
        case 'bounce':
            return 0.35
        case 'elastic':
            return 0.22
        default:
            return 1
    }
}

/** 타이밍 대신 스프링으로 돌려야 자연스러운 움직임인지 (스프링만 받는 곳에서) */
export const isSpringy = (key: EasingKey) => key === 'spring' || zetaOf(key) < 0.5

/** "점점 빠르게" 모양의 기본 곡선 */
function styleIn(E: any, style: EasingStyle) {
    switch (style) {
        case 'sine':
            return E.sin
        case 'quad':
            return E.quad
        case 'quart':
            return E.poly(4)
        case 'quint':
            return E.poly(5)
        case 'circ':
            return E.circle
        case 'expo':
            return E.exp
        case 'bounce':
            // E.bounce 는 끝에서 통통 튀는 모양(Out)이라 뒤집어서 In 으로
            return E.out(E.bounce)
        default:
            return E.cubic
    }
}

function wrap(E: any, bezier: EasingBezier, f: any) {
    return bezier === 'in' ? E.in(f) : bezier === 'inOut' ? E.inOut(f) : E.out(f)
}

/** 계단 곡선. Reanimated 는 워클릿이어야 해서 만드는 쪽을 넘겨받는다 */
export type StepsMaker = (n: number) => any
const jsSteps: StepsMaker = n => (t: number) => (t >= 1 ? 1 : Math.floor(t * n) / n)

/** Easing 모듈(react-native 또는 reanimated)로 곡선 함수를 만든다. 두 라이브러리 API가 같다 */
export function easingFrom(E: any, key: EasingKey, steps: StepsMaker = jsSteps) {
    if (isCustomEasing(key)) {
        const c = decodeEasing(key)
        switch (c.type) {
            case 'linear':
                return E.linear
            case 'steps':
                return steps(Math.max(1, Math.round(c.amount)))
            case 'back':
                return wrap(E, c.bezier, E.back(c.amount))
            case 'elastic':
                // E.elastic 은 끝에서 출렁이는 모양(Out)이라 뒤집어서 In 으로
                return wrap(E, c.bezier, E.out(E.elastic(c.amount)))
            default:
                return wrap(E, c.bezier, styleIn(E, c.style))
        }
    }
    switch (key) {
        case 'linear':
            return E.linear
        case 'smooth':
            return E.inOut(E.cubic)
        case 'expo':
            return E.out(E.exp)
        case 'back':
            return E.out(E.back(1.7))
        case 'bounce':
            return E.bounce
        case 'elastic':
            return E.elastic(1.1)
        default:
            return E.out(E.cubic)
    }
}

/**
 * 시간(ms)에 맞춰 멈추는 물리 스프링 값. 감쇠비 zeta가 작을수록 더 출렁인다.
 * 스프링은 대략 4 / (zeta * omega) 초 뒤에 멈춘다.
 */
export function springFor(duration: number, zeta = 0.55) {
    const t = Math.max(0.08, duration / 1000)
    const omega = 4 / (zeta * t)
    return {
        mass: 1,
        stiffness: Math.round(omega * omega),
        damping: Math.round(2 * zeta * omega * 100) / 100,
        overshootClamping: false,
        restDisplacementThreshold: 0.01,
        restSpeedThreshold: 0.01,
    }
}
