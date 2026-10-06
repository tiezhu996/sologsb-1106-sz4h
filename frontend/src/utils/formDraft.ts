/**
 * 表单草稿暂存：返修、重打这类多字段单据在提交失败或关掉标签页后，
 * 重新打开仍能接着填。草稿只存 localStorage，提交成功即清。
 */
const STORAGE_PREFIX = 'gbwoodprint-draft:'

export function saveDraft<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify({ savedAt: new Date().toISOString(), value }))
  } catch {
    // 隐私模式或配额不足时静默降级，不影响主流程。
  }
}

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { value?: T }
    return parsed.value ?? null
  } catch {
    return null
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${key}`)
  } catch {
    // ignore
  }
}
