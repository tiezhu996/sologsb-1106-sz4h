import type { BlockName, BlockState, WoodType } from './block'

/** 版次来源：刻版记录可考为首刻；老档升级、来历不明一律按未知保留，不反推历史依据。 */
export type RevisionOrigin = 'initial' | 'repair' | 'unknown'

/**
 * 版次快照：登记这一版当时的版片摘要。
 * 后续改刀、换料只追加新版次，绝不回写老快照。
 */
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
  blockId: string
  /** 版次序号，同一块版从 1 起严格递增。 */
  revNo: number
  origin: RevisionOrigin
  operator: string
  createdAt: string
  note: string
  /** 改刀原因；首刻或来源缺失时可为空。 */
  repairReason: string
  /** 本版是否换过木料。 */
  woodReplaced: boolean
  /** 换料前的木料；未换料或来源未知时为 null。 */
  previousWoodType: WoodType | null
  /** 当时的版片摘要（见 BlockSnapshot），冻结保存。 */
  snapshot: BlockSnapshot
}

/** 返修追加新版次的表单输入。 */
export interface RepairInput {
  operator: string
  repairReason: string
  woodType: WoodType
  thicknessMm: number
  state?: BlockState
  defectNote?: string
  note?: string
  createdAt?: string
}
