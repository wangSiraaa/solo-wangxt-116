import { createId } from './db'
import { plainClone } from './plainClone'
import { appendVersion } from './planService'
import { createPendingMerge, normalizeProposal } from './proposalService'
import type {
  MergeConflict,
  MergeRecord,
  PartQueue,
  PartQueueItem,
  PendingMerge,
  RehearsalChangeProposal,
  RehearsalPlan
} from './types'

export interface ApplyMergeResult {
  plan: RehearsalPlan
  record: MergeRecord
  pending?: PendingMerge
}

function setField(target: Record<string, unknown>, field: string, value: unknown) {
  const key = field.split('.').pop()!
  target[key] = plainClone(value)
}

export function resolveConflict(
  pending: PendingMerge,
  conflictId: string,
  resolution: MergeConflict['resolution'],
  customValue?: unknown
) {
  const conflict = pending.conflicts.find((item) => item.id === conflictId)
  if (!conflict) return
  conflict.resolution = resolution
  conflict.mergedValue =
    resolution === 'local'
      ? plainClone(conflict.local)
      : resolution === 'proposal'
        ? plainClone(conflict.proposal)
        : customValue === undefined
          ? plainClone(conflict.local)
          : plainClone(customValue)
  conflict.resolvedAt = Date.now()
}

export function unresolvedConflicts(pending: PendingMerge): MergeConflict[] {
  return pending.conflicts.filter((conflict) => !conflict.resolution)
}

export async function applyMerge(plan: RehearsalPlan, proposal: RehearsalChangeProposal, conflicts: MergeConflict[]): Promise<ApplyMergeResult> {
  if (conflicts.some((conflict) => !conflict.resolution)) {
    const pending = createPendingMerge(plan, proposal)
    pending.conflicts = plainClone(conflicts)
    return { plan, record: undefined as never, pending }
  }

  const normalized = normalizeProposal(plainClone(proposal))
  const inverse: MergeRecord['inverse'] = []
  const baseVersion = plan.versions.find((version) => version.id === normalized.base.versionId)

  const touchedItemIds = new Set(
    normalized.ops
      .filter((op) => op.type.startsWith('queue-item'))
      .map((op) => op.targetId)
  )
  const touchedSegmentIds = new Set(
    normalized.ops
      .filter((op) => op.type.startsWith('segment'))
      .map((op) => op.targetId)
  )

  // Segments: proposal-created, updated or deleted. Completions always remain untouched.
  for (const proposalSegment of normalized.segments) {
    const wasTouched = !baseVersion?.segments.some((segment) => segment.id === proposalSegment.id) || touchedSegmentIds.has(proposalSegment.id)
    if (!wasTouched) continue
    const localSegment = plan.segments.find((segment) => segment.id === proposalSegment.id)
    const baseSegment = baseVersion?.segments.find((segment) => segment.id === proposalSegment.id)
    if (!localSegment && !baseSegment) {
      plan.segments.push(plainClone(proposalSegment))
      continue
    }
    if (!localSegment) continue
    if (proposalSegment.historical && !localSegment.historical) {
      inverse.push({ entityType: 'segment', entityId: localSegment.id, field: 'segment.historical', before: localSegment.historical ?? false, after: true })
      localSegment.historical = true
      localSegment.note = proposalSegment.note ?? localSegment.note
    }
    mergeEntity(
      localSegment,
      baseSegment,
      proposalSegment,
      conflictsFor(conflicts, 'segment', localSegment.id),
      [
        ['name', 'segment.name'],
        ['loops', 'segment.loops'],
        ['start', 'segment.start'],
        ['end', 'segment.end'],
        ['historical', 'segment.historical']
      ] as const,
      inverse,
      'segment'
    )
  }

  for (const proposalQueue of normalized.queues) {
    let localQueue = plan.queues.find((queue) => queue.id === proposalQueue.id)
    const baseQueue = baseVersion?.queues.find((queue) => queue.id === proposalQueue.id)
    if (!localQueue) {
      localQueue = {
        ...plainClone(proposalQueue),
        position: null,
        completions: [],
        updatedAt: Date.now()
      }
      plan.queues.push(localQueue)
      continue
    }

    const wasQueueTouched = normalized.ops.some((op) => op.type.startsWith('queue-item') && proposalQueue.items.some((item) => item.id === op.targetId))
    if (!wasQueueTouched && baseQueue) continue
    // Queue order: only replace if the proposal changed it and any conflict was explicitly resolved.
    const baseOrder = (baseQueue?.items ?? []).map((item) => item.id)
    const proposalOrder = proposalQueue.items.map((item) => item.id)
    const orderConflict = conflicts.find((conflict) => conflict.entityType === 'queue' && conflict.entityId === localQueue!.id && conflict.field === 'queue.order')
    if (JSON.stringify(baseOrder) !== JSON.stringify(proposalOrder)) {
      if (!orderConflict || orderConflict.resolution === 'proposal' || orderConflict.resolution === 'merge') {
        inverse.push({ entityType: 'queue', entityId: localQueue.id, field: 'queue.order', before: localQueue.items.map((i) => i.id), after: proposalOrder })
        reorderItems(localQueue, proposalOrder, proposalQueue.items)
      }
    }

    for (const proposalItem of proposalQueue.items) {
      const localItem = localQueue.items.find((item) => item.id === proposalItem.id)
      const baseItem = baseQueue?.items.find((item) => item.id === proposalItem.id)
      const wasTouched = !baseItem || touchedItemIds.has(proposalItem.id)
      if (!wasTouched) continue
      if (!localItem && !baseItem) {
        localQueue.items.push(plainClone(proposalItem))
        continue
      }
      if (!localItem) continue
    mergeEntity(
      localItem,
      baseItem ?? undefined,
      proposalItem,
        conflictsFor(conflicts, 'queue-item', localItem.id),
        [
          ['loops', 'item.loops'],
          ['tempoScale', 'item.tempoScale'],
          ['status', 'item.status'],
          ['start', 'item.start'],
          ['end', 'item.end']
        ] as Array<readonly [keyof PartQueueItem, MergeConflict['field']]>,
        inverse,
        'queue-item'
      )
    }

    // Deleted items are retained as historical so completion history stays traceable.
    const proposalIds = new Set(proposalQueue.items.map((item) => item.id))
    for (const localItem of localQueue.items) {
      const existedInBase = (baseQueue?.items ?? []).some((item) => item.id === localItem.id)
      if (existedInBase && !proposalIds.has(localItem.id) && localItem.status !== 'historical') {
        inverse.push({ entityType: 'queue-item', entityId: localItem.id, field: 'item.status', before: localItem.status, after: 'historical' })
        localItem.status = 'historical'
        localItem.note = '提案删除该队列项；完成历史保留。'
        if (localQueue.position?.itemId === localItem.id) localQueue.position = null
      }
    }
    localQueue.updatedAt = Date.now()
  }

  // Proposal runtime history remains untouched; explicit item ops were applied above.

  // Proposal never resets progress, completion records or completedAllAt.
  plan.updatedAt = Date.now()
  await appendVersion(plan, `合并排练变更提案：${normalized.name}`, true)
  const record: MergeRecord = {
    id: createId(),
    proposalId: normalized.id,
    proposalName: normalized.name,
    appliedAt: Date.now(),
    versionAfter: plan.versions[0]?.version ?? 1,
    inverse,
    skippedUndoFields: []
  }
  normalized.status = 'merged'
  if (!plan.queues.length) plan.queues = []
  return { plan, record }
}

function conflictsFor(conflicts: MergeConflict[], entityType: MergeConflict['entityType'], entityId: string) {
  return conflicts.filter((conflict) => conflict.entityType === entityType && conflict.entityId === entityId)
}

function mergeEntity<T extends object>(
  local: T,
  base: T | undefined,
  proposal: T,
  conflicts: MergeConflict[],
  fields: ReadonlyArray<readonly [keyof T, MergeConflict['field']]>,
  inverse: MergeRecord['inverse'],
  entityType: MergeConflict['entityType']
) {
  void base
  for (const [key, field] of fields) {
    const localValue = (local as Record<string, unknown>)[key as string]
    const proposalValue = (proposal as Record<string, unknown>)[key as string]
    const conflict = conflicts.find((item) => item.field === field)
    let nextValue = localValue
    if (conflict?.resolution === 'proposal' || conflict?.resolution === 'merge') {
      nextValue = conflict.mergedValue ?? proposalValue
    } else if (!conflict) {
      if (proposalValue !== undefined) nextValue = proposalValue
    }
    if (JSON.stringify(nextValue) !== JSON.stringify(localValue)) {
      inverse.push({ entityType, entityId: (local as { id?: string }).id ?? '', field, before: plainClone(localValue), after: plainClone(nextValue) })
      setField(local as Record<string, unknown>, field, nextValue)
    }
  }
}

function reorderItems(queue: PartQueue, order: string[], sourceItems: PartQueueItem[]) {
  const byId = new Map(queue.items.map((item) => [item.id, item]))
  const reordered: PartQueueItem[] = []
  for (const id of order) {
    const existing = byId.get(id)
    const source = sourceItems.find((item) => item.id === id)
    if (existing) reordered.push(existing)
    else if (source) reordered.push(plainClone(source))
  }
  for (const item of queue.items) {
    if (!order.includes(item.id)) reordered.push(item)
  }
  queue.items = reordered
}

export async function undoMerge(plan: RehearsalPlan, record: MergeRecord): Promise<boolean> {
  if (record.undoneAt) return false
  const skipped: string[] = []
  for (const change of record.inverse) {
    if (hasNewerLocalChange(record.appliedAt, plan, change)) {
      skipped.push(`${change.entityType}:${change.entityId}:${change.field}`)
      continue
    }
    applyInverseChange(plan, change)
  }
  record.skippedUndoFields = skipped
  record.undoneAt = Date.now()
  await appendVersion(plan, `撤销提案合并：${record.proposalName}`, true)
  return true
}

function hasNewerLocalChange(
  appliedAt: number,
  plan: RehearsalPlan,
  change: MergeRecord['inverse'][number]
): boolean {
  if (change.entityType === 'segment') {
    const segment = plan.segments.find((item) => item.id === change.entityId)
    return !!segment && segment.updatedAt > appliedAt
  }
  const item = plan.queues.flatMap((queue) => queue.items).find((candidate) => candidate.id === change.entityId)
  return !!item && item.updatedAt > appliedAt
}

function applyInverseChange(plan: RehearsalPlan, change: MergeRecord['inverse'][number]) {
  if (change.entityType === 'segment') {
    const segment = plan.segments.find((item) => item.id === change.entityId)
    if (segment) setField(segment as unknown as Record<string, unknown>, change.field, change.before)
    return
  }
  const item = plan.queues.flatMap((queue) => queue.items).find((candidate) => candidate.id === change.entityId)
  if (item) setField(item as unknown as Record<string, unknown>, change.field, change.before)
  if (change.entityType === 'queue') {
    const queue = plan.queues.find((candidate) => candidate.id === change.entityId)
    if (queue && Array.isArray(change.before)) queue.items = (change.before as string[]).map((id) => queue.items.find((item) => item.id === id)!).filter(Boolean)
  }
}

// Merge records are plain serializable snapshots.
