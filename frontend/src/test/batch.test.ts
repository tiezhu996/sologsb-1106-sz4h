import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { appendRepairRevision } from '../utils/revisionService'
import { keepOldSample, listPendingRuns, registerBatch, reprintRun } from '../utils/batchService'

async function seededDb() {
  const db = createTestDb()
  await db.open()
  return db
}

describe('批次登记与印次', () => {
  it('登记批次逐版落印次，按各版当前版次记录原印次与套色偏差', async () => {
    const db = await seededDb()
    const { batch, runs } = await registerBatch(
      {
        draftId: 'draft-liannian-youyu',
        batchNo: '莲鱼-测试-09',
        printedAt: '2026-03-10',
        paperBatch: '绵竹-2609',
        inkNote: '按老方调色',
        qty: 100,
        pieceCount: 3,
        qcNote: '',
        operator: '当班印工',
        deviations: {
          'block-ll-01': '墨线套准',
          'block-ll-02': '黄版略浮',
        },
      },
      { database: db },
    )

    expect(runs.length).toBe(4)
    const inkRun = runs.find((run) => run.blockId === 'block-ll-01')
    expect(inkRun?.revNo).toBe(2)
    expect(inkRun?.pieceCount).toBe(3)
    expect(inkRun?.deviation).toBe('墨线套准')
    expect(inkRun?.origin).toBe('registered')
    expect(runs.every((run) => run.batchId === batch.id)).toBe(true)

    const pending = await listPendingRuns({ database: db, batchId: batch.id })
    expect(pending.length).toBe(0)
  })
})

describe('待复核与复核决策', () => {
  it('沿用旧印样：原印次与偏差保留，待复核消除', async () => {
    const db = await seededDb()
    // block-ms-02 当前 revNo=1，试印印次也是 revNo=1；追加第 2 版后进入待复核。
    await appendRepairRevision(
      'block-ms-02',
      { operator: '秦木生', repairReason: '边线再收一刀', woodType: '梨木', thicknessMm: 20, createdAt: '2026-03-02T10:00' },
      { expectedRevNo: 1, database: db },
    )

    let pending = await listPendingRuns({ database: db })
    const target = pending.find((run) => run.batchId === 'batch-ms-001' && run.blockId === 'block-ms-02')
    expect(target).toBeDefined()
    expect(target?.revNo).toBe(1)
    expect(target?.currentRevNo).toBe(2)

    const originalDeviation = target!.deviation
    await keepOldSample(target!.id, { operator: '管事', note: '旧样刀口与新版一致，可沿用' }, { database: db })

    pending = await listPendingRuns({ database: db })
    expect(pending.some((run) => run.id === target!.id)).toBe(false)

    const originalRun = await db.printRuns.get(target!.id)
    expect(originalRun?.deviation).toBe(originalDeviation)
    expect(originalRun?.revNo).toBe(1)
  })

  it('按新刀口重打：结果另存，原印次、原印次数量与套色偏差都保留', async () => {
    const db = await seededDb()
    await appendRepairRevision(
      'block-ms-02',
      { operator: '秦木生', repairReason: '边线再收一刀', woodType: '梨木', thicknessMm: 20, createdAt: '2026-03-02T10:00' },
      { expectedRevNo: 1, database: db },
    )

    const pending = await listPendingRuns({ database: db })
    const target = pending.find((run) => run.batchId === 'batch-ms-001' && run.blockId === 'block-ms-02')!
    const { reprint, review } = await reprintRun(
      target.id,
      { operator: '印工甲', deviation: '重打后套准，偏差不足半线', pieceCount: 2, printedAt: '2026-03-05' },
      { database: db },
    )

    expect(reprint.revNo).toBe(2)
    expect(reprint.reprintOf).toBe(target.id)
    expect(reprint.pieceCount).toBe(2)
    expect(reprint.deviation).toBe('重打后套准，偏差不足半线')

    const original = await db.printRuns.get(target.id)
    expect(original?.supersededBy).toBe(reprint.id)
    expect(original?.deviation).toBe(target.deviation)
    expect(original?.pieceCount).toBe(target.pieceCount)
    expect(original?.revNo).toBe(1)

    expect(review.decision).toBe('reprint')
    expect(review.reprintRunId).toBe(reprint.id)
    expect(review.revNo).toBe(2)

    const stillPending = await listPendingRuns({ database: db })
    expect(stillPending.some((run) => run.id === target.id)).toBe(false)
  })

  it('再次改刀后，已按旧版复核过的老批次重新进入待复核', async () => {
    const db = await seededDb()
    // 第一次补刀到第 2 版，并沿用旧样完成复核。
    await appendRepairRevision(
      'block-ms-02',
      { operator: '秦木生', repairReason: '第一次补刀', woodType: '梨木', thicknessMm: 20, createdAt: '2026-03-02T10:00' },
      { expectedRevNo: 1, database: db },
    )
    let pending = await listPendingRuns({ database: db })
    const target = pending.find((run) => run.batchId === 'batch-ms-001' && run.blockId === 'block-ms-02')!
    await keepOldSample(target.id, { operator: '管事' }, { database: db })
    expect((await listPendingRuns({ database: db })).length).toBe(0)

    // 第二次补刀到第 3 版：旧复核只认第 2 版，老印次重新待复核。
    const block = await db.blocks.get('block-ms-02')
    await appendRepairRevision(
      'block-ms-02',
      { operator: '秦木生', repairReason: '第二次补刀', woodType: '梨木', thicknessMm: 20, createdAt: '2026-03-06T10:00' },
      { expectedRevNo: block!.currentRevNo, database: db },
    )
    pending = await listPendingRuns({ database: db })
    expect(pending.some((run) => run.batchId === 'batch-ms-001' && run.blockId === 'block-ms-02')).toBe(true)
  })
})
