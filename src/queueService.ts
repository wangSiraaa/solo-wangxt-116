import { fnv1aHash } from './crypto'
import { createId } from './db'
import { plainClone } from './plainClone'
import type {
  PartQueue,
  PartQueueItem,
  PlanMismatch,
  QueueCompletion,
  QueuePosition,
  RehearsalPlan,
  RehearsalSegment,
  SegmentEndpoint
} from './types'

const EMPTY_QUEUE_HASH = 'empty'

export function ensureQueues(plan: RehearsalPlan): boolean {
  if (Array.isArray(plan.queues)) return false
  plan.queues = []
  return true
}

export function queueContentHash(queue: Pick<PartQueue, 'name' | 'items'>): string {
  return fnv1aHash({
    name: queue.name,
    items: queue.items.map((item) => ({
      segmentId: item.segmentId,
      segmentName: item.segmentName,
      start: item.start.visitKey,
      end: item.end.visitKey,
      loops: item.loops,
      tempoScale: item.tempoScale
    }))
  })
}

export function fullQueueHash(queue: PartQueue): string {
  return fnv1aHash({
    content: queueContentHash(queue),
    position: queue.position,
    completions: queue.completions.map((completion) => ({
      itemId: completion.itemId,
      segmentId: completion.segmentId,
      completedAt: completion.completedAt
    })),
    updatedAt: queue.updatedAt
  })
}

export function createQueue(plan: RehearsalPlan, name: string, items: PartQueueItem[] = []): PartQueue {
  ensureQueues(plan)
  const now = Date.now()
  const queue: PartQueue = {
    id: createId(),
    name,
    items: items.map((item) => ({ ...item })),
    position: null,
    completions: [],
    createdAt: now,
    updatedAt: now
  }
  plan.queues.push(queue)
  plan.updatedAt = now
  return queue
}

export function createQueueItem(segment: RehearsalSegment, loops = segment.loops, tempoScale = 1): PartQueueItem {
  const now = Date.now()
  return {
    id: createId(),
    segmentId: segment.id,
    segmentName: segment.name,
    start: plainClone(segment.start),
    end: plainClone(segment.end),
    loops: Math.max(1, loops),
    tempoScale,
    status: segment.historical ? 'historical' : 'ready',
    createdAt: now,
    updatedAt: now
  }
}

export function addQueueItem(plan: RehearsalPlan, queueId: string, item: PartQueueItem): boolean {
  ensureQueues(plan)
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  if (!queue) return false
  queue.items.push(item)
  touchQueue(queue)
  return true
}

export function removeQueueItem(plan: RehearsalPlan, queueId: string, itemId: string): boolean {
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  if (!queue) return false
  queue.items = queue.items.filter((item) => item.id !== itemId)
  if (queue.position?.itemId === itemId) queue.position = null
  queue.completions = queue.completions.filter((completion) => completion.itemId !== itemId)
  plan.mismatches = plan.mismatches.filter((mismatch) => !(mismatch.queueId === queueId && mismatch.itemId === itemId))
  touchQueue(queue)
  return true
}

export function moveQueueItem(plan: RehearsalPlan, queueId: string, itemId: string, direction: -1 | 1): boolean {
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  if (!queue) return false
  const index = queue.items.findIndex((item) => item.id === itemId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= queue.items.length) return false
  const [item] = queue.items.splice(index, 1)
  queue.items.splice(target, 0, item)
  touchQueue(queue)
  return true
}

export function updateQueueItem(
  plan: RehearsalPlan,
  queueId: string,
  itemId: string,
  patch: Partial<Pick<PartQueueItem, 'loops' | 'tempoScale' | 'note'>>
): boolean {
  const item = plan.queues.find((queue) => queue.id === queueId)?.items.find((candidate) => candidate.id === itemId)
  if (!item) return false
  if (patch.loops !== undefined) item.loops = Math.max(1, patch.loops)
  if (patch.tempoScale !== undefined) item.tempoScale = Math.max(0.1, patch.tempoScale)
  if (patch.note !== undefined) item.note = patch.note
  item.updatedAt = Date.now()
  touchQueue(plan.queues.find((queue) => queue.id === queueId)!)
  return true
}

export function renameQueue(plan: RehearsalPlan, queueId: string, name: string): boolean {
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  if (!queue) return false
  queue.name = name
  touchQueue(queue)
  return true
}

export function deleteQueue(plan: RehearsalPlan, queueId: string): boolean {
  const before = plan.queues.length
  plan.queues = plan.queues.filter((queue) => queue.id !== queueId)
  plan.mismatches = plan.mismatches.filter((mismatch) => mismatch.queueId !== queueId)
  plan.updatedAt = Date.now()
  return before !== plan.queues.length
}

export function updateQueueProgress(plan: RehearsalPlan, queueId: string, position: QueuePosition | null) {
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  if (!queue) return
  queue.position = position
  touchQueue(queue)
}

export function startQueueRun(queue: PartQueue, restart = false): string {
  const runId = createId()
  queue.activeRunId = runId
  queue.completedAllAt = undefined
  if (restart || !queue.position || queue.position.completed) {
    const first = queue.items.find((item) => item.status === 'ready')
    queue.position = first
      ? {
          queueId: queue.id,
          itemId: first.id,
          segmentId: first.segmentId,
          visitKey: first.start.visitKey,
          loopIndex: 0,
          measureQuarter: 0,
          updatedAt: Date.now(),
          completed: false,
          runId
        }
      : null
  }
  touchQueue(queue)
  return runId
}

export function advanceQueueItem(
  plan: RehearsalPlan,
  queueId: string,
  completedItemId: string,
  runId: string | undefined
): { status: 'next' | 'finished' | 'blocked'; position: QueuePosition | null } {
  const queue = plan.queues.find((candidate) => candidate.id === queueId)
  const item = queue?.items.find((candidate) => candidate.id === completedItemId)
  if (!queue || !item) return { status: 'blocked', position: null }

  if (!queue.completions.some((completion) => completion.itemId === completedItemId && completion.runId === runId)) {
    const completion: QueueCompletion = {
      id: createId(),
      runId,
      itemId: item.id,
      segmentId: item.segmentId,
      segmentName: item.segmentName,
      loops: item.loops,
      tempoScale: item.tempoScale,
      completedAt: Date.now()
    }
    queue.completions.push(completion)
  }

  const nextItemId = queue.position?.itemId
  const currentIndex = queue.items.findIndex((candidate) => candidate.id === completedItemId)
  const searchStart = nextItemId === completedItemId ? currentIndex + 1 : Math.max(0, currentIndex)
  const next = queue.items.slice(searchStart).find((candidate) => candidate.status === 'ready')
  const blocked = queue.items.slice(currentIndex + 1).find((candidate) => candidate.status !== 'ready')

  if (next) {
    const position: QueuePosition = {
      queueId: queue.id,
      itemId: next.id,
      segmentId: next.segmentId,
      visitKey: next.start.visitKey,
      loopIndex: 0,
      measureQuarter: 0,
      updatedAt: Date.now(),
      completed: false,
      runId
    }
    queue.position = position
    queue.completedAllAt = undefined
    touchQueue(queue)
    return { status: 'next', position }
  }

  const finalPosition: QueuePosition = {
    queueId: queue.id,
    itemId: item.id,
    segmentId: item.segmentId,
    visitKey: item.end.visitKey,
    loopIndex: Math.max(0, item.loops - 1),
    measureQuarter: 0,
    updatedAt: Date.now(),
    completed: true,
    runId
  }
  queue.position = finalPosition
  if (!blocked) queue.completedAllAt = Date.now()
  touchQueue(queue)
  return { status: blocked ? 'blocked' : 'finished', position: finalPosition }
}

export function queueSummary(queue: PartQueue): {
  next: PartQueueItem | null
  completed: number
  pending: number
  ready: number
  blocked: number
  finished: boolean
} {
  const pending = queue.items.filter((item) => item.status === 'pending').length
  const historical = queue.items.filter((item) => item.status === 'historical').length
  const currentItemId = queue.position?.itemId
  const currentIndex = queue.items.findIndex((item) => item.id === currentItemId)
  const next =
    queue.position?.completed
      ? null
      : queue.items.slice(Math.max(0, currentIndex)).find((item) => item.status === 'ready') ??
        queue.items.find((item) => item.status === 'ready') ??
        null
  const runId = queue.position?.runId ?? queue.activeRunId
  const completedThisRun = runId
    ? queue.completions.filter((completion) => completion.runId === runId).length
    : queue.completions.length
  return {
    next,
    completed: completedThisRun,
    pending,
    ready: queue.items.filter((item) => item.status === 'ready').length,
    blocked: pending + historical,
    finished: !!queue.completedAllAt
  }
}

export function validateQueuesAfterSegmentChange(plan: RehearsalPlan) {
  ensureQueues(plan)
  const currentSegmentIds = new Set(plan.segments.map((segment) => segment.id))
  for (const queue of plan.queues) {
    for (const item of queue.items) {
      const segment = plan.segments.find((candidate) => candidate.id === item.segmentId)
      if (!currentSegmentIds.has(item.segmentId) || !segment) {
        item.status = 'historical'
        item.removedSegment = true
        item.note = '原段落已删除；完成记录保留，此队列项不可播放。'
        addMismatchForItem(plan, queue, item, item.start, 'start', '关联段落已从方案删除；完成记录保留，队列项不可播放。')
      } else if (segment.historical) {
        item.status = 'historical'
        item.note = segment.note
      } else {
        syncItemEndpoints(item, segment)
      }
    }
  }
}

export function markQueueMismatches(
  plan: RehearsalPlan,
  previousXmlHash: string,
  currentHasVisit: (key: string) => boolean,
  signatureMatches: (endpoint: SegmentEndpoint) => boolean,
  candidatesFor: (endpoint: SegmentEndpoint) => SegmentEndpoint[]
) {
  ensureQueues(plan)
  for (const queue of plan.queues) {
    for (const item of queue.items) {
      if (item.status === 'historical') continue
      const startOk = currentHasVisit(item.start.visitKey) && signatureMatches(item.start)
      const endOk = currentHasVisit(item.end.visitKey) && signatureMatches(item.end)
      if (!startOk || !endOk) {
        item.status = 'pending'
        const side = !startOk ? 'start' : 'end'
        const endpoint = !startOk ? item.start : item.end
        const kind = previousXmlHash !== plan.xmlSha256 ? 'score-content' : 'missing-visit'
        addMismatchForItem(
          plan,
          queue,
          item,
          endpoint,
          side,
          kind === 'score-content'
            ? `分部队列“${queue.name}”的段落“${item.segmentName}”${side === 'start' ? '起点' : '终点'}因乐谱内容变更失配；必须显式重绑，不能跳到同书面小节。`
            : `分部队列“${queue.name}”的段落“${item.segmentName}”${side === 'start' ? '起点' : '终点'}已从路径消失；必须显式重绑，不能跳到同书面小节。`,
          candidatesFor(endpoint)
        )
      } else {
        item.status = 'ready'
      }
    }

    if (queue.position) {
      const item = queue.items.find((candidate) => candidate.id === queue.position?.itemId)
      if (!item || item.status !== 'ready' || !currentHasVisit(queue.position.visitKey)) {
        plan.mismatches.push({
          id: createId(),
          kind: previousXmlHash !== plan.xmlSha256 ? 'score-content' : 'missing-visit',
          subject: 'queue-position',
          queueId: queue.id,
          itemId: item?.id,
          segmentId: item?.segmentId ?? queue.position.segmentId,
          expected: {
            ...queue.position,
            writtenMeasure: undefined,
            printedNumber: ''
          },
          candidates: [],
          message: `分部队列“${queue.name}”的恢复位置已失效；请先处理对应段落，再从段落边界重新开始。`,
          resolved: false
        })
      }
    }
  }
}

export function rebindQueueItem(
  plan: RehearsalPlan,
  mismatchId: string,
  chosenStart: SegmentEndpoint | null,
  chosenEnd: SegmentEndpoint | null
): boolean {
  const mismatch = plan.mismatches.find((item) => item.id === mismatchId)
  if (!mismatch || mismatch.subject !== 'queue-item' || !mismatch.queueId || !mismatch.itemId) return false
  const queue = plan.queues.find((candidate) => candidate.id === mismatch.queueId)
  const item = queue?.items.find((candidate) => candidate.id === mismatch.itemId)
  if (!queue || !item) return false
  if (mismatch.endpointSide === 'start' && chosenStart) item.start = plainClone(chosenStart)
  if (mismatch.endpointSide === 'end' && chosenEnd) item.end = plainClone(chosenEnd)
  const otherSideMissing = mismatch.endpointSide === 'start'
    ? !item.end.visitKey
    : !item.start.visitKey
  const otherMismatch = plan.mismatches.find(
    (candidate) =>
      candidate.queueId === queue.id &&
      candidate.itemId === item.id &&
      candidate.subject === 'queue-item' &&
      candidate.id !== mismatch.id
  )
  if (!otherMismatch && !otherSideMissing) item.status = 'ready'
  mismatch.resolved = true
  mismatch.resolution = 'rebound'
  plan.mismatches = plan.mismatches.filter((candidate) => !candidate.resolved)
  queue.updatedAt = Date.now()
  plan.updatedAt = queue.updatedAt
  return true
}

export function markQueueItemHistorical(plan: RehearsalPlan, mismatchId: string): boolean {
  const mismatch = plan.mismatches.find((item) => item.id === mismatchId)
  if (!mismatch?.queueId || !mismatch.itemId) return false
  const queue = plan.queues.find((candidate) => candidate.id === mismatch.queueId)
  const item = queue?.items.find((candidate) => candidate.id === mismatch.itemId)
  if (!queue || !item) return false
  item.status = 'historical'
  item.note = mismatch.message
  for (const related of plan.mismatches.filter((candidate) => candidate.queueId === queue.id && candidate.itemId === item.id)) {
    related.resolved = true
    related.resolution = 'historical'
  }
  plan.mismatches = plan.mismatches.filter((candidate) => !candidate.resolved)
  touchQueue(queue)
  return true
}

export function removeQueueMismatchItem(plan: RehearsalPlan, mismatchId: string): boolean {
  const mismatch = plan.mismatches.find((item) => item.id === mismatchId)
  if (!mismatch?.queueId || !mismatch.itemId) return false
  removeQueueItem(plan, mismatch.queueId, mismatch.itemId)
  plan.mismatches = plan.mismatches.filter((item) => item.id !== mismatchId)
  return true
}

export function migrateSessionsToDefaultQueue(plan: RehearsalPlan): PartQueue | null {
  ensureQueues(plan)
  if (plan.queues.length) return plan.queues[0]
  const queue = createQueue(plan, '默认分部', [])
  for (const session of plan.sessions) {
    for (const segmentId of session.segmentIds) {
      const segment = plan.segments.find((candidate) => candidate.id === segmentId)
      if (!segment) continue
      const item = createQueueItem(segment, session.segmentLoops[segmentId] ?? segment.loops, 1)
      queue.items.push(item)
      if (session.position?.segmentId === segment.id) {
        queue.position = {
          queueId: queue.id,
          itemId: item.id,
          segmentId: segment.id,
          visitKey: session.position.visitKey,
          loopIndex: session.position.loopIndex,
          measureQuarter: session.position.measureQuarter,
          updatedAt: session.position.updatedAt,
          completed: session.position.completed
        }
      }
    }
  }
  touchQueue(queue)
  return queue
}

function syncItemEndpoints(item: PartQueueItem, segment: RehearsalSegment) {
  // Queue items intentionally retain their own endpoint snapshots. Do not overwrite them on
  // unrelated edits; reconciliation creates explicit mismatches when path identity changes.
  if (!item.start.visitKey) item.start = plainClone(segment.start)
  if (!item.end.visitKey) item.end = plainClone(segment.end)
}

function addMismatchForItem(
  plan: RehearsalPlan,
  queue: PartQueue,
  item: PartQueueItem,
  endpoint: SegmentEndpoint,
  side: 'start' | 'end',
  message: string,
  candidates: SegmentEndpoint[] = []
) {
  if (
    plan.mismatches.some(
      (mismatch) =>
        mismatch.subject === 'queue-item' &&
        mismatch.queueId === queue.id &&
        mismatch.itemId === item.id &&
        mismatch.endpointSide === side
    )
  ) {
    return
  }
  const mismatch: PlanMismatch = {
    id: createId(),
    kind: plan.xmlSha256 ? 'score-content' : 'missing-visit',
    subject: 'queue-item',
    queueId: queue.id,
    itemId: item.id,
    segmentId: item.segmentId,
    endpointSide: side,
    expected: endpoint,
    candidates,
    message,
    resolved: false
  }
  plan.mismatches.push(mismatch)
}

function touchQueue(queue: PartQueue) {
  queue.updatedAt = Date.now()
}

export { EMPTY_QUEUE_HASH }
