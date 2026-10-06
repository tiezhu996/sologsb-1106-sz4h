export type BlockName = '墨线版' | '黄版' | '红版' | '绿版'

/**
 * 木料在常见梨木、黄杨之外允许作坊手填新料名，
 * 这里保留联合提示同时允许任意字符串。
 */
export type WoodType = '梨木' | '黄杨' | (string & {})
export type BlockState = '待刻' | '在刻' | '已刻成' | '已修版'

/** 版片当前状态（版片头）。历史状态只存在于各版次的快照里。 */
export interface Block {
  id: string
  draftId: string
  blockName: BlockName
  colorNo: number
  woodType: WoodType
  thicknessMm: number
  carvedBy: string
  state: BlockState
  defectNote: string
  currentRevNo: number
  schemaRev?: number
}
