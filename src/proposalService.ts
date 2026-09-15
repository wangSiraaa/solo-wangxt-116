import { fnv1aHash } from './crypto'
import { createId } from './db'
import { plainClone } from './plainClone'
import type {
  MergeConflict,
  MergeConflictField,
  PartQueue,
  PartQueueItem,
  PendingMerge,
  ProposalOp,
  ProposalOpType,
  RehearsalChangeProposal,
  RehearsalPlan,
  RehearsalPlanVersion,
  RehearsalSegment,
  StoredProject
} from './types'

function hash(value: unknown): string {
  return fnv1aHash(value)
}

export function planVersionAt(plan: RehearsalPlan, versionId: string): RehearsalPlanVersion | null {
  return plan.versions.find((version) => version.id === versionId) ?? null
}

export function createProposal(
  plan: RehearsalPlan,
  name: string,
  author: string
): RehearsalChangeProposal {
  const version = plan.versions[0]
  if (!version) throw new Error('方案没有可作为提案基线的版本。')
  const now = Date.now()
  const proposal: RehearsalChangeProposal = {
    id: createId(),
    name,
    author,
    base: {
      planId: plan.id,
      versionId: version.id,
      version: version.version,
      xmlSha256: plan.xmlSha256,
      pathChecksum: plan.pathChecksum,
      at: now
    },
    segments: plainClone(version.segments ?? plan.segments),
    queues: stripRuntimeQueueState(plainClone(version.queues ?? plan.queues)),
    ops: [],
    contentHash: '',
    createdAt: now,
    updatedAt: now,
    status: 'draft'
  }
  proposal.contentHash = proposalHash(proposal)
  return proposal
}

function stripRuntimeQueueState(queues: PartQueue[]): PartQueue[] {
  return queues.map((queue) => ({
    ...queue,
    position: null,
    completions: [],
    activeRunId: undefined,
    completedAllAt: undefined
  }))
}

export function recordOp(
  proposal: RehearsalChangeProposal,
  type: ProposalOpType,
  targetId: string,
  summary: string,
  before: unknown,
  after: unknown
): ProposalOp {
  const op: ProposalOp = {
    id: createId(),
    type,
    at: Date.now(),
    targetId,
    summary,
    before: before === undefined ? undefined : plainClone(before),
    after: after === undefined ? undefined : plainClone(after),
    order: proposal.ops.length,
    contentHash: hash({ type, targetId, before, after })
  }
  proposal.ops.push(op)
  proposal.updatedAt = op.at
  proposal.contentHash = proposalHash(proposal)
  return op
}

export function proposalHash(proposal: RehearsalChangeProposal): string {
  return hash({
    id: proposal.id,
    base: proposal.base,
    segments: proposal.segments.map((segment) => ({
      id: segment.id,
      name: segment.name,
      start: segment.start.visitKey,
      end: segment.end.visitKey,
      loops: segment.loops,
      historical: segment.historical ?? false
    })),
    queues: proposal.queues.map((queue) => ({
      id: queue.id,
      name: queue.name,
      items: queue.items.map((item) => ({
        id: item.id,
        segmentId: item.segmentId,
        loops: item.loops,
        tempoScale: item.tempoScale,
        status: item.status,
        start: item.start.visitKey,
        end: item.end.visitKey
      }))
    })),
    ops: proposal.ops.map((op) => op.contentHash)
  })
}

export function proposalAddSegment(
  proposal: RehearsalChangeProposal,
  segment: RehearsalSegment
): RehearsalSegment {
  const copy = plainClone(segment)
  proposal.segments.push(copy)
  recordOp(proposal, 'segment.add', copy.id, `提案新增段落“${copy.name}”`, undefined, copy)
  return copy
}

export function proposalUpdateSegment(
  proposal: RehearsalChangeProposal,
  segmentId: string,
  patch: Partial<Pick<RehearsalSegment, 'name' | 'loops' | 'historical' | 'note'>>
) {
  const segment = proposal.segments.find((item) => item.id === segmentId)
  if (!segment) return
  const before = plainClone(segment)
  Object.assign(segment, patch, { updatedAt: Date.now() })
  recordOp(proposal, 'segment.update', segment.id, `提案更新段落“${segment.name}”`, before, segment)
}

export function proposalDeleteSegment(proposal: RehearsalChangeProposal, segmentId: string) {
  const index = proposal.segments.findIndex((item) => item.id === segmentId)
  if (index < 0) return
  const [removed] = proposal.segments.splice(index, 1)
  recordOp(proposal, 'segment.delete', segmentId, `提案删除段落“${removed.name}”`, removed, undefined)
}

export function proposalUpsertQueue(proposal: RehearsalChangeProposal, queue: PartQueue) {
  const index = proposal.queues.findIndex((item) => item.id === queue.id)
  const clean = stripRuntimeQueueStateFromQueue(plainClone(queue))
  if (index < 0) {
    proposal.queues.push(clean)
    recordOp(proposal, 'queue.add', clean.id, `提案新增分部队列“${clean.name}”`, undefined, clean)
  } else {
    const before = plainClone(proposal.queues[index])
    proposal.queues[index] = clean
    recordOp(proposal, 'queue.add', clean.id, `提案更新分部队列“${clean.name}”`, before, clean)
  }
}

export function proposalUpdateQueueItem(
  proposal: RehearsalChangeProposal,
  queueId: string,
  itemId: string,
  patch: Partial<Pick<PartQueueItem, 'loops' | 'tempoScale' | 'status' | 'note'>>
) {
  const queue = proposal.queues.find((item) => item.id === queueId)
  const item = queue?.items.find((candidate) => candidate.id === itemId)
  if (!queue || !item) return
  const before = plainClone(item)
  Object.assign(item, patch, { updatedAt: Date.now() })
  recordOp(proposal, 'queue-item.update', item.id, `提案更新队列项“${item.segmentName}”`, before, item)
}

export function proposalReorderQueueItem(proposal: RehearsalChangeProposal, queueId: string, itemId: string, direction: -1 | 1) {
  const queue = proposal.queues.find((item) => item.id === queueId)
  if (!queue) return
  const index = queue.items.findIndex((item) => item.id === itemId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= queue.items.length) return
  const before = queue.items.map((item) => item.id)
  const [item] = queue.items.splice(index, 1)
  queue.items.splice(target, 0, item)
  recordOp(proposal, 'queue-item.reorder', itemId, `提案调整“${queue.name}”队列顺序`, before, queue.items.map((entry) => entry.id))
}

export function proposalDeleteQueueItem(proposal: RehearsalChangeProposal, queueId: string, itemId: string) {
  const queue = proposal.queues.find((item) => item.id === queueId)
  const index = queue?.items.findIndex((item) => item.id === itemId) ?? -1
  if (!queue || index < 0) return
  const [removed] = queue.items.splice(index, 1)
  recordOp(proposal, 'queue-item.delete', itemId, `提案删除“${queue.name}”队列项“${removed.segmentName}”`, removed, undefined)
}

export function normalizeProposal(proposal: RehearsalChangeProposal): RehearsalChangeProposal {
  proposal.ops.sort((a, b) => a.order - b.order)
  proposal.ops = proposal.ops.filter(
    (op, index, all) => index === all.findIndex((other) => other.id === op.id || other.contentHash === op.contentHash && other.targetId === op.targetId)
  )
  proposal.ops.forEach((op, index) => (op.order = index))
  proposal.queues = proposal.queues.map(stripRuntimeQueueStateFromQueue)
  proposal.contentHash = proposalHash(proposal)
  return proposal
}

function stripRuntimeQueueStateFromQueue(queue: PartQueue): PartQueue {
  return {
    ...queue,
    position: null,
    completions: [],
    activeRunId: undefined,
    completedAllAt: undefined
  }
}

export function proposalAlreadyImported(project: StoredProject, proposal: RehearsalChangeProposal): boolean {
  return (project.proposals ?? []).some(
    (existing) =>
      existing.id === proposal.id ||
      (existing.base.versionId === proposal.base.versionId && existing.contentHash === proposal.contentHash)
  )
}

export function proposalMerged(project: StoredProject, proposal: RehearsalChangeProposal): boolean {
  return (project.mergeRecords ?? []).some((record) => record.proposalId === proposal.id && !record.undoneAt)
}

export function prepareMerge(
  plan: RehearsalPlan,
  proposal: RehearsalChangeProposal
): { conflicts: MergeConflict[]; canAutoApply: boolean } {
  const baseVersion = plan.versions.find((version) => version.id === proposal.base.versionId)
  const baseSegments = baseVersion?.segments ?? proposal.segments
  const baseQueues = baseVersion?.queues ?? proposal.queues
  const conflicts: MergeConflict[] = []

  for (const proposalSegment of proposal.segments) {
    const localSegment = plan.segments.find((segment) => segment.id === proposalSegment.id)
    const baseSegment = baseSegments.find((segment) => segment.id === proposalSegment.id)
    if (!baseSegment) {
      // New segment created by proposal: no three-way conflict.
      continue
    }
    compareFields(
      conflicts,
      proposal,
      'segment',
      proposalSegment.id,
      proposalSegment.name,
      baseSegment,
      localSegment,
      proposalSegment,
      [
        ['name', 'segment.name'],
        ['loops', 'segment.loops'],
        ['start', 'segment.start', endpointKey],
        ['end', 'segment.end', endpointKey],
        ['historical', 'segment.historical']
      ]
    )
  }

  for (const proposalQueue of proposal.queues) {
    const localQueue = plan.queues.find((queue) => queue.id === proposalQueue.id)
    const baseQueue = baseQueues.find((queue) => queue.id === proposalQueue.id)
    if (!localQueue) continue
    const localOrder = localQueue.items.map((item) => item.id)
    const proposalOrder = proposalQueue.items.map((item) => item.id)
    const baseOrder = (baseQueue?.items ?? []).map((item) => item.id)
    if (hash(localOrder) !== hash(baseOrder) && hash(proposalOrder) !== hash(baseOrder) && hash(localOrder) !== hash(proposalOrder)) {
      conflicts.push(makeConflict(proposal, 'queue', localQueue.id, localQueue.name, 'queue.order', baseOrder, localOrder, proposalOrder))
    }
    for (const proposalItem of proposalQueue.items) {
      const localItem = localQueue.items.find((item) => item.id === proposalItem.id)
      const baseItem = baseQueue?.items.find((item) => item.id === proposalItem.id)
      if (!localItem) continue
      compareFields(
        conflicts,
        proposal,
        'queue-item',
        proposalItem.id,
        proposalItem.segmentName,
        baseItem ?? proposalItem,
        localItem,
        proposalItem,
        [
          ['loops', 'item.loops'],
          ['tempoScale', 'item.tempoScale'],
          ['status', 'item.status'],
          ['start', 'item.start', endpointKey],
          ['end', 'item.end', endpointKey]
        ]
      )
    }
  }

  return { conflicts, canAutoApply: conflicts.every((conflict) => conflict.resolution) }
}

type FieldSpec<T extends object> = readonly [keyof T, MergeConflictField, ((value: unknown) => unknown)?]

function compareFields<T extends object>(
  conflicts: MergeConflict[],
  proposal: RehearsalChangeProposal,
  entityType: MergeConflict['entityType'],
  entityId: string,
  label: string,
  baseEntity: T,
  localEntity: T | undefined,
  incomingEntity: T,
  fields: ReadonlyArray<FieldSpec<T>>
) {
  if (!localEntity) return
  for (const spec of fields) {
    const [key, field, transform] = spec
    const normalize = transform ?? ((value: unknown) => value)
    const baseValue = normalize(baseEntity[key])
    const localValue = normalize(localEntity[key])
    const proposalValue = normalize(incomingEntity[key])
    if (localValue !== proposalValue && localValue !== baseValue && proposalValue !== baseValue) {
      conflicts.push(makeConflict(proposal, entityType, entityId, label, field, baseEntity[key], localEntity[key], incomingEntity[key]))
    }
  }
}

function endpointKey(value: unknown): unknown {
  if (value && typeof value === 'object' && 'visitKey' in value) return (value as { visitKey: string }).visitKey
  return value
}

function makeConflict(
  proposal: RehearsalChangeProposal,
  entityType: MergeConflict['entityType'],
  entityId: string,
  label: string,
  field: MergeConflictField,
  base: unknown,
  local: unknown,
  incoming: unknown
): MergeConflict {
  return {
    id: createId(),
    proposalId: proposal.id,
    entityType,
    entityId,
    entityLabel: label,
    field,
    base: plainClone(base),
    local: plainClone(local),
    proposal: plainClone(incoming)
  }
}

export function createPendingMerge(plan: RehearsalPlan, proposal: RehearsalChangeProposal): PendingMerge {
  const { conflicts } = prepareMerge(plan, proposal)
  return {
    proposal: normalizeProposal(plainClone(proposal)),
    conflicts,
    startedAt: Date.now()
  }
}

export { hash as mergeHash }
