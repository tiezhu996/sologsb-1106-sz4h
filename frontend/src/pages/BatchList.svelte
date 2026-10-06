<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import { keepOldSample, listPendingRuns, registerBatch, reprintRun, type PendingRun } from '../utils/batchService'
  import { clearDraft, loadDraft, saveDraft } from '../utils/formDraft'
  import type { PrintBatch, PrintRun } from '../types/batch'

  let batches = $state<PrintBatch[]>([])
  let runs = $state<PrintRun[]>([])
  let pendingRuns = $state<PendingRun[]>([])
  let showForm = $state(false)
  let draftId = $state('')
  let batchNo = $state('')
  let printedAt = $state(new Date().toISOString().slice(0, 10))
  let paperBatch = $state('')
  let inkNote = $state('')
  let qty = $state(100)
  let pieceCount = $state(4)
  let qcNote = $state('')
  let deviations = $state<Record<string, string>>({})
  let formMessage = $state('')

  // 复核单
  let reviewRunId = $state<string | null>(null)
  let reviewOperator = $state('')
  let reviewMode = $state<'keep-sample' | 'reprint'>('keep-sample')
  let reviewNote = $state('')
  let reprintPieceCount = $state(0)
  let reprintDeviation = $state('')
  let reprintAt = $state(new Date().toISOString().slice(0, 10))
  let reviewSaving = $state(false)
  let reviewError = $state('')

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? [...$blockStore].filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  const reviewRun = $derived(pendingRuns.find((run) => run.id === reviewRunId) ?? null)

  function reviewDraftKeyFor(runId: string | null): string {
    return runId ? `review:${runId}` : ''
  }

  const pendingBatchIds = $derived(new Set(pendingRuns.map((run) => run.batchId)))
  const pendingCountByBatch = $derived.by(() => {
    const counts: Record<string, number> = {}
    for (const run of pendingRuns) counts[run.batchId] = (counts[run.batchId] ?? 0) + 1
    return counts
  })

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), refreshAll()])
  })

  async function refreshBatches(): Promise<void> {
    const records = await db.batches.toArray()
    records.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
    batches = records
    runs = await db.printRuns.toArray()
  }

  async function refreshPending(): Promise<void> {
    pendingRuns = await listPendingRuns()
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshBatches(), refreshPending()])
  }

  function openForm(): void {
    showForm = true
    formMessage = ''
    if (!draftId) {
      const firstDraft = $draftStore[0]
      if (firstDraft) selectDraft(firstDraft.id)
    }
  }

  function selectDraft(nextId: string): void {
    draftId = nextId
    deviations = {}
    const target = $draftStore.find((draft) => draft.id === nextId)
    if (target) batchNo = `${target.title}-${new Date().getFullYear()}-01`
  }

  function draftTitle(targetId: string): string {
    return $draftStore.find((draft) => draft.id === targetId)?.title ?? '未知画稿'
  }

  async function submitBatch(): Promise<void> {
    if (!draftId || !batchNo.trim() || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      formMessage = '请选择画稿，并补全批次号、纸张批号和印数。'
      return
    }

    await registerBatch({
      draftId,
      batchNo: batchNo.trim(),
      printedAt,
      paperBatch: paperBatch.trim(),
      inkNote: inkNote.trim() || '颜料与胶量待续记',
      qty: Number(qty),
      pieceCount: Number(pieceCount),
      qcNote: qcNote.trim(),
      deviations,
    })

    await refreshAll()
    showForm = false
    batchNo = ''
    paperBatch = ''
    inkNote = ''
    qty = 100
    pieceCount = 4
    qcNote = ''
    deviations = {}
    formMessage = ''
  }

  function runsOfBatch(batchId: string): PrintRun[] {
    return runs
      .filter((run) => run.batchId === batchId)
      .sort((a, b) => a.colorNo - b.colorNo || a.revNo - b.revNo || a.printedAt.localeCompare(b.printedAt))
  }

  function persistReviewDraft(): void {
    const key = reviewDraftKeyFor(reviewRunId)
    if (!key) return
    saveDraft(key, {
      operator: reviewOperator,
      mode: reviewMode,
      note: reviewNote,
      pieceCount: reprintPieceCount,
      deviation: reprintDeviation,
      printedAt: reprintAt,
    })
  }

  function openReview(run: PendingRun): void {
    reviewRunId = run.id
    reviewError = ''
    const key = reviewDraftKeyFor(run.id)
    const saved = key
      ? loadDraft<{
          operator: string
          mode: 'keep-sample' | 'reprint'
          note: string
          pieceCount: number
          deviation: string
          printedAt: string
        }>(key)
      : null
    reviewOperator = saved?.operator ?? (run.operator !== '未知' ? run.operator : '')
    reviewMode = saved?.mode ?? 'keep-sample'
    reviewNote = saved?.note ?? ''
    reprintPieceCount = saved?.pieceCount ?? run.pieceCount
    reprintDeviation = saved?.deviation ?? ''
    reprintAt = saved?.printedAt ?? new Date().toISOString().slice(0, 10)
  }

  function closeReview(): void {
    reviewRunId = null
    reviewError = ''
    reviewSaving = false
  }

  async function submitReview(): Promise<void> {
    if (!reviewRun) return
    if (!reviewOperator.trim()) {
      reviewError = '请先填写复核人。'
      return
    }
    if (reviewMode === 'reprint' && reprintPieceCount <= 0) {
      reviewError = '按新刀口重打时，重打印次需大于 0。'
      return
    }

    reviewSaving = true
    reviewError = ''
    persistReviewDraft()
    try {
      if (reviewMode === 'keep-sample') {
        await keepOldSample(reviewRun.id, { operator: reviewOperator, note: reviewNote })
      } else {
        await reprintRun(reviewRun.id, {
          operator: reviewOperator,
          note: reviewNote,
          pieceCount: Number(reprintPieceCount),
          deviation: reprintDeviation,
          printedAt: reprintAt,
        })
      }
      clearDraft(reviewDraftKeyFor(reviewRunId))
      closeReview()
      await refreshAll()
    } catch (error) {
      reviewError = `写入失败，整笔已回滚：${error instanceof Error ? error.message : '未知错误'}。单据草稿已保留，可重试。`
    } finally {
      reviewSaving = false
    }
  }

  function deviationText(run: PrintRun): string {
    return run.deviation.trim() || (run.origin === 'migrated-inferred' ? '老档迁移，逐版偏差未留存' : '未见偏差')
  }

  async function exportArchive(): Promise<void> {
    const [drafts, blocks, carvers, nodes, revisions, printRuns, reviews] = await Promise.all([
      db.drafts.toArray(),
      db.blocks.toArray(),
      db.carvers.toArray(),
      db.nodes.toArray(),
      db.blockRevisions.toArray(),
      db.printRuns.toArray(),
      db.blockReviews.toArray(),
    ])
    downloadJson('木版年画工序档案.json', {
      exportedAt: new Date().toISOString(),
      drafts,
      blocks,
      batches,
      carvers,
      nodes,
      blockRevisions: revisions,
      printRuns,
      blockReviews: reviews,
    })
  }
</script>

<svelte:head>
  <title>印制批次登记 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">套色印制留档</p>
    <h1>印制批次登记</h1>
    <p>登记纸张、颜料与每版印次，逐版留下套色偏差；版片改刀后在此复核。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>新建批次</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>登记批次</span><strong data-testid="count-batch">{batches.length}</strong></div>
  <div><span>累计印数</span><strong>{batches.reduce((sum, batch) => sum + batch.qty, 0)}</strong></div>
  <div><span>待复核印次</span><strong data-testid="count-pending">{pendingRuns.length}</strong></div>
  <div><span>在册画稿</span><strong>{$draftStore.length}</strong></div>
</section>

{#if pendingRuns.length > 0}
  <section class="panel pending-panel" data-testid="panel-pending">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">改刀待复核</span>
        <h2>{pendingRuns.length} 个印次所用版次已落后</h2>
        <p class="gentle-copy">仅列出真正用到改版版片的已登记批次；没碰到该版的批次不受影响。可沿用旧印样，或按新刀口重打。</p>
      </div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>版片</th>
            <th>落印版次</th>
            <th>当前版次</th>
            <th>原印次</th>
            <th>原套色偏差</th>
            <th>复核</th>
          </tr>
        </thead>
        <tbody>
          {#each pendingRuns as run (run.id)}
            <tr data-testid={`pending-${run.id}`}>
              <td>
                <strong>{batches.find((batch) => batch.id === run.batchId)?.batchNo ?? run.batchId}</strong>
                <small>{run.printedAt.replace(/-/g, '.')}</small>
              </td>
              <td><b>{run.colorNo}</b>{run.blockName}</td>
              <td><span class="tag">第 {run.revNo} 版</span></td>
              <td><span class="tag state-已刻成">第 {run.currentRevNo} 版</span></td>
              <td>{run.pieceCount}</td>
              <td class="deviation-cell">{deviationText(run)}</td>
              <td>
                <button class="mini-button strong" data-testid={`open-review-${run.id}`} type="button" onclick={() => openReview(run)}>
                  去复核
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

{#if reviewRun}
  <section class="panel form-panel review-panel" data-testid="form-review">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">复核单据</span>
        <h2>{reviewRun.blockName} · 第 {reviewRun.revNo} 版印次复核到第 {reviewRun.currentRevNo} 版</h2>
        <p class="gentle-copy">原印次 {reviewRun.pieceCount} 与套色偏差原样保留；重打结果会另存一条印次并与原印次互相挂接。</p>
      </div>
      <button class="text-button" type="button" onclick={closeReview} disabled={reviewSaving}>收起</button>
    </div>

    <div class="review-original">
      <span><b>原批次：</b>{batches.find((batch) => batch.id === reviewRun.batchId)?.batchNo ?? reviewRun.batchId}</span>
      <span><b>原偏差：</b>{deviationText(reviewRun)}</span>
      <span><b>原印次：</b>{reviewRun.pieceCount}</span>
    </div>

    <div class="form-grid three">
      <label>
        <span>复核人</span>
        <input data-testid="field-review-operator" bind:value={reviewOperator} oninput={persistReviewDraft} placeholder="管事或复核印工" />
      </label>
      <label>
        <span>处理方式</span>
        <select data-testid="field-review-mode" bind:value={reviewMode} onchange={persistReviewDraft}>
          <option value="keep-sample">沿用旧印样</option>
          <option value="reprint">按新刀口重打</option>
        </select>
      </label>
      {#if reviewMode === 'reprint'}
        <label>
          <span>重打日期</span>
          <input data-testid="field-reprint-at" type="date" bind:value={reprintAt} oninput={persistReviewDraft} />
        </label>
        <label>
          <span>重打印次（每版）</span>
          <input data-testid="field-reprint-pieceCount" type="number" min="1" bind:value={reprintPieceCount} oninput={persistReviewDraft} />
        </label>
      {/if}
      <label class="wide">
        <span>{reviewMode === 'reprint' ? '重打套色偏差（新印次另存）' : '复核说明'}</span>
        <textarea
          data-testid="field-review-note"
          rows="2"
          value={reviewMode === 'reprint' ? reprintDeviation : reviewNote}
          oninput={(event) => {
            const text = (event.currentTarget as HTMLTextAreaElement).value
            if (reviewMode === 'reprint') reprintDeviation = text
            else reviewNote = text
            persistReviewDraft()
          }}
          placeholder={reviewMode === 'reprint' ? '记录新刀口下的套色偏差' : '认可旧印样的说明'}
        ></textarea>
      </label>
    </div>

    {#if reviewError}<p class="form-message" data-testid="review-error">{reviewError}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-review" type="button" disabled={reviewSaving} onclick={submitReview}>
        {reviewSaving ? '提交中…' : reviewMode === 'keep-sample' ? '确认沿用旧印样' : '保存重打结果'}
      </button>
      <button class="button ghost" type="button" onclick={closeReview} disabled={reviewSaving}>取消（草稿保留）</button>
    </div>
  </section>
{/if}

{#if showForm}
  <section class="panel form-panel" data-testid="form-batch">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">新印批</span>
        <h2>登记纸张与套色检查</h2>
      </div>
      <button class="text-button" type="button" onclick={() => (showForm = false)}>收起</button>
    </div>

    <div class="form-grid three">
      <label>
        <span>所属画稿</span>
        <select data-testid="field-draftId" value={draftId} onchange={(event) => selectDraft((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">请选择</option>
          {#each $draftStore as draft}<option value={draft.id}>{draft.title} · {draft.genre}</option>{/each}
        </select>
      </label>
      <label>
        <span>批次号</span>
        <input data-testid="field-batchNo" bind:value={batchNo} />
      </label>
      <label>
        <span>印制日期</span>
        <input data-testid="field-printedAt" type="date" bind:value={printedAt} />
      </label>
      <label>
        <span>纸张批号</span>
        <input data-testid="field-paperBatch" bind:value={paperBatch} placeholder="如：泾县-2605" />
      </label>
      <label>
        <span>总印数</span>
        <input data-testid="field-qty" type="number" min="1" bind:value={qty} />
      </label>
      <label>
        <span>每版印次</span>
        <input data-testid="field-pieceCount" type="number" min="1" bind:value={pieceCount} />
      </label>
      <label class="wide">
        <span>颜料与胶量</span>
        <textarea data-testid="field-inkNote" rows="2" bind:value={inkNote} placeholder="分色记录颜料、胶量与稀稠"></textarea>
      </label>
    </div>

    {#if selectedDraft}
      <div class="deviation-block">
        <div class="section-title-row">
          <div>
            <span class="section-kicker">逐版检查（按各版当前版次落印）</span>
            <h3>{selectedDraft.title}套色偏差</h3>
          </div>
          <span>{selectedBlocks.length} 块版片</span>
        </div>
        <div class="deviation-grid">
          {#each selectedBlocks as block}
            <label>
              <span><b>{block.colorNo}</b>{block.blockName} · 第{block.currentRevNo}版</span>
              <input
                data-testid={`field-deviation-${block.id}`}
                value={deviations[block.id] ?? ''}
                oninput={(event) => (deviations[block.id] = (event.currentTarget as HTMLInputElement).value)}
                placeholder="如：右下角偏红线半根"
              />
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <label class="stacked-field">
      <span>总检说明</span>
      <textarea data-testid="field-qcNote" rows="2" bind:value={qcNote} placeholder="走版、纸面洇墨与整体套准情况"></textarea>
    </label>

    {#if formMessage}<p class="form-message">{formMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-batch" type="button" onclick={submitBatch}>保存批次</button>
      <button class="button ghost" type="button" onclick={() => (showForm = false)}>取消</button>
    </div>
  </section>
{/if}

{#if batches.length === 0}
  <EmptyBox
    title="尚无印制批次"
    message="版片刻成后即可逐版试印，登记纸张与套色偏差。"
    actionLabel="新建批次"
    onaction={openForm}
  />
{:else}
  <section class="batch-list">
    {#each batches as batch (batch.id)}
      <article class="panel batch-item" data-testid="row-batch">
        <div class="batch-number">
          <span>{batch.printedAt.replace(/-/g, '.')}</span>
          <h2>{batch.batchNo}</h2>
          <p>{draftTitle(batch.draftId)} · {batch.paperBatch}</p>
          {#if pendingBatchIds.has(batch.id)}
            <span class="tag pending-tag" data-testid={`pending-tag-${batch.id}`}>待复核 {pendingCountByBatch[batch.id] ?? 0} 版</span>
          {/if}
        </div>
        <div class="batch-counts">
          <div><span>总印数</span><strong>{batch.qty}</strong></div>
          <div><span>每版印次</span><strong>{batch.pieceCount}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          {#if batch.qcNote}<p><b>总检：</b>{batch.qcNote}</p>{/if}
          <div class="run-list" data-testid={`runs-${batch.id}`}>
            {#each runsOfBatch(batch.id) as run (run.id)}
              <div class="run-item run-origin-{run.origin}" class:run-superseded={!!run.supersededBy}>
                <span class="run-color">{run.colorNo} {run.blockName}</span>
                <span class="run-rev">第 {run.revNo} 版</span>
                <span class="run-pieces">{run.pieceCount} 印次</span>
                <span class="run-deviation">{deviationText(run)}</span>
                {#if run.reprintOf}<span class="run-badge">重打另存</span>{/if}
                {#if run.supersededBy}<span class="run-badge muted">已由重打取代（原印次留存）</span>{/if}
                {#if run.origin === 'migrated-inferred'}<span class="run-badge muted">迁移推断</span>{/if}
              </div>
            {/each}
          </div>
        </div>
      </article>
    {/each}
  </section>
{/if}
