import type { ParsedScore, PathVisit, PerformancePath, TimedPulse } from './types'

interface RepeatRegion {
  start: number
  times: number
  visits: number
}

interface JumpState {
  used: Set<string>
  afterJump: boolean
  codaArmed: boolean
}

interface CursorState {
  index: number
  boundary: 'left' | 'right'
  pass: number
  ending: number | null
  action: string
}

const MAX_STEPS = 10000

export function buildPerformancePath(score: ParsedScore): PerformancePath {
  const errors: string[] = [...score.diagnostics.filter((d) => d.level === 'error').map((d) => d.message)]
  if (score.measures.length === 0) {
    return { visits: [], pulses: [], totalSeconds: 0, errors: errors.length ? errors : ['没有可构造的小节。'] }
  }

  const repeats: RepeatRegion[] = []
  const jump: JumpState = { used: new Set(), afterJump: false, codaArmed: false }
  const visits: PathVisit[] = []

  let cursor: CursorState = { index: 0, boundary: 'left', pass: 1, ending: null, action: '开始' }

  let steps = 0
  while (cursor.index < score.measures.length) {
    steps += 1
    if (steps > MAX_STEPS) {
      errors.push('演奏路径超过 10000 步，判定存在无法闭合的循环。')
      break
    }
    if (visits.length > MAX_STEPS) {
      errors.push('演奏路径超过 10000 个小节，判定存在无法闭合的循环。')
      break
    }

    if (cursor.boundary === 'left') {
      enterRepeatStart(score, repeats, cursor.index)
      const endingDecision =
        cursor.ending === null ? chooseEnding(score, repeats, cursor) : { ...cursor, ending: cursor.ending }
      if (endingDecision?.action.startsWith('第 ')) {
        const completedRepeat = repeats.find((r) => r.visits >= r.times)
        if (completedRepeat) repeats.splice(repeats.indexOf(completedRepeat), 1)
        cursor = endingDecision
        continue
      }
      if (endingDecision) cursor.ending = endingDecision.ending

      if (markerAt(score, cursor.index, 'left', 'segno') && jump.afterJump) cursor.action = cursor.action || '到达 Segno'
      if (markerAt(score, cursor.index, 'left', 'coda') && jump.afterJump) cursor.action = cursor.action || '进入 Coda'
      if (isFine(score, cursor.index, 'left') && shouldStopAtFine(score, jump)) {
        cursor.action = 'Fine：结束'
        break
      }
    }

    const measure = score.measures[cursor.index]
    const sequence = visits.length
    const startQuarter = visits.reduce((sum, v) => sum + v.durationQuarters, 0)
    const startTime = visits.reduce((sum, v) => sum + v.durationSeconds, 0)
    visits.push({
      sequence,
      writtenMeasure: cursor.index,
      printedNumber: measure.printedNumber,
      startQuarter,
      durationQuarters: measure.actualQuarters,
      startTime,
      durationSeconds: measureDurationSeconds(score, cursor.index),
      pass: cursor.pass,
      endingNumber: cursor.ending,
      action: cursor.action
    })

    if (isFine(score, cursor.index, 'right') && shouldStopAtFine(score, jump)) {
      visits[visits.length - 1].action = 'Fine：结束'
      break
    }

    cursor = processRightBoundary(score, repeats, jump, cursor, errors)
    if (cursor.action === '__STOP__') break
  }

  validateMarkersUsed(score, jump, errors)
  const pulses = buildPulses(score, visits)
  return {
    visits,
    pulses,
    totalSeconds: visits.reduce((sum, v) => sum + v.durationSeconds, 0),
    errors: [...new Set(errors)]
  }
}

function enterRepeatStart(score: ParsedScore, repeats: RepeatRegion[], index: number) {
  const marker = score.markers.find((m) => m.measureIndex === index && m.location === 'left' && m.type === 'repeat-start')
  if (!marker || repeats.some((r) => r.start === index)) return
  repeats.push({ start: index, times: marker.times ?? 2, visits: 0 })
}

function chooseEnding(score: ParsedScore, repeats: RepeatRegion[], cursor: CursorState): CursorState | null {
  const active = score.endings.filter((e) => cursor.index >= e.startMeasure && cursor.index <= e.stopMeasure)
  if (!active.length) return null

  const innermost = [...repeats].reverse().find((r) => active.some((e) => e.startMeasure >= r.start))
  const pass = innermost ? innermost.visits + 1 : cursor.pass
  const selected = active.find((e) => e.number === pass)
  if (!selected) {
    const stop = Math.max(...active.map((e) => e.stopMeasure))
    return {
      index: stop + 1,
      boundary: 'left',
      pass,
      ending: null,
      action: `第 ${pass} 遍跳过 ${active.map((e) => `第${e.number}跳房`).join('、')}`
    }
  }
  return { ...cursor, pass, ending: selected.number, action: '顺序前进' }
}

function processRightBoundary(
  score: ParsedScore,
  repeats: RepeatRegion[],
  jump: JumpState,
  cursor: CursorState,
  errors: string[]
): CursorState {
  const repeatEnd = score.markers.find((m) => m.measureIndex === cursor.index && m.location === 'right' && m.type === 'repeat-end')
  if (repeatEnd) {
    const region = activeRegionFor(score, repeats, cursor.index)
    if (region) {
      if (region.visits + 1 < region.times) {
        region.visits += 1
        return {
          index: region.start,
          boundary: 'left',
          pass: region.visits + 1,
          ending: null,
          action: `反复：回到书面第 ${region.start + 1} 小节（第 ${region.visits + 1} 遍）`
        }
      }
      // Section complete. Keep the record for ending selection until the ending is left.
      region.visits += 1
    }
  }

  const ending = score.endings.find((e) => cursor.ending === e.number && e.stopMeasure === cursor.index)
  if (ending) {
    if (repeats.some((r) => r.start <= ending.startMeasure && r.visits >= r.times)) {
      repeats.splice(0, repeats.length)
    }
    return {
      index: ending.stopMeasure + 1,
      boundary: 'left',
      pass: cursor.pass,
      ending: null,
      action: ending.stopMeasure + 1 >= score.measures.length ? '__STOP__' : `离开第${ending.number}跳房，顺序前进`
    }
  }

  const explicitJump = score.jumps
    .filter((j) => j.measureIndex === cursor.index && j.location === 'right')
    .sort((a, b) => ({ 'to-coda': 0, ds: 1, dc: 2 }[a.kind] - { 'to-coda': 0, ds: 1, dc: 2 }[b.kind]))[0]
  if (explicitJump) {
    const key = `${explicitJump.kind}:${explicitJump.measureIndex}`
    if (jump.used.has(key)) {
      errors.push(`第 ${cursor.index + 1} 小节的 ${explicitJump.raw} 第二次到达；为避免无限循环未再次执行。`)
    } else if (explicitJump.kind === 'to-coda') {
      if (!score.coda) errors.push(`“${explicitJump.raw}”找不到 Coda 目标。`)
      else {
        jump.used.add(key)
        jump.codaArmed = true
        return jumpCursor(score.coda.measureIndex, score.coda.location, `To Coda：跳到书面第 ${score.coda.measureIndex + 1} 小节`, jump)
      }
    } else {
      const target = explicitJump.target === 'head' ? { measureIndex: 0, location: 'left' as const } : score.segno
      if (!target) errors.push(`“${explicitJump.raw}”找不到 ${explicitJump.target === 'segno' ? 'Segno' : '曲首'}。`)
      else {
        jump.used.add(key)
        jump.afterJump = true
        jump.codaArmed = explicitJump.armsCoda
        return jumpCursor(
          target.measureIndex,
          target.location,
          `${explicitJump.raw}：跳到书面第 ${target.measureIndex + 1} 小节${explicitJump.stopAtFine ? '，至 Fine 结束' : ''}`,
          jump
        )
      }
    }
  }

  if (jump.codaArmed && score.coda) {
    const launch = score.jumps.find((j) => j.kind === 'to-coda')
    if (!launch) {
      errors.push('al Coda 已武装，但没有明确的 To Coda 起跳点；不能猜测跳转位置。')
    } else if (cursor.index >= launch.measureIndex) {
      jump.codaArmed = false
      return jumpCursor(score.coda.measureIndex, score.coda.location, `al Coda：跳到书面第 ${score.coda.measureIndex + 1} 小节`, jump)
    }
  }

  if (cursor.index + 1 >= score.measures.length) return { ...cursor, index: cursor.index + 1, action: '__STOP__' }
  return { ...cursor, index: cursor.index + 1, boundary: 'left', ending: null, action: '顺序前进' }
}

function activeRegionFor(score: ParsedScore, repeats: RepeatRegion[], repeatEndIndex: number): RepeatRegion | null {
  const inEnding = score.endings.some((e) => repeatEndIndex >= e.startMeasure && repeatEndIndex <= e.stopMeasure)
  const candidates = repeats.filter((r) => r.start <= repeatEndIndex)
  if (inEnding) {
    return [...candidates].reverse().find((r) => score.endings.some((e) => repeatEndIndex >= e.startMeasure && e.startMeasure >= r.start)) ?? null
  }
  return candidates[candidates.length - 1] ?? null
}

function jumpCursor(
  index: number,
  boundary: 'left' | 'right',
  action: string,
  jump: JumpState
): CursorState {
  jump.afterJump = true
  return { index, boundary, pass: 1, ending: null, action }
}

function markerAt(score: ParsedScore, index: number, location: 'left' | 'right', type: string): boolean {
  return score.markers.some((m) => m.measureIndex === index && m.location === location && m.type === type)
}
function isFine(score: ParsedScore, index: number, location: 'left' | 'right'): boolean {
  return !!score.fine && score.fine.measureIndex === index && score.fine.location === location
}
function shouldStopAtFine(score: ParsedScore, jump: JumpState): boolean {
  return jump.afterJump && score.jumps.some((j) => j.stopAtFine)
}

function validateMarkersUsed(score: ParsedScore, jump: JumpState, errors: string[]) {
  for (const j of score.jumps) {
    if (j.target === 'segno' && !score.segno) errors.push(`第 ${j.measureIndex + 1} 小节“${j.raw}”缺少 Segno 目标。`)
    if (j.target === 'coda' && !score.coda) errors.push(`第 ${j.measureIndex + 1} 小节“${j.raw}”缺少 Coda 目标。`)
    if (j.stopAtFine && !score.fine) errors.push(`第 ${j.measureIndex + 1} 小节“${j.raw}”缺少 Fine。`)
  }
  if (score.segno && !score.jumps.some((j) => j.target === 'segno')) {
    errors.push(`Segno 位于书面第 ${score.segno.measureIndex + 1} 小节，但没有 D.S. 使用它。`)
  }
  if (score.fine && !score.jumps.some((j) => j.stopAtFine)) {
    errors.push(`Fine 位于书面第 ${score.fine.measureIndex + 1} 小节，但没有 D.C./D.S. al Fine 使用它。`)
  }
  if (score.coda && !score.jumps.some((j) => j.kind === 'to-coda' || j.armsCoda)) {
    errors.push(`Coda 位于书面第 ${score.coda.measureIndex + 1} 小节，但没有 To Coda/al Coda 使用它。`)
  }
  if (jump.codaArmed && score.coda) errors.push('到达曲末时仍未完成 al Coda 跳转，跳转无法闭合。')
}

function bpmAt(score: ParsedScore, measureIndex: number, quarterOffset: number): number {
  let bpm = 100
  for (const m of score.measures) {
    if (m.index > measureIndex) break
    for (const e of m.tempoEvents) {
      if (m.index < measureIndex || e.quarterOffset <= quarterOffset) bpm = e.bpm
    }
  }
  return bpm
}

function measureDurationSeconds(score: ParsedScore, measureIndex: number): number {
  const measure = score.measures[measureIndex]
  let elapsed = 0
  let cursor = 0
  let bpm = bpmAt(score, measureIndex, 0)
  for (const e of measure.tempoEvents.filter((e) => e.quarterOffset > 0).sort((a, b) => a.quarterOffset - b.quarterOffset)) {
    elapsed += ((e.quarterOffset - cursor) * 60) / bpm
    cursor = e.quarterOffset
    bpm = e.bpm
  }
  elapsed += Math.max(0, (measure.actualQuarters - cursor) * 60) / bpm
  return elapsed
}

function measureOffsetSeconds(score: ParsedScore, measureIndex: number, offset: number): number {
  const measure = score.measures[measureIndex]
  let elapsed = 0
  let cursor = 0
  let bpm = bpmAt(score, measureIndex, 0)
  for (const e of measure.tempoEvents.filter((e) => e.quarterOffset > 0 && e.quarterOffset < offset).sort((a, b) => a.quarterOffset - b.quarterOffset)) {
    elapsed += ((e.quarterOffset - cursor) * 60) / bpm
    cursor = e.quarterOffset
    bpm = e.bpm
  }
  elapsed += Math.max(0, (offset - cursor) * 60) / bpm
  return elapsed
}

function buildPulses(score: ParsedScore, visits: PathVisit[]): TimedPulse[] {
  const pulses: TimedPulse[] = []
  for (const visit of visits) {
    const measure = score.measures[visit.writtenMeasure]
    const groups = measure.timesig.beatGroupQuarters
    const isFirstPerformancePickup = measure.isPickup && visit.sequence === 0
    const positions = isFirstPerformancePickup ? pickupPositions(groups, measure.actualQuarters) : beatPositions(groups, measure.actualQuarters)
    positions.forEach((q, i) => {
      pulses.push({
        visitSequence: visit.sequence,
        writtenMeasure: visit.writtenMeasure,
        printedNumber: measure.printedNumber,
        measureQuarter: q,
        performanceQuarter: visit.startQuarter + q,
        time: visit.startTime + measureOffsetSeconds(score, visit.writtenMeasure, q),
        beatLabel: isFirstPerformancePickup ? `弱起${i + 1}` : `${i + 1}`,
        accent: !isFirstPerformancePickup && i === 0,
        pickup: isFirstPerformancePickup,
        bpm: bpmAt(score, visit.writtenMeasure, q)
      })
    })
  }
  return pulses
}

function beatPositions(groups: number[], actualQuarters: number): number[] {
  const out = [0]
  let sum = 0
  for (const g of groups) {
    sum += g
    if (sum < actualQuarters - 1e-9) out.push(sum)
  }
  return out
}

function pickupPositions(groups: number[], actualQuarters: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    sum += groups[i]
    if (sum <= actualQuarters + 1e-9) out.unshift(actualQuarters - sum)
    else break
  }
  return out.length ? out : [0]
}
