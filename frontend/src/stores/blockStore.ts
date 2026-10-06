import { derived, writable } from 'svelte/store'
import type { Block, BlockName, BlockState, WoodType } from '../types/block'
import type { BlockRevision } from '../types/revision'
import { db } from '../utils/db'

const blockList = writable<Block[]>([])

export interface DraftBlockStats {
  total: number
  carved: number
  rate: number
}

const statsByDraft = derived(blockList, ($blocks) => {
  const stats: Record<string, DraftBlockStats> = {}
  for (const block of $blocks) {
    const current = stats[block.draftId] ?? { total: 0, carved: 0, rate: 0 }
    current.total += 1
    if (block.state === '已刻成' || block.state === '已修版') current.carved += 1
    current.rate = current.total === 0 ? 0 : Math.round((current.carved / current.total) * 100)
    stats[block.draftId] = current
  }
  return stats
})

async function load(): Promise<void> {
  const records = await db.blocks.toArray()
  records.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.colorNo - b.colorNo)
  blockList.set(records)
}

/** 新建一块待刻版，并同时建立它的首个版次（首刻建档）。 */
async function createWithInitialRevision(input: {
  draftId: string
  blockName: BlockName
  colorNo: number
  woodType: WoodType
  thicknessMm: number
}): Promise<string> {
  const id = `block-${crypto.randomUUID()}`
  const block: Block = {
    id,
    draftId: input.draftId,
    blockName: input.blockName,
    colorNo: input.colorNo,
    woodType: input.woodType,
    thicknessMm: input.thicknessMm,
    carvedBy: '',
    state: '待刻',
    defectNote: '',
    currentRevNo: 1,
  }
  const revision: BlockRevision = {
    id: `rev-${crypto.randomUUID()}`,
    blockId: id,
    revNo: 1,
    origin: 'initial',
    operator: '未知',
    createdAt: '',
    note: '首刻建档。',
    repairReason: '',
    woodReplaced: false,
    previousWoodType: null,
    snapshot: {
      blockName: block.blockName,
      colorNo: block.colorNo,
      woodType: block.woodType,
      thicknessMm: block.thicknessMm,
      carvedBy: '',
      state: '待刻',
      defectNote: '',
    },
  }
  await db.transaction('rw', db.blocks, db.blockRevisions, async () => {
    await db.blocks.add(block)
    await db.blockRevisions.add(revision)
  })
  await load()
  return id
}

async function update(id: string, changes: Partial<Omit<Block, 'id'>>): Promise<void> {
  await db.blocks.update(id, changes)
  await load()
}

async function reorder(ordered: Array<Pick<Block, 'id' | 'colorNo'>>): Promise<void> {
  await db.transaction('rw', db.blocks, async () => {
    for (const item of ordered) {
      await db.blocks.update(item.id, { colorNo: item.colorNo })
    }
  })
  await load()
}

async function removeByDraft(draftId: string): Promise<void> {
  await db.blocks.where('draftId').equals(draftId).delete()
  await load()
}

export const blockStore = {
  subscribe: blockList.subscribe,
  statsByDraft,
  load,
  createWithInitialRevision,
  update,
  reorder,
  removeByDraft,
}
