import { writable } from 'svelte/store'
import type { BlockRevision } from '../types/revision'
import { db } from '../utils/db'

/** 版次档案只追加；store 缓存只读视图，所有写入走 services/ledger 的事务 */
const revisionList = writable<BlockRevision[]>([])

async function load(): Promise<void> {
  const records = await db.revisions.toArray()
  records.sort((a, b) => a.blockId.localeCompare(b.blockId) || a.revisionNo - b.revisionNo)
  revisionList.set(records)
}

export const revisionStore = {
  subscribe: revisionList.subscribe,
  load,
}
