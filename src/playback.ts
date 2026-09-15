import type {
  PathVisit,
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
  resume: SessionPosition | null
): SegmentPlayback | null {
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
      const visit: PathVisit = { ...source, sequence: visits.length, startTime: cursor }
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
