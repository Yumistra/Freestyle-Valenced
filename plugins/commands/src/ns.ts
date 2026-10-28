// 이 저장소가 만드는 앱 (Valenced 판은 이 파일만 다르다)
declare const valenced: any

/** 모드 이름 (메시지에 보이는 것) */
export const MOD = 'Valenced'
/** 네이티브 메서드 이름 앞부분 (valenced.plugins.list …) */
export const NS = 'valenced'
/** 플러그인이 받는 API 전역 (/eval 에서 쓸 수 있게) */
export const api = () => valenced
export const API_NAME = 'valenced'
