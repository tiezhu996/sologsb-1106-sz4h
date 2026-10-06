export type ReviewDecision = '沿用旧印样' | '按新刀口重打'

/**
 * 批次复核：版片追加新版次后，用到旧版次的已登记批次进入待复核。
 * 每条复核针对「批次 + 版片 + 当时待复核的版次号」，只追加。
 * reviewedRevisionNo 为复核确认时该块版的最新版次号。
 */
export interface BatchReview {
  id: string
  /** 同一批次、同一块版、同一新版次只允许一笔复核成功 */
  reviewKey: string
  batchId: string
  blockId: string
  reviewedRevisionNo: number
  decision: ReviewDecision
  operator: string
  note: string
  reviewedAt: string
  schemaRev: number
}

/**
 * 重打结果：选择「按新刀口重打」时另存的一条印次，
 * 不覆盖原 BatchImpression 的印次与套色偏差。
 */
export interface RestrikeResult {
  id: string
  reviewId: string
  batchId: string
  blockId: string
  revisionNo: number
  restrikeNo: number
  pieceCount: number
  deviation: string
  operator: string
  restrikedAt: string
  note: string
  schemaRev: number
}
