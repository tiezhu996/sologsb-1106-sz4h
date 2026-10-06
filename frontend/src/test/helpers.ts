import 'fake-indexeddb/auto'
import { createDatabase, type WoodprintDatabase } from '../../src/utils/db'

let databaseCounter = 0

/** 每个用例独立的 IndexedDB 库名，结构与数据互不串扰。 */
export function createTestDb(): WoodprintDatabase {
  databaseCounter += 1
  return createDatabase(`gbwoodprint-test-${Date.now()}-${databaseCounter}`)
}
