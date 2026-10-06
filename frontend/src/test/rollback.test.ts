import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { appendRepairRevision } from '../utils/revisionService'
import { listPendingRuns, reprintRun } from '../utils/batchService'

async function seededDb() {
  const db = createTestDb()
  await db.open()
  return db
}

describe('写入失败整笔回滚', () => {
  it('返修中途某步写入失败：新版次、版片当前态、节点全部不落地', async () => {
    const db = await seededDb()
    const blockId = 'block-zw-01'

    // 让最后一步（nodes.add）抛错，模拟任一步写入失败。
    const originalAdd = db.nodes.add.bind(db.nodes)
    let nodeWrites = 0
    db.nodes.add = ((value: unknown, key?: unknown) => {
      nodeWrites += 1
      const record = value as { stage?: string }
      if (record.stage === '修版') throw new Error('模拟节点写入失败')
      return originalAdd(value as never, key as never)
    }) as typeof db.nodes.add

    await expect(
      appendRepairRevision(
        blockId,
        { operator: '秦木生', repairReason: '回滚测试', woodType: '梨木', thicknessMm: 16, createdAt: '2026-03-03T11:00' },
        { expectedRevNo: 1, database: db },
      ),
    ).rejects.toThrow('模拟节点写入失败')

    expect(nodeWrites).toBeGreaterThan(0)
    const block = await db.blocks.get(blockId)
    expect(block?.currentRevNo).toBe(1)
    expect(block?.woodType).toBe('黄杨')
    const revisions = await db.blockRevisions.where('blockId').equals(blockId).toArray()
    expect(revisions.map((rev) => rev.revNo)).toEqual([1])
    const nodes = await db.nodes.where('blockId').equals(blockId).toArray()
    expect(nodes.some((node) => node.stage === '修版' && node.note.includes('回滚测试'))).toBe(false)
  })

  it('重打中途写入失败：不产生半截新印次，原印次不被挂接，待复核保持', async () => {
    const db = await seededDb()
    await appendRepairRevision(
      'block-ms-02',
      { operator: '秦木生', repairReason: '边线再收一刀', woodType: '梨木', thicknessMm: 20, createdAt: '2026-03-02T10:00' },
      { expectedRevNo: 1, database: db },
    )
    const target = (await listPendingRuns({ database: db })).find(
      (run) => run.batchId === 'batch-ms-001' && run.blockId === 'block-ms-02',
    )!
    const runsBefore = await db.printRuns.toArray()

    // 复核结论写入失败，应与新印次、原印次挂接一起回滚。
    const originalAdd = db.blockReviews.add.bind(db.blockReviews)
    db.blockReviews.add = (() => {
      throw new Error('模拟复核写入失败')
    }) as typeof db.blockReviews.add

    await expect(
      reprintRun(target.id, { operator: '印工甲', deviation: '不应落地', pieceCount: 1 }, { database: db }),
    ).rejects.toThrow('模拟复核写入失败')

    db.blockReviews.add = originalAdd
    const runsAfter = await db.printRuns.toArray()
    expect(runsAfter.length).toBe(runsBefore.length)
    const original = await db.printRuns.get(target.id)
    expect(original?.supersededBy).toBeUndefined()
    const pending = await listPendingRuns({ database: db })
    expect(pending.some((run) => run.id === target.id)).toBe(true)
  })
})
