<template>
  <div class="app-shell">
    <aside class="sidebar">
      <h1>排练乐谱台</h1>
      <p class="subtitle">Vue 3 + TypeScript + OSMD · 本地 IndexedDB · 可恢复排练方案</p>

      <div class="card">
        <h2>工程</h2>
        <div class="row">
          <button class="primary" @click="loadSample">载入双跳房/变速/多声部样例</button>
          <button @click="fileInput?.click()">打开 MusicXML</button>
          <button @click="planFileInput?.click()">导入方案 JSON</button>
          <button @click="proposalFileInput?.click()">导入提案</button>
          <input ref="fileInput" data-testid="score-file" hidden type="file" accept=".xml,.musicxml,application/xml" @change="onFile" />
          <input ref="planFileInput" data-testid="plan-file" hidden type="file" accept=".json,application/json" @change="onPlanImport" />
          <input ref="proposalFileInput" data-testid="proposal-file" hidden type="file" accept=".json,application/json" @change="onPlanImport" />
        </div>
        <label>IndexedDB 本地工程</label>
        <select v-if="projects.length" :value="currentProjectId" @change="openProject(($event.target as HTMLSelectElement).value)">
          <option value="">— 选择已保存工程 —</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">
            {{ p.title }} · v{{ p.plan?.versions?.[0]?.version ?? 0 }} · {{ formatDate(p.updatedAt) }}
          </option>
        </select>
        <p v-else class="muted">尚无本地工程；打开或载入样例后自动保存。</p>
        <div class="row" style="margin-top: 9px">
          <button :disabled="!xml" @click="saveCurrent">保存/更新工程</button>
          <button class="danger" :disabled="!currentProjectId" @click="removeCurrent">删除</button>
          <button :disabled="!xml" @click="exportData">导出 XML+标记+方案</button>
        </div>
        <p v-if="importMessage" class="muted">{{ importMessage }}</p>
        <p data-testid="save-state" class="muted">{{ saveState }}</p>
      </div>

      <div class="card">
        <h2>节拍与光标</h2>
        <div class="stat-grid">
          <div class="stat"><b>{{ parsed?.measures.length ?? 0 }}</b><span>书面小节</span></div>
          <div class="stat"><b>{{ path.visits.length }}</b><span>实际到达</span></div>
          <div class="stat"><b>{{ formatTime(path.totalSeconds) }}</b><span>参考总时长</span></div>
        </div>
        <div class="row between" style="margin-top: 10px">
          <button class="primary" :disabled="!canPlayFullPath" @click="togglePlay">
            {{ playing ? '停止' : '从当前书面小节播放节拍' }}
          </button>
          <select v-model.number="rate" style="width: 92px" :disabled="playing">
            <option :value="0.5">0.5×</option>
            <option :value="0.75">0.75×</option>
            <option :value="1">1×</option>
            <option :value="1.25">1.25×</option>
          </select>
        </div>
        <p class="muted">当前：<span class="current-pulse">{{ cursorLabel }}</span></p>
      </div>

      <div class="card">
        <div class="tabs">
          <button :class="{ active: tab === 'measures' }" @click="tab = 'measures'">书面小节</button>
          <button :class="{ active: tab === 'path' }" @click="tab = 'path'">实际路径</button>
          <button :class="{ active: tab === 'plan' }" @click="tab = 'plan'">排练方案</button>
          <button :class="{ active: tab === 'markers' }" @click="tab = 'markers'">标记</button>
          <button :class="{ active: tab === 'diagnostics' }" @click="tab = 'diagnostics'">
            诊断 {{ errorCount ? `(${errorCount})` : '' }}
          </button>
        </div>

        <div v-if="tab === 'measures'" class="scrollbox">
          <table class="measure-table">
            <thead><tr><th>书面</th><th>时长/拍号</th><th>速度</th><th>声部</th><th>到达</th></tr></thead>
            <tbody>
              <tr
                v-for="m in parsed?.measures ?? []"
                :key="m.index"
                class="clickable"
                :class="{ active: selectedWritten === m.index }"
                @click="selectWritten(m.index)"
              >
                <td><b>{{ m.printedNumber }}</b><br /><span v-if="m.isPickup" class="pill">弱起</span></td>
                <td>{{ m.actualQuarters }}♩ / {{ m.timesig.beats }}/{{ m.timesig.beatType }}</td>
                <td>
                  <span v-for="t in m.tempoEvents" :key="t.quarterOffset">{{ t.bpm }}@{{ t.quarterOffset }}♩ </span>
                </td>
                <td>{{ m.voiceCount }} 声部</td>
                <td>{{ visitsForWritten(m.index).length }} 次</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'path'" class="scrollbox">
          <table class="visit-table">
            <thead><tr><th>#</th><th>书面</th><th>遍/房</th><th>起(s)</th><th>动作</th></tr></thead>
            <tbody>
              <tr
                v-for="v in path.visits"
                :key="v.visitKey"
                class="clickable"
                :class="{ active: currentVisitKey === v.visitKey }"
                @click="selectVisit(v)"
              >
                <td>{{ v.sequence + 1 }}</td>
                <td>{{ v.printedNumber }}</td>
                <td>{{ v.pass }}<span v-if="v.endingNumber"> / 第{{ v.endingNumber }}房</span></td>
                <td>{{ v.startTime.toFixed(2) }}</td>
                <td>{{ v.action }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'plan'">
          <div v-if="plan" class="plan-header">
            <div class="row">
              <input v-model="planName" data-testid="plan-name" placeholder="排练方案名称" style="flex:1" @change="renamePlan" />
              <span class="pill">v{{ plan.versions[0]?.version ?? 1 }}</span>
              <span class="badge" :class="plan.status === 'ready' ? 'ok' : 'error'">
                {{ plan.status === 'ready' ? '可播放' : '待处理失配' }}
              </span>
            </div>
            <div class="muted">路径校验：{{ shortHash(plan.pathChecksum) }} · 乐谱：{{ shortHash(plan.xmlSha256) }}</div>
          </div>

          <div v-if="mismatches.length" class="mismatch-list">
            <h3>路径失配（禁止按同书面小节误播）</h3>
            <div v-for="mismatch in mismatches" :key="mismatch.id" class="diagnostic error">
              <div><b>{{ subjectText[mismatch.subject] }}</b>：{{ mismatch.message }}</div>
              <select v-model="mismatchChoices[mismatch.id]">
                <option value="">选择新路径到达位置…</option>
                <option v-for="candidate in mismatch.candidates" :key="candidate.visitKey" :value="candidate.visitKey">
                  {{ describeEndpoint(candidate) }}
                </option>
              </select>
              <div class="row" style="margin-top:6px">
                <button :disabled="!mismatchChoices[mismatch.id]" @click="resolveOne(mismatch.id, 'rebind', mismatchChoices[mismatch.id])">重新绑定</button>
                <button v-if="mismatch.subject === 'queue-item'" @click="resolveOne(mismatch.id, 'historical')">保留历史</button>
                <button class="danger" @click="resolveOne(mismatch.id, 'delete')">删除</button>
              </div>
            </div>
          </div>

          <h3>从实际路径创建命名段落</h3>
          <label>段落名称</label>
          <input v-model="newSegmentName" data-testid="segment-name" placeholder="例如：第一房反复到第二房" />
          <div class="row">
            <label style="margin:0">起</label>
            <select v-model="newSegmentStartKey" data-testid="segment-start" style="flex:1">
              <option value="">选择实际到达…</option>
              <option v-for="v in path.visits" :key="v.visitKey" :value="v.visitKey">{{ describeEndpoint(v) }}</option>
            </select>
          </div>
          <div class="row">
            <label style="margin:0">止</label>
            <select v-model="newSegmentEndKey" data-testid="segment-end" style="flex:1">
              <option value="">选择实际到达…</option>
              <option v-for="v in path.visits" :key="v.visitKey" :value="v.visitKey">{{ describeEndpoint(v) }}</option>
            </select>
          </div>
          <div class="row between">
            <label style="margin:0">循环次数</label>
            <input v-model.number="newSegmentLoops" type="number" min="1" max="20" style="width:90px" />
          </div>
          <button class="primary" data-testid="save-segment" :disabled="!canAddSegment" @click="addSegment">保存为可追溯版本</button>

          <h3>分部队列</h3>
          <div class="row">
            <input v-model="newQueueName" data-testid="queue-name" placeholder="例如：第一小提琴" style="flex:1" />
            <button data-testid="add-queue" :disabled="!newQueueName.trim()" @click="addNamedQueue">建立分部队列</button>
          </div>
          <div v-for="queue in queues" :key="queue.id" class="queue-card" data-testid="queue-card">
            <div class="row between">
              <b>{{ queue.name }}</b>
              <span class="pill">内容 {{ shortHash(queueContentHash(queue)) }}</span>
            </div>
            <div class="muted">
              下一段：{{ queueSummary(queue).next?.segmentName ?? '无' }} ·
              已完成 {{ queueSummary(queue).completed }} ·
              待处理 {{ queueSummary(queue).blocked }} ·
              <span v-if="queueSummary(queue).finished" class="badge ok">队列已完成</span>
            </div>
            <div class="row">
              <select v-model="queueItemSegmentId" :data-testid="`queue-segment-${queue.id}`" style="flex:1">
                <option value="">选择现有实际到达段落…</option>
                <option v-for="segment in plan?.segments ?? []" :key="segment.id" :value="segment.id">{{ segment.name }}</option>
              </select>
              <input v-model.number="queueItemLoops" type="number" min="1" style="width:70px" title="循环数" aria-label="循环数" />
              <input v-model.number="queueItemTempo" type="number" min="0.25" step="0.05" style="width:80px" title="速度倍率" aria-label="速度倍率" />
              <button :disabled="!queueItemSegmentId" @click="addExistingSegmentToQueue(queue)">加入</button>
            </div>
            <ol class="queue-items">
              <li v-for="(item, index) in queue.items" :key="item.id" :class="item.status" :data-testid="`queue-item-${item.id}`">
                <b>{{ index + 1 }}. {{ item.segmentName }}</b>
                ×{{ item.loops }} · ♩{{ Math.round(item.tempoScale * 100) }}%
                <span v-if="item.status === 'pending'" class="badge error">待处理</span>
                <span v-else-if="item.status === 'historical'" class="badge warning">历史</span>
                <button @click="moveQueueItem(queue.id, item.id, -1)" :disabled="index === 0">↑</button>
                <button @click="moveQueueItem(queue.id, item.id, 1)" :disabled="index === queue.items.length - 1">↓</button>
                <button @click="removeQueueItem(queue.id, item.id)">移除</button>
              </li>
            </ol>
            <div class="muted">
              恢复：{{ queuePositionText(queue) }}
            </div>
            <button
              class="primary"
              data-testid="queue-play"
              :disabled="queueSummary(queue).blocked > 0 || ledgerValidation?.ok === false"
              @click="playQueue(queue)"
            >
              {{ queuePositionText(queue).includes('已完成队列') ? '重新播放整个队列' : '按队列顺序恢复播放' }}
            </button>
            <div class="history-line">历史完成：{{ queue.completions.length ? queue.completions.slice(-3).map((c) => c.segmentName).join('、') : '无' }}</div>
          </div>

          <h3>段落实际序列与旧会话</h3>
          <div v-for="segment in plan?.segments ?? []" :key="segment.id" class="segment-card" :class="{ historical: segment.historical }" :data-testid="`segment-${segment.id}`">
            <div class="row between">
              <b>{{ segment.name }}</b>
              <span class="pill">v{{ plan?.versions[0]?.version }}</span>
            </div>
            <div class="muted">
              {{ describeEndpoint(segment.start) }} → {{ describeEndpoint(segment.end) }} · {{ segment.loops }} 循环
            </div>
            <div class="sequence-line">{{ segmentSequenceText(segment) }}</div>
            <div v-for="session in sessionsForSegment(segment.id)" :key="session.id" class="session-line">
              {{ session.name }}：{{ sessionProgressText(segment, session) }}
              <button data-testid="segment-play" :disabled="!canPlaySegment(segment)" @click="playSegment(segment, session)">
                {{ resumeButtonText(segment, session) }}
              </button>
              <button :disabled="!session.position || session.position.completed" @click="resetSessionProgress(session)">重置进度</button>
            </div>
          </div>

          <h3>可验证事件账本</h3>
          <div class="ledger-panel" data-testid="ledger-panel">
            <div class="muted">事件 {{ project?.ledger ? ledgerEventCount : 0 }} · 检查点 {{ project?.ledger ? ledgerCheckpointCount : 0 }} · 隔离 {{ ledgerValidation?.quarantined.length ?? 0 }}</div>
            <span v-if="ledgerValidation?.ok" class="badge ok">链校验通过</span>
            <span v-else-if="ledgerValidation" class="badge error">账本阻塞</span>
            <ul v-if="ledgerValidation && !ledgerValidation.ok" class="ledger-errors">
              <li v-for="error in ledgerValidation.errors.slice(0, 5)" :key="error">{{ error }}</li>
            </ul>
            <ul v-if="ledgerQuarantined.length" class="ledger-errors" data-testid="ledger-quarantine">
              <li v-for="item in ledgerQuarantined" :key="item.id">
                隔离：{{ quarantineReasonText(item.reason) }} · {{ formatDate(item.at) }}
                <div class="row">
                  <button @click="resolveQuarantine(item.id, 'historical')">保留历史</button>
                  <button @click="resolveQuarantine(item.id, 'fork')">分叉为只读审计线</button>
                  <button class="danger" @click="resolveQuarantine(item.id, 'rejected')">拒绝</button>
                </div>
              </li>
            </ul>
            <details>
              <summary>事件时间线</summary>
              <ul class="op-list">
                <li v-for="event in ledgerEvents.slice(-12)" :key="event.id">#{{ event.clock }} · {{ event.summary }}</li>
              </ul>
            </details>
          </div>

          <h3>变更提案与三方合并</h3>
          <div class="row">
            <input v-model="proposalAuthor" placeholder="作者/分部" style="width:110px" />
            <input v-model="proposalName" placeholder="提案名称" style="flex:1" />
            <button :disabled="!proposalName.trim() || !proposalAuthor.trim()" @click="createDraftProposal">基于当前版本建提案</button>
          </div>
          <div v-for="proposal in project?.proposals ?? []" :key="proposal.id" class="proposal-card" :data-testid="`proposal-${proposal.id}`">
            <div class="row between">
              <b>{{ proposal.name }}</b>
              <span class="pill">基线 v{{ proposal.base.version }}</span>
              <span class="badge info">{{ proposal.status }}</span>
            </div>
            <div class="muted">作者：{{ proposal.author }} · 内容 {{ shortHash(proposal.contentHash) }} · 操作 {{ proposal.ops.length }}</div>
            <div class="row proposal-editor" :class="{ active: activeProposalId === proposal.id }" v-if="true">
              <select v-model="proposalQueueId" data-testid="proposal-queue-select" :disabled="activeProposalId !== proposal.id" style="flex:1">
                <option value="">选择队列…</option>
                <option v-for="q in proposal.queues" :key="q.id" :value="q.id">{{ q.name }}</option>
              </select>
              <select v-model="proposalItemId" data-testid="proposal-item-select" :disabled="activeProposalId !== proposal.id" style="flex:1">
                <option value="">选择队列项…</option>
                <option v-for="item in proposalQueueItems" :key="item.id" :value="item.id">{{ item.segmentName }}</option>
              </select>
              <input v-model.number="proposalItemLoops" data-testid="proposal-item-loops" type="number" min="1" title="循环" style="width:70px" />
              <input v-model.number="proposalItemTempo" data-testid="proposal-item-tempo" type="number" min="0.25" step="0.05" title="速度" style="width:80px" />
              <button data-testid="proposal-item-apply" :disabled="!proposalItemId" @click="editActiveProposalItem">调整</button>
              <button :disabled="!proposalItemId" @click="moveActiveProposalItem(-1)">↑</button>
              <button :disabled="!proposalItemId" @click="moveActiveProposalItem(1)">↓</button>
              <button class="danger" :disabled="!proposalItemId" @click="deleteActiveProposalItem">删</button>
            </div>
            <div class="row" style="margin-top:6px">
              <button data-testid="export-proposal" @click="exportActiveProposal(proposal)">导出提案</button>
              <span class="muted">{{ proposalMergeStatus(proposal.id) }}</span>
            </div>
            <details>
              <summary>操作时间线</summary>
              <ul class="op-list">
                <li v-for="op in proposal.ops" :key="op.id">{{ formatDate(op.at) }} · {{ op.summary }}</li>
              </ul>
            </details>
          </div>

          <div v-for="pending in project?.pendingMerges ?? []" :key="pending.proposal.id" class="mismatch-list" :data-testid="`pending-merge-${pending.proposal.id}`">
            <h3>待处理合并：{{ pending.proposal.name }}</h3>
            <p class="muted">刷新后仍保留；未解决冲突时不能合并或播放受影响队列。</p>
            <div v-for="conflict in pending.conflicts" :key="conflict.id" class="diagnostic warning">
              <b>{{ conflict.entityLabel }} · {{ conflict.field }}</b>
              <div class="muted">基线：{{ formatConflictValue(conflict.base) }} ｜ 本地：{{ formatConflictValue(conflict.local) }} ｜ 提案：{{ formatConflictValue(conflict.proposal) }}</div>
              <div class="row">
                <button :class="{ active: conflict.resolution === 'local' }" @click="resolvePendingConflict(pending.proposal.id, conflict.id, 'local')">采用本地</button>
                <button :class="{ active: conflict.resolution === 'proposal' }" @click="resolvePendingConflict(pending.proposal.id, conflict.id, 'proposal')">采用提案</button>
              </div>
            </div>
            <div class="row">
              <button class="primary" data-testid="apply-merge" :disabled="hasUnresolvedConflict(pending.proposal.id)" @click="applyPendingMerge(pending.proposal.id)">应用合并并建版本</button>
              <button @click="discardPendingMerge(pending.proposal.id)">保留为待处理历史</button>
            </div>
          </div>

          <div v-if="(project?.mergeRecords ?? []).length">
            <h3>合并记录 / 撤销</h3>
            <div v-for="record in project?.mergeRecords ?? []" :key="record.id" class="proposal-card">
              <b>{{ record.proposalName }}</b>
              <span class="pill">v{{ record.versionAfter }}</span>
              <span v-if="record.undoneAt" class="badge warning">已撤销</span>
              <button v-else data-testid="undo-merge" @click="undoRecord(record.id)">撤销本次合并</button>
            </div>
          </div>

          <h3>版本历史</h3>
          <div class="scrollbox small">
            <table class="visit-table">
              <tbody>
                <tr v-for="version in plan?.versions ?? []" :key="version.id">
                  <td><b>v{{ version.version }}</b></td>
                  <td>{{ version.changeSummary }}</td>
                  <td>{{ formatDate(version.createdAt) }}</td>
                  <td>{{ version.segments.length }} 段 / {{ (version.queues ?? []).length }} 队列 / {{ version.mismatches.length }} 失配</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="tab === 'markers'">
          <p class="muted">标记与 XML 和方案分离保存；迁移的旧标记保持不变。</p>
          <div class="row">
            <input v-model="newMarkerLabel" placeholder="例如：从这里接第二提琴进入" style="flex: 1" />
            <button :disabled="selectedWritten === null" @click="addMarker">加到书面第 {{ selectedWritten === null ? '?' : selectedWritten + 1 }} 小节</button>
          </div>
          <table class="marker-table" style="margin-top: 10px">
            <tbody>
              <tr v-for="marker in markers" :key="marker.id">
                <td><span class="pill">第 {{ marker.writtenMeasure + 1 }} 小节</span></td>
                <td>{{ marker.label }}</td>
                <td><button class="danger" @click="removeMarker(marker.id)">删</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'diagnostics'">
          <p>
            <span class="badge" :class="path.errors.length ? 'error' : 'ok'">
              {{ path.errors.length ? '路径存在无法闭合问题' : '路径可闭合' }}
            </span>
            未知结构、导航文字和无法闭合跳转均在此显式列出。
          </p>
          <div v-for="(d, i) in parsed?.diagnostics ?? []" :key="i" class="diagnostic" :class="d.level">
            <span class="badge" :class="d.level">{{ levelText[d.level] }}</span>
            <span class="diagnostic-code">{{ d.code }}</span><br />
            书面第 {{ d.measureIndex < 0 ? '—' : d.measureIndex + 1 }} 小节：{{ d.message }}
          </div>
        </div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <h2 class="title-main">{{ parsed?.title ?? '未打开乐谱' }}</h2>
          <div class="muted">
            选中书面小节：{{ selectedWritten === null ? '—' : selectedWritten + 1 }}；
            实际到达：{{ selectedVisits.length ? selectedVisits.map((v) => `第${v.sequence + 1}次/第${v.printedNumber}小节`).join('，') : '无' }}
          </div>
        </div>
        <div class="row">
          <button :disabled="!selectedVisit" @click="selectVisit(selectedVisit!)">定位光标</button>
        </div>
      </header>
      <section class="score-wrap">
        <div id="osmd-container" ref="scoreContainer"></div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  PathVisit,
  PartQueue,
  PlanMismatch,
  QueuePosition,
  RehearsalMarker,
  RehearsalPlan,
  RehearsalSegment,
  RehearsalSession,
  SessionPosition,
  StoredProject,
  TimedPulse
} from './types'
import { parseMusicXml } from './musicxmlParser'
import { buildPerformancePath } from './pathBuilder'
import { createDisplay, type DisplayHandle } from './display'
import { Metronome } from './metronome'
import { createSampleXml } from './sampleScore'
import { createId, deleteProject, listProjects, saveProject } from './db'
import { exportProjectArtifacts } from './exporter'
import { sha256Text } from './crypto'
import {
  addSegment as addPlanSegment,
  appendVersion,
  createPlan,
  describeEndpoint,
  endpointFromVisit,
  reconcilePlan,
  resolveMismatch,
  savePlanRevision,
  segmentVisits,
  updateSessionProgress,
  ensurePlanQueues
} from './planService'
import {
  addQueueItem,
  advanceQueueItem,
  createQueue,
  createQueueItem,
  moveQueueItem as moveQueueItemInPlan,
  queueContentHash,
  queueSummary,
  removeQueueItem as removeQueueItemById,
  startQueueRun,
  updateQueueProgress
} from './queueService'
import { buildQueuePlayback, buildSegmentPlayback } from './playback'
import { plainClone } from './plainClone'
import { importPlanBundle, migrateLegacyProject, validateImportedPlan } from './projectMigration'
import {
  createProposal,
  proposalDeleteQueueItem,
  proposalReorderQueueItem,
  proposalUpdateQueueItem
} from './proposalService'
import { exportProposal, importProposal } from './proposalExchange'
import { applyMerge, resolveConflict, undoMerge, unresolvedConflicts } from './mergeService'
import {
  appendLedgerEvent,
  createCheckpoint,
  createLedger,
  importLedgerEvents,
  migrateSnapshotToLedger,
  replayLedger,
  type EventLedger,
  type LedgerValidation
} from './ledgerService'
function ledgerFromProject(): EventLedger | null {
  return (project.value?.ledger as EventLedger | undefined) ?? null
}
async function appendProjectLedgerEvent(input: Omit<Parameters<typeof appendLedgerEvent>[0], 'ledger'>): Promise<void> {
  const ledger = ledgerFromProject()
  if (!ledger || !plan.value) return
  await appendLedgerEvent({ ...input, ledger })
}

const scoreContainer = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const planFileInput = ref<HTMLInputElement | null>(null)
const proposalFileInput = ref<HTMLInputElement | null>(null)
const display = shallowRef<DisplayHandle | null>(null)
const audioContext = shallowRef<AudioContext | null>(null)
const metronome = shallowRef<Metronome | null>(null)

const projects = ref<StoredProject[]>([])
const currentProjectId = ref('')
const project = ref<StoredProject | null>(null)
const xml = ref('')
const currentFileName = ref('sample.musicxml')
const xmlHash = ref('')
const markers = ref<RehearsalMarker[]>([])
const plan = ref<RehearsalPlan | null>(null)
const planName = ref('')
const selectedWritten = ref<number | null>(null)
const selectedVisitSequence = ref<number | null>(null)
const currentVisitKey = ref<string | null>(null)
const currentPulse = shallowRef<TimedPulse | null>(null)
const playing = ref(false)
const activePlayback = shallowRef<{
  queue?: PartQueue
  itemId?: string
  runId?: string
  segment?: RehearsalSegment
  session?: RehearsalSession
} | null>(null)
const activePosition = shallowRef<QueuePosition | SessionPosition | null>(null)
const suppressNextPathReconcile = ref(false)
const rate = ref(1)
const tab = ref<'measures' | 'path' | 'plan' | 'markers' | 'diagnostics'>('plan')
const newMarkerLabel = ref('')
const importMessage = ref('')
const saveState = ref('未保存')

const newSegmentName = ref('')
const newSegmentStartKey = ref('')
const newSegmentEndKey = ref('')
const newSegmentLoops = ref(2)
const newQueueName = ref('')
const queueItemSegmentId = ref('')
const queueItemLoops = ref(1)
const queueItemTempo = ref(1)
const mismatchChoices = ref<Record<string, string>>({})
const ledgerValidation = ref<LedgerValidation | null>(null)

const proposalName = ref('')
const proposalAuthor = ref('')
const activeProposalId = ref('')
const proposalQueueId = ref('')
const proposalItemId = ref('')
const proposalItemLoops = ref(1)
const proposalItemTempo = ref(1)

watch([proposalItemId, activeProposalId, proposalQueueId], () => {
  const proposal = project.value?.proposals?.find((item) => item.id === activeProposalId.value)
  const item = proposal?.queues
    .flatMap((queue) => queue.items)
    .find((candidate) => candidate.id === proposalItemId.value)
  if (!item) return
  proposalItemLoops.value = item.loops
  proposalItemTempo.value = item.tempoScale
})

const parsed = computed(() => (xml.value ? parseMusicXml(xml.value, currentFileName.value) : null))
const path = computed(() =>
  parsed.value ? buildPerformancePath(parsed.value) : { visits: [], pulses: [], totalSeconds: 0, errors: [] }
)
const selectedVisits = computed(() =>
  selectedWritten.value === null ? [] : path.value.visits.filter((v) => v.writtenMeasure === selectedWritten.value)
)
const selectedVisit = computed(() =>
  selectedVisitSequence.value === null
    ? selectedVisits.value[0] ?? null
    : path.value.visits.find((v) => v.sequence === selectedVisitSequence.value) ?? null
)
const queues = computed<PartQueue[]>(() => plan.value?.queues ?? [])
const ledgerEvents = computed(() => ((project.value?.ledger as EventLedger | undefined)?.events ?? []))
const ledgerEventCount = computed(() => ledgerEvents.value.length)
const ledgerCheckpointCount = computed(() => ((project.value?.ledger as EventLedger | undefined)?.checkpoints ?? []).length)
const ledgerQuarantined = computed(() => ((project.value?.ledger as EventLedger | undefined)?.quarantined ?? []))
function quarantineReasonText(reason: string): string {
  return {
    'same-id-different-content': '同 ID 不同内容',
    'missing-parent': '父链缺失/不可达',
    'broken-hash': '哈希损坏',
    'summary-mismatch': 'XML/路径摘要不符',
    unknown: '未知错误'
  }[reason as 'missing-parent'] ?? reason
}
async function resolveQuarantine(itemId: string, resolution: 'historical' | 'fork' | 'rejected') {
  const ledger = ledgerFromProject()
  if (!ledger || !plan.value) return
  const item = ledger.quarantined.find((entry) => entry.id === itemId)
  if (!item) return
  item.resolution = resolution
  if (resolution === 'fork') item.forkId = createId()
  ledgerValidation.value = await replayLedger(plan.value, ledger)
  await persistProject()
}
const proposalQueueItems = computed(() => {
  const proposal = project.value?.proposals?.find((item) => item.id === activeProposalId.value)
  return proposal?.queues.find((queue) => queue.id === proposalQueueId.value)?.items ?? []
})
const mismatches = computed(() => plan.value?.mismatches ?? [])
const errorCount = computed(() => parsed.value?.diagnostics.filter((d) => d.level === 'error').length ?? 0)
const levelText = { error: '错误', warning: '警告', info: '信息' } as const
const subjectText: Record<PlanMismatch['subject'], string> = {
  'segment-start': '段落起点',
  'segment-end': '段落终点',
  'session-position': '会话恢复位置',
  'queue-item': '分部队列段落',
  'queue-position': '分部队列恢复位置'
}
const canPlayFullPath = computed(() => path.value.visits.length > 0 && !path.value.errors.length && !mismatches.value.length && ledgerValidation.value?.ok !== false)
const canAddSegment = computed(() =>
  !!plan.value &&
  !!newSegmentStartKey.value &&
  !!newSegmentEndKey.value &&
  newSegmentName.value.trim().length > 0 &&
  newSegmentLoops.value >= 1 &&
  !mismatches.value.length
)
const cursorLabel = computed(() => {
  if (currentPulse.value) {
    return `第 ${currentPulse.value.printedNumber} 小节 ${currentPulse.value.beatLabel} 拍 · ♩=${currentPulse.value.bpm} · 循环${(currentPulse.value.loopIndex ?? 0) + 1}`
  }
  if (activePlayback.value?.session?.position) return '等待从恢复位置播放'
  if (selectedVisit.value) return `第 ${selectedVisit.value.printedNumber} 小节，等待播放`
  return '选择一个书面小节'
})

onMounted(async () => {
  if (scoreContainer.value) display.value = await createDisplay(scoreContainer.value)
  projects.value = await listProjects()
  const latest = projects.value[0]
  if (latest) await openProject(latest.id)
  else await loadSample()
})

onBeforeUnmount(() => {
  metronome.value?.dispose()
  void audioContext.value?.close()
})

watch(xml, async () => {
  if (xml.value && display.value) {
    try {
      await display.value.render(xml.value)
    } catch (err) {
      console.error(err)
    }
    await nextTick()
    if (selectedWritten.value !== null) display.value.showMeasure(selectedWritten.value)
  }
})

watch(selectedWritten, async (idx) => {
  if (idx === null) return
  await nextTick()
  if (selectedVisitSequence.value === null) display.value?.showMeasure(idx)
  const visit = path.value.visits.find((v) => v.writtenMeasure === idx)
  currentVisitKey.value = visit?.visitKey ?? null
})

watch(plan, (nextPlan) => {
  planName.value = nextPlan?.name ?? ''
  mismatchChoices.value = {}
})

watch(
  path,
  async (currentPath) => {
    metronome.value?.setData(currentPath.pulses, currentPath.visits)
    if (!xmlHash.value || !parsed.value) return
    if (suppressNextPathReconcile.value) {
      suppressNextPathReconcile.value = false
      return
    }
    const previousPlan = project.value?.plan ?? plan.value
    if (previousPlan) {
      const result = await reconcilePlan(previousPlan, currentPath, xmlHash.value)
      if (result.changed) {
        plan.value = result.plan
        if (project.value) {
          project.value.plan = result.plan
          project.value.updatedAt = result.plan.updatedAt
          await saveProject(project.value)
          projects.value = await listProjects()
        }
      } else {
        plan.value = previousPlan
      }
    }
  },
  { flush: 'post' }
)

async function setScore(nextXml: string, fileName: string, nextMarkers: RehearsalMarker[], preserveProjectId = '') {
  stopPlayback()
  currentFileName.value = fileName
  xml.value = nextXml
  xmlHash.value = await sha256Text(nextXml)
  markers.value = nextMarkers.map((marker) => ({ ...marker }))
  currentProjectId.value = preserveProjectId
  selectedWritten.value = 0
  selectedVisitSequence.value = null
  const performancePath = buildPerformancePath(parseMusicXml(nextXml, fileName))
  plan.value = await createPlan('默认排练方案', performancePath, xmlHash.value, {
    migratedFromLegacyMarkers: !preserveProjectId && nextMarkers.length > 0
  })
  await persistProject()
}

async function loadSample() {
  await setScore(
    createSampleXml(),
    'double-ending-tempo-multivoice.musicxml',
    [
      { id: createId(), writtenMeasure: 4, label: '第一遍：一房子后反复', createdAt: Date.now() },
      { id: createId(), writtenMeasure: 5, label: '第二遍：二房子，速度变 140', createdAt: Date.now() }
    ]
  )
  selectedWritten.value = 1
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  const hash = await sha256Text(text)
  const existingSameHash = projects.value.find((item) => item.xmlSha256 === hash)
  if (existingSameHash) {
    await openProject(existingSameHash.id)
  } else if (project.value) {
    await replaceCurrentProjectScore(text, file.name)
  } else {
    await setScore(text, file.name, [])
  }
  input.value = ''
}

async function replaceCurrentProjectScore(nextXml: string, fileName: string) {
  if (!project.value || !plan.value) return
  stopPlayback()
  const newHash = await sha256Text(nextXml)
  const performancePath = buildPerformancePath(parseMusicXml(nextXml, fileName))
  const reconciled = await reconcilePlan(plan.value, performancePath, newHash)
  suppressNextPathReconcile.value = true
  xml.value = nextXml
  xmlHash.value = newHash
  currentFileName.value = fileName
  currentProjectId.value = project.value.id
  selectedWritten.value = 0
  selectedVisitSequence.value = null
  plan.value = reconciled.plan
  const updatedProject: StoredProject = {
    ...project.value,
    title: parseMusicXml(nextXml, fileName).title,
    fileName,
    xml: nextXml,
    xmlSha256: newHash,
    plan: plainClone(reconciled.plan),
    schemaVersion: 2,
    updatedAt: Date.now()
  }
  project.value = updatedProject
  await saveProject(plainClone(updatedProject))
  projects.value = await listProjects()
}

async function openProject(id: string) {
  if (!id) return
  stopPlayback()
  const stored = projects.value.find((p) => p.id === id)
  if (!stored) return
  currentProjectId.value = id
  project.value = stored
  currentFileName.value = stored.fileName
  xml.value = stored.xml
  xmlHash.value = stored.xmlSha256 ?? (await sha256Text(stored.xml))
  markers.value = stored.markers.map((marker) => ({ ...marker }))
  selectedWritten.value = 0
  selectedVisitSequence.value = null

  if (stored.plan) {
    plan.value = plainClone(stored.plan)
    if (await ensurePlanQueues(plan.value)) await persistProject()
    if (!stored.ledger) {
      const ledger = await migrateSnapshotToLedger(plan.value, stored)
      stored.ledger = ledger
      project.value = stored
      await persistProject()
    }
    const ledger = ledgerFromProject()
    if (ledger) {
      ledgerValidation.value = await replayLedger(plan.value, ledger)
      stored.ledger = ledger
      stored.plan = plainClone(plan.value)
      project.value = stored
      await saveProject(plainClone(stored))
      projects.value = await listProjects()
    }
  } else {
    const performancePath = buildPerformancePath(parseMusicXml(stored.xml, stored.fileName))
    const migrated = await createPlan('从旧标记工程迁移的默认方案', performancePath, xmlHash.value, {
      migratedFromLegacyMarkers: stored.markers.length > 0
    })
    plan.value = migrated
    plan.value = migrated
    const migratedProject = await migrateLegacyProject(
      plainClone({ ...stored, xmlSha256: xmlHash.value }),
      plainClone(migrated)
    )
    project.value = migratedProject
    await saveProject(plainClone(migratedProject))
    projects.value = await listProjects()
    await ensurePlanQueues(migrated)
  }
}

async function persistProject() {
  if (!xml.value || !plan.value) return
  const now = Date.now()
  const existing = currentProjectId.value ? projects.value.find((p) => p.id === currentProjectId.value) : undefined
  const stored = plainClone({
    id: currentProjectId.value || createId(),
    title: parseMusicXml(xml.value, currentFileName.value).title,
    fileName: currentFileName.value,
    xml: xml.value,
    xmlSha256: xmlHash.value,
    markers: markers.value.map((marker) => ({ ...marker })),
    plan: plan.value,
    ledger: (project.value?.ledger as EventLedger | undefined) ?? null,
    ledgerMigration: project.value?.ledgerMigration,
    schemaVersion: 3 as const,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
  await saveProject(stored)
  saveState.value = `已保存 ${new Date().toLocaleTimeString()}`
  currentProjectId.value = stored.id
  project.value = stored
  projects.value = await listProjects()
}

async function saveCurrent() {
  if (!plan.value) return
  plan.value.updatedAt = Date.now()
  const created = await appendVersion(plan.value, '手动保存工程', false)
  importMessage.value = created ? '已创建新版本。' : '内容未变化：保存幂等，未产生重复版本。'
  await persistProject()
}

async function removeCurrent() {
  if (!currentProjectId.value) return
  await deleteProject(currentProjectId.value)
  currentProjectId.value = ''
  project.value = null
  projects.value = await listProjects()
}

async function exportData() {
  if (!parsed.value || !plan.value) return
  await exportProjectArtifacts(parsed.value.xml, markers.value, plan.value, project.value?.ledger ?? null, parsed.value.title, currentFileName.value)
}

async function onPlanImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsedJson: unknown = JSON.parse(text)
    const schemaName = typeof parsedJson === 'object' && parsedJson !== null ? (parsedJson as { schema?: string }).schema : ''
    if (schemaName === 'rehearsal-stand-proposal/v1') {
      await onProposalImportContent(parsedJson)
      await nextTick()
    } else if (schemaName === 'rehearsal-stand-ledger/v1') {
      await onLedgerImportContent(parsedJson)
      await nextTick()
    } else {
      const valid = await validateImportedPlan(parsedJson)
      if (!valid.ok) {
        importMessage.value = valid.message
        return
      }
      const result = await importPlanBundle(project.value ?? undefined, valid.bundle)
      importMessage.value = result.message
      if (result.project) {
        await saveProject(result.project)
        projects.value = await listProjects()
        await openProject(result.project.id)
      }
    }
  } catch (error) {
    importMessage.value = `方案 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`
  } finally {
    input.value = ''
  }
}

async function onProposalImportContent(content: unknown) {
  if (!project.value) {
    importMessage.value = '请先打开同乐谱工程。'
    return
  }
  const result = await importProposal(project.value, content)
  importMessage.value = result.message
  const stored = plainClone(project.value)
  await saveProject(stored)
  project.value = stored
  if (stored.plan) plan.value = plainClone(stored.plan)
  projects.value = await listProjects()
}

async function onLedgerImportContent(content: unknown) {
  if (!project.value?.ledger || !plan.value) {
    importMessage.value = '请先打开带方案的工程。'
    return
  }
  const bundle = content as { xmlSha256?: string; ledger?: EventLedger }
  if (bundle.xmlSha256 && bundle.xmlSha256 !== xmlHash.value) {
    importMessage.value = '账本 XML 摘要不匹配，已拒绝导入。'
    return
  }
  if (!bundle.ledger) {
    importMessage.value = '账本文件缺少 ledger 数据。'
    return
  }
  const result = importLedgerEvents(project.value.ledger as EventLedger, bundle.ledger)
  ledgerValidation.value = await replayLedger(plan.value, project.value.ledger as EventLedger)
  await persistProject()
  importMessage.value = result.blocked
    ? `账本导入：${result.applied} 条应用，${result.duplicated} 条重复，${result.quarantined.length} 条隔离并阻塞播放。`
    : `账本导入：${result.applied} 条应用，${result.duplicated} 条重复。`
}

async function createDraftProposal() {
  if (!plan.value || !project.value) return
  const draft = createProposal(plan.value, proposalName.value.trim(), proposalAuthor.value.trim())
  project.value.proposals = project.value.proposals ?? []
  project.value.proposals.push(draft)
  const stored = plainClone(project.value)
  await saveProject(stored)
  project.value = stored
  projects.value = await listProjects()
  currentProjectId.value = stored.id
  activeProposalId.value = draft.id
  proposalQueueId.value = draft.queues[0]?.id ?? ''
  await nextTick()
  proposalName.value = ''
}

async function editActiveProposalItem() {
  const proposal = project.value?.proposals?.find((item) => item.id === activeProposalId.value)
  if (!proposal || !proposalQueueId.value || !proposalItemId.value) return
  proposalUpdateQueueItem(proposal, proposalQueueId.value, proposalItemId.value, {
    loops: proposalItemLoops.value,
    tempoScale: proposalItemTempo.value
  })
  const stored = plainClone(project.value!)
  await saveProject(stored)
  project.value = stored
  projects.value = await listProjects()
}

async function moveActiveProposalItem(direction: -1 | 1) {
  const proposal = project.value?.proposals?.find((item) => item.id === activeProposalId.value)
  if (!proposal) return
  proposalReorderQueueItem(proposal, proposalQueueId.value, proposalItemId.value, direction)
  const stored = plainClone(project.value!)
  await saveProject(stored)
  project.value = stored
  projects.value = await listProjects()
}

async function deleteActiveProposalItem() {
  const proposal = project.value?.proposals?.find((item) => item.id === activeProposalId.value)
  if (!proposal) return
  proposalDeleteQueueItem(proposal, proposalQueueId.value, proposalItemId.value)
  proposalItemId.value = ''
  const stored = plainClone(project.value!)
  await saveProject(stored)
  project.value = stored
  projects.value = await listProjects()
}

async function exportActiveProposal(proposal: { id: string }) {
  if (!parsed.value || !project.value) return
  const full = project.value.proposals?.find((item) => item.id === proposal.id)
  if (!full) return
  await exportProposal(parsed.value.xml, full, parsed.value.title, currentFileName.value)
}

function proposalMergeStatus(proposalId: string): string {
  const pending = project.value?.pendingMerges?.some((item) => item.proposal.id === proposalId)
  if (pending) return '存在待处理冲突'
  const merged = project.value?.mergeRecords?.some((item) => item.proposalId === proposalId && !item.undoneAt)
  return merged ? '已合并' : '可导入/待合并'
}

function formatConflictValue(value: unknown): string {
  if (value && typeof value === 'object' && 'visitKey' in value) return String((value as { visitKey: string }).visitKey)
  if (Array.isArray(value)) return value.join(', ')
  return String(value ?? '—')
}

function hasUnresolvedConflict(proposalId: string): boolean {
  const pending = project.value?.pendingMerges?.find((item) => item.proposal.id === proposalId)
  return !pending || unresolvedConflicts(pending).length > 0
}

function resolvePendingConflict(proposalId: string, conflictId: string, resolution: 'local' | 'proposal') {
  const pending = project.value?.pendingMerges?.find((item) => item.proposal.id === proposalId)
  if (!pending) return
  resolveConflict(pending, conflictId, resolution)
}

async function applyPendingMerge(proposalId: string) {
  if (!project.value?.plan) return
  const pending = project.value.pendingMerges?.find((item) => item.proposal.id === proposalId)
  if (!pending || unresolvedConflicts(pending).length) return
  const result = await applyMerge(project.value.plan, pending.proposal, pending.conflicts)
  if (!result.record) return
  project.value.mergeRecords = project.value.mergeRecords ?? []
  project.value.mergeRecords.push(result.record)
  project.value.pendingMerges = (project.value.pendingMerges ?? []).filter((item) => item.proposal.id !== proposalId)
  const proposal = project.value.proposals?.find((item) => item.id === proposalId)
  if (proposal) proposal.status = 'merged'
  plan.value = plainClone(project.value.plan)
  await appendProjectLedgerEvent({
    type: 'proposal.merge',
    xmlSha256: xmlHash.value,
    pathChecksum: plan.value.pathChecksum,
    planVersion: plan.value.versions[0]?.version ?? 1,
    summary: `合并提案：${pending.proposal.name}`,
    entityType: 'proposal',
    entityId: proposalId,
    after: { proposalId, inverse: result.record.inverse.length }
  })
  await saveProject(project.value)
}

async function discardPendingMerge(proposalId: string) {
  if (!project.value) return
  const pending = project.value.pendingMerges?.find((item) => item.proposal.id === proposalId)
  if (pending) pending.proposal.status = 'imported'
  importMessage.value = '提案保留为历史，未应用。'
  await saveProject(project.value)
}

async function undoRecord(recordId: string) {
  if (!project.value?.plan) return
  const record = project.value.mergeRecords?.find((item) => item.id === recordId)
  if (!record) return
  await undoMerge(project.value.plan, record)
  plan.value = plainClone(project.value.plan)
  await appendProjectLedgerEvent({
    type: 'proposal.undo',
    xmlSha256: xmlHash.value,
    pathChecksum: plan.value.pathChecksum,
    planVersion: plan.value.versions[0]?.version ?? 1,
    summary: `撤销提案合并：${record.proposalName}`,
    entityType: 'proposal',
    entityId: record.proposalId,
    after: { mergeRecordId: record.id }
  })
  await saveProject(project.value)
}

function visitsForWritten(index: number) {
  return path.value.visits.filter((v) => v.writtenMeasure === index)
}

function selectWritten(index: number) {
  selectedWritten.value = index
  selectedVisitSequence.value = null
}

function selectVisit(visit: PathVisit) {
  selectedVisitSequence.value = visit.sequence
  currentVisitKey.value = visit.visitKey
  selectedWritten.value = visit.writtenMeasure
  display.value?.showMeasure(visit.writtenMeasure)
}

function shortHash(value: string): string {
  return value.slice(0, 10)
}

async function renamePlan() {
  if (!plan.value || !planName.value.trim() || plan.value.name === planName.value.trim()) {
    planName.value = plan.value?.name ?? ''
    return
  }
  plan.value.name = planName.value.trim()
  await appendVersion(plan.value, `重命名方案为“${plan.value.name}”`, false)
  await persistProject()
}

async function addSegment() {
  if (!plan.value || !canAddSegment.value) return
  const startVisit = path.value.visits.find((v) => v.visitKey === newSegmentStartKey.value)
  const endVisit = path.value.visits.find((v) => v.visitKey === newSegmentEndKey.value)
  if (!startVisit || !endVisit || startVisit.sequence > endVisit.sequence) return
  const segment = addPlanSegment(
    plan.value,
    newSegmentName.value.trim(),
    endpointFromVisit(startVisit),
    endpointFromVisit(endVisit),
    newSegmentLoops.value
  )
  await appendVersion(plan.value, `创建段落“${segment.name}”并生成会话`, false)
  newSegmentName.value = ''
  newSegmentStartKey.value = ''
  newSegmentEndKey.value = ''
  await persistProject()
}

async function addNamedQueue() {
  if (!plan.value || !newQueueName.value.trim()) return
  createQueue(plan.value, newQueueName.value.trim())
  newQueueName.value = ''
  await appendVersion(plan.value, '建立具名分部队列', false)
  await persistProject()
}

async function addExistingSegmentToQueue(queue: PartQueue) {
  if (!plan.value || !queueItemSegmentId.value) return
  const segment = plan.value.segments.find((candidate) => candidate.id === queueItemSegmentId.value)
  if (!segment) return
  const item = createQueueItem(segment, queueItemLoops.value, queueItemTempo.value)
  addQueueItem(plan.value, queue.id, item)
  queueItemSegmentId.value = ''
  queueItemLoops.value = 1
  queueItemTempo.value = 1
  await appendVersion(plan.value, `向“${queue.name}”加入段落“${segment.name}”`, false)
  await persistProject()
}

async function moveQueueItem(queueId: string, itemId: string, direction: -1 | 1) {
  if (!plan.value) return
  moveQueueItemInPlan(plan.value, queueId, itemId, direction)
  const queue = plan.value.queues.find((candidate) => candidate.id === queueId)
  await appendVersion(plan.value, `调整“${queue?.name ?? '分部'}”队列顺序`, false)
  await persistProject()
}

async function removeQueueItem(queueId: string, itemId: string) {
  if (!plan.value) return
  removeQueueItemById(plan.value, queueId, itemId)
  await appendVersion(plan.value, '从分部队列移除段落，其他分部历史保留', false)
  await persistProject()
}

function queuePositionText(queue: PartQueue): string {
  if (queue.position?.completed || queue.completedAllAt) return '队列已完成'
  if (!queue.position) return '未开始'
  const item = queue.items.find((candidate) => candidate.id === queue.position?.itemId)
  if (!item) return '恢复位置失效'
  return `${item.segmentName} · 循环${queue.position.loopIndex + 1} · 第${queue.position.measureQuarter + 1}拍`
}

async function playQueue(queue: PartQueue, restart = false) {
  if (!plan.value || (ledgerValidation.value && !ledgerValidation.value.ok)) return
  const summary = queueSummary(queue)
  const pendingBlocked = new Set(
    (project.value?.pendingMerges ?? []).flatMap((pending) =>
      pending.conflicts
        .filter((conflict) => conflict.entityType === 'queue-item')
        .map((conflict) => conflict.entityId)
    )
  )
  if (summary.blocked > 0 || summary.pending > 0 || queue.items.some((item) => pendingBlocked.has(item.id))) return
  const resume = restart || queue.position?.completed ? null : queue.position
  const playback = buildQueuePlayback(queue, path.value.visits, path.value.pulses, resume)
  if (!playback) return
  const liveQueue = plan.value.queues.find((candidate) => candidate.id === queue.id) ?? queue
  let ledger = ledgerFromProject()
  if (!ledger) {
    ledger = await createLedger(xmlHash.value, plan.value.pathChecksum, plan.value.versions[0]?.version ?? 1)
    if (!project.value) {
      const now = Date.now()
      project.value = {
        id: currentProjectId.value || createId(),
        title: parsed.value?.title ?? currentFileName.value,
        fileName: currentFileName.value,
        xml: xml.value,
        xmlSha256: xmlHash.value,
        markers: markers.value,
        plan: plan.value,
        schemaVersion: 3,
        createdAt: now,
        updatedAt: now
      }
    }
    project.value.ledger = ledger
  }
  const runId = startQueueRun(liveQueue, restart)
  if (ledger) {
    const event = await appendLedgerEvent({
      ledger,
      type: 'queue.run-start',
      xmlSha256: xmlHash.value,
      pathChecksum: plan.value.pathChecksum,
      planVersion: plan.value.versions[0]?.version ?? 1,
      summary: `开始队列播放：${liveQueue.name}`,
      entityType: 'queue',
      entityId: liveQueue.id,
      after: { queueId: liveQueue.id, position: liveQueue.position }
    })
    createCheckpoint(ledger, plan.value, event)
  }
  await persistProject()
  const { context, metro } = ensureAudio()
  await context.resume()
  activePlayback.value = { queue: liveQueue, itemId: playback.startPosition.itemId, runId }
  currentVisitKey.value = playback.startPosition.visitKey
  metro.startCustom(playback.pulses, playback.visits, 1)
  playing.value = true
}

function sessionsForSegment(segmentId: string): RehearsalSession[] {
  return plan.value?.sessions.filter((session) => session.segmentIds.includes(segmentId)) ?? []
}

function segmentSequenceText(segment: RehearsalSegment): string {
  if (!plan.value) return ''
  const visits = segmentVisits(plan.value, segment)
  return visits.map((visit) => `${visit.printedNumber}${visit.endingNumber ? `(房${visit.endingNumber})` : ''}`).join(' → ')
}

function sessionProgressText(segment: RehearsalSegment, session: RehearsalSession): string {
  if (segment.historical) return '历史保留，不可播放'
  if (!session.position || session.position.segmentId !== segment.id) {
    return `未开始，将从 ${describeEndpoint(segment.start)} 开始，循环 ${session.segmentLoops[segment.id] ?? segment.loops} 次`
  }
  const visit = plan.value?.currentSnapshot.visits.find((v) => v.visitKey === session.position?.visitKey)
  const suffix = session.position.completed
    ? '已完成'
    : `中断于循环${session.position.loopIndex + 1} · ${visit ? describeEndpoint(visit) : '未知'}`
  return suffix
}

function canPlaySegment(segment: RehearsalSegment): boolean {
  return !segment.historical && !mismatches.value.some((m) => m.segmentId === segment.id)
}

function resumeButtonText(segment: RehearsalSegment, session: RehearsalSession): string {
  return session.position && !session.position.completed ? '从中断位置恢复循环' : `从段落起点播放 ${session.segmentLoops[segment.id] ?? segment.loops} 次`
}

async function playSegment(segment: RehearsalSegment, session: RehearsalSession) {
  if (!plan.value || mismatches.value.length) return
  const resumePosition = session.position?.completed ? null : session.position
  const playback = buildSegmentPlayback(segment, session, path.value.visits, path.value.pulses, resumePosition)
  if (!playback) return
  const { context, metro } = ensureAudio()
  await context.resume()
  activePlayback.value = { segment, session }
  currentVisitKey.value = playback.startPosition.visitKey
  metro.startCustom(playback.pulses, playback.visits, rate.value)
  playing.value = true
}

async function resetSessionProgress(session: RehearsalSession) {
  if (!plan.value) return
  updateSessionProgress(plan.value, session, null)
  await persistProject()
}

async function resolveOne(mismatchId: string, action: 'rebind' | 'historical' | 'delete', chosenKey?: string) {
  if (!plan.value) return
  await resolveMismatch(plan.value, mismatchId, action, chosenKey)
  await persistProject()
}

function ensureAudio(): { context: AudioContext; metro: Metronome } {
  if (!audioContext.value) {
    audioContext.value = new AudioContext()
    metronome.value = new Metronome({
      audio: audioContext.value,
      onPulse: (pulse, fraction) => {
        currentPulse.value = pulse
        currentVisitKey.value = pulse.visitKey
        display.value?.showMeasure(pulse.writtenMeasure, fraction)
        if (activePlayback.value?.queue) {
          const queue = activePlayback.value.queue
          const item = queue.items.find((candidate) => candidate.id === pulse.queueItemId || candidate.id === activePlayback.value?.itemId)
          if (item) {
            activePosition.value = {
              queueId: queue.id,
              itemId: item.id,
              segmentId: item.segmentId,
              visitKey: pulse.visitKey,
              loopIndex: pulse.loopIndex ?? 0,
              measureQuarter: pulse.measureQuarter,
              updatedAt: Date.now(),
              completed: false,
              runId: activePlayback.value.runId
            }
          }
        } else if (activePlayback.value?.segment && activePlayback.value.session) {
          activePosition.value = {
            segmentId: activePlayback.value.segment.id,
            visitKey: pulse.visitKey,
            loopIndex: pulse.loopIndex ?? 0,
            measureQuarter: pulse.measureQuarter,
            updatedAt: Date.now(),
            completed: false
          }
        }
      },
      onVisit: (visit) => {
        currentVisitKey.value = visit.visitKey
        display.value?.showMeasure(visit.writtenMeasure, 0)
        if (activePlayback.value?.queue && visit.queueItemId) {
          activePlayback.value.itemId = visit.queueItemId
        }
      },
      onVisitEnd: async (visit) => {
        if (!activePlayback.value?.queue || !plan.value || !visit.queueItemEnd || !visit.queueItemId) return
        const liveQueue = plan.value.queues.find((candidate) => candidate.id === activePlayback.value?.queue?.id)
        if (liveQueue && visit.queueItemId) {
          const before = { position: plainClone(liveQueue.position), completions: plainClone(liveQueue.completions) }
          const result = advanceQueueItem(plan.value, liveQueue.id, visit.queueItemId, activePlayback.value.runId)
          if (result.status === 'finished' && !liveQueue.completedAllAt) liveQueue.completedAllAt = Date.now()
          const ledger = ledgerFromProject()
          if (ledger) {
            const eventType = result.status === 'finished' ? 'queue.finished' : 'queue.item-complete'
            const event = await appendLedgerEvent({
              ledger,
              type: eventType,
              xmlSha256: xmlHash.value,
              pathChecksum: plan.value.pathChecksum,
              planVersion: plan.value.versions[0]?.version ?? 1,
              summary: eventType === 'queue.finished' ? `队列完成：${liveQueue.name}` : `队列项边界完成：${visit.queueItemId}`,
              entityType: eventType === 'queue.finished' ? 'queue' : 'queue-item',
              entityId: eventType === 'queue.finished' ? liveQueue.id : visit.queueItemId,
              before,
              after: {
                queueId: liveQueue.id,
                position: liveQueue.position,
                completion: liveQueue.completions.at(-1),
                completedAllAt: liveQueue.completedAllAt
              }
            })
            createCheckpoint(ledger, plan.value, event)
          }
          await persistProject()
        }
      },
      onStop: async (completed) => {
        playing.value = false
        // On natural completion the final onVisitEnd already advanced state and persisted.
        if (!completed && activePlayback.value?.queue && plan.value) {
          const queueId = activePlayback.value.queue.id
          const liveQueue = plan.value.queues.find((candidate) => candidate.id === queueId)
          if (liveQueue && activePosition.value && 'queueId' in activePosition.value) {
            const ledger = ledgerFromProject()
            const position: QueuePosition = { ...activePosition.value, runId: activePlayback.value.runId }
            updateQueueProgress(plan.value, liveQueue.id, position)
            if (ledger) {
              await appendLedgerEvent({
                ledger,
                type: 'queue.pause',
                xmlSha256: xmlHash.value,
                pathChecksum: plan.value.pathChecksum,
                planVersion: plan.value.versions[0]?.version ?? 1,
                summary: `队列暂停：${liveQueue.name}`,
                entityType: 'queue',
                entityId: liveQueue.id,
                after: { queueId: liveQueue.id, position }
              })
            }
          }
          await persistProject()
        }
        if (activePlayback.value?.segment && activePlayback.value.session && plan.value) {
          const { segment, session } = activePlayback.value
          const position: SessionPosition | null = completed
            ? {
                segmentId: segment.id,
                visitKey: segment.end.visitKey,
                loopIndex: (session.segmentLoops[segment.id] ?? segment.loops) - 1,
                measureQuarter: 0,
                updatedAt: Date.now(),
                completed: true
              }
            : activePosition.value ?? session.position
          if (position) updateSessionProgress(plan.value, session, position)
          await persistProject()
        }
      }
    })
    metronome.value.setData(path.value.pulses, path.value.visits)
  }
  return { context: audioContext.value, metro: metronome.value! }
}

function togglePlay() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!canPlayFullPath.value) return
  const { context, metro } = ensureAudio()
  void context.resume()
  const startVisit = selectedVisit.value ?? path.value.visits[0]
  currentVisitKey.value = startVisit.visitKey
  activePlayback.value = null
  metro.start(startVisit.sequence, rate.value)
  playing.value = true
}

function stopPlayback(notify = true) {
  metronome.value?.stop(notify, false)
  playing.value = false
}

async function addMarker() {
  if (selectedWritten.value === null || !newMarkerLabel.value.trim()) return
  markers.value.push({ id: createId(), writtenMeasure: selectedWritten.value, label: newMarkerLabel.value.trim(), createdAt: Date.now() })
  newMarkerLabel.value = ''
  await persistProject()
}

async function removeMarker(id: string) {
  markers.value = markers.value.filter((m) => m.id !== id)
  await persistProject()
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Keep the import referenced so tree-shaking preserves savePlanRevision in future manual re-snapshot flows.
void savePlanRevision
</script>
