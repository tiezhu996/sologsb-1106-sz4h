import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { appendRepairRevision, listRevisions, RevisionConflictError } from '../utils/revisionService'

async function seededDb() {
  const db = createTestDb()
  await db.open()
  return db
}

describe('追加式版次', () => {
  it('返修只追加新版次：旧快照冻结，旧节点留在原处', async () => {
    const db = await seededDb()
    const blockId = 'block-ll-01'

    const before = await db.blocks.get(blockId)
    expect(before?.currentRevNo).toBe(2)
    const nodesBefore = await db.nodes.where('blockId').equals(blockId).toArray()
    expect(nodesBefore.length).toBe(2)

    const result = await appendRepairRevision(
      blockId,
      {
        operator: '秦木生',
        repairReason: '印面发现新崩线，需顺线补刀',
        woodType: '梨木',
        thicknessMm: 16,
        defectNote: '鱼鳞线二次加修。',
        createdAt: '2026-03-01T09:00',
      },
      { expectedRevNo: 2, database: db },
    )

    expect(result.revision.revNo).toBe(3)
    // 快照保存的是改刀前摘要，不被后来的状态覆盖。
    expect(result.revision.snapshot.defectNote).toBe('鱼鳞线加修一次，边缘改圆顺。')
    expect(result.revision.snapshot.woodType).toBe('黄杨')
    expect(result.revision.woodReplaced).toBe(true)
    expect(result.revision.previousWoodType).toBe('黄杨')

    const revisions = await listRevisions(blockId, db)
    expect(revisions.map((rev) => rev.revNo)).toEqual([1, 2, 3])
    const first = revisions[0]
    expect(first.origin).toBe('initial')

    const after = await db.blocks.get(blockId)
    expect(after?.currentRevNo).toBe(3)
    expect(after?.woodType).toBe('梨木')
    expect(after?.defectNote).toBe('鱼鳞线二次加修。')

    // 旧节点未被改动，新修版节点挂在第 3 版，序号续接。
    const nodesAfter = await db.nodes.where('blockId').equals(blockId).toArray()
    expect(nodesAfter.length).toBe(3)
    const newNode = nodesAfter.find((node) => node.revNo === 3)
    expect(newNode?.seq).toBe(3)
    expect(newNode?.stage).toBe('修版')
    expect(nodesAfter.find((node) => node.id === 'node-ll-01')?.revNo).toBe(1)
    expect(nodesAfter.find((node) => node.id === 'node-ll-02')?.revNo).toBe(2)
  })

  it('用到该版的批次进入待复核，没碰到的批次不受影响', async () => {
    const db = await seededDb()
    // block-ms-02（黄版）只有 batch-ms-001 一次试印，按 revNo=1 落印。
    await appendRepairRevision(
      'block-ms-02',
      {
        operator: '秦木生',
        repairReason: '甲胄边线嵌补处需再收一刀',
        woodType: '梨木',
        thicknessMm: 20,
        createdAt: '2026-03-02T10:00',
      },
      { expectedRevNo: 1, database: db },
    )

    const { listPendingRuns } = await import('../utils/batchService')
    const pending = await listPendingRuns({ database: db })
    const msRuns = pending.filter((run) => run.batchId === 'batch-ms-001')
    expect(msRuns.some((run) => run.blockId === 'block-ms-02')).toBe(true)
    // 墨线版当时已按第 2 版印，不该重复待复核。
    expect(msRuns.some((run) => run.blockId === 'block-ms-01')).toBe(false)
    // 莲鱼两个批次完全不涉及门神版片。
    expect(pending.some((run) => run.batchId.startsWith('batch-ll'))).toBe(false)
  })

  it('两个标签页同时提交同一版次，只有一个成功，败者整笔回滚', async () => {
    const db = await seededDb()
    const blockId = 'block-zw-01'

    const payload = {
      operator: '秦木生',
      repairReason: '并发改刀测试',
      woodType: '梨木',
      thicknessMm: 16,
      createdAt: '2026-03-03T11:00',
    } as const

    const [winner, loser] = await Promise.allSettled([
      appendRepairRevision(blockId, payload, { expectedRevNo: 1, database: db }),
      appendRepairRevision(blockId, { ...payload }, { expectedRevNo: 1, database: db }),
    ])

    expect(winner.status).toBe('fulfilled')
    expect(loser.status).toBe('rejected')
    const reason = loser.status === 'rejected' ? loser.reason : null
    expect(reason).toBeInstanceOf(RevisionConflictError)

    const revisions = await listRevisions(blockId, db)
    expect(revisions.map((rev) => rev.revNo)).toEqual([1, 2])
    const block = await db.blocks.get(blockId)
    expect(block?.currentRevNo).toBe(2)
    // 败者没有留下半截节点。
    const nodes = await db.nodes.where('blockId').equals(blockId).toArray()
    expect(nodes.filter((node) => node.revNo === 2).length).toBe(1)
  })
})
