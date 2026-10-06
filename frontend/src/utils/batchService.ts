import type { WoodprintDatabase } from './db'
import { db as defaultDb } from './db'
import type { BlockReview, PrintBatch, PrintRun } from '../types/batch'

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface BatchRegistrationInput {
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  operator?: string
  deviations?: Record<string, string>
}

/**
 * 登记批次并逐版落印次，整笔同一事务。
 * 新批次的印次一律按各版当前版次落印，不与老批次互相覆盖。
 */
export async function registerBatch(
  input: BatchRegistrationInput,
  options: { database?: WoodprintDatabase } = {},
): Promise<{ batch: PrintBatch; runs: PrintRun[] }> {
  const database = options.database ?? defaultDb

  return database.transaction(
    'rw',
    database.batches,
    database.printRuns,
    database.blocks,
    async () => {
      const blocks = await database.blocks.where('draftId').equals(input.draftId).toArray()
      blocks.sort((a, b) => a.colorNo - b.colorNo)

      const batch: PrintBatch = {
        id: newId('batch'),
        draftId: input.draftId,
        batchNo: input.batchNo,
        printedAt: input.printedAt,
        paperBatch: input.paperBatch,
        inkNote: input.inkNote,
        qty: input.qty,
        pieceCount: input.pieceCount,
        qcNote: input.qcNote,
      }
      await database.batches.add(batch)

      const runs: PrintRun[] = blocks.map((block) => ({
        id: newId('run'),
        batchId: batch.id,
        draftId: input.draftId,
        blockId: block.id,
        blockName: block.blockName,
        colorNo: block.colorNo,
        revNo: block.currentRevNo,
        pieceCount: input.pieceCount,
        deviation: input.deviations?.[block.id]?.trim() ?? '',
        operator: input.operator?.trim() || '未知',
        printedAt: input.printedAt,
        origin: 'registered' as const,
      }))
      if (runs.length > 0) await database.printRuns.bulkAdd(runs)

      return { batch, runs }
    },
  )
}

export interface PendingRun extends PrintRun {
  currentRevNo: number
}

/**
 * 派生待复核印次：
 * - 印次所用版次落后于当前版次；
 * - 原印次未被重打结果取代；
 * - 且还没有针对当前版次的复核结论（沿用旧样也只认当前这版）。
 * 没碰到该版片的批次根本没有印次，自然不会进入名单。
 */
export async function listPendingRuns(options: { database?: WoodprintDatabase; batchId?: string } = {}): Promise<PendingRun[]> {
  const database = options.database ?? defaultDb
  const [runs, blocks, reviews] = await Promise.all([
    options.batchId ? database.printRuns.where('batchId').equals(options.batchId).toArray() : database.printRuns.toArray(),
    database.blocks.toArray(),
    database.blockReviews.toArray(),
  ])

  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const coveredRuns = new Set(
    reviews
      .filter((review) => {
        const block = blockById.get(review.blockId)
        return block !== undefined && review.revNo === block.currentRevNo
      })
      .map((review) => review.runId),
  )

  return runs
    .filter((run) => {
      const block = blockById.get(run.blockId)
      if (!block) return false
      if (run.supersededBy) return false
      if (run.revNo >= block.currentRevNo) return false
      if (coveredRuns.has(run.id)) return false
      return true
    })
    .map((run) => ({ ...run, currentRevNo: blockById.get(run.blockId)?.currentRevNo ?? run.revNo }))
    .sort((a, b) =>
      a.batchId.localeCompare(b.batchId) || a.colorNo - b.colorNo || a.printedAt.localeCompare(b.printedAt),
    )
}

export interface ReviewInput {
  operator: string
  note?: string
  reviewedAt?: string
}

/**
 * 沿用旧印样：原印次、原印次数量、套色偏差全部不动，只追加一条复核结论。
 */
export async function keepOldSample(
  runId: string,
  input: ReviewInput,
  options: { database?: WoodprintDatabase } = {},
): Promise<BlockReview> {
  const database = options.database ?? defaultDb

  return database.transaction('rw', database.printRuns, database.blocks, database.blockReviews, async () => {
    const run = await database.printRuns.get(runId)
    if (!run) throw new Error(`未找到印次 ${runId}`)
    const block = await database.blocks.get(run.blockId)
    if (!block) throw new Error(`未找到版片 ${run.blockId}`)
    if (run.revNo >= block.currentRevNo) throw new Error('该印次已是当前刀口，无需复核。')

    const review: BlockReview = {
      id: newId('review'),
      runId,
      blockId: run.blockId,
      batchId: run.batchId,
      revNo: block.currentRevNo,
      decision: 'keep-sample',
      operator: input.operator.trim() || '未知',
      reviewedAt: input.reviewedAt ?? today(),
      note: (input.note ?? '').trim() || '沿用旧印样，重核刀口后认可。',
    }
    await database.blockReviews.add(review)
    return review
  })
}

export interface ReprintInput extends ReviewInput {
  deviation: string
  pieceCount: number
  printedAt?: string
}

/**
 * 按新刀口重打：新建一条印次另存（原印次与套色偏差原样保留），
 * 新旧印次互相挂接，并追加复核结论。整笔同一事务。
 */
export async function reprintRun(
  runId: string,
  input: ReprintInput,
  options: { database?: WoodprintDatabase } = {},
): Promise<{ review: BlockReview; reprint: PrintRun }> {
  const database = options.database ?? defaultDb

  return database.transaction(
    'rw',
    database.printRuns,
    database.blocks,
    database.blockReviews,
    async () => {
      const original = await database.printRuns.get(runId)
      if (!original) throw new Error(`未找到印次 ${runId}`)
      if (original.supersededBy) throw new Error('该印次已有重打结果。')
      const block = await database.blocks.get(original.blockId)
      if (!block) throw new Error(`未找到版片 ${original.blockId}`)
      if (original.revNo >= block.currentRevNo) throw new Error('该印次已是当前刀口，无需重打。')
      if (input.pieceCount <= 0) throw new Error('重打印次需大于 0。')

      const reprint: PrintRun = {
        id: newId('run'),
        batchId: original.batchId,
        draftId: original.draftId,
        blockId: original.blockId,
        blockName: original.blockName,
        colorNo: original.colorNo,
        revNo: block.currentRevNo,
        pieceCount: input.pieceCount,
        deviation: input.deviation.trim(),
        operator: input.operator.trim() || '未知',
        printedAt: input.printedAt ?? today(),
        origin: 'registered',
        reprintOf: original.id,
      }
      await database.printRuns.add(reprint)
      await database.printRuns.update(original.id, { supersededBy: reprint.id })

      const review: BlockReview = {
        id: newId('review'),
        runId: original.id,
        blockId: original.blockId,
        batchId: original.batchId,
        revNo: block.currentRevNo,
        decision: 'reprint',
        reprintRunId: reprint.id,
        operator: input.operator.trim() || '未知',
        reviewedAt: input.reviewedAt ?? reprint.printedAt,
        note: (input.note ?? '').trim() || `按第 ${block.currentRevNo} 版刀口重打，原印次留存。`,
      }
      await database.blockReviews.add(review)

      return { review, reprint }
    },
  )
}

export async function listReviewsForBlock(
  blockId: string,
  options: { database?: WoodprintDatabase } = {},
): Promise<BlockReview[]> {
  const database = options.database ?? defaultDb
  const records = await database.blockReviews.where('blockId').equals(blockId).toArray()
  return records.sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
}
