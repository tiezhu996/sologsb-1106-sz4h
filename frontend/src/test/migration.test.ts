import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../utils/db'

const dbName = `gbwoodprint-migrate-${Date.now()}`

interface LegacyShape {
  id: string
  [key: string]: unknown
}

/** 按 v2 结构造一个老库：有版片、节点、批次，但没有版次与印次。 */
async function buildLegacyV2Database(name: string): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(1).stores({
    drafts: 'id, genre, status, title',
    blocks: 'id, draftId, colorNo, carvedBy, state',
    carvers: 'id, specialty, skillLevel, name',
    batches: 'id, draftId, batchNo, printedAt',
    nodes: 'id, batchId, blockId, stage, seq, operator',
  })
  legacy.version(2).stores({
    drafts: 'id, genre, status, title, schemaRev',
    blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
    carvers: 'id, specialty, skillLevel, name, schemaRev',
    batches: 'id, draftId, batchNo, printedAt, schemaRev',
    nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
  })

  await legacy.table('blocks').bulkAdd([
    { id: 'b1', draftId: 'd1', blockName: '墨线版', colorNo: 1, woodType: '黄杨', thicknessMm: 18, carvedBy: '齐师傅', state: '已刻成', defectNote: '旧备注写过崩口修补。', schemaRev: 2 },
    { id: 'b2', draftId: 'd1', blockName: '黄版', colorNo: 2, woodType: '梨木', thicknessMm: 20, carvedBy: '周桂枝', state: '已刻成', defectNote: '', schemaRev: 2 },
  ] satisfies LegacyShape[])
  await legacy.table('drafts').bulkAdd([
    { id: 'd1', title: '老画稿', genre: '门神', designer: '佚名', sizeCm: '30 × 20 cm', paperNote: '', status: '可印', schemaRev: 2 },
  ] satisfies LegacyShape[])
  await legacy.table('nodes').bulkAdd([
    { id: 'n1', blockId: 'b1', stage: '刻版', seq: 1, operator: '齐师傅', startedAt: '2025-11-01T08:00', durationMin: 300, note: '老节点：刻版', schemaRev: 2 },
    { id: 'n2', blockId: 'b1', stage: '修版', seq: 2, operator: '秦木生', startedAt: '2025-11-03T09:00', durationMin: 60, note: '老节点：修版刀口', schemaRev: 2 },
  ] satisfies LegacyShape[])
  await legacy.table('batches').bulkAdd([
    { id: 'bt1', draftId: 'd1', batchNo: '老批-01', printedAt: '2025-12-01', paperBatch: '老纸批', inkNote: '', qty: 50, pieceCount: 2, qcNote: '旧总检原文保留。', schemaRev: 2 },
  ] satisfies LegacyShape[])
  await legacy.close()
}

describe('v2 → v3 老数据升级', () => {
  it('按现有工序节点补首个版次：来源缺失记未知，不冒充历史依据', async () => {
    const name = `${dbName}-rev`
    await buildLegacyV2Database(name)
    const db = createDatabase(name)
    await db.open()

    const block = await db.blocks.get('b1')
    expect(block?.currentRevNo).toBe(1)
    expect(block?.defectNote).toBe('旧备注写过崩口修补。')
    expect(block?.schemaRev).toBe(3)

    const revisions = await db.blockRevisions.where('blockId').anyOf('b1', 'b2').toArray()
    expect(revisions.length).toBe(2)
    for (const rev of revisions) {
      expect(rev.revNo).toBe(1)
      expect(rev.origin).toBe('unknown')
      expect(rev.operator).toBe('未知')
    }
    const b1Rev = revisions.find((rev) => rev.blockId === 'b1')
    // 首版快照保存升级当时的版片摘要。
    expect(b1Rev?.snapshot.state).toBe('已刻成')
    expect(b1Rev?.snapshot.defectNote).toBe('旧备注写过崩口修补。')
    expect(b1Rev?.createdAt).toBe('2025-11-01T08:00')

    // 旧节点留在原处，归属首版。
    const oldNodes = await db.nodes.where('blockId').equals('b1').toArray()
    expect(oldNodes.map((node) => [node.id, node.revNo]).sort()).toEqual([
      ['n1', 1],
      ['n2', 1],
    ])
  })

  it('旧批次按现有版片补推断印次并标注迁移推断，qcNote 原文不动', async () => {
    const name = `${dbName}-runs`
    await buildLegacyV2Database(name)
    const db = createDatabase(name)
    await db.open()

    const runs = await db.printRuns.where('batchId').equals('bt1').toArray()
    expect(runs.length).toBe(2)
    for (const run of runs) {
      expect(run.revNo).toBe(1)
      expect(run.origin).toBe('migrated-inferred')
      expect(run.operator).toBe('未知')
      // 逐版偏差拆不出来，留空而不是编造。
      expect(run.deviation).toBe('')
    }
    const batch = await db.batches.get('bt1')
    expect(batch?.qcNote).toBe('旧总检原文保留。')
  })
})
