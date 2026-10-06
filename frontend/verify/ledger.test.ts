/**
 * 数据层验证（node --import tsx）：
 * 覆盖 种子版次链 / 待复核派生 / 追加版次 / 复核沿用与重打 /
 * 并发唯一约束 / 事务回滚。
 * 运行：node --import tsx --import ./verify/preload.ts verify/ledger.test.ts
 */
import assert from 'node:assert/strict'

const DB_NAME = 'gbwoodprint-db'

async function freshModules() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('删库被阻塞'))
  })
  const stamp = `${Date.now()}-${Math.random()}`
  const dbMod = await import(`../src/utils/db.ts?v=${stamp}`)
  const ledger = await import(`../src/services/ledger.ts?v=${stamp}`)
  const archive = await import(`../src/utils/archive.ts?v=${stamp}`)
  await dbMod.initializeDatabase()
  return { db: dbMod.db, ledger, archive }
}

let passed = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  // 1. 种子：版次链按修版节点回溯
  {
    const { db } = await freshModules()
    const msRevs = await db.revisions.where('blockId').equals('block-ms-01').toArray()
    msRevs.sort((a, b) => a.revisionNo - b.revisionNo)
    ok('门神墨线版按修版节点补出2个版次', msRevs.length === 2)
    ok('首版来源为工序节点', msRevs[0].origin === '工序节点' && msRevs[0].originNodeId === 'node-ms-01')
    ok('第2版次为返修且原因取自节点', msRevs[1].kind === '返修' && msRevs[1].reason.includes('胡须'))
    ok('返修换木料旧档无依据记未知', msRevs[1].replacedWood === '未知')
    ok('首版摘要未被后来的修补崩口回写', msRevs[0].snapshot.defectNote === '')
    ok('返修摘要保留当时崩口留痕', msRevs[1].snapshot.defectNote.includes('胡须末梢修补'))

    // 待刻版无节点：首版来源必须是迁移未知，不冒充历史
    const waiting = await db.revisions.where('blockId').equals('block-ms-03').toArray()
    ok('无节点版首版来源为迁移未知', waiting.length === 1 && waiting[0].origin === '迁移未知')
    ok('无节点版首版原因标注未知保留', waiting[0].reason.includes('未知'))

    const block = await db.blocks.get('block-ms-01')
    ok('版片当前版次号=2', block.currentRevisionNo === 2)

    // 旧节点留在原处并被打上所属版次
    const node5 = await db.nodes.get('node-ms-05')
    const node4 = await db.nodes.get('node-ms-04')
    ok('修版节点归属第2版次', node5.revisionNo === 2)
    ok('修版前节点归属第1版次', node4.revisionNo === 1)
    await db.close()
  }

  // 2. 印次关联：批次冻结版次号与偏差
  {
    const { db } = await freshModules()
    const imps = await db.impressions.where('batchId').equals('batch-ll-001').toArray()
    const ll01 = imps.find((i) => i.blockId === 'block-ll-01')!
    ok('旧批次印次关联来源为迁移未知', ll01.source === '迁移未知')
    ok('旧批次印次按日期推断为第2版次（返修在2025-12）', ll01.revisionNo === 2)
    ok('旧批次套色偏差从总检文本切出', ll01.deviation === '线条饱满')
    ok('旧批次印次保留原印次', ll01.pieceCount === 4)
    await db.close()
  }

  // 3. 追加返修版次 → 已登记批次进入待复核；没碰到的不受影响
  {
    const { db, ledger, archive } = await freshModules()
    await ledger.appendRepairRevision({
      blockId: 'block-ms-03',
      expectedRevisionNo: 2,
      reason: '红料口崩裂重刻',
      replacedWood: '梨木',
      operator: '秦木生',
    })
    const blocks = await db.blocks.toArray()
    const impressions = await db.impressions.toArray()
    const reviews = await db.reviews.toArray()
    const restrikes = await db.restrikes.toArray()
    const currentMap = new Map(blocks.map((b) => [b.id, b.currentRevisionNo]))

    const msState = archive.deriveBatchReviewState('batch-ms-001', blocks, currentMap, impressions, reviews, restrikes)
    ok('门神批次有同画稿全部4块印次（升级按画稿补）', msState.impressions.length === 4)
    const pendingRed = msState.pending.find((p) => p.blockId === 'block-ms-03')
    ok('碰到红版返修→门神批待复核含红版', !!pendingRed && pendingRed.currentRevisionNo === 2)
    const llState = archive.deriveBatchReviewState('batch-ll-001', blocks, currentMap, impressions, reviews, restrikes)
    ok('莲鱼批次未受门神返修影响', llState.pending.length === 0)

    // 工序节点同事务留下
    const redNodes = await db.nodes.where('blockId').equals('block-ms-03').toArray()
    ok('返修同时写入挂第2版次的修版节点', redNodes.some((n) => n.stage === '修版' && n.revisionNo === 2 && n.note.includes('崩裂')))
    const redBlock = await db.blocks.get('block-ms-03')
    ok('版片当前版次推进到2、状态已修版', redBlock.currentRevisionNo === 2 && redBlock.state === '已修版')

    // 重开后仍能继续：再认领略号成功
    await ledger.appendRepairRevision({ blockId: 'block-ms-03', expectedRevisionNo: 3, reason: '再修', replacedWood: '未知', operator: '秦木生' })
    const after = await db.blocks.get('block-ms-03')
    ok('重开后认领下一版次仍可继续', after.currentRevisionNo === 3)
    await db.close()
  }

  // 4. 复核：沿用旧印样；按新刀口重打另存且保留原印次
  {
    const { db, ledger, archive } = await freshModules()
    await ledger.appendRepairRevision({ blockId: 'block-ms-02', expectedRevisionNo: 2, reason: '甲胄边线改刀', replacedWood: '未换料', operator: '秦木生' })

    await ledger.submitBatchReview({
      batchId: 'batch-ms-001',
      operator: '管事',
      note: '黄版重打，其余放行',
      keepBlockIds: ['block-ms-01', 'block-ms-03', 'block-ms-04'],
      restrikes: {
        'block-ms-02': { restrikeNo: 3, pieceCount: 2, deviation: '走版已消', note: '' },
      },
    })

    const restrikes = await db.restrikes.where('batchId').equals('batch-ms-001').toArray()
    ok('重打结果另存一条', restrikes.length === 1)
    ok('重打挂在新版次刀口上', restrikes[0].revisionNo === 2 && restrikes[0].restrikeNo === 3)
    ok('重打新偏差单独保存', restrikes[0].deviation === '走版已消')

    // 原印次未被覆盖
    const imps = await db.impressions.where('batchId').equals('batch-ms-001').toArray()
    const yellow = imps.find((i) => i.blockId === 'block-ms-02')!
    ok('原印次与原偏差保留不动', yellow.pieceCount === 2 && yellow.deviation.includes('走版'))

    // 复核后不再待复核
    const blocks = await db.blocks.toArray()
    const currentMap = new Map(blocks.map((b) => [b.id, b.currentRevisionNo]))
    const state = archive.deriveBatchReviewState('batch-ms-001', blocks, currentMap, imps, await db.reviews.toArray(), restrikes)
    ok('复核后批次解除待复核', state.pending.length === 0)

    // 再来一次返修 → 已复核批次重新进入待复核（只对新产生的版次）
    await ledger.appendRepairRevision({ blockId: 'block-ms-02', expectedRevisionNo: 3, reason: '二次顺线', replacedWood: '未知', operator: '秦木生' })
    const blocks2 = await db.blocks.toArray()
    const map2 = new Map(blocks2.map((b) => [b.id, b.currentRevisionNo]))
    const state2 = archive.deriveBatchReviewState('batch-ms-001', blocks2, map2, imps, await db.reviews.toArray(), await db.restrikes.toArray())
    ok('再次返修只就第3版次待复核', state2.pending.length === 1 && state2.pending[0].blockId === 'block-ms-02' && state2.pending[0].currentRevisionNo === 3)
    await db.close()
  }

  // 5. 并发：两个标签页同时追加同一版次，只有一个成功
  {
    const { db, ledger } = await freshModules()
    const [a, b] = await Promise.allSettled([
      ledger.appendRepairRevision({ blockId: 'block-ms-04', expectedRevisionNo: 2, reason: '改刀A', replacedWood: '未换料', operator: '甲' }),
      ledger.appendRepairRevision({ blockId: 'block-ms-04', expectedRevisionNo: 2, reason: '改刀B', replacedWood: '未换料', operator: '乙' }),
    ])
    ok('并发两笔恰有一笔成功', (a.status === 'fulfilled') !== (b.status === 'fulfilled'))
    const loser = a.status === 'rejected' ? a : b
    ok('失败笔为版次冲突语义错误', loser.reason?.name === 'RevisionConflictError')
    const revs = await db.revisions.where('blockId').equals('block-ms-04').toArray()
    ok('只落下一个返修版次（第2版）', revs.length === 2 && revs.some((r) => r.revisionNo === 2))
    const nodes = await db.nodes.where('blockId').equals('block-ms-04').toArray()
    ok('失败笔的修版节点也随事务回滚', nodes.filter((n) => n.stage === '修版').length === 1)
    await db.close()
  }

  // 6. 复核并发：同一版次的复核只有一笔成功
  {
    const { db, ledger } = await freshModules()
    await ledger.appendRepairRevision({ blockId: 'block-ms-02', expectedRevisionNo: 2, reason: '改刀', replacedWood: '未换料', operator: '秦木生' })
    const payload = {
      batchId: 'batch-ms-001',
      operator: '管事',
      note: '',
      keepBlockIds: ['block-ms-01', 'block-ms-02', 'block-ms-03', 'block-ms-04'],
      restrikes: {},
    }
    const [a, b] = await Promise.allSettled([ledger.submitBatchReview(payload), ledger.submitBatchReview(payload)])
    ok('复核并发恰有一笔成功', (a.status === 'fulfilled') !== (b.status === 'fulfilled'))
    const reviews = await db.reviews.where('batchId').equals('batch-ms-001').toArray()
    ok('同版次复核只存一组', reviews.length === 4)
    await db.close()
  }

  // 7. 事务回滚：复核校验失败时不留半截数据
  {
    const { db, ledger } = await freshModules()
    await ledger.appendRepairRevision({ blockId: 'block-ms-02', expectedRevisionNo: 2, reason: '改刀', replacedWood: '未换料', operator: '秦木生' })
    const beforeReviews = await db.reviews.count()
    await assert.rejects(
      ledger.submitBatchReview({
        batchId: 'batch-ms-001',
        operator: '管事',
        note: '',
        keepBlockIds: [],
        restrikes: {},
      }),
      /没有可提交的复核项/,
    )
    ok('空复核被拒绝且无写入', (await db.reviews.count()) === beforeReviews)

    // 版次号跳号认领被拒，不写入
    const beforeRevs = await db.revisions.where('blockId').equals('block-ms-02').count()
    await assert.rejects(
      ledger.appendRepairRevision({ blockId: 'block-ms-02', expectedRevisionNo: 9, reason: '跳号', replacedWood: '未换料', operator: '秦木生' }),
      /对不上/,
    )
    ok('跳号版次被拒且无写入', (await db.revisions.where('blockId').equals('block-ms-02').count()) === beforeRevs)
    await db.close()
  }

  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
