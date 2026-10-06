import Dexie from 'dexie'
import { db } from '../utils/db'
import type { Block, WoodType } from '../types/block'
import type { BlockRevision, ReplacedWood } from '../types/revision'
import type { BatchImpression } from '../types/impression'
import type { BatchReview, RestrikeResult, ReviewDecision } from '../types/review'
import type { ProcessNode } from '../types/node'
import { SCHEMA_REVISION, snapshotOf } from '../utils/archive'

/** revKey / reviewKey 唯一索引冲突：两个标签页/两次提交抢同一版次或复核 */
export class RevisionConflictError extends Error {
  constructor(message = '该版次已被另一笔提交登记，本次未写入，请刷新后重试。') {
    super(message)
    this.name = 'RevisionConflictError'
  }
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConstraintError' || error.name === Dexie.errnames.Constraint)
  )
}

export interface AppendRevisionInput {
  blockId: string
  /**
   * 提交方认领的新版次号（打开表单时看到的当前版次 + 1）。
   * 两个标签页同时提交时会认领同一号，revKey 唯一索引保证只成一笔；
   * 号已落后或跳号则拒绝，提示刷新后继续——不静默改成别的版次。
   */
  expectedRevisionNo: number
  reason: string
  replacedWood: ReplacedWood
  operator: string
  note?: string
}

/**
 * 追加一个返修版次，整笔事务：
 * 1. 读当前最高版次号 → 2. 写 revisions（revKey 唯一，并发时只有一笔成功）
 * 3. 更新版片当前版次与木料 → 4. 留一条「修版」工序节点（挂新版次）
 * 任一步失败整笔回滚；冲突由唯一索引抛出 ConstraintError 转成语义错误。
 */
export async function appendRepairRevision(input: AppendRevisionInput): Promise<BlockRevision> {
  if (!input.reason.trim()) throw new Error('请先填写改刀原因。')

  try {
    return await db.transaction(
      'rw',
      db.revisions,
      db.blocks,
      db.nodes,
      async (): Promise<BlockRevision> => {
        const block = await db.blocks.get(input.blockId)
        if (!block) throw new Error('版片档案不存在，无法追加版次。')

        const existing = await db.revisions.where('blockId').equals(block.id).toArray()
        const nextNo = existing.reduce((max, item) => Math.max(max, item.revisionNo), 0) + 1
        if (input.expectedRevisionNo !== nextNo) {
          throw new RevisionConflictError(
            `你要追加的第 ${input.expectedRevisionNo} 版次已与档案对不上（档案下一版次为第 ${nextNo}），请刷新后重试。`,
          )
        }
        const revisionNo = nextNo
        const now = new Date().toISOString()
        const nextWood: WoodType =
          input.replacedWood === '梨木' || input.replacedWood === '黄杨'
            ? input.replacedWood
            : block.woodType

        const nextBlock: Block = {
          ...block,
          woodType: nextWood,
          state: '已修版',
        }

        const revision: BlockRevision = {
          id: `rev-${crypto.randomUUID()}`,
          revKey: `${block.id}#${revisionNo}`,
          blockId: block.id,
          revisionNo,
          kind: '返修',
          origin: '当班登记',
          originNodeId: null,
          reason: input.reason.trim(),
          replacedWood: input.replacedWood,
          operator: input.operator.trim(),
          createdAt: now.slice(0, 16),
          snapshot: snapshotOf(nextBlock),
          schemaRev: SCHEMA_REVISION,
        }

        // add 命中 revKey 唯一索引时整事务中止，另一笔同样失败其一。
        await db.revisions.add(revision)
        await db.blocks.update(block.id, {
          currentRevisionNo: revisionNo,
          woodType: nextWood,
          state: '已修版',
        } satisfies Partial<Block>)

        const blockNodes = await db.nodes.where('blockId').equals(block.id).toArray()
        const nextSeq = blockNodes.reduce((max, node) => Math.max(max, node.seq), 0) + 1
        const node: ProcessNode = {
          id: `node-${crypto.randomUUID()}`,
          blockId: block.id,
          stage: '修版',
          seq: nextSeq,
          operator: input.operator.trim(),
          startedAt: now.slice(0, 16),
          durationMin: 0,
          note: input.note?.trim() || input.reason.trim(),
          revisionNo,
        }
        await db.nodes.add(node)

        return revision
      },
    )
  } catch (error) {
    if (isConstraintError(error)) {
      throw new RevisionConflictError('同一版次已由另一笔提交登记成功，本次未写入，请刷新后重试。')
    }
    throw error
  }
}

/** 新立画稿时随四块基础版写入首个版次（与建块同事务） */
export async function createInitialRevision(block: Block, operator: string): Promise<BlockRevision> {
  const revision: BlockRevision = {
    id: `rev-${crypto.randomUUID()}`,
    revKey: `${block.id}#1`,
    blockId: block.id,
    revisionNo: 1,
    kind: '首版',
    origin: '当班登记',
    originNodeId: null,
    reason: '首个版次',
    replacedWood: '未换料',
    operator,
    createdAt: new Date().toISOString().slice(0, 16),
    snapshot: snapshotOf(block),
    schemaRev: SCHEMA_REVISION,
  }
  await db.revisions.add(revision)
  return revision
}

export interface RegisterBatchInput {
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** blockId -> 逐版套色偏差 */
  deviations: Record<string, string>
}

/**
 * 登记印制批次：批次 + 逐版印次（含版次号、原印次、套色偏差）同一事务写入。
 * 印次一经保存不回写，之后追加版次不会改动这些记录。
 */
export async function registerPrintBatch(input: RegisterBatchInput): Promise<string> {
  const batchId = `batch-${crypto.randomUUID()}`

  await db.transaction('rw', db.batches, db.blocks, db.impressions, async () => {
    const blocks = await db.blocks.where('draftId').equals(input.draftId).toArray()
    blocks.sort((a, b) => a.colorNo - b.colorNo)

    await db.batches.add({
      id: batchId,
      draftId: input.draftId,
      batchNo: input.batchNo,
      printedAt: input.printedAt,
      paperBatch: input.paperBatch,
      inkNote: input.inkNote,
      qty: input.qty,
      pieceCount: input.pieceCount,
      qcNote: input.qcNote,
    })

    const impressions: BatchImpression[] = blocks.map((block) => ({
      id: `imp-${crypto.randomUUID()}`,
      impKey: `${batchId}#${block.id}`,
      batchId,
      draftId: input.draftId,
      blockId: block.id,
      revisionNo: block.currentRevisionNo ?? 1,
      pieceCount: input.pieceCount,
      deviation: (input.deviations[block.id] ?? '').trim(),
      source: '当班登记',
      createdAt: new Date().toISOString(),
      schemaRev: SCHEMA_REVISION,
    }))
    await db.impressions.bulkAdd(impressions)
  })

  return batchId
}

export interface BatchReviewInput {
  batchId: string
  operator: string
  note: string
  /** 对哪些待复核版片沿用旧印样（不重打） */
  keepBlockIds: string[]
  /** blockId -> 重打结果 */
  restrikes: Record<
    string,
    {
      restrikeNo: number
      pieceCount: number
      deviation: string
      note: string
    }
  >
}

export interface SubmittedReview {
  reviews: BatchReview[]
  restrikes: RestrikeResult[]
}

/**
 * 提交批次复核：所有待复核版片要么沿用旧印样、要么另存重打结果，
 * reviewKey（批次#版片#确认版次号）唯一，重复提交只有一笔成功；
 * 原印次与其套色偏差原样保留。整包一个事务，失败全部回滚。
 */
export async function submitBatchReview(input: BatchReviewInput): Promise<SubmittedReview> {
  try {
    return await db.transaction(
      'rw',
      db.batches,
      db.blocks,
      db.impressions,
      db.reviews,
      db.restrikes,
      async () => {
        const batch = await db.batches.get(input.batchId)
        if (!batch) throw new Error('批次不存在，无法复核。')

        const impressions = await db.impressions.where('batchId').equals(input.batchId).toArray()
        const priorReviews = await db.reviews.where('batchId').equals(input.batchId).toArray()
        const reviewedKey = new Set(priorReviews.map((review) => review.reviewKey))

        const keepSet = new Set(input.keepBlockIds)
        const targetBlockIds = new Set([...input.keepBlockIds, ...Object.keys(input.restrikes)])
        const reviews: BatchReview[] = []
        const restrikes: RestrikeResult[] = []
        const now = new Date().toISOString()

        for (const impression of impressions) {
          if (!targetBlockIds.has(impression.blockId)) continue
          const block = await db.blocks.get(impression.blockId)
          if (!block) continue

          const currentRevisionNo = block.currentRevisionNo ?? 1
          const decision: ReviewDecision = keepSet.has(impression.blockId) ? '沿用旧印样' : '按新刀口重打'
          const review: BatchReview = {
            id: `review-${crypto.randomUUID()}`,
            reviewKey: `${input.batchId}#${impression.blockId}#${currentRevisionNo}`,
            batchId: input.batchId,
            blockId: impression.blockId,
            reviewedRevisionNo: currentRevisionNo,
            decision,
            operator: input.operator.trim(),
            note: input.note.trim(),
            reviewedAt: now,
            schemaRev: SCHEMA_REVISION,
          }
          if (reviewedKey.has(review.reviewKey)) {
            throw new RevisionConflictError('该版次的复核已由另一笔提交保存，本次未写入，请刷新后查看。')
          }
          reviews.push(review)
          reviewedKey.add(review.reviewKey)
        }

        if (reviews.length === 0) throw new Error('没有可提交的复核项。')

        for (const review of reviews) {
          if (review.decision !== '按新刀口重打') continue
          const resultInput = input.restrikes[review.blockId]
          if (!resultInput) continue
          restrikes.push({
            id: `restrike-${crypto.randomUUID()}`,
            reviewId: review.id,
            batchId: review.batchId,
            blockId: review.blockId,
            revisionNo: review.reviewedRevisionNo,
            restrikeNo: Math.max(1, Math.trunc(resultInput.restrikeNo)),
            pieceCount: Math.max(1, Math.trunc(resultInput.pieceCount)),
            deviation: resultInput.deviation.trim(),
            operator: input.operator.trim(),
            restrikedAt: now,
            note: resultInput.note.trim(),
            schemaRev: SCHEMA_REVISION,
          })
        }

        await db.reviews.bulkAdd(reviews)
        if (restrikes.length > 0) await db.restrikes.bulkAdd(restrikes)
        return { reviews, restrikes }
      },
    )
  } catch (error) {
    if (isConstraintError(error)) {
      throw new RevisionConflictError('同一版次的复核已由另一笔提交保存，本次未写入，请刷新后查看。')
    }
    throw error
  }
}
