/**
 * 印次登记：一个印制批次逐块版片留下的留档。
 * revisionNo 为该批次实际用到的版次；旧数据升级、无法判定时为 null。
 * 记录只追加、不回写，后来的版次状态不会覆盖这里的套色偏差。
 */
export interface BatchImpression {
  id: string
  batchId: string
  draftId: string
  blockId: string
  /** 批次与版片的唯一键，防止同批同版重复登记 */
  impKey: string
  revisionNo: number | null
  pieceCount: number
  /** 当时逐版记录的套色偏差 */
  deviation: string
  /** 登记 / 迁移未知 等来源说明 */
  source: string
  createdAt: string
  schemaRev: number
}
