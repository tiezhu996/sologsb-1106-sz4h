import type { BlockName } from './block'

export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  schemaRev?: number
}

/** 印次记录来源：当次登记 / 老数据升级时按现有版片推断。 */
export type PrintRunOrigin = 'registered' | 'migrated-inferred'

/**
 * 逐版印次。记录落印时所用的版次、原印次与套色偏差。
 * 重打不覆盖原印次，而是另存一条并互相挂接。
 */
export interface PrintRun {
  id: string
  batchId: string
  draftId: string
  blockId: string
  blockName: BlockName
  colorNo: number
  /** 落印时该版所用的版次号。 */
  revNo: number
  /** 原印次：每版走纸印刷的次数。 */
  pieceCount: number
  /** 本版套色偏差原文。 */
  deviation: string
  operator: string
  printedAt: string
  origin: PrintRunOrigin
  /** 重打结果指向原印次；原始印次为空。 */
  reprintOf?: string
  /** 原印次被重打后指向新印次；未重打为空。 */
  supersededBy?: string
}

export type ReviewDecision = 'keep-sample' | 'reprint'

/** 复核结论：可沿用旧印样，也可按新刀口重打（重打另有印次记录）。 */
export interface BlockReview {
  id: string
  runId: string
  blockId: string
  batchId: string
  /** 复核针对的新版次号。 */
  revNo: number
  decision: ReviewDecision
  /** 决策为 reprint 时，挂接重打产生的新印次。 */
  reprintRunId?: string
  operator: string
  reviewedAt: string
  note: string
}
