import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'

/**
 * 지금 디스코드 아이콘 (새 디자인의 벡터 아이콘). 표 줄 아이콘 자리에 디스코드와 같은 크기, 색으로.
 * 그 이름의 새 아이콘이 없으면 예전 그림 아이콘.
 */
export function rowIcon(name: string) {
    const C: any = lookupGeneratedIconComponent(name as any)
    const TI = (Design as any)?.TableRow?.Icon
    if (C && TI) return <TI IconComponent={C} />
    if (C) return <C size="md" />
    return <TableRowAssetIcon name={name} />
}

/** 아이콘 컴포넌트 (크기, 색을 직접 줄 때) */
export const iconComponent = (name: string): any => lookupGeneratedIconComponent(name as any)
