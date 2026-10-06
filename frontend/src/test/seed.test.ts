import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'

describe('初始档案一致性', () => {
  it('每块版都有第 1 版且版次连续，所有印次版次不超过当前版次', async () => {
    const db = createTestDb()
    await db.open()

    const [blocks, revisions, runs] = await Promise.all([
      db.blocks.toArray(),
      db.blockRevisions.toArray(),
      db.printRuns.toArray(),
    ])

    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      const revNos = revisions.filter((rev) => rev.blockId === block.id).map((rev) => rev.revNo).sort((a, b) => a - b)
      expect(revNos[0]).toBe(1)
      for (let index = 1; index < revNos.length; index += 1) {
        expect(revNos[index]).toBe(revNos[index - 1] + 1)
      }
      expect(revNos[revNos.length - 1]).toBe(block.currentRevNo)
    }

    for (const run of runs) {
      const block = blocks.find((item) => item.id === run.blockId)
      expect(block, `印次 ${run.id} 应挂在存在的版片上`).toBeDefined()
      expect(run.revNo).toBeLessThanOrEqual(block!.currentRevNo)
      expect(run.revNo).toBeGreaterThanOrEqual(1)
    }
  })
})
