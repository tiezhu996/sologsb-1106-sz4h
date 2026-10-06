<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { buildDeviationNote } from '../utils/seq'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import { deriveBatchReviewState } from '../utils/archive'
  import { registerPrintBatch, submitBatchReview, RevisionConflictError } from '../services/ledger'
  import type { PrintBatch } from '../types/batch'
  import type { Block } from '../types/block'
  import type { BatchImpression } from '../types/impression'
  import type { BatchReview, RestrikeResult } from '../types/review'

  let batches = $state<PrintBatch[]>([])
  let impressions = $state<BatchImpression[]>([])
  let reviews = $state<BatchReview[]>([])
  let restrikes = $state<RestrikeResult[]>([])
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

  // 复核表单
  let reviewBatchId = $state<string | null>(null)
  let reviewOperator = $state('')
  let reviewNote = $state('')
  let reviewMode = $state<Record<string, 'keep' | 'restrike'>>({})
  let restrikeDraft = $state<Record<string, { no: number; pieceCount: number; deviation: string; note: string }>>({})
  let reviewMessage = $state('')
  let reviewSubmitting = $state(false)

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? $blockStore.filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  const currentRevisionByBlock = $derived(new Map($blockStore.map((block) => [block.id, block.currentRevisionNo ?? 1])))

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), refreshArchive()])
  })

  async function refreshArchive(): Promise<void> {
    const [batchRecords, impressionRecords, reviewRecords, restrikeRecords] = await Promise.all([
      db.batches.toArray(),
      db.impressions.toArray(),
      db.reviews.toArray(),
      db.restrikes.toArray(),
    ])
    batchRecords.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
    batches = batchRecords
    await blockStore.load()
    impressions = impressionRecords
    reviews = reviewRecords
    restrikes = restrikeRecords
  }

  function reviewStateOf(batchId: string) {
    return deriveBatchReviewState(
      batchId,
      $blockStore,
      currentRevisionByBlock,
      impressions,
      reviews,
      restrikes,
    )
  }

  function blockOf(blockId: string): Block | undefined {
    return $blockStore.find((block) => block.id === blockId)
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

  async function submitBatchForm(): Promise<void> {
    if (!draftId || !batchNo.trim() || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      formMessage = '请选择画稿，并补全批次号、纸张批号和印数。'
      return
    }

    const deviationText = buildDeviationNote(
      selectedBlocks.map((block) => ({
        blockName: block.blockName,
        deviation: deviations[block.id] ?? '',
      })),
    )

    try {
      await registerPrintBatch({
        draftId,
        batchNo: batchNo.trim(),
        printedAt,
        paperBatch: paperBatch.trim(),
        inkNote: inkNote.trim() || '颜料与胶量待续记',
        qty: Number(qty),
        pieceCount: Number(pieceCount),
        qcNote: qcNote.trim() ? `${qcNote.trim()}；${deviationText}` : deviationText,
        deviations,
      })
    } catch (error) {
      formMessage = `批次保存失败，整笔已回滚：${error instanceof Error ? error.message : '请重试。'}`
      return
    }

    await refreshArchive()
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

  function openReview(batchId: string): void {
    const state = reviewStateOf(batchId)
    reviewBatchId = batchId
    reviewOperator = ''
    reviewNote = ''
    reviewMessage = ''
    const nextMode: Record<string, 'keep' | 'restrike'> = {}
    const nextRestrike: typeof restrikeDraft = {}
    for (const pending of state.pending) {
      const original = state.impressions.find((item) => item.blockId === pending.blockId)
      nextMode[pending.blockId] = 'keep'
      nextRestrike[pending.blockId] = {
        no: (original?.pieceCount ?? pieceCount) + 1,
        pieceCount: original?.pieceCount ?? 1,
        deviation: '',
        note: '',
      }
    }
    reviewMode = nextMode
    restrikeDraft = nextRestrike
  }

  async function submitReviewForm(): Promise<void> {
    if (!reviewBatchId) return
    if (!reviewOperator.trim()) {
      reviewMessage = '请填写复核操作人。'
      return
    }
    const state = reviewStateOf(reviewBatchId)
    const keepBlockIds = state.pending
      .filter((pending) => reviewMode[pending.blockId] === 'keep')
      .map((pending) => pending.blockId)
    const restrikeInputs: Record<string, (typeof restrikeDraft)[string]> = {}
    for (const pending of state.pending) {
      if (reviewMode[pending.blockId] !== 'restrike') continue
      const draft = restrikeDraft[pending.blockId]
      if (!draft || draft.pieceCount <= 0) {
        reviewMessage = '重打版片的印次需为正整数。'
        return
      }
      restrikeInputs[pending.blockId] = draft
    }
    if (keepBlockIds.length === 0 && Object.keys(restrikeInputs).length === 0) {
      reviewMessage = '请至少选择一个待复核版片。'
      return
    }

    reviewSubmitting = true
    reviewMessage = ''
    try {
      const restrikesPayload = Object.fromEntries(
        Object.entries(restrikeInputs).map(([blockId, draft]) => [
          blockId,
          {
            restrikeNo: draft.no,
            pieceCount: draft.pieceCount,
            deviation: draft.deviation,
            note: draft.note,
          },
        ]),
      )
      await submitBatchReview({
        batchId: reviewBatchId,
        operator: reviewOperator,
        note: reviewNote,
        keepBlockIds,
        restrikes: restrikesPayload,
      })
      await refreshArchive()
      reviewBatchId = null
    } catch (error) {
      reviewMessage =
        error instanceof RevisionConflictError
          ? error.message
          : error instanceof Error
            ? `复核保存失败，整笔已回滚：${error.message}`
            : '复核保存失败，整笔已回滚，请重试。'
    } finally {
      reviewSubmitting = false
    }
  }

  const pendingBatchCount = $derived(batches.filter((batch) => reviewStateOf(batch.id).pending.length > 0).length)

  async function exportArchive(): Promise<void> {
    const [drafts, carvers, nodes, revisionRecords, impressionRecords, reviewRecords, restrikeRecords] = await Promise.all([
      db.drafts.toArray(),
      db.carvers.toArray(),
      db.nodes.toArray(),
      db.revisions.toArray(),
      db.impressions.toArray(),
      db.reviews.toArray(),
      db.restrikes.toArray(),
    ])
    downloadJson('木版年画工序档案.json', {
      exportedAt: new Date().toISOString(),
      drafts,
      blocks: $blockStore,
      carvers,
      batches,
      nodes,
      revisions: revisionRecords,
      impressions: impressionRecords,
      reviews: reviewRecords,
      restrikes: restrikeRecords,
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
    <p>登记纸张、颜料与每版印次，逐版留下套色偏差；版片返修后，相关批次在此复核。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>新建批次</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>登记批次</span><strong data-testid="count-batch">{batches.length}</strong></div>
  <div><span>待复核批次</span><strong data-testid="count-pending">{pendingBatchCount}</strong></div>
  <div><span>累计印数</span><strong>{batches.reduce((sum, batch) => sum + batch.qty, 0)}</strong></div>
  <div><span>在册画稿</span><strong>{$draftStore.length}</strong></div>
</section>

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
            <span class="section-kicker">逐版检查</span>
            <h3>{selectedDraft.title}套色偏差（随印次归档，之后不改写）</h3>
          </div>
          <span>{selectedBlocks.length} 块版片 · 各按当前版次登记</span>
        </div>
        <div class="deviation-grid">
          {#each selectedBlocks as block}
            <label>
              <span><b>{block.colorNo}</b>{block.blockName} · 第 {block.currentRevisionNo} 版次</span>
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
      <button class="button primary" data-testid="submit-batch" type="button" onclick={submitBatchForm}>保存批次</button>
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
      {@const state = reviewStateOf(batch.id)}
      <article class="panel batch-item" data-testid="row-batch" class:pending-review={state.pending.length > 0}>
        <div class="batch-number">
          <span>{batch.printedAt.replace(/-/g, '.')}</span>
          <h2>{batch.batchNo}</h2>
          <p>{draftTitle(batch.draftId)} · {batch.paperBatch}</p>
          {#if state.pending.length > 0}
            <span class="tag status-2" data-testid={`pending-tag-${batch.id}`}>待复核 · {state.pending.length} 块版</span>
          {:else}
            <span class="tag status-3">版次已核对</span>
          {/if}
        </div>
        <div class="batch-counts">
          <div><span>总印数</span><strong>{batch.qty}</strong></div>
          <div><span>每版印次</span><strong>{batch.pieceCount}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          <p><b>套色检查：</b>{batch.qcNote}</p>
        </div>
      </article>

      <section class="panel impression-panel" data-testid={`impressions-${batch.id}`}>
        <div class="panel-heading">
          <div>
            <span class="section-kicker">逐版印次（原印次与套色偏差冻结保存）</span>
            <h3>{batch.batchNo} 印次留档</h3>
          </div>
          {#if state.pending.length > 0}
            <button class="button primary" data-testid={`open-review-${batch.id}`} type="button" onclick={() => openReview(batch.id)}>
              复核 {state.pending.length} 块待核版片
            </button>
          {/if}
        </div>

        <div class="impression-grid">
          {#each state.impressions as impression (impression.id)}
            {@const block = blockOf(impression.blockId)}
            <div class="impression-card" class:is-pending={state.pending.some((pending) => pending.blockId === impression.blockId)}>
              <div class="impression-head">
                <strong>{block?.blockName ?? '未知版片'}</strong>
                <span>
                  用第 {impression.revisionNo ?? '?'} 版次印
                  {#if block && block.currentRevisionNo > (impression.revisionNo ?? 0)}
                    <em>（现第 {block.currentRevisionNo} 版次）</em>
                  {/if}
                </span>
              </div>
              <p><b>原印次：</b>第 {impression.pieceCount} 印次</p>
              <p><b>套色偏差：</b>{impression.deviation || '未见偏差'}</p>
              <small>来源：{impression.source}{impression.source === '迁移未知' ? '（不冒充历史依据）' : ''}</small>

              {#each state.restrikes.filter((item) => item.blockId === impression.blockId) as restrike (restrike.id)}
                <div class="restrike-card" data-testid={`restrike-${restrike.id}`}>
                  <strong>重打另存 · 第 {restrike.revisionNo} 版次刀口</strong>
                  <p>重打印次第 {restrike.restrikeNo} · 印 {restrike.pieceCount} 次</p>
                  <p><b>新套色偏差：</b>{restrike.deviation || '未见偏差'}</p>
                  <small>{restrike.operator} · {restrike.restrikedAt.slice(0, 16).replace('T', ' ')}{restrike.note ? ` · ${restrike.note}` : ''}</small>
                </div>
              {/each}

              {#each state.reviews.filter((item) => item.blockId === impression.blockId && item.decision === '沿用旧印样') as review (review.id)}
                <p class="review-keep" data-testid={`keep-${review.id}`}>已沿用旧印样核对至第 {review.reviewedRevisionNo} 版次（{review.operator} · {review.reviewedAt.slice(0, 10)}）</p>
              {/each}
            </div>
          {/each}
        </div>
      </section>

      {#if reviewBatchId === batch.id}
        <section class="panel form-panel" data-testid={`review-form-${batch.id}`}>
          <div class="panel-heading">
            <div>
              <span class="section-kicker">批次复核</span>
              <h3>对 {batch.batchNo} 的待核版片逐块定夺</h3>
              <p class="gentle-copy">可沿用旧印样放行，也可按新刀口重打；重打结果另存，原印次与套色偏差保留不动。</p>
            </div>
            <button class="text-button" type="button" onclick={() => (reviewBatchId = null)}>收起</button>
          </div>

          <div class="review-block-list">
            {#each state.pending as pending (pending.blockId)}
              {@const block = blockOf(pending.blockId)}
              {@const original = state.impressions.find((item) => item.blockId === pending.blockId)}
              <div class="review-block" data-testid={`review-block-${pending.blockId}`}>
                <div class="review-block-head">
                  <strong>{block?.blockName ?? '未知版片'}</strong>
                  <span>
                    原用第 {pending.usedRevisionNo ?? '?'} 版次
                    {#if pending.unknownOrigin}<em> · 旧档来源未知</em>{/if}
                    → 现第 {pending.currentRevisionNo} 版次
                  </span>
                </div>
                <div class="review-choice">
                  <label>
                    <input type="radio" name={`mode-${pending.blockId}`} value="keep" checked={reviewMode[pending.blockId] === 'keep'} onchange={() => (reviewMode[pending.blockId] = 'keep')} />
                    沿用旧印样
                  </label>
                  <label>
                    <input type="radio" name={`mode-${pending.blockId}`} value="restrike" checked={reviewMode[pending.blockId] === 'restrike'} onchange={() => (reviewMode[pending.blockId] = 'restrike')} />
                    按新刀口重打
                  </label>
                </div>
                {#if reviewMode[pending.blockId] === 'restrike' && restrikeDraft[pending.blockId]}
                  <div class="restrike-form">
                    <label>
                      <span>重打印次号</span>
                      <input data-testid={`restrike-no-${pending.blockId}`} type="number" min="1" bind:value={restrikeDraft[pending.blockId].no} />
                    </label>
                    <label>
                      <span>重打印数</span>
                      <input data-testid={`restrike-count-${pending.blockId}`} type="number" min="1" bind:value={restrikeDraft[pending.blockId].pieceCount} />
                    </label>
                    <label class="wide">
                      <span>新刀口套色偏差</span>
                      <input data-testid={`restrike-deviation-${pending.blockId}`} bind:value={restrikeDraft[pending.blockId].deviation} placeholder="如：左肩偏差已消，荷叶边均匀" />
                    </label>
                    <p class="gentle-copy">原印次第 {original?.pieceCount} 与原偏差「{original?.deviation || '未见偏差'}」继续保留，不覆盖。</p>
                  </div>
                {/if}
              </div>
            {/each}
          </div>

          <div class="form-grid">
            <label>
              <span>复核操作人</span>
              <input data-testid="field-review-operator" bind:value={reviewOperator} placeholder="印制管事姓名" />
            </label>
            <label class="wide">
              <span>复核备注</span>
              <input data-testid="field-review-note" bind:value={reviewNote} placeholder="整批复核结论" />
            </label>
          </div>

          {#if reviewMessage}<p class="form-message" data-testid="review-message">{reviewMessage}</p>{/if}
          <div class="form-actions">
            <button class="button primary" data-testid={`submit-review-${batch.id}`} type="button" disabled={reviewSubmitting} onclick={submitReviewForm}>
              {reviewSubmitting ? '提交中…' : '提交复核'}
            </button>
            <button class="button ghost" type="button" disabled={reviewSubmitting} onclick={() => (reviewBatchId = null)}>取消</button>
          </div>
        </section>
      {/if}
    {/each}
  </section>
{/if}
