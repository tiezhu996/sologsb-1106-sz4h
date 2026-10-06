import Dexie, { type Table } from 'dexie'
import type { Draft } from '../types/draft'
import type { Block } from '../types/block'
import type { Carver } from '../types/carver'
import type { PrintBatch } from '../types/batch'
import type { ProcessNode } from '../types/node'
import type { BlockRevision } from '../types/revision'
import type { BatchImpression } from '../types/impression'
import type { BatchReview, RestrikeResult } from '../types/review'
import { SCHEMA_REVISION, buildBlockHistory, buildImpressionsForBatch } from './archive'
import { buildSeedArchive } from './seed'

type StoredRecord = Record<string, unknown> & { schemaRev?: number }

class WoodprintDatabase extends Dexie {
  drafts!: Table<Draft, string>
  blocks!: Table<Block, string>
  carvers!: Table<Carver, string>
  batches!: Table<PrintBatch, string>
  nodes!: Table<ProcessNode, string>
  revisions!: Table<BlockRevision, string>
  impressions!: Table<BatchImpression, string>
  reviews!: Table<BatchReview, string>
  restrikes!: Table<RestrikeResult, string>

  constructor() {
    super('gbwoodprint-db')

    this.version(1).stores({
      drafts: 'id, genre, status, title',
      blocks: 'id, draftId, colorNo, carvedBy, state',
      carvers: 'id, specialty, skillLevel, name',
      batches: 'id, draftId, batchNo, printedAt',
      nodes: 'id, batchId, blockId, stage, seq, operator',
    })

    this.version(2)
      .stores({
        drafts: 'id, genre, status, title, schemaRev',
        blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
        carvers: 'id, specialty, skillLevel, name, schemaRev',
        batches: 'id, draftId, batchNo, printedAt, schemaRev',
        nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
      })
      .upgrade(async (transaction) => {
        const tableNames = ['drafts', 'blocks', 'carvers', 'batches', 'nodes'] as const
        for (const tableName of tableNames) {
          await transaction.table(tableName).toCollection().modify((record: StoredRecord) => {
            record.schemaRev = 2
          })
        }
      })

    // v3：追加式版次。revisions / impressions / reviews / restrikes 只追加不覆盖；
    // revKey、impKey、reviewKey 的唯一索引保证并发提交只有一笔成功。
    this.version(3)
      .stores({
        drafts: 'id, genre, status, title, schemaRev',
        blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
        carvers: 'id, specialty, skillLevel, name, schemaRev',
        batches: 'id, draftId, batchNo, printedAt, schemaRev',
        nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
        revisions: 'id, revKey, blockId, revisionNo, originNodeId',
        impressions: 'id, impKey, batchId, draftId, blockId, revisionNo',
        reviews: 'id, reviewKey, batchId, blockId, reviewedRevisionNo',
        restrikes: 'id, reviewId, batchId, blockId, revisionNo',
      })
      .upgrade(async (transaction) => {
        const revisionsTable = transaction.table<BlockRevision, string>('revisions')
        const impressionsTable = transaction.table<BatchImpression, string>('impressions')
        const blocksTable = transaction.table<Block & StoredRecord, string>('blocks')
        const nodesTable = transaction.table<ProcessNode & StoredRecord, string>('nodes')
        const batchesTable = transaction.table<PrintBatch & StoredRecord, string>('batches')

        const legacyBlocks = await blocksTable.toArray()
        const legacyNodes = await nodesTable.toArray()
        const legacyBatches = await batchesTable.toArray()

        const revisionsToAdd: BlockRevision[] = []
        const stampedCurrent = new Map<string, number>()

        for (const storedBlock of legacyBlocks) {
          const block: Block = {
            id: storedBlock.id,
            draftId: storedBlock.draftId,
            blockName: storedBlock.blockName,
            colorNo: storedBlock.colorNo,
            woodType: storedBlock.woodType,
            thicknessMm: storedBlock.thicknessMm,
            carvedBy: storedBlock.carvedBy,
            state: storedBlock.state,
            defectNote: storedBlock.defectNote ?? '',
            currentRevisionNo: 1,
          }
          const blockNodes = legacyNodes.filter((node) => node.blockId === block.id)
          const history = buildBlockHistory(block, blockNodes, {
            idPrefix: `rev-mig-${block.id}`,
          })
          revisionsToAdd.push(...history.revisions)
          stampedCurrent.set(block.id, history.currentRevisionNo)

          await blocksTable.update(block.id, {
            currentRevisionNo: history.currentRevisionNo,
            schemaRev: SCHEMA_REVISION,
          } as Partial<Block & StoredRecord>)

          // 旧节点留在原处，仅补所属版次号；判定不出的保持 null，不硬编历史。
          for (const node of blockNodes) {
            const revisionNo = history.nodeRevisionNos.get(node.id) ?? null
            if (revisionNo !== null) {
              await nodesTable.update(node.id, { revisionNo, schemaRev: SCHEMA_REVISION } as Partial<ProcessNode & StoredRecord>)
            }
          }
        }

        // 没有归属到任何块的节点（含 batchId 节点）也统一抬到新结构版本
        const touchedNodeIds = new Set(legacyNodes.filter((node) => node.blockId).map((node) => node.id))
        for (const node of legacyNodes) {
          if (!touchedNodeIds.has(node.id)) {
            await nodesTable.update(node.id, { schemaRev: SCHEMA_REVISION } as Partial<ProcessNode & StoredRecord>)
          }
        }

        if (revisionsToAdd.length > 0) await revisionsTable.bulkAdd(revisionsToAdd)

        const revisionsByBlock = new Map<string, BlockRevision[]>()
        for (const revision of revisionsToAdd) {
          const list = revisionsByBlock.get(revision.blockId) ?? []
          list.push(revision)
          revisionsByBlock.set(revision.blockId, list)
        }

        const normalizedBlocks: Block[] = legacyBlocks.map((stored) => ({
          id: stored.id,
          draftId: stored.draftId,
          blockName: stored.blockName,
          colorNo: stored.colorNo,
          woodType: stored.woodType,
          thicknessMm: stored.thicknessMm,
          carvedBy: stored.carvedBy,
          state: stored.state,
          defectNote: stored.defectNote ?? '',
          currentRevisionNo: stampedCurrent.get(stored.id) ?? 1,
        }))

        const impressionsToAdd: BatchImpression[] = []
        for (const batch of legacyBatches) {
          await batchesTable.update(batch.id, { schemaRev: SCHEMA_REVISION } as Partial<PrintBatch & StoredRecord>)
          impressionsToAdd.push(
            ...buildImpressionsForBatch(batch, normalizedBlocks, revisionsByBlock, {
              idPrefix: `imp-mig-${batch.id}`,
            }),
          )
        }
        if (impressionsToAdd.length > 0) await impressionsTable.bulkAdd(impressionsToAdd)

        for (const tableName of ['drafts', 'carvers'] as const) {
          await transaction.table(tableName).toCollection().modify((record: StoredRecord) => {
            record.schemaRev = SCHEMA_REVISION
          })
        }
      })
  }
}

export const db = new WoodprintDatabase()

db.on('populate', () => {
  const seed = buildSeedArchive()
  return Promise.all([
    db.drafts.bulkAdd(seed.drafts),
    db.blocks.bulkAdd(seed.blocks),
    db.carvers.bulkAdd(seed.carvers),
    db.batches.bulkAdd(seed.batches),
    db.nodes.bulkAdd(seed.nodes),
    db.revisions.bulkAdd(seed.revisions),
    db.impressions.bulkAdd(seed.impressions),
  ])
})

export async function initializeDatabase(): Promise<void> {
  await db.open()
  const draftCount = await db.drafts.count()
  if (draftCount > 0) return

  // 空库兜底（populate 未触发时）：整笔写入，失败整体回滚，重开仍可继续。
  const seed = buildSeedArchive()
  await db.transaction(
    'rw',
    [db.drafts, db.blocks, db.carvers, db.batches, db.nodes, db.revisions, db.impressions],
    async () => {
      await Promise.all([
        db.drafts.bulkPut(seed.drafts),
        db.blocks.bulkPut(seed.blocks),
        db.carvers.bulkPut(seed.carvers),
        db.batches.bulkPut(seed.batches),
        db.nodes.bulkPut(seed.nodes),
        db.revisions.bulkPut(seed.revisions),
        db.impressions.bulkPut(seed.impressions),
      ])
    },
  )
}

export type { WoodprintDatabase }
