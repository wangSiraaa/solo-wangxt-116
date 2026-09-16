import { sha256Text } from './crypto'
import { createId } from './db'
import { plainClone } from './plainClone'
import type {
  QueueCompletion,
  QueuePosition,
  RehearsalPlan,
  StoredProject
} from './types'

export type LedgerEventType =
  | 'ledger.genesis'
  | 'ledger.migration'
  | 'queue.run-start'
  | 'queue.pause'
  | 'queue.item-complete'
  | 'queue.finished'
  | 'path.mismatch'
  | 'path.rebind'
  | 'proposal.merge'
  | 'proposal.undo'
  | 'checkpoint'

export interface LedgerEvent {
  id: string
  parentHash: string
  hash: string
  clock: number
  at: number
  type: LedgerEventType
  xmlSha256: string
  pathChecksum: string
  planVersion: number
  entityType?: 'queue' | 'queue-item' | 'segment' | 'proposal' | 'plan'
  entityId?: string
  summary: string
  before?: unknown
  after?: unknown
}

export interface LedgerCheckpoint {
  id: string
  eventId: string
  eventHash: string
  clock: number
  at: number
  xmlSha256: string
  pathChecksum: string
  planVersion: number
  queues: Array<{
    id: string
    position: QueuePosition | null
    completions: QueueCompletion[]
    completedAllAt?: number
  }>
}

export interface LedgerQuarantineItem {
  id: string
  event?: LedgerEvent
  raw?: unknown
  reason: 'same-id-different-content' | 'missing-parent' | 'broken-hash' | 'summary-mismatch' | 'unknown'
  at: number
  resolution?: 'rejected' | 'historical' | 'fork'
  forkId?: string
}

export interface EventLedger {
  version: 1
  id: string
  createdAt: number
  xmlSha256: string
  events: LedgerEvent[]
  checkpoints: LedgerCheckpoint[]
  quarantined: LedgerQuarantineItem[]
  buffered: LedgerEvent[]
  lastCheckpointId?: string
  migratedFromVersion?: number
  migratedAt?: number
}

export interface LedgerValidation {
  ok: boolean
  errors: string[]
  lastTrustedEvent?: LedgerEvent
  quarantined: LedgerQuarantineItem[]
}

interface LedgerRuntimeState {
  byQueue: Map<string, {
    position: QueuePosition | null
    completions: QueueCompletion[]
    completedAllAt?: number
  }>
}

const GENESIS_ID = 'ledger-genesis'

export async function createLedger(xmlSha256: string, pathChecksum: string, planVersion: number): Promise<EventLedger> {
  const now = Date.now()
  const genesis: LedgerEvent = {
    id: GENESIS_ID,
    parentHash: '',
    hash: '',
    clock: 0,
    at: now,
    type: 'ledger.genesis',
    xmlSha256,
    pathChecksum,
    planVersion,
    entityType: 'plan',
    summary: '账本初始化',
    before: null,
    after: { xmlSha256, pathChecksum, planVersion }
  }
  genesis.hash = await hashEventContent(genesis)
  return {
    version: 1,
    id: createId(),
    createdAt: now,
    xmlSha256,
    events: [genesis],
    checkpoints: [],
    quarantined: [],
    buffered: []
  }
}

async function hashEventContent(event: Omit<LedgerEvent, 'hash'>): Promise<string> {
  const canonical = JSON.stringify({
    id: event.id,
    parentHash: event.parentHash,
    clock: event.clock,
    at: event.at,
    type: event.type,
    xmlSha256: event.xmlSha256,
    pathChecksum: event.pathChecksum,
    planVersion: event.planVersion,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    before: event.before ?? null,
    after: event.after ?? null
  })
  return sha256Text(canonical)
}

export async function validateLedger(ledger: EventLedger, expectedXmlSha256: string, expectedPathChecksum: string): Promise<LedgerValidation> {
  const errors: string[] = []
  let lastTrusted: LedgerEvent | undefined
  const byId = new Map(ledger.events.map((event) => [event.id, event]))
  for (let index = 0; index < ledger.events.length; index += 1) {
    const event = ledger.events[index]
    const previous = index === 0 ? undefined : ledger.events[index - 1]
    const { hash: _ignored, ...withoutHash } = event
    void _ignored
    const expectedHash = await hashEventContent(withoutHash)
    if (index === 0 && event.id !== GENESIS_ID) errors.push(`缺少 genesis 事件：${event.id}`)
    if (event.hash !== expectedHash) errors.push(`事件哈希损坏：${event.id}`)
    if (index > 0 && event.parentHash !== previous?.hash) errors.push(`事件父链断裂：${event.id}`)
    if (index > 0 && event.clock !== (previous?.clock ?? -1) + 1) errors.push(`逻辑时钟不连续：${event.id}`)
    if (byId.get(event.id) && [...byId.values()].filter((candidate) => candidate.id === event.id).length > 1) {
      errors.push(`重复事件 ID：${event.id}`)
    }
    if (index > 0 && event.xmlSha256 !== expectedXmlSha256) errors.push(`XML 摘要不匹配：${event.id}`)
    if (index > 0 && event.pathChecksum !== expectedPathChecksum && event.type !== 'path.mismatch' && event.type !== 'path.rebind') {
      errors.push(`路径快照不匹配：${event.id}`)
    }
    if (!errors.some((error) => error.includes(event.id))) lastTrusted = event
  }
  if (ledger.quarantined.length) errors.push(`存在 ${ledger.quarantined.length} 条隔离事件`)
  return { ok: errors.length === 0, errors, lastTrustedEvent: lastTrusted, quarantined: ledger.quarantined }
}

export async function appendLedgerEvent(input: {
  ledger: EventLedger
  type: LedgerEventType
  xmlSha256: string
  pathChecksum: string
  planVersion: number
  summary: string
  entityType?: LedgerEvent['entityType']
  entityId?: string
  before?: unknown
  after?: unknown
}): Promise<LedgerEvent> {
  const parent = input.ledger.events[input.ledger.events.length - 1]
  const event: LedgerEvent = {
    id: createId(),
    parentHash: parent?.hash ?? '',
    hash: '',
    clock: (parent?.clock ?? -1) + 1,
    at: Date.now(),
    type: input.type,
    xmlSha256: input.xmlSha256,
    pathChecksum: input.pathChecksum,
    planVersion: input.planVersion,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary,
    before: plainClone(input.before ?? null),
    after: plainClone(input.after ?? null)
  }
  event.hash = await hashEventContent(event)
  input.ledger.events.push(event)
  return event
}

export function createCheckpoint(ledger: EventLedger, plan: RehearsalPlan, event: LedgerEvent): LedgerCheckpoint {
  const checkpoint: LedgerCheckpoint = {
    id: createId(),
    eventId: event.id,
    eventHash: event.hash,
    clock: event.clock,
    at: Date.now(),
    xmlSha256: event.xmlSha256,
    pathChecksum: event.pathChecksum,
    planVersion: event.planVersion,
    queues: plan.queues.map((queue) => ({
      id: queue.id,
      position: plainClone(queue.position),
      completions: plainClone(queue.completions),
      completedAllAt: queue.completedAllAt
    }))
  }
  ledger.checkpoints.push(checkpoint)
  ledger.lastCheckpointId = checkpoint.id
  return checkpoint
}

function emptyRuntime(plan: RehearsalPlan): LedgerRuntimeState {
  return {
    byQueue: new Map(
      plan.queues.map((queue) => [
        queue.id,
        { position: null, completions: [], completedAllAt: undefined }
      ])
    )
  }
}

export async function replayLedger(plan: RehearsalPlan, ledger: EventLedger): Promise<LedgerValidation> {
  const validation = await validateLedger(ledger, plan.xmlSha256, plan.pathChecksum)
  const state = emptyRuntime(plan)
  for (const queue of plan.queues) {
    queue.position = null
    queue.completions = []
    queue.completedAllAt = undefined
  }

  const trustedIds = new Set<string>()
  for (let index = 0; index < ledger.events.length; index += 1) {
    const event = ledger.events[index]
    const previous = index === 0 ? undefined : ledger.events[index - 1]
    const { hash: _ignored, ...withoutHash } = event
    void _ignored
    const expectedHash = await hashEventContent(withoutHash)
    const structuralOk =
      (index === 0 ? event.id === GENESIS_ID : event.parentHash === previous?.hash) &&
      event.hash === expectedHash &&
      (index === 0 || event.clock === (previous?.clock ?? -1) + 1)
    if (!structuralOk) break
    trustedIds.add(event.id)
  }

  for (const event of ledger.events) {
    if (!trustedIds.has(event.id)) break
    const queueId = event.after && typeof event.after === 'object' && 'queueId' in (event.after as object)
      ? String((event.after as { queueId?: string }).queueId ?? event.entityId)
      : event.entityId
    const queueState = queueId ? state.byQueue.get(queueId) : undefined
    const queue = queueId ? plan.queues.find((candidate) => candidate.id === queueId) : undefined
    if (!queueState || !queue) continue

    if (event.type === 'queue.item-complete') {
      const completion = (event.after as { completion?: QueueCompletion }).completion
      const nextPosition = (event.after as { position?: QueuePosition | null }).position
      if (completion && !queueState.completions.some((item) => item.id === completion.id || (item.runId === completion.runId && item.itemId === completion.itemId))) {
        queueState.completions.push(plainClone(completion))
      }
      if (nextPosition) queueState.position = plainClone(nextPosition)
    }
    if (event.type === 'queue.pause') {
      const position = (event.after as { position?: QueuePosition | null }).position
      queueState.position = position ? plainClone(position) : null
    }
    if (event.type === 'queue.run-start') {
      const position = (event.after as { position?: QueuePosition | null }).position
      if (position) queueState.position = plainClone(position)
    }
    if (event.type === 'queue.finished') {
      const position = (event.after as { position?: QueuePosition | null }).position
      const completion = (event.after as { completion?: QueueCompletion }).completion
      const completedAt = (event.after as { completedAllAt?: number }).completedAllAt
      if (completion && !queueState.completions.some((item) => item.id === completion.id || (item.runId === completion.runId && item.itemId === completion.itemId))) {
        queueState.completions.push(plainClone(completion))
      }
      if (position) queueState.position = plainClone(position)
      if (completedAt) queueState.completedAllAt = completedAt
    }
  }

  for (const queue of plan.queues) {
    const restored = state.byQueue.get(queue.id)
    if (!restored) continue
    queue.position = plainClone(restored.position)
    queue.completions = plainClone(restored.completions)
    queue.completedAllAt = restored.completedAllAt
  }
  return validation
}

export async function migrateSnapshotToLedger(plan: RehearsalPlan, project: StoredProject): Promise<EventLedger | null> {
  if (project.ledger) return project.ledger as unknown as EventLedger
  const ledger = await createLedger(plan.xmlSha256, plan.pathChecksum, plan.versions[0]?.version ?? 1)
  ledger.migratedFromVersion = project.schemaVersion
  ledger.migratedAt = Date.now()
  for (const queue of plan.queues) {
    for (const completion of queue.completions) {
      const event = await appendLedgerEvent({
        ledger,
        type: 'queue.item-complete',
        xmlSha256: plan.xmlSha256,
        pathChecksum: plan.pathChecksum,
        planVersion: plan.versions[0]?.version ?? 1,
        summary: `迁移完成历史：${completion.segmentName}`,
        entityType: 'queue-item',
        entityId: completion.itemId,
        before: null,
        after: { queueId: queue.id, completion, position: queue.position }
      })
      if (queue.position?.itemId === completion.itemId) createCheckpoint(ledger, plan, event)
    }
    if (queue.completedAllAt) {
      await appendLedgerEvent({
        ledger,
        type: 'queue.finished',
        xmlSha256: plan.xmlSha256,
        pathChecksum: plan.pathChecksum,
        planVersion: plan.versions[0]?.version ?? 1,
        summary: `迁移队列完成状态：${queue.name}`,
        entityType: 'queue',
        entityId: queue.id,
        before: null,
        after: { queueId: queue.id, position: queue.position, completedAllAt: queue.completedAllAt }
      })
    }
  }
  project.ledgerMigration = {
    migratedAt: Date.now(),
    fromSchemaVersion: project.schemaVersion ?? 1,
    ledgerVersion: 1,
    source: 'snapshot-runtime'
  }
  return ledger
}

export function quarantineEvent(ledger: EventLedger, raw: unknown, reason: LedgerQuarantineItem['reason']): LedgerQuarantineItem {
  const item: LedgerQuarantineItem = { id: createId(), raw: plainClone(raw), reason, at: Date.now() }
  ledger.quarantined.push(item)
  return item
}

export function ledgerSummary(ledger: EventLedger): string {
  return `${ledger.events.length}:${ledger.checkpoints.length}:${ledger.quarantined.length}:${ledger.lastCheckpointId ?? ''}`
}

export interface LedgerImportResult {
  applied: number
  duplicated: number
  quarantined: LedgerQuarantineItem[]
  blocked: boolean
}

/**
 * Import events from another ledger for the same score.
 * - duplicate ids are ignored
 * - out-of-order events whose parent exists later are buffered and folded causally
 * - same id / different content, unresolvable parent or summary mismatch are quarantined
 */
export function importLedgerEvents(target: EventLedger, incoming: EventLedger): LedgerImportResult {
  const quarantined: LedgerQuarantineItem[] = []
  let applied = 0
  let duplicated = 0
  const knownHashes = new Set(target.events.map((event) => event.hash))
  const knownIds = new Set(target.events.map((event) => event.id))
  const pending = [...incoming.events.filter((event) => event.id !== GENESIS_ID)]

  let progressed = true
  while (progressed) {
    progressed = false
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const event = pending[index]
      if (knownIds.has(event.id)) {
        duplicated += 1
        pending.splice(index, 1)
        progressed = true
        continue
      }
      if (!knownHashes.has(event.parentHash)) continue
      if (event.xmlSha256 !== target.xmlSha256) {
        quarantined.push(quarantineEvent(target, event, 'summary-mismatch'))
        pending.splice(index, 1)
        progressed = true
        continue
      }
      target.events.push(plainClone(event))
      knownHashes.add(event.hash)
      knownIds.add(event.id)
      pending.splice(index, 1)
      applied += 1
      progressed = true
    }
  }

  for (const orphan of pending) {
    const reason = target.events.some((event) => event.id === orphan.id)
      ? 'same-id-different-content'
      : 'missing-parent'
    quarantined.push(quarantineEvent(target, orphan, reason))
  }

  target.buffered = []
  return { applied, duplicated, quarantined, blocked: quarantined.length > 0 }
}

export function isLedgerBundle(value: unknown): value is { schema: string; ledger: EventLedger } {
  return !!value && typeof value === 'object' && (value as { schema?: string }).schema === 'rehearsal-stand-ledger/v1'
}
