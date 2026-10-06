export type ProcessStage = '起稿' | '勾描' | '上样' | '刻版' | '修版' | '调色' | '套印' | '晾晒'

export interface ProcessNode {
  id: string
  batchId?: string
  blockId?: string
  /** 节点归属的版次；老数据升级后补为 1。旧节点始终留在原版次下，不随改刀迁移。 */
  revNo?: number
  stage: ProcessStage
  seq: number
  operator: string
  startedAt: string
  durationMin: number
  note: string
  schemaRev?: number
}
