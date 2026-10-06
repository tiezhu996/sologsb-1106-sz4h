<script lang="ts">
  import { onMount } from 'svelte'
  import { link, params } from 'svelte-spa-router'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { blockStore } from '../stores/blockStore'
  import { db } from '../utils/db'
  import { listRevisions } from '../utils/revisionService'
  import type { BlockRevision } from '../types/revision'
  import type { ProcessNode, ProcessStage } from '../types/node'

  const stages: ProcessStage[] = ['起稿', '勾描', '上样', '刻版', '修版', '调色', '套印', '晾晒']
  const blockId = $derived($params?.id ?? '')
  const block = $derived($blockStore.find((item) => item.id === blockId) ?? null)

  let nodes = $state<ProcessNode[]>([])
  let revisions = $state<BlockRevision[]>([])
  let operator = $state('')
  let durationMin = $state(60)
  let stage = $state<ProcessStage>('修版')
  let note = $state('')
  let feedback = $state('')

  const currentRevNo = $derived(block?.currentRevNo ?? 1)
  const orderedRevisions = $derived([...revisions].sort((a, b) => a.revNo - b.revNo))

  interface NodeGroup {
    revNo: number
    revision: BlockRevision | null
    nodes: ProcessNode[]
    isCurrent: boolean
  }

  const nodeGroups = $derived.by<NodeGroup[]>(() => {
    const groups: NodeGroup[] = []
    for (const rev of orderedRevisions) {
      const revNodes = nodes
        .filter((node) => (node.revNo ?? 1) === rev.revNo)
        .sort((a, b) => a.seq - b.seq)
      groups.push({ revNo: rev.revNo, revision: rev, nodes: revNodes, isCurrent: rev.revNo === currentRevNo })
    }
    // 兼容个别节点版次在版次表缺失的情况。
    const knownRevs = new Set(orderedRevisions.map((rev) => rev.revNo))
    const orphanRevs = [...new Set(nodes.map((node) => node.revNo ?? 1).filter((revNo) => !knownRevs.has(revNo)))]
    for (const revNo of orphanRevs.sort((a, b) => a - b)) {
      groups.push({
        revNo,
        revision: null,
        nodes: nodes.filter((node) => (node.revNo ?? 1) === revNo).sort((a, b) => a.seq - b.seq),
        isCurrent: revNo === currentRevNo,
      })
    }
    return groups.sort((a, b) => b.revNo - a.revNo)
  })

  const currentNodes = $derived(nodes.filter((node) => (node.revNo ?? 1) === currentRevNo).sort((a, b) => a.seq - b.seq))
  const latestNode = $derived(currentNodes[currentNodes.length - 1] ?? null)

  onMount(() => {
    void Promise.all([blockStore.load(), loadNodes(), loadRevisions()])
  })

  $effect(() => {
    if (block && !operator) operator = block.carvedBy
  })

  async function loadRevisions(): Promise<void> {
    revisions = await listRevisions(blockId)
  }

  async function loadNodes(): Promise<void> {
    const records = await db.nodes.where('blockId').equals(blockId).toArray()
    records.sort((a, b) => a.seq - b.seq)
    nodes = records
    const last = records[records.length - 1]
    if (last) durationMin = last.durationMin
  }

  async function addNode(): Promise<void> {
    if (!block) return
    if (!operator.trim()) {
      feedback = '请先填写操作人。'
      return
    }

    const allNodes = await db.nodes.where('blockId').equals(block.id).toArray()
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      // 新节点只进当前版次，绝不回填到老版次里。
      revNo: currentRevNo,
      stage,
      seq: Math.max(0, ...allNodes.map((node) => node.seq)) + 1,
      operator: operator.trim(),
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: Math.max(0, Number(durationMin)),
      note: note.trim() || `${stage}工序登记（第 ${currentRevNo} 版）`,
    })
    note = ''
    feedback = `已在第 ${currentRevNo} 版登记${stage}节点`
    await loadNodes()
  }

  /** 只允许回退当前版次的末节点；旧版节点是历史，不能删。 */
  async function retreatCurrent(): Promise<void> {
    if (!latestNode) {
      feedback = '当前版次没有可回退的节点，旧版节点保留不动。'
      return
    }
    await db.nodes.delete(latestNode.id)
    feedback = `已回退第 ${currentRevNo} 版的${latestNode.stage}节点`
    await loadNodes()
  }

  async function updateDuration(): Promise<void> {
    if (!latestNode) {
      feedback = '当前版次登记节点后才能记录耗时。'
      return
    }
    await db.nodes.update(latestNode.id, { durationMin: Math.max(0, Number(durationMin)) })
    feedback = `已登记${latestNode.stage}耗时 ${durationMin} 分钟`
    await loadNodes()
  }

  function formatTime(value: string): string {
    return value.replace('T', ' ')
  }

  function originLabel(revision: BlockRevision | null): string {
    if (!revision) return '未知版次'
    if (revision.origin === 'initial') return '首刻'
    if (revision.origin === 'repair') return '返修'
    return '未知来源'
  }
</script>

<svelte:head>
  <title>工序节点时间线 · 木版年画刻版工序档案</title>
</svelte:head>

{#if !block}
  <div class="page-heading">
    <div><p class="eyebrow">单块版片工序</p><h1>工序节点时间线</h1><p>正在读取版片与节点档案。</p></div>
  </div>
  <EmptyBox title="未找到这块版片" message="版片档案尚未载入，请从画稿总览重新进入。" />
  <a class="button secondary" use:link href="/drafts">返回画稿总览</a>
{:else}
  <div class="page-heading" data-testid="detail-node">
    <div>
      <p class="eyebrow">单块版片工序</p>
      <h1>{block.blockName}工序节点时间线</h1>
      <p>{block.woodType} · 版厚 {block.thicknessMm} mm · 当前 {block.state} · 第 {currentRevNo} 版</p>
    </div>
    <a class="button ghost" use:link href={`/drafts/${block.draftId}/blocks`}>返回版片编排台</a>
  </div>

  <div class="timeline-grid">
    <section class="panel form-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">当前第 {currentRevNo} 版</span>
          <h2>给当前版次登记工序节点</h2>
        </div>
      </div>

      <div class="form-grid">
        <label>
          <span>工序环节</span>
          <select data-testid="field-node-stage" bind:value={stage}>
            {#each stages as item}<option value={item}>{item}</option>{/each}
          </select>
        </label>
        <label>
          <span>操作人</span>
          <input data-testid="field-node-operator" bind:value={operator} placeholder="刻工或画师姓名" />
        </label>
        <label>
          <span>本次耗时（分钟）</span>
          <input data-testid="field-node-duration" type="number" min="0" bind:value={durationMin} />
        </label>
        <label class="wide">
          <span>工序记录</span>
          <textarea data-testid="field-node-note" rows="3" bind:value={note} placeholder="记刀路、试印或修补要点"></textarea>
        </label>
      </div>
      <button class="button primary" data-testid="submit-node" type="button" onclick={addNode}>登记到第 {currentRevNo} 版</button>

      <div class="inline-actions">
        <button class="button secondary" type="button" onclick={updateDuration}>更新当前版末节点耗时</button>
        <button class="button danger" type="button" onclick={retreatCurrent}>回退当前版末节点</button>
      </div>
      <p class="gentle-copy">旧版节点属于历史档案，不在此回退；改刀请在编排台追加新版次。</p>
      {#if feedback}<p class="notice">{feedback}</p>{/if}
    </section>

    <section class="panel timeline-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">按版次留存</span>
          <h2>工序往来</h2>
        </div>
        <strong>{nodes.length} 条 · {orderedRevisions.length} 版</strong>
      </div>

      {#if nodeGroups.length === 0}
        <EmptyBox title="尚未登记节点" message="从左侧为当前版次登记操作人、耗时与工序要点。" />
      {:else}
        <div class="rev-timeline">
          {#each nodeGroups as group (group.revNo)}
            <article class="rev-group" class:rev-current-group={group.isCurrent}>
              <header class="rev-group-head">
                <h3>第 {group.revNo} 版 · {originLabel(group.revision)}</h3>
                {#if group.isCurrent}<span class="tag state-已刻成">当前版</span>{:else}<span class="tag">历史版</span>{/if}
              </header>
              {#if group.revision?.repairReason}
                <p class="rev-group-reason"><b>改刀原因：</b>{group.revision.repairReason}</p>
              {/if}
              {#if group.revision?.origin === 'unknown'}
                <p class="rev-group-reason">来源缺失按未知保留，不冒充历史依据。</p>
              {/if}
              {#if group.nodes.length === 0}
                <p class="gentle-copy">这一版没有登记工序节点。</p>
              {:else}
                <ol class="timeline-list">
                  {#each [...group.nodes].reverse() as node}
                    <li>
                      <span class="timeline-dot"></span>
                      <div>
                        <div class="timeline-title"><strong>{node.stage}</strong><span>第 {node.seq} 节点</span></div>
                        <p>{node.note}</p>
                        <small>{node.operator} · {formatTime(node.startedAt)} · {node.durationMin} 分钟</small>
                      </div>
                    </li>
                  {/each}
                </ol>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/if}
