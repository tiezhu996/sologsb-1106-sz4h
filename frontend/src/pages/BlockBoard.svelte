<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { link, params } from 'svelte-spa-router'
  import ColorSwatch from '../components/common/ColorSwatch.svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import SeqInput from '../components/common/SeqInput.svelte'
  import StageRail from '../components/common/StageRail.svelte'
  import { blockStore } from '../stores/blockStore'
  import { carverStore } from '../stores/carverStore'
  import { draftStore } from '../stores/draftStore'
  import { useBlockOrder } from '../hooks/useBlockOrder'
  import { useCarverLoad } from '../hooks/useCarverLoad'
  import { validateColorSequence } from '../utils/seq'
  import { db } from '../utils/db'
  import { appendRepairRevision, listRevisions, RevisionConflictError } from '../utils/revisionService'
  import { clearDraft, loadDraft, saveDraft } from '../utils/formDraft'
  import type { Block, BlockState } from '../types/block'
  import type { BlockRevision } from '../types/revision'
  import type { ProcessStage } from '../types/node'

  const draftId = $derived($params?.id ?? '')
  // 初始传 null，由下方 $effect 跟随路由参数 setDraft，避免只捕获初值。
  const {
    blocks: orderedBlocks,
    carvedRate: blockCarvedRate,
    reorder: reorderBlocks,
    setDraft: setBlockDraft,
  } = useBlockOrder(null)
  const { activeCount: selectedActiveCount, averageDuration: selectedAverageDuration, refresh: refreshCarverLoad } = useCarverLoad('')

  let sequenceDraft = $state<Record<string, number>>({})
  let selectedCarverId = $state('')
  let notice = $state('')
  let lastSync = $state('刚刚')
  let revisionHistory = $state<Record<string, BlockRevision[]>>({})

  // 返修单：每次只对一块版追加一个新版次。
  let repairBlockId = $state<string | null>(null)
  let repairOperator = $state('')
  let repairReason = $state('')
  let repairWoodType = $state<string>('梨木')
  let repairThickness = $state(20)
  let repairDefect = $state('')
  let repairState = $state<BlockState>('已修版')
  let repairSaving = $state(false)
  let repairError = $state('')

  const draft = $derived($draftStore.find((item) => item.id === draftId) ?? null)
  const repairBlock = $derived($orderedBlocks.find((item) => item.id === repairBlockId) ?? null)

  function repairDraftKeyFor(blockId: string | null): string {
    return blockId ? `repair:${blockId}` : ''
  }

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), carverStore.load()]).then(() => {
      void refreshAllHistory()
    })
  })

  $effect(() => {
    setBlockDraft(draftId)
  })

  $effect(() => {
    for (const block of $orderedBlocks) {
      if (sequenceDraft[block.id] === undefined) sequenceDraft[block.id] = block.colorNo
    }
  })

  $effect(() => {
    const firstCarver = $carverStore[0]
    if (!selectedCarverId && firstCarver) {
      selectedCarverId = firstCarver.id
      void refreshCarverLoad(firstCarver.id)
    }
  })

  function blockStateStage(state: Block['state']): number {
    if (state === '待刻' || state === '在刻') return 3
    return 4
  }

  function occupiedNumbers(exceptId: string): number[] {
    return $orderedBlocks.filter((block) => block.id !== exceptId).map((block) => block.colorNo)
  }

  async function assignCarver(block: Block, carverName: string): Promise<void> {
    const carver = $carverStore.find((item) => item.name === carverName)
    if (!carver) return
    await carverStore.assignBlock(block, carver.id)
    await blockStore.load()
    lastSync = `已把${block.blockName}指派给刻工`
  }

  async function markCarved(block: Block): Promise<void> {
    await blockStore.update(block.id, { state: '已刻成' })
    await carverStore.releaseBlock(block.id)
    const currentBlocks = get(blockStore).filter((item) => item.draftId === draftId)
    const allCarved = currentBlocks.every((item) => item.state === '已刻成' || item.state === '已修版')
    await draftStore.update(draftId, { status: allCarved ? '可印' : '刻版中' })

    const existing = await db.nodes.where('blockId').equals(block.id).toArray()
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      revNo: block.currentRevNo,
      stage: '刻版',
      seq: Math.max(0, ...existing.map((node) => node.seq)) + 1,
      operator: block.carvedBy || '当班刻工',
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: 0,
      note: '版片验线后标记刻成。',
    })
    lastSync = `${block.blockName}已标记刻成`
  }

  async function saveSequence(block: Block): Promise<void> {
    const next = sequenceDraft[block.id] ?? block.colorNo
    const check = validateColorSequence([...occupiedNumbers(block.id), next])
    if (!check.valid) {
      notice = check.duplicates.length
        ? `色序 ${check.duplicates.join('、')} 已占用，请调换后再存。`
        : `当前色序有跳号，缺少 ${check.gaps.join('、')}。`
      return
    }

    await blockStore.update(block.id, { colorNo: next })
    notice = `${block.blockName}色序已改为 ${next}`
    lastSync = '套色序号已存档'
  }

  async function moveBlock(block: Block, direction: -1 | 1): Promise<void> {
    const ordered = [...$orderedBlocks]
    const index = ordered.findIndex((item) => item.id === block.id)
    const target = ordered[index + direction]
    if (index < 0 || !target) return

    const moved = [...ordered]
    moved[index] = target
    moved[index + direction] = block
    await reorderBlocks(moved.map((item, itemIndex) => ({ id: item.id, colorNo: itemIndex + 1 })))
    moved.forEach((item, itemIndex) => {
      sequenceDraft[item.id] = itemIndex + 1
    })
    lastSync = `${block.blockName}已${direction < 0 ? '前移' : '后移'}`
  }

  async function refreshHistory(blockId: string): Promise<void> {
    revisionHistory[blockId] = await listRevisions(blockId)
  }

  async function refreshAllHistory(): Promise<void> {
    for (const block of $orderedBlocks) {
      await refreshHistory(block.id)
    }
  }

  function persistRepairDraft(): void {
    const key = repairDraftKeyFor(repairBlockId)
    if (!key) return
    saveDraft(key, {
      operator: repairOperator,
      reason: repairReason,
      woodType: repairWoodType,
      thicknessMm: repairThickness,
      defectNote: repairDefect,
      state: repairState,
    })
  }

  function openRepair(block: Block): void {
    repairBlockId = block.id
    repairError = ''
    const key = repairDraftKeyFor(block.id)
    const saved = key ? loadDraft<{
      operator: string
      reason: string
      woodType: string
      thicknessMm: number
      defectNote: string
      state: BlockState
    }>(key) : null
    repairOperator = saved?.operator ?? block.carvedBy
    repairReason = saved?.reason ?? ''
    repairWoodType = saved?.woodType ?? String(block.woodType)
    repairThickness = saved?.thicknessMm ?? block.thicknessMm
    repairDefect = saved?.defectNote ?? block.defectNote
    repairState = saved?.state ?? '已修版'
  }

  function closeRepair(): void {
    repairBlockId = null
    repairError = ''
    repairSaving = false
  }

  async function submitRepair(): Promise<void> {
    if (!repairBlock || !repairBlockId) return
    if (!repairReason.trim()) {
      repairError = '请先写明改刀原因，再追加版次。'
      return
    }
    if (!String(repairWoodType).trim()) {
      repairError = '请填写改刀后的木料。'
      return
    }

    repairSaving = true
    repairError = ''
    persistRepairDraft()
    try {
      const result = await appendRepairRevision(repairBlockId, {
        operator: repairOperator,
        repairReason: repairReason,
        woodType: repairWoodType,
        thicknessMm: Number(repairThickness),
        state: repairState,
        defectNote: repairDefect,
      }, { expectedRevNo: repairBlock.currentRevNo })

      clearDraft(repairDraftKeyFor(repairBlockId))
      await Promise.all([blockStore.load(), refreshHistory(repairBlockId)])
      const affected = result.affectedBatchIds.length
      lastSync = affected > 0
        ? `第 ${result.revision.revNo} 版已追加，${affected} 个印制批次进入待复核`
        : `第 ${result.revision.revNo} 版已追加，暂无已登记批次受影响`
      closeRepair()
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        repairError = `${error.message} 已为你保留草稿，请刷新版次后基于最新版重试。`
      } else {
        repairError = `写入失败，整笔已回滚：${error instanceof Error ? error.message : '未知错误'}。草稿已保留，可直接重试。`
      }
    } finally {
      repairSaving = false
    }
  }

  async function returnToStage(_index: number, stage: ProcessStage): Promise<void> {
    const block = $orderedBlocks[0]
    if (!block) return
    if (stage === '刻版' || stage === '修版') {
      await blockStore.update(block.id, { state: stage === '修版' ? '已修版' : '在刻' })
      lastSync = `已将首块版片阶段调至${stage}`
    }
  }

  function chooseCarver(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement
    selectedCarverId = select.value
    void refreshCarverLoad(select.value)
  }

  function originLabel(revision: BlockRevision): string {
    if (revision.origin === 'initial') return '首刻'
    if (revision.origin === 'repair') return '返修'
    return '未知来源'
  }

  function formatStamp(value: string): string {
    return value ? value.replace('T', ' ') : '时间不详'
  }
</script>

<svelte:head>
  <title>版片编排台 · 木版年画刻版工序档案</title>
</svelte:head>

{#if !draft}
  <div class="page-heading">
    <div><p class="eyebrow">画稿与分版</p><h1>版片编排台</h1><p>正在读取画稿与版片档案。</p></div>
  </div>
  <EmptyBox title="未找到这张画稿" message="画稿可能尚未载入或档案编号有误。" />
  <a class="button secondary" use:link href="/drafts">返回画稿总览</a>
{:else}
  <div class="page-heading">
    <div>
      <p class="eyebrow">{draft.genre} · {draft.designer}</p>
      <h1>{draft.title}版片编排台</h1>
      <p>{draft.sizeCm} · 按套色序号依次刻制，先墨线后套色；返修一律追加新版次，不覆盖旧记录。</p>
    </div>
    <a class="button ghost" use:link href="/drafts">返回画稿总览</a>
  </div>

  <section class="summary-strip four">
    <div><span>版片总数</span><strong>{$orderedBlocks.length}</strong></div>
    <div><span>刻成率</span><strong>{$blockCarvedRate}%</strong></div>
    <div><span>在刻版片</span><strong>{$orderedBlocks.filter((block) => block.state === '在刻').length}</strong></div>
    <div><span>返修版次</span><strong>{Object.values(revisionHistory).flat().filter((rev) => rev.origin === 'repair').length}</strong></div>
  </section>

  {#if repairBlock}
    <section class="panel form-panel repair-panel" data-testid="form-repair">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">追加式返修</span>
          <h2>{repairBlock.blockName} · 登记第 {repairBlock.currentRevNo + 1} 版</h2>
          <p class="gentle-copy">
            当前为第 {repairBlock.currentRevNo} 版。旧版次、旧工序节点、旧批次印次都留在原处；
            本版会冻结改刀前的版片摘要，并记录改刀原因与木料更换。
          </p>
        </div>
        <button class="text-button" type="button" onclick={closeRepair} disabled={repairSaving}>收起</button>
      </div>

      <div class="form-grid three">
        <label>
          <span>改刀操作人</span>
          <input data-testid="field-repair-operator" bind:value={repairOperator} oninput={persistRepairDraft} placeholder="修版刻工姓名" />
        </label>
        <label>
          <span>改刀后木料</span>
          <input data-testid="field-repair-wood" list="wood-options" bind:value={repairWoodType} oninput={persistRepairDraft} placeholder="梨木 / 黄杨 / 其它" />
          <datalist id="wood-options">
            <option value="梨木"></option>
            <option value="黄杨"></option>
          </datalist>
        </label>
        <label>
          <span>版厚（mm）</span>
          <input data-testid="field-repair-thickness" type="number" min="1" bind:value={repairThickness} oninput={persistRepairDraft} />
        </label>
        <label>
          <span>改刀后状态</span>
          <select data-testid="field-repair-state" bind:value={repairState} onchange={persistRepairDraft}>
            <option value="已修版">已修版</option>
            <option value="已刻成">已刻成</option>
            <option value="在刻">在刻</option>
          </select>
        </label>
        <label class="wide">
          <span>改刀原因</span>
          <textarea
            data-testid="field-repair-reason"
            rows="2"
            bind:value={repairReason}
            oninput={persistRepairDraft}
            placeholder="如：试印崩线、嵌补处吃墨不足、刀口需收顺……"
          ></textarea>
        </label>
        <label class="wide">
          <span>本版备注（写到当前版片）</span>
          <textarea data-testid="field-repair-defect" rows="2" bind:value={repairDefect} oninput={persistRepairDraft}></textarea>
        </label>
      </div>

      {#if repairError}<p class="form-message" data-testid="repair-error">{repairError}</p>{/if}
      <div class="form-actions">
        <button class="button primary" data-testid="submit-repair" type="button" disabled={repairSaving} onclick={submitRepair}>
          {repairSaving ? '提交中…' : `追加第 ${repairBlock.currentRevNo + 1} 版`}
        </button>
        <button class="button ghost" type="button" onclick={closeRepair} disabled={repairSaving}>取消（草稿保留）</button>
      </div>
    </section>
  {/if}

  <div class="workbench-grid">
    <section class="panel table-panel wide-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">套色序列</span>
          <h2>版片刻制编排</h2>
        </div>
        <span class="sync-note">{lastSync}</span>
      </div>

      {#if $orderedBlocks.length === 0}
        <EmptyBox title="尚未分版" message="先回画稿总览建立画稿，系统会生成四块基础版片。" />
      {:else}
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>色序</th>
                <th>版片</th>
                <th>木料 / 版厚</th>
                <th>刻工指派</th>
                <th>状态 / 版次</th>
                <th>返修与版次沿革</th>
              </tr>
            </thead>
            <tbody>
              {#each $orderedBlocks as block, blockIndex (block.id)}
                <tr data-testid="row-block">
                  <td class="sequence-cell">
                    {#if sequenceDraft[block.id] !== undefined}
                      <SeqInput
                        bind:value={sequenceDraft[block.id]}
                        existing={occupiedNumbers(block.id)}
                        label="序号"
                        testid={`field-colorNo-${block.id}`}
                      />
                    {/if}
                    <button class="mini-button" type="button" onclick={() => saveSequence(block)}>存序号</button>
                    <div class="order-buttons">
                      <button type="button" disabled={blockIndex === 0} onclick={() => moveBlock(block, -1)}>上移</button>
                      <button type="button" disabled={blockIndex === $orderedBlocks.length - 1} onclick={() => moveBlock(block, 1)}>下移</button>
                    </div>
                  </td>
                  <td>
                    <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
                  </td>
                  <td>
                    <strong>{block.woodType}</strong>
                    <small>{block.thicknessMm} mm</small>
                  </td>
                  <td>
                    <select
                      data-testid={`field-carvedBy-${block.id}`}
                      value={block.carvedBy}
                      onchange={(event) => assignCarver(block, (event.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">待指派</option>
                      {#each $carverStore as carver}
                        <option value={carver.name}>{carver.name} · {carver.specialty}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <span class="tag state-{block.state}">{block.state}</span>
                    {#if block.state !== '已刻成' && block.state !== '已修版'}
                      <button class="mini-button strong" type="button" onclick={() => markCarved(block)}>标刻成</button>
                    {/if}
                    <div class="rev-current">当前第 <strong>{block.currentRevNo}</strong> 版</div>
                  </td>
                  <td>
                    <button class="mini-button strong" data-testid={`open-repair-${block.id}`} type="button" onclick={() => openRepair(block)}>
                      返修登记（追加新版）
                    </button>
                    <a class="mini-link" use:link href={`/blocks/${block.id}/nodes`}>查看工序时间线</a>
                    <div class="rev-history" data-testid={`rev-history-${block.id}`}>
                      {#each (revisionHistory[block.id] ?? []) as rev (rev.id)}
                        <div class="rev-item origin-{rev.origin}">
                          <span class="rev-no">第 {rev.revNo} 版</span>
                          <span class="rev-origin">{originLabel(rev)}</span>
                          <small>{formatStamp(rev.createdAt)} · {rev.operator}</small>
                          {#if rev.origin === 'repair'}
                            <p class="rev-reason">{rev.repairReason}</p>
                            {#if rev.woodReplaced}
                              <p class="rev-wood">换木料：{rev.previousWoodType ?? '原木料不详'} → {block.woodType}</p>
                            {/if}
                          {:else if rev.origin === 'unknown'}
                            <p class="rev-reason">来源缺失，按未知保留，未据旧备注反推。</p>
                          {/if}
                          <details>
                            <summary>当时版片摘要</summary>
                            <ul class="snapshot-list">
                              <li>{rev.snapshot.woodType} · {rev.snapshot.thicknessMm} mm · {rev.snapshot.state}</li>
                              <li>刻工：{rev.snapshot.carvedBy || '待指派'}</li>
                              <li>备注：{rev.snapshot.defectNote || '无'}</li>
                            </ul>
                          </details>
                        </div>
                      {/each}
                    </div>
                  </td>
                </tr>
                <tr class="stage-row">
                  <td colspan="6">
                    <StageRail
                      activeIndex={blockStateStage(block.state)}
                      completedCount={block.state === '已刻成' || block.state === '已修版' ? 5 : block.state === '在刻' ? 3 : 1}
                      compact={true}
                      onselect={block.id === $orderedBlocks[0]?.id ? returnToStage : undefined}
                    />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <aside class="panel side-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">当班安排</span>
          <h2>刻工负荷</h2>
        </div>
      </div>
      <label class="stacked-field">
        <span>选择刻工</span>
        <select value={selectedCarverId} onchange={chooseCarver}>
          {#each $carverStore as carver}<option value={carver.id}>{carver.name} · {carver.specialty}</option>{/each}
        </select>
      </label>
      <div class="load-card">
        <span>当前在刻</span>
        <strong>{$selectedActiveCount}</strong>
        <small>版片</small>
      </div>
      <div class="load-card muted">
        <span>节点平均耗时</span>
        <strong>{$selectedAverageDuration}</strong>
        <small>分钟</small>
      </div>
      {#if notice}<p class="notice">{notice}</p>{/if}
      <p class="gentle-copy">改刀请走“返修登记”，系统会追加版次并把用到该版的已登记批次置为待复核。</p>
      <a class="button secondary full" use:link href="/carvers">查看刻工档与分布</a>
    </aside>
  </div>
{/if}
