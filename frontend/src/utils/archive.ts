import type { Block } from '../types/block'
import type { BlockRevision, BlockSnapshot, RevisionOrigin } from '../types/revision'
import type { BatchImpression } from '../types/impression'
import type { BatchReview, RestrikeResult } from '../types/review'
import type { PrintBatch } from '../types/batch'
import type { ProcessNode } from '../types/node'

export const SCHEMA_REVISION = 3

/** 取版片某一时点的冻结摘要；调用方负责传入该时点的字段值 */
export function snapshotOf(block: Pick<Block, keyof BlockSnapshot>): BlockSnapshot {
  return {
    blockName: block.blockName,
    colorNo: block.colorNo,
    woodType: block.woodType,
    thicknessMm: block.thicknessMm,
    carvedBy: block.carvedBy,
    state: block.state,
    defectNote: block.defectNote,
  }
}

interface BuiltBlockHistory {
  revisions: BlockRevision[]
  /** node.id -> 该节点所属版次号 */
  nodeRevisionNos: Map<string, number>
  currentRevisionNo: number
}

/**
 * 按现有工序节点为一块版补出版次链：
 * 首个版次锚定最早节点；每个「修版」节点追加一个返修版次。
 * 节点缺失（待刻版）时首版来源按「迁移未知」保留，不虚构依据。
 */
export function buildBlockHistory(
  block: Block,
  blockNodes: ProcessNode[],
  options: { idPrefix?: string; now?: string } = {},
): BuiltBlockHistory {
  const prefix = options.idPrefix ?? `rev-${block.id}`
  const sorted = [...blockNodes].sort((a, b) => a.seq - b.seq)
  const repairs = sorted.filter((node) => node.stage === '修版')
  const nodeRevisionNos = new Map<string, number>()

  let passedRepairs = 0
  for (const node of sorted) {
    if (node.stage === '修版') passedRepairs += 1
    nodeRevisionNos.set(node.id, passedRepairs + 1)
  }

  const revisions: BlockRevision[] = []
  const firstNode = sorted[0] ?? null
  const firstRepair = repairs[0] ?? null
  const origin: RevisionOrigin = firstNode ? '工序节点' : '迁移未知'

  const firstState: Block['state'] = (() => {
    const beforeRepair = firstRepair ? sorted.filter((node) => node.seq < firstRepair.seq) : sorted
    if (beforeRepair.some((node) => node.stage === '刻版')) return '已刻成'
    if (beforeRepair.some((node) => ['上样', '勾描', '起稿'].includes(node.stage))) return '在刻'
    return block.state === '已修版' ? '在刻' : block.state
  })()

  revisions.push({
    id: `${prefix}-1`,
    revKey: `${block.id}#1`,
    blockId: block.id,
    revisionNo: 1,
    kind: '首版',
    origin,
    originNodeId: firstNode?.id ?? null,
    reason: firstNode ? firstNode.note || '首个版次' : '首个版次（来源缺失，按未知保留）',
    replacedWood: '未换料',
    operator: firstNode?.operator ?? '',
    createdAt: firstNode?.startedAt ?? '',
    snapshot: {
      ...snapshotOf(block),
      state: firstState,
      // 返修之后才补记的崩口说明不回写到首版摘要
      defectNote: repairs.length > 0 ? '' : block.defectNote,
    },
    schemaRev: SCHEMA_REVISION,
  })

  repairs.forEach((repair, index) => {
    const revisionNo = index + 2
    revisions.push({
      id: `${prefix}-${revisionNo}`,
      revKey: `${block.id}#${revisionNo}`,
      blockId: block.id,
      revisionNo,
      kind: '返修',
      origin: '工序节点',
      originNodeId: repair.id,
      reason: repair.note || '改刀返修（节点未记原因）',
      replacedWood: '未知',
      operator: repair.operator,
      createdAt: repair.startedAt,
      snapshot: {
        ...snapshotOf(block),
        state: '已修版',
        defectNote: block.defectNote,
      },
      schemaRev: SCHEMA_REVISION,
    })
  })

  return { revisions, nodeRevisionNos, currentRevisionNo: revisions.length }
}

/** 从旧批次总检文本中按「版名：……」切出逐版套色偏差；切不到不杜撰 */
export function parseDeviation(qcNote: string, blockName: string): string {
  const matched = new RegExp(`${blockName}：([^；;]*)`).exec(qcNote)
  return matched?.[1]?.trim() ?? ''
}

/** 推断批次印制日期当时处在第几版次；无日期依据时回落首版 */
export function revisionInUseAt(revisions: BlockRevision[], printedAt: string): number {
  const eligible = revisions
    .filter((revision) => revision.createdAt !== '' && revision.createdAt.slice(0, 10) <= printedAt)
    .map((revision) => revision.revisionNo)
  if (eligible.length === 0) return 1
  return Math.max(...eligible)
}

/**
 * 旧批次升级 / 种子数据：按同画稿版片补印次关联。
 * 来源一律标「迁移未知」——版次是按节点回溯的，不冒充原始登记依据。
 */
export function buildImpressionsForBatch(
  batch: PrintBatch,
  blocks: Block[],
  revisionsByBlock: Map<string, BlockRevision[]>,
  options: { idPrefix?: string } = {},
): BatchImpression[] {
  const prefix = options.idPrefix ?? `imp-${batch.id}`
  return blocks
    .filter((block) => block.draftId === batch.draftId)
    .sort((a, b) => a.colorNo - b.colorNo)
    .map((block, index) => {
      const revisions = revisionsByBlock.get(block.id) ?? []
      return {
        id: `${prefix}-${index + 1}`,
        impKey: `${batch.id}#${block.id}`,
        batchId: batch.id,
        draftId: batch.draftId,
        blockId: block.id,
        revisionNo: revisions.length > 0 ? revisionInUseAt(revisions, batch.printedAt) : null,
        pieceCount: batch.pieceCount,
        deviation: parseDeviation(batch.qcNote, block.blockName),
        source: '迁移未知',
        createdAt: batch.printedAt,
        schemaRev: SCHEMA_REVISION,
      } satisfies BatchImpression
    })
}

export interface PendingBlock {
  blockId: string
  usedRevisionNo: number | null
  currentRevisionNo: number
  /** 旧印次来源缺失（未知），需管事当眼看一次 */
  unknownOrigin: boolean
}

export interface BatchReviewState {
  pending: PendingBlock[]
  reviewedBlocks: number
  impressions: BatchImpression[]
  reviews: BatchReview[]
  restrikes: RestrikeResult[]
}

/**
 * 派生批次复核态（纯计算，不写库）：
 * 用到的某块版存在比印次更新、且未就该新版次复核的版次 → 待复核；
 * 印次来源未知（revisionNo 为 null）也先列待复核；
 * 完全没碰到新版次的批次不受影响。
 */
export function deriveBatchReviewState(
  batchId: string,
  blocks: Block[],
  currentRevisionByBlock: Map<string, number>,
  impressions: BatchImpression[],
  reviews: BatchReview[],
  restrikes: RestrikeResult[],
): BatchReviewState {
  const ownImpressions = impressions.filter((item) => item.batchId === batchId)
  const ownReviews = reviews.filter((item) => item.batchId === batchId)
  const ownRestrikes = restrikes.filter((item) => item.batchId === batchId)

  const lastReviewedByBlock = new Map<string, number>()
  for (const review of ownReviews) {
    const prev = lastReviewedByBlock.get(review.blockId) ?? 0
    lastReviewedByBlock.set(review.blockId, Math.max(prev, review.reviewedRevisionNo))
  }

  const pending: PendingBlock[] = []
  for (const impression of ownImpressions) {
    const block = blocks.find((item) => item.id === impression.blockId)
    if (!block) continue
    const current = currentRevisionByBlock.get(impression.blockId) ?? block.currentRevisionNo ?? 1
    const lastReviewed = lastReviewedByBlock.get(impression.blockId) ?? 0
    const baseline = impression.revisionNo ?? 0
    if (current > Math.max(baseline, lastReviewed)) {
      pending.push({
        blockId: impression.blockId,
        usedRevisionNo: impression.revisionNo,
        currentRevisionNo: current,
        unknownOrigin: impression.revisionNo === null,
      })
    }
  }

  return {
    pending,
    reviewedBlocks: ownReviews.filter((review) => review.decision === '沿用旧印样').length,
    impressions: ownImpressions,
    reviews: ownReviews,
    restrikes: ownRestrikes,
  }
}
