import type { BlockName, BlockState, WoodType } from './block'

/**
 * 版次来源：
 * - 工序节点：由已登记的工序节点（含修版节点）回溯建立
 * - 当班登记：当班次由师傅正式追加
 * - 迁移未知：旧数据升级而来，无可靠来源依据，不冒充历史
 */
export type RevisionOrigin = '工序节点' | '当班登记' | '迁移未知'
export type RevisionKind = '首版' | '返修'
export type ReplacedWood = WoodType | '未换料' | '未知'

/** 版次建立时版片的冻结摘要，之后任何修改都不会回写老摘要 */
export interface BlockSnapshot {
  blockName: BlockName
  colorNo: number
  woodType: WoodType
  thicknessMm: number
  carvedBy: string
  state: BlockState
  defectNote: string
}

export interface BlockRevision {
  id: string
  /** 版片名与版次号组成的唯一键，保证并发追加时只有一笔成功 */
  revKey: string
  blockId: string
  revisionNo: number
  kind: RevisionKind
  origin: RevisionOrigin
  /** 来源节点 id；来源缺失时为 null */
  originNodeId: string | null
  /** 改刀原因；首版记首个版次说明 */
  reason: string
  /** 返修换用的木料；未换料记「未换料」，旧数据无依据记「未知」 */
  replacedWood: ReplacedWood
  operator: string
  createdAt: string
  snapshot: BlockSnapshot
  schemaRev: number
}
