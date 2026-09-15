import { canonicalJson, sha256Json, sha256Text } from './crypto'
import { createId } from './db'
import { plainClone } from './plainClone'
import {
  ensureQueues,
  markQueueItemHistorical,
  markQueueMismatches,
  migrateSessionsToDefaultQueue,
  rebindQueueItem,
  removeQueueMismatchItem,
  validateQueuesAfterSegmentChange
} from './queueService'
import type {
  PathSnapshotVisit,
  PathVisit,
  PerformancePath,
  PlanMismatch,
  PlanMismatchKind,
  RehearsalPathSnapshot,
  RehearsalPlan,
  RehearsalPlanVersion,
  RehearsalSegment,
  RehearsalSession,
  SegmentEndpoint
} from './types'

export interface ReconcileResult {
  plan: RehearsalPlan
  changed: boolean
  newVersion: boolean
}

export async function computeXmlHash(xml: string): Promise<string> {
  return sha256Text(xml)
}

export async function createSnapshot(path: PerformancePath, xmlSha256: string): Promise<RehearsalPathSnapshot> {
  const visits: PathSnapshotVisit[] = path.visits.map(toSnapshotVisit)
  return {
    computedAt: Date.now(),
    xmlSha256,
    pathChecksum: await pathChecksum(visits),
    totalSeconds: path.totalSeconds,
    visits
  }
}

export function endpointFromVisit(visit: PathVisit | PathSnapshotVisit): SegmentEndpoint {
  return {
    visitKey: visit.visitKey,
    sequence: visit.sequence,
    writtenMeasure: visit.writtenMeasure,
    printedNumber: visit.printedNumber,
    pass: visit.pass,
    endingNumber: visit.endingNumber,
    actionKind: visit.actionKind,
    structuralSignature: visit.structuralSignature
  }
}

export async function createPlan(
  name: string,
  path: PerformancePath,
  xmlSha256: string,
  options: { migratedFromLegacyMarkers?: boolean } = {}
): Promise<RehearsalPlan> {
  const snapshot = await createSnapshot(path, xmlSha256)
  const now = Date.now()
  const plan: RehearsalPlan = {
    id: createId(),
    name,
    xmlSha256,
    pathChecksum: snapshot.pathChecksum,
    status: 'ready',
    currentSnapshot: snapshot,
    segments: [],
    sessions: [],
    queues: [],
    mismatches: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    migratedFromLegacyMarkers: options.migratedFromLegacyMarkers
  }
  await appendVersion(plan, '创建排练方案', true)
  return plan
}

export async function savePlanRevision(
  plan: RehearsalPlan,
  snapshot: RehearsalPathSnapshot,
  changeSummary: string
): Promise<boolean> {
  plan.currentSnapshot = snapshot
  plan.pathChecksum = snapshot.pathChecksum
  plan.xmlSha256 = snapshot.xmlSha256
  plan.updatedAt = Date.now()
  return appendVersion(plan, changeSummary, false)
}

export function addSegment(
  plan: RehearsalPlan,
  name: string,
  start: SegmentEndpoint,
  end: SegmentEndpoint,
  loops: number
): RehearsalSegment {
  const now = Date.now()
  const segment: RehearsalSegment = {
    id: createId(),
    name,
    start,
    end,
    loops: Math.max(1, loops),
    createdAt: now,
    updatedAt: now
  }
  plan.segments.push(segment)
  plan.updatedAt = now
  const session = createSession(`会话：${name}`, [segment.id], Object.fromEntries([[segment.id, segment.loops]]))
  plan.sessions.push(session)
  if (!Array.isArray(plan.queues)) plan.queues = []
  return segment
}

export function updateSegment(plan: RehearsalPlan, segmentId: string, patch: Partial<Pick<RehearsalSegment, 'name' | 'loops'>>): RehearsalSegment | null {
  const segment = plan.segments.find((item) => item.id === segmentId)
  if (!segment) return null
  Object.assign(segment, patch, { updatedAt: Date.now() })
  plan.updatedAt = Date.now()
  return segment
}

export function deleteSegment(plan: RehearsalPlan, segmentId: string) {
  plan.segments = plan.segments.filter((segment) => segment.id !== segmentId)
  for (const session of plan.sessions) {
    session.segmentIds = session.segmentIds.filter((id) => id !== segmentId)
    delete session.segmentLoops[segmentId]
    if (session.position?.segmentId === segmentId) session.position = null
  }
  plan.mismatches = plan.mismatches.filter((mismatch) => mismatch.segmentId !== segmentId)
  validateQueuesAfterSegmentChange(plan)
  plan.updatedAt = Date.now()
}

export function createSession(name: string, segmentIds: string[], segmentLoops: Record<string, number>): RehearsalSession {
  const now = Date.now()
  return {
    id: createId(),
    name,
    segmentIds,
    segmentLoops,
    position: null,
    createdAt: now,
    updatedAt: now
  }
}

export function updateSessionProgress(plan: RehearsalPlan, session: RehearsalSession, position: RehearsalSession['position']) {
  session.position = position
  session.updatedAt = Date.now()
  plan.updatedAt = session.updatedAt
}

export function segmentVisits(plan: RehearsalPlan, segment: RehearsalSegment): PathSnapshotVisit[] {
  const byKey = new Map(plan.currentSnapshot.visits.map((visit) => [visit.visitKey, visit]))
  const start = byKey.get(segment.start.visitKey)
  const end = byKey.get(segment.end.visitKey)
  if (!start || !end || start.sequence > end.sequence) return []
  return plan.currentSnapshot.visits.slice(start.sequence, end.sequence + 1)
}

export async function reconcilePlan(
  previous: RehearsalPlan,
  path: PerformancePath,
  xmlSha256: string
): Promise<ReconcileResult> {
  const snapshot = await createSnapshot(path, xmlSha256)
  if (
    previous.xmlSha256 === xmlSha256 &&
    previous.pathChecksum === snapshot.pathChecksum &&
    previous.currentSnapshot.visits.length === snapshot.visits.length
  ) {
    previous.currentSnapshot = snapshot
    return { plan: previous, changed: false, newVersion: false }
  }

  const next: RehearsalPlan = plainClone(previous)
  ensureQueues(next)
  next.currentSnapshot = snapshot
  next.xmlSha256 = xmlSha256
  next.pathChecksum = snapshot.pathChecksum
  next.updatedAt = Date.now()
  next.mismatches = []

  const currentByKey = new Map(snapshot.visits.map((visit) => [visit.visitKey, visit]))
  const findCandidates = (endpoint: SegmentEndpoint) => {
    const sameMeasure = snapshot.visits.filter((visit) => visit.writtenMeasure === endpoint.writtenMeasure)
    // If the whole written measure disappeared from the new path, expose all current visits
    // for explicit manual rebinding rather than silently choosing a nearby ordinal.
    return sameMeasure.length ? sameMeasure : snapshot.visits
  }

  const checkEndpoint = (
    endpoint: SegmentEndpoint,
    subject: PlanMismatch['subject'],
    segment: RehearsalSegment | undefined,
    session: RehearsalSession | undefined
  ) => {
    const current = currentByKey.get(endpoint.visitKey)
    if (current && current.structuralSignature === endpoint.structuralSignature) return
    let kind: PlanMismatchKind = 'missing-visit'
    if (previous.xmlSha256 !== xmlSha256) kind = 'score-content'
    else if (current && current.structuralSignature !== endpoint.structuralSignature) kind = 'structural-signature'
    const candidates = findCandidates(endpoint).map((visit) => endpointFromVisit(visit))
    const location = `第 ${endpoint.printedNumber} 书面小节、第 ${endpoint.pass} 遍${endpoint.endingNumber ? `、第 ${endpoint.endingNumber} 跳房` : ''}`
    const message =
      kind === 'score-content'
        ? `乐谱内容已变更，原绑定的到达位置 ${location} 需确认；不能只按书面小节号自动改绑。`
        : kind === 'structural-signature'
          ? `导航记号变更后，同书面小节的路径身份变化：${location}。请选择新到达位置、保留历史或删除。`
          : `新路径中找不到原到达位置 ${location}；不能误播到同书面小节。`
    next.mismatches.push({
      id: createId(),
      kind,
      subject,
      segmentId: segment?.id,
      sessionId: session?.id,
      expected: endpoint,
      candidates,
      message,
      resolved: false
    })
  }

  for (const segment of next.segments) {
    if (segment.historical) continue
    checkEndpoint(segment.start, 'segment-start', segment, undefined)
    checkEndpoint(segment.end, 'segment-end', segment, undefined)
  }

  for (const session of next.sessions) {
    if (!session.position) continue
    const endpoint = endpointFromPosition(next, session.position)
    if (endpoint) checkEndpoint(endpoint, 'session-position', next.segments.find((segment) => segment.id === session.position?.segmentId), session)
  }

  markQueueMismatches(
    next,
    previous.xmlSha256,
    (visitKey) => currentByKey.has(visitKey),
    (endpoint) => currentByKey.get(endpoint.visitKey)?.structuralSignature === endpoint.structuralSignature,
    (endpoint) => {
      const sameMeasure = snapshot.visits.filter((visit) => visit.writtenMeasure === endpoint.writtenMeasure)
      return (sameMeasure.length ? sameMeasure : snapshot.visits).map((visit) => endpointFromVisit(visit))
    }
  )
  validateQueuesAfterSegmentChange(next)

  next.status = next.mismatches.length ? 'pending-mismatch' : 'ready'
  const changed = await appendVersion(next, previous.xmlSha256 === xmlSha256 ? '导航路径变更后重新校验方案' : '乐谱内容变更后重新校验方案', true)
  return { plan: next, changed: true, newVersion: changed }
}

function endpointFromPosition(plan: RehearsalPlan, position: NonNullable<RehearsalSession['position']>): SegmentEndpoint | null {
  for (const segment of plan.segments) {
    if (segment.start.visitKey === position.visitKey) return segment.start
    if (segment.end.visitKey === position.visitKey) return segment.end
  }
  const visit = plan.currentSnapshot.visits.find((item) => item.visitKey === position.visitKey)
  return visit ? endpointFromVisit(visit) : null
}

export async function resolveMismatch(
  plan: RehearsalPlan,
  mismatchId: string,
  action: 'rebind' | 'historical' | 'delete',
  chosenVisitKey?: string
): Promise<boolean> {
  ensureQueues(plan)
  const mismatch = plan.mismatches.find((item) => item.id === mismatchId)
  if (!mismatch) return false

  if (mismatch.subject === 'queue-item') {
    const chosen = chosenVisitKey ? plan.currentSnapshot.visits.find((visit) => visit.visitKey === chosenVisitKey) : null
    const endpoint = chosen ? endpointFromVisit(chosen) : null
    if (action === 'rebind' && endpoint) {
      rebindQueueItem(
        plan,
        mismatchId,
        mismatch.endpointSide === 'start' ? endpoint : null,
        mismatch.endpointSide === 'end' ? endpoint : null
      )
    } else if (action === 'historical') {
      markQueueItemHistorical(plan, mismatchId)
    } else if (action === 'delete') {
      removeQueueMismatchItem(plan, mismatchId)
    }
    plan.status = plan.mismatches.length ? 'pending-mismatch' : 'ready'
    return appendVersion(
      plan,
      action === 'rebind' ? '逐项重新绑定分部队列到达位置' : action === 'historical' ? '保留分部队列为历史' : '删除失配队列项',
      false
    )
  }

  const chosen = chosenVisitKey ? plan.currentSnapshot.visits.find((visit) => visit.visitKey === chosenVisitKey) : null

  if (action === 'rebind' && chosen) {
    const endpoint = endpointFromVisit(chosen)
    if (mismatch.subject === 'segment-start' && mismatch.segmentId) {
      const segment = plan.segments.find((item) => item.id === mismatch.segmentId)
      if (segment) segment.start = endpoint
    }
    if (mismatch.subject === 'segment-end' && mismatch.segmentId) {
      const segment = plan.segments.find((item) => item.id === mismatch.segmentId)
      if (segment) segment.end = endpoint
    }
    if (mismatch.subject === 'session-position' && mismatch.sessionId) {
      const session = plan.sessions.find((item) => item.id === mismatch.sessionId)
      if (session?.position) session.position = { ...session.position, visitKey: chosen.visitKey, completed: false }
    }
    mismatch.resolved = true
    mismatch.resolution = 'rebound'
  }

  if (action === 'historical' && mismatch.segmentId) {
    const segment = plan.segments.find((item) => item.id === mismatch.segmentId)
    if (segment) {
      segment.historical = true
      segment.note = `路径变更后保留为不可播放历史：${mismatch.message}`
    }
    mismatch.resolved = true
    mismatch.resolution = 'historical'
  }

  if (action === 'delete') {
    if (mismatch.segmentId) deleteSegment(plan, mismatch.segmentId)
    plan.mismatches = plan.mismatches.filter((item) => item.id !== mismatchId)
  } else {
    mismatch.resolved = true
  }

  plan.mismatches = plan.mismatches.filter((item) => !item.resolved)
  plan.status = plan.mismatches.length ? 'pending-mismatch' : plan.segments.some((segment) => segment.historical) ? 'historical' : 'ready'
  plan.updatedAt = Date.now()
  return appendVersion(
    plan,
    action === 'rebind' ? '逐项重新绑定方案到达位置' : action === 'historical' ? '保留旧方案为不可播放历史' : '删除失配方案段落',
    false
  )
}

export async function ensurePlanQueues(plan: RehearsalPlan, changeSummary = '迁移单会话方案为默认分部队列'): Promise<boolean> {
  ensureQueues(plan)
  const migrated = migrateSessionsToDefaultQueue(plan)
  if (migrated && migrated.items.length) {
    return appendVersion(plan, changeSummary, false)
  }
  return false
}

export { validateQueuesAfterSegmentChange }

export async function appendVersion(plan: RehearsalPlan, changeSummary: string, force: boolean): Promise<boolean> {
  const contentHash = await versionContentHash(plan)
  if (!force && plan.versions[0]?.contentHash === contentHash) return false
  const version: RehearsalPlanVersion = {
    id: createId(),
    version: (plan.versions[0]?.version ?? 0) + 1,
    createdAt: Date.now(),
    changeSummary,
    contentHash,
    xmlSha256: plan.xmlSha256,
    pathChecksum: plan.pathChecksum,
    segments: plainClone(plan.segments),
    sessions: plainClone(plan.sessions),
    queues: plainClone(plan.queues ?? []),
    mismatches: plainClone(plan.mismatches)
  }
  plan.versions.unshift(version)
  plan.updatedAt = version.createdAt
  return true
}

async function versionContentHash(plan: RehearsalPlan): Promise<string> {
  return sha256Json({
    xmlSha256: plan.xmlSha256,
    pathChecksum: plan.pathChecksum,
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      name: segment.name,
      start: segment.start.visitKey,
      end: segment.end.visitKey,
      loops: segment.loops,
      historical: segment.historical ?? false
    })),
    sessions: plan.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      segmentIds: session.segmentIds,
      segmentLoops: session.segmentLoops,
      position: session.position
    })),
    queues: (plan.queues ?? []).map((queue) => ({
      id: queue.id,
      name: queue.name,
      items: queue.items.map((item) => ({
        id: item.id,
        segmentId: item.segmentId,
        start: item.start.visitKey,
        end: item.end.visitKey,
        loops: item.loops,
        tempoScale: item.tempoScale,
        status: item.status
      })),
      position: queue.position,
      completions: queue.completions.map((completion) => ({
        itemId: completion.itemId,
        segmentId: completion.segmentId,
        completedAt: completion.completedAt
      })),
      updatedAt: queue.updatedAt
    })),
    mismatches: plan.mismatches.map((mismatch) => ({
      id: mismatch.id,
      subject: mismatch.subject,
      expected: mismatch.expected,
      resolved: mismatch.resolved
    }))
  })
}

async function pathChecksum(visits: PathSnapshotVisit[]): Promise<string> {
  return sha256Json(visits.map((visit) => ({
    key: visit.visitKey,
    m: visit.writtenMeasure,
    pass: visit.pass,
    ending: visit.endingNumber,
    action: visit.actionKind,
    signature: visit.structuralSignature,
    duration: visit.durationSeconds
  })))
}

function toSnapshotVisit(visit: PathVisit): PathSnapshotVisit {
  return {
    sequence: visit.sequence,
    visitKey: visit.visitKey,
    structuralSignature: visit.structuralSignature,
    writtenMeasure: visit.writtenMeasure,
    printedNumber: visit.printedNumber,
    pass: visit.pass,
    endingNumber: visit.endingNumber,
    action: visit.action,
    actionKind: visit.actionKind,
    startTime: visit.startTime,
    durationSeconds: visit.durationSeconds
  }
}

export function describeEndpoint(endpoint: Pick<SegmentEndpoint, 'printedNumber' | 'pass' | 'endingNumber' | 'sequence'>): string {
  return `第${endpoint.sequence + 1}次到达 · 书面${endpoint.printedNumber} · 第${endpoint.pass}遍${endpoint.endingNumber ? ` · ${endpoint.endingNumber}跳房` : ''}`
}

export { canonicalJson }
