// 에디터용 최소 타입. 실제 API는 Valenced가 런타임에 `valenced` 전역으로 넘겨준다
declare function plugin<T extends object>(options: T): T
declare module '@valenced/*'
declare module 'react-native'
