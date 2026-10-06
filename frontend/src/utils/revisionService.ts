import type { WoodprintDatabase } from './db'
import { db as defaultDb } from './db'
import type { Block } from '../types/block'
import type { BlockRevision, RepairInput } from '../types/revision'

/** 同一版次被并发占用（另一个标签页已先提交）时抛出。整笔事务已回滚，调用方应刷新后重试。 */
export class RevisionConflictError extends Error {
  constructor(
    public blockId: string,
    public expectedRevNo: number,
    public actualRevNo: number,
  ) {
    super(`版次冲突：该版片已有第 ${actualRevNo} 版，请刷新后基于新版次返修。`)
    this.name = 'RevisionConflictError'
  }
}

function nowStamp(): string {
  return new Date().toISOString().slice(0, 16)
}

export function snapshotOf(block: Block): BlockRevision['snapshot'] {
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

export interface AppendRepairResult {
  revision: BlockRevision
  affectedBatchIds: string[]
}

/**
 * 追加一次返修版次。
 *
 * - 只追加，不覆盖：旧版次快照、旧节点、旧批次全部留在原处；
 * - expectedRevNo 是发起返修时看到的当前版次，事务内重新核对，
 *   两个标签页同时提交同一版次时只有先写入的一个成功；
 * - 版次写入、版片当前态更新、修版节点登记、待复核批次标记
 *   全部在同一事务，任一步失败整笔回滚。
 */
export async function appendRepairRevision(
  blockId: string,
  input: RepairInput,
  options: { expectedRevNo?: number; database?: WoodprintDatabase } = {},
): Promise<AppendRepairResult> {
  const database = options.database ?? defaultDb
  const expectedRevNo = options.expectedRevNo

  const result = await database.transaction(
    'rw',
    database.blocks,
    database.blockRevisions,
    database.nodes,
    database.printRuns,
    database.blockReviews,
    async () => {
      const block = await database.blocks.get(blockId)
      if (!block) throw new Error(`未找到版片 ${blockId}`)

      const orderedRevisions = await database.blockRevisions.where('blockId').equals(blockId).sortBy('revNo')
      const currentRevNo = orderedRevisions[orderedRevisions.length - 1]?.revNo ?? block.currentRevNo
      if (expectedRevNo !== undefined && currentRevNo !== expectedRevNo) {
        throw new RevisionConflictError(blockId, expectedRevNo, currentRevNo)
      }

      const nextRevNo = currentRevNo + 1
      const woodChanged = input.woodType !== block.woodType
      const revision: BlockRevision = {
        id: `rev-${crypto.randomUUID()}`,
        blockId,
        revNo: nextRevNo,
        origin: 'repair',
        operator: input.operator.trim() || '未知',
        createdAt: input.createdAt ?? nowStamp(),
        note: (input.note ?? '').trim(),
        repairReason: input.repairReason.trim(),
        woodReplaced: woodChanged,
        previousWoodType: woodChanged ? block.woodType : null,
        // 快照冻结的是改刀前的版片摘要，保存"当时"而非改完后的状态。
        snapshot: snapshotOf(block),
      }

      // 唯一复合索引兜底：即便预期检查意外通过，重复版次号也无法落库。
      await database.blockRevisions.add(revision)

      await database.blocks.update(blockId, {
        woodType: input.woodType,
        thicknessMm: input.thicknessMm,
        state: input.state ?? '已修版',
        defectNote: input.defectNote ?? block.defectNote,
        currentRevNo: nextRevNo,
      })

      const existingNodes = await database.nodes.where('blockId').equals(blockId).toArray()
      await database.nodes.add({
        id: `node-${crypto.randomUUID()}`,
        blockId,
        revNo: nextRevNo,
        stage: '修版',
        seq: Math.max(0, ...existingNodes.map((node) => node.seq)) + 1,
        operator: revision.operator,
        startedAt: revision.createdAt,
        durationMin: 0,
        note: input.repairReason.trim()
          ? `返修登记：${input.repairReason.trim()}${woodChanged ? `；木料更换为${String(input.woodType)}。` : ''}`
          : '返修登记：改刀留档。',
      })

      // 用到这块版、且还停留在旧版次上的已登记批次，进入待复核范围。
      // 没碰到该版的批次不会出现在 printRuns 中，天然不受影响。
      const relatedRuns = await database.printRuns.where('blockId').equals(blockId).toArray()
      const staleRuns = relatedRuns.filter((run) => run.revNo < nextRevNo && !run.supersededBy)
      const affectedBatchIds = [...new Set(staleRuns.map((run) => run.batchId))]

      return { revision, affectedBatchIds }
    },
  )

  return result
}

/** 列出一块版的全部版次（旧到新）。 */
export async function listRevisions(blockId: string, database: WoodprintDatabase = defaultDb): Promise<BlockRevision[]> {
  const records = await database.blockRevisions.where('blockId').equals(blockId).toArray()
  return records.sort((a, b) => a.revNo - b.revNo)
}
