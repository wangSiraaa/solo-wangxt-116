import type {
  PartQueue,
  PathVisit,
  QueuePosition,
  RehearsalSegment,
  RehearsalSession,
  SessionPosition,
  TimedPulse
} from './types'

export interface SegmentPlayback {
  pulses: TimedPulse[]
  visits: PathVisit[]
  totalSeconds: number
  startPosition: SessionPosition
}

export function buildSegmentPlayback(
  segment: RehearsalSegment,
  session: RehearsalSession,
  allVisits: PathVisit[],
  allPulses: TimedPulse[],
  resume: SessionPosition | null,
  queueItemId?: string
): SegmentPlayback | null {
  void queueItemId
  const start = allVisits.find((visit) => visit.visitKey === segment.start.visitKey)
  const end = allVisits.find((visit) => visit.visitKey === segment.end.visitKey)
  if (!start || !end || start.sequence > end.sequence) return null

  const sourceVisits = allVisits.slice(start.sequence, end.sequence + 1)
  const sourcePulseByVisit = new Map<string, TimedPulse[]>()
  for (const pulse of allPulses) {
    const list = sourcePulseByVisit.get(pulse.visitKey) ?? []
    list.push(pulse)
    sourcePulseByVisit.set(pulse.visitKey, list)
  }

  const loops = session.segmentLoops[segment.id] ?? segment.loops
  const resumeInSegment = resume?.segmentId === segment.id ? resume : null
  let resumeIndex = 0
  let resumeLoop = resumeInSegment?.loopIndex ?? 0
  let resumeQuarter = resumeInSegment?.measureQuarter ?? 0
  if (resumeInSegment) {
    resumeIndex = sourceVisits.findIndex((visit) => visit.visitKey === resumeInSegment.visitKey)
    if (resumeIndex < 0) return null
    resumeLoop = Math.min(resumeLoop, loops - 1)
  }

  const visits: PathVisit[] = []
  const pulses: TimedPulse[] = []
  let cursor = 0

  for (let loopIndex = 0; loopIndex < loops; loopIndex += 1) {
    for (let visitIndex = 0; visitIndex < sourceVisits.length; visitIndex += 1) {
      if (resumeInSegment && loopIndex === resumeLoop && visitIndex < resumeIndex) continue
      const source = sourceVisits[visitIndex]
      const visit: PathVisit = {
        ...source,
        durationQuarters: source.durationQuarters,
        sequence: visits.length,
        startTime: cursor,
        queueItemId,
        queueItemEnd: false
      }
      visits.push(visit)
      const sourcePulses = sourcePulseByVisit.get(source.visitKey) ?? []
      for (const sourcePulse of sourcePulses) {
        if (resumeInSegment && loopIndex === resumeLoop && visitIndex === resumeIndex && sourcePulse.measureQuarter < resumeQuarter) {
          continue
        }
        pulses.push({
          ...sourcePulse,
          visitSequence: visit.sequence,
          loopIndex,
          time: cursor + sourcePulse.time - source.startTime
        })
      }
      cursor += source.durationSeconds
    }
  }

  const startVisit = sourceVisits[resumeIndex] ?? sourceVisits[0]
  return {
    pulses,
    visits,
    totalSeconds: cursor,
    startPosition: {
      segmentId: segment.id,
      visitKey: startVisit.visitKey,
      loopIndex: resumeLoop,
      measureQuarter: resumeQuarter,
      updatedAt: Date.now(),
      completed: false
    }
  }
}

export interface QueuePlayback {
  pulses: TimedPulse[]
  visits: PathVisit[]
  totalSeconds: number
  startPosition: QueuePosition
}

export function buildQueuePlayback(
  queue: PartQueue,
  allVisits: PathVisit[],
  allPulses: TimedPulse[],
  resume: QueuePosition | null,
  blockedItemIds: ReadonlySet<string> = new Set()
): QueuePlayback | null {
  const playableItems = queue.items.filter((item) => item.status === 'ready' && !blockedItemIds.has(item.id))
  if (!playableItems.length || playableItems.length !== queue.items.length) return null
  const resumeItemId = resume?.itemId
  const startIndex = resume ? playableItems.findIndex((item) => item.id === resumeItemId) : 0
  const effectiveStart = startIndex < 0 ? 0 : startIndex
  const pulses: TimedPulse[] = []
  const visits: PathVisit[] = []
  let cursor = 0
  let itemStart = 0
  let startPosition: QueuePosition | null = null

  for (let itemOrder = effectiveStart; itemOrder < playableItems.length; itemOrder += 1) {
    const item = playableItems[itemOrder]
    const startVisit = allVisits.find((visit) => visit.visitKey === item.start.visitKey)
    const endVisit = allVisits.find((visit) => visit.visitKey === item.end.visitKey)
    if (!startVisit || !endVisit || startVisit.sequence > endVisit.sequence) return null

    const segment: RehearsalSegment = {
      id: item.segmentId,
      name: item.segmentName,
      start: item.start,
      end: item.end,
      loops: item.loops,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
    const session: RehearsalSession = {
      id: queue.id,
      name: queue.name,
      segmentIds: [segment.id],
      segmentLoops: { [segment.id]: item.loops },
      position: null,
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt
    }
    const itemResume =
      resume && itemOrder === effectiveStart && resume.itemId === item.id
        ? {
            segmentId: item.segmentId,
            visitKey: resume.visitKey,
            loopIndex: resume.loopIndex,
            measureQuarter: resume.measureQuarter,
            updatedAt: resume.updatedAt,
            completed: false
          }
        : null

    const playback = buildSegmentPlayback(segment, session, allVisits, allPulses, itemResume, item.id)
    if (!playback) return null
    itemStart = cursor

    const offset = visits.length
    for (const visit of playback.visits) {
      visits.push({
        ...visit,
        sequence: visits.length,
        startTime: itemStart + visit.startTime / item.tempoScale,
        durationSeconds: visit.durationSeconds / item.tempoScale,
        queueItemId: item.id,
        queueItemEnd: false
      })
    }
    for (const pulse of playback.pulses) {
      pulses.push({
        ...pulse,
        visitSequence: offset + pulse.visitSequence,
        loopIndex: pulse.loopIndex,
        queueItemId: item.id,
        time: itemStart + pulse.time / item.tempoScale,
        bpm: Math.round(pulse.bpm * item.tempoScale)
      })
    }
    const last = visits[visits.length - 1]
    if (last) {
      last.queueItemEnd = true
      last.queueItemId = item.id
    }
    cursor = itemStart + playback.totalSeconds / item.tempoScale

    if (itemOrder === effectiveStart) {
      startPosition = {
        queueId: queue.id,
        itemId: item.id,
        segmentId: item.segmentId,
        visitKey: itemResume?.visitKey ?? item.start.visitKey,
        loopIndex: itemResume?.loopIndex ?? 0,
        measureQuarter: itemResume?.measureQuarter ?? 0,
        updatedAt: Date.now(),
        completed: false
      }
    }
  }

  if (!startPosition) return null
  return { pulses, visits, totalSeconds: cursor, startPosition }
}
