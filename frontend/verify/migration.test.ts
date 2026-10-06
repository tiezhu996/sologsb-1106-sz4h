/**
 * v2 → v3 旧数据升级验证。
 * 先按旧结构造一个 v2 库（无 currentRevisionNo / 无版次表 / 节点无 revisionNo），
 * 再用正式 db.ts 打开触发 upgrade，逐项核对。
 */
import assert from 'node:assert/strict'
import Dexie from 'dexie'

const DB_NAME = 'gbwoodprint-db'

async function main() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })

  // —— 造旧库（v2 结构 + 旧形状数据）——
  const legacy = new Dexie(DB_NAME)
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

  await legacy.table('drafts').bulkAdd([
    { id: 'd1', title: '旧年画', genre: '门神', designer: '老画师', sizeCm: '10 × 10 cm', paperNote: '', status: '可印', schemaRev: 2 },
  ])
  await legacy.table('blocks').bulkAdd([
    // 有完整节点链含修版
    { id: 'b1', draftId: 'd1', blockName: '墨线版', colorNo: 1, woodType: '黄杨', thicknessMm: 18, carvedBy: '甲', state: '已修版', defectNote: '后补的崩口说明', schemaRev: 2 },
    // 完全没有节点（来源缺失）
    { id: 'b2', draftId: 'd1', blockName: '黄版', colorNo: 2, woodType: '梨木', thicknessMm: 20, carvedBy: '乙', state: '待刻', defectNote: '', schemaRev: 2 },
  ])
  await legacy.table('batches').bulkAdd([
    { id: 'bt1', draftId: 'd1', batchNo: '旧批-1', printedAt: '2026-03-01', paperBatch: '纸-1', inkNote: '', qty: 50, pieceCount: 2, qcNote: '墨线版：旧偏差；黄版：偏黄', schemaRev: 2 },
  ])
  await legacy.table('nodes').bulkAdd([
    { id: 'n1', blockId: 'b1', stage: '刻版', seq: 1, operator: '甲', startedAt: '2026-01-01T08:00', durationMin: 100, note: '初刻', schemaRev: 2 },
    { id: 'n2', blockId: 'b1', stage: '修版', seq: 2, operator: '丙', startedAt: '2026-02-01T08:00', durationMin: 40, note: '刀口修补原因', schemaRev: 2 },
  ])
  await legacy.close()

  // —— 正式代码打开，触发 v3 升级 ——
  const stamp = `${Date.now()}-${Math.random()}`
  const dbMod = await import(`../src/utils/db.ts?v=${stamp}`)
  await dbMod.initializeDatabase()
  const db = dbMod.db

  let passed = 0
  const ok = (name: string, cond: boolean) => {
    assert.ok(cond, name)
    passed += 1
    console.log(`  ✓ ${name}`)
  }

  const b1 = await db.blocks.get('b1')
  const b2 = await db.blocks.get('b2')
  ok('有修版节点的版补到第2版次', b1.currentRevisionNo === 2)
  ok('无节点版补首个版次', b2.currentRevisionNo === 1)
  ok('版片结构版本抬到3', b1.schemaRev === 3 && b2.schemaRev === 3)

  const revs1 = await db.revisions.where('blockId').equals('b1').toArray()
  revs1.sort((a, b) => a.revisionNo - b.revisionNo)
  ok('b1 补出首版+返修两条版次', revs1.length === 2)
  ok('首版锚定最早节点来源', revs1[0].origin === '工序节点' && revs1[0].originNodeId === 'n1')
  ok('返修版次原因取自修版节点', revs1[1].reason === '刀口修补原因' && revs1[1].originNodeId === 'n2')
  ok('返修换木料无依据记未知', revs1[1].replacedWood === '未知')
  ok('首版摘要冻结为修补前状态（不被后补崩口覆盖）', revs1[0].snapshot.defectNote === '')

  const revs2 = await db.revisions.where('blockId').equals('b2').toArray()
  ok('无节点版首版来源按未知保留、不冒充', revs2.length === 1 && revs2[0].origin === '迁移未知' && revs2[0].originNodeId === null)
  ok('未知首版时间留空不编造', revs2[0].createdAt === '')

  // 旧节点留在原处
  const n1 = await db.nodes.get('n1')
  const n2 = await db.nodes.get('n2')
  ok('旧节点记录未改动（原因/人/时间保留）', n1.note === '初刻' && n2.operator === '丙')
  ok('旧节点补所属版次号', n1.revisionNo === 1 && n2.revisionNo === 2)
  ok('旧节点结构版本抬到3', n1.schemaRev === 3)

  // 旧批次补印次关联
  const imps = await db.impressions.where('batchId').equals('bt1').toArray()
  imps.sort((a, b) => a.blockId.localeCompare(b.blockId))
  ok('旧批次按同画稿版片补2条印次', imps.length === 2)
  ok('印次来源标迁移未知', imps.every((i) => i.source === '迁移未知'))
  const impB1 = imps.find((i) => i.blockId === 'b1')!
  const impB2 = imps.find((i) => i.blockId === 'b2')!
  ok('印次按印制日期推断版次：b1 用第2版（2月已返修）', impB1.revisionNo === 2)
  ok('印次按印制日期推断版次：b2 用第1版', impB2.revisionNo === 1)
  ok('旧偏差逐版切出保留', impB1.deviation === '旧偏差' && impB2.deviation === '偏黄')
  ok('原印次保留', impB1.pieceCount === 2)

  // 复核/重打表存在但为空
  ok('升级不产生任何复核记录', (await db.reviews.count()) === 0)
  ok('升级不产生任何重打记录', (await db.restrikes.count()) === 0)

  // 旧批次本体未被改写
  const bt1 = await db.batches.get('bt1')
  ok('旧批次本体原样保留', bt1.qcNote === '墨线版：旧偏差；黄版：偏黄' && bt1.schemaRev === 3)

  await db.close()
  console.log(`\n迁移验证全部 ${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
