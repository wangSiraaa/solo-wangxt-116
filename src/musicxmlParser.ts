import type {
  BarlineMarker,
  Diagnostic,
  EndingRange,
  JumpInstruction,
  ParsedMeasure,
  ParsedScore,
  TempoEvent,
  TimeSignature
} from './types'

interface RawMeasureContext {
  index: number
  printedNumber: string
  actualQuarters: number
  nominalQuarters: number
  voiceCount: number
  partIds: string[]
  tempos: TempoEvent[]
  startTimesig: TimeSignature | null
  midmeasureTimesigChanges: number
}

export function parseMusicXml(xml: string, fileName = 'score.musicxml'): ParsedScore {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parseError = doc.getElementsByTagName('parsererror')[0]
  const diagnostics: Diagnostic[] = []
  if (parseError) {
    diagnostics.push({
      level: 'error',
      code: 'EMPTY_SCORE',
      measureIndex: -1,
      message: `XML 无法解析：${parseError.textContent?.slice(0, 180) ?? '语法错误'}`
    })
    return emptyScore(xml, diagnostics)
  }

  const root = doc.documentElement
  if (root.localName === 'score-timewise') {
    diagnostics.push({
      level: 'error',
      code: 'UNSUPPORTED_STRUCTURE',
      measureIndex: -1,
      message: '暂不支持 timewise MusicXML；请另存为 partwise（按声部组织）MusicXML。'
    })
    return emptyScore(xml, diagnostics)
  }
  if (root.localName !== 'score-partwise') {
    diagnostics.push({
      level: 'error',
      code: 'EMPTY_SCORE',
      measureIndex: -1,
      message: '根元素不是 score-partwise。'
    })
    return emptyScore(xml, diagnostics)
  }

  const partIds = Array.from(doc.getElementsByTagName('score-part')).map((p) => p.getAttribute('id') ?? '')
  const partNames: Record<string, string> = {}
  Array.from(doc.getElementsByTagName('score-part')).forEach((p) => {
    const id = p.getAttribute('id') ?? ''
    partNames[id] = text(p, 'part-name') || id
  })

  const partElements = Array.from(root.children).filter((c) => c.localName === 'part')
  if (partElements.length === 0 || partIds.length === 0) {
    diagnostics.push({ level: 'error', code: 'EMPTY_SCORE', measureIndex: -1, message: '未找到任何声部。' })
    return emptyScore(xml, diagnostics)
  }

  const measureCount = Math.max(...partElements.map((p) => p.getElementsByTagName('measure').length))
  if (measureCount === 0) {
    diagnostics.push({ level: 'error', code: 'EMPTY_SCORE', measureIndex: -1, message: '未找到任何小节。' })
    return emptyScore(xml, diagnostics)
  }

  const divisionsByPart: Record<string, number> = {}
  const activeTimesigByPart: Record<string, TimeSignature | null> = {}
  const raw: RawMeasureContext[] = Array.from({ length: measureCount }, (_, i) => ({
    index: i,
    printedNumber: String(i + 1),
    actualQuarters: 0,
    nominalQuarters: 0,
    voiceCount: 0,
    partIds: [],
    tempos: [],
    startTimesig: null,
    midmeasureTimesigChanges: 0
  }))

  const markers: BarlineMarker[] = []
  const jumps: JumpInstruction[] = []
  const segnoCandidates: Array<{ measureIndex: number; location: 'left' | 'right' }> = []
  const codaCandidates: Array<{ measureIndex: number; location: 'left' | 'right' }> = []
  const fineCandidates: Array<{ measureIndex: number; location: 'left' | 'right' }> = []

  for (const part of partElements) {
    const partId = part.getAttribute('id') ?? ''
    let divisions = Number(text(part, 'divisions')) || 0
    let activeTimesig: TimeSignature | null = null
    const measures = Array.from(part.children).filter((c) => c.localName === 'measure')

    measures.forEach((measure, measureIndex) => {
      const ctx = raw[measureIndex]
      if (!ctx) return
      ctx.partIds.push(partId)
      if (measureIndex === 0) ctx.printedNumber = measure.getAttribute('number') || '1'
      else if (measure.getAttribute('number')) ctx.printedNumber = measure.getAttribute('number')!

      const voices = new Map<string, number>()
      let globalCursor = 0
      let divisionAtMeasureStart = divisions
      let timesigDeclaredAtThisMeasure = false

      for (const child of Array.from(measure.children)) {
        if (child.localName === 'attributes') {
          const d = num(child, 'divisions')
          if (Number.isFinite(d) && d > 0) divisions = d
          const ts = readTimeSignature(child)
          if (ts) {
            if (!timesigDeclaredAtThisMeasure) {
              activeTimesig = ts
              ctx.startTimesig ??= ts
              timesigDeclaredAtThisMeasure = true
            } else {
              ctx.midmeasureTimesigChanges += 1
            }
          }
        }

        if (child.localName === 'note') {
          if (!divisionAtMeasureStart) divisionAtMeasureStart = divisions
          const voice = text(child, 'voice') || '1'
          const isChord = !!child.getElementsByTagName('chord')[0]
          const isGrace = child.getElementsByTagName('grace').length > 0
          const duration = Number(text(child, 'duration'))
          let onset = globalCursor
          if (!voices.has(voice)) voices.set(voice, globalCursor)
          if (!isChord) {
            onset = voices.get(voice) ?? globalCursor
          } else {
            onset = voices.get(voice) ?? globalCursor
          }
          const noteSound = firstLocal(child, 'sound')
          if (noteSound?.getAttribute('tempo')) {
            const bpm = Number(noteSound.getAttribute('tempo'))
            if (Number.isFinite(bpm) && bpm > 0) {
              ctx.tempos.push({
                measureIndex,
                quarterOffset: divisions ? onset / divisions : 0,
                bpm,
                source: `<note><sound tempo="${bpm}">`
              })
            }
          }
          if (!isGrace && Number.isFinite(duration) && duration > 0 && divisions > 0 && !isChord) {
            const quarters = duration / divisions
            const end = onset + quarters
            voices.set(voice, end)
            globalCursor = Math.max(globalCursor, end)
          }
        }

        if (child.localName === 'forward') {
          const duration = Number(text(child, 'duration'))
          const voice = text(child, 'voice') || '1'
          if (Number.isFinite(duration) && divisions > 0) {
            const end = (voices.get(voice) ?? globalCursor) + duration / divisions
            voices.set(voice, end)
            globalCursor = Math.max(globalCursor, end)
          }
        }

        if (child.localName === 'backup') {
          const duration = Number(text(child, 'duration'))
          if (Number.isFinite(duration) && divisions > 0) {
            globalCursor = Math.max(0, globalCursor - duration / divisions)
          }
        }

        if (child.localName === 'direction') {
          const directionSound = Array.from(child.getElementsByTagName('sound')).find((s) =>
            s.getAttribute('tempo')
          )
          let offsetQuarters = 0
          const offset = firstLocal(child, 'offset')
          if (offset && divisions > 0) offsetQuarters = Number(offset.textContent) / divisions
          if (directionSound) {
            const bpm = Number(directionSound.getAttribute('tempo'))
            if (Number.isFinite(bpm) && bpm > 0) {
              ctx.tempos.push({
                measureIndex,
                quarterOffset: Math.max(0, offsetQuarters),
                bpm,
                source: `<sound tempo="${bpm}">`
              })
            }
          }
          const metro = firstLocal(child, 'metronome')
          if (metro) {
            const bpm = metronomeBpm(metro)
            if (bpm) {
              ctx.tempos.push({
                measureIndex,
                quarterOffset: Math.max(0, offsetQuarters),
                bpm,
                source: metro.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40) || 'metronome'
              })
            }
          }
          collectNavigationText(child, measureIndex, 'right', jumps, fineCandidates, diagnostics)
        }

        if (child.localName === 'barline') {
          collectBarline(child, measureIndex, markers, segnoCandidates, codaCandidates, fineCandidates, diagnostics)
        }
      }

      divisionsByPart[partId] = divisions
      activeTimesigByPart[partId] = activeTimesig
      const measured = Math.max(0, ...Array.from(voices.values()))
      ctx.actualQuarters = Math.max(ctx.actualQuarters, measured)
      ctx.voiceCount = Math.max(ctx.voiceCount, voices.size)
      if (!activeTimesig) {
        activeTimesig = { beats: 4, beatType: 4, beatUnitQuarters: 1, nominalQuarters: 4, beatGroupQuarters: [1, 1, 1, 1] }
      }
      ctx.nominalQuarters = activeTimesig.nominalQuarters
    })
  }

  // Canonicalize tempo events and timesignatures. All parts should agree for a deterministic rehearsal clock.
  for (let i = 0; i < raw.length; i++) {
    const ctx = raw[i]
    const timesigs = new Set(partElements.map((part) => {
      const m = Array.from(part.children).filter((c) => c.localName === 'measure')[i]
      return m ? attrsTimesigKey(m) : ''
    }))
    if (timesigs.size > 1) {
      diagnostics.push({
        level: 'warning',
        code: 'MULTIPLE_TIME_SIGNATURES',
        measureIndex: i,
        message: `书面第 ${ctx.printedNumber} 小节各声部拍号不同；演奏路径以第一个声部计算，节拍器可能不适合所有声部。`
      })
    }
    if (ctx.midmeasureTimesigChanges > 0) {
      diagnostics.push({
        level: 'warning',
        code: 'UNSUPPORTED_STRUCTURE',
        measureIndex: i,
        message: `书面第 ${ctx.printedNumber} 小节包含小节中拍号变化；当前仅支持拍号在小节边界改变。`
      })
    }
    ctx.tempos = ctx.tempos.filter(
      (event, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex < index &&
            other.measureIndex === event.measureIndex &&
            Math.abs(other.quarterOffset - event.quarterOffset) < 1e-9 &&
            other.bpm === event.bpm
        )
    )
    ctx.tempos.sort((a, b) => a.quarterOffset - b.quarterOffset || a.bpm - b.bpm)
  }

  const measures: ParsedMeasure[] = raw.map((ctx, index) => {
    const timesig = ctx.startTimesig ?? activeTimesigByPart[partElements[0]?.getAttribute('id') ?? ''] ?? {
      beats: 4,
      beatType: 4,
      beatUnitQuarters: 1,
      nominalQuarters: 4,
      beatGroupQuarters: [1, 1, 1, 1]
    }
    const actual = ctx.actualQuarters > 0 ? ctx.actualQuarters : timesig.nominalQuarters
    const epsilon = 1 / 10000
    const isPickup = index === 0 && actual + epsilon < timesig.nominalQuarters
    const irregular = Math.abs(actual - timesig.nominalQuarters) > epsilon && !isPickup
    if (isPickup) {
      diagnostics.push({
        level: 'info',
        code: 'IRREGULAR_MEASURE',
        measureIndex: index,
        message: `第 ${ctx.printedNumber} 小节识别为弱起：实际 ${actual} 个四分音符，完整小节应为 ${timesig.nominalQuarters}。`
      })
    }
    if (irregular) {
      diagnostics.push({
        level: 'warning',
        code: 'IRREGULAR_MEASURE',
        measureIndex: index,
        message: `第 ${ctx.printedNumber} 小节实际时长 ${actual} 与拍号时长 ${timesig.nominalQuarters} 不一致，已按实际音符计算，请确认是否为省略/非标记谱。`
      })
    }
    return {
      index,
      printedNumber: ctx.printedNumber,
      actualQuarters: actual,
      nominalQuarters: timesig.nominalQuarters,
      isPickup,
      isShortOrIrregular: isPickup || irregular,
      timesig,
      tempoEvents: ctx.tempos,
      voiceCount: Math.max(1, ctx.voiceCount),
      partIds: [...new Set(ctx.partIds)]
    }
  })

  if (!measures.some((m) => m.tempoEvents.length > 0)) {
    diagnostics.push({
      level: 'warning',
      code: 'MISSING_TEMPO',
      measureIndex: 0,
      message: '未找到 <sound tempo> 或节拍器标记；默认按 ♩=100 生成节拍参考，并不会将其写回原 XML。'
    })
    measures[0].tempoEvents.push({ measureIndex: 0, quarterOffset: 0, bpm: 100, source: '默认 ♩=100' })
  }

  dedupeMarkers(markers)
  validateEndingMarkers(markers, measures.length, diagnostics)
  const endings = buildEndingRanges(markers, diagnostics)
  validateRepeats(markers, endings, diagnostics)

  const uniqueSegno = uniqueMarkerPosition(segnoCandidates, 'Segno', diagnostics)
  const uniqueCoda = uniqueMarkerPosition(codaCandidates, 'Coda', diagnostics)
  const uniqueFine = uniqueMarkerPosition(fineCandidates, 'Fine', diagnostics)
  validateJumpInstructions(
    jumps,
    uniqueSegno ? { measureIndex: uniqueSegno.measureIndex } : null,
    uniqueCoda ? { measureIndex: uniqueCoda.measureIndex } : null,
    uniqueFine ? { measureIndex: uniqueFine.measureIndex } : null,
    diagnostics
  )

  const title = text(doc, 'work-title') || text(doc, 'movement-title') || fileName.replace(/\.(musicxml|xml)$/i, '')
  return {
    title,
    partIds: partIds.filter(Boolean),
    partNames,
    divisionsByPart,
    measures,
    markers,
    segno: uniqueSegno,
    coda: uniqueCoda,
    fine: uniqueFine,
    jumps,
    endings,
    diagnostics,
    xml
  }
}

function emptyScore(xml: string, diagnostics: Diagnostic[]): ParsedScore {
  return {
    title: '无法读取的乐谱',
    partIds: [],
    partNames: {},
    divisionsByPart: {},
    measures: [],
    markers: [],
    segno: null,
    coda: null,
    fine: null,
    jumps: [],
    endings: [],
    diagnostics,
    xml
  }
}

function text(parent: Element | Document, tag: string): string {
  return parent.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''
}
function firstLocal(parent: Element, tag: string): Element | null {
  return Array.from(parent.children).find((c) => c.localName === tag) ?? null
}
function num(parent: Element, tag: string): number {
  return Number(text(parent, tag))
}

function readTimeSignature(attributes: Element): TimeSignature | null {
  const time = Array.from(attributes.children).find((c) => c.localName === 'time')
  if (!time) return null
  const beats = Number(text(time, 'beats'))
  const beatType = Number(text(time, 'beat-type'))
  if (!Number.isFinite(beats) || !Number.isFinite(beatType) || beats <= 0 || beatType <= 0) return null
  const beatUnitQuarters = 4 / beatType
  let groups: number[]
  if (beatType === 8 && [6, 12].includes(beats)) groups = Array(beats / 6).fill(3 * beatUnitQuarters)
  else if (beatType === 8 && beats === 9) groups = [3 * beatUnitQuarters, 3 * beatUnitQuarters, 3 * beatUnitQuarters]
  else if (beatType === 8 && beats % 3 === 0) groups = Array(beats / 3).fill(3 * beatUnitQuarters)
  else groups = Array(beats).fill(beatUnitQuarters)
  return {
    beats,
    beatType,
    beatUnitQuarters,
    nominalQuarters: beats * beatUnitQuarters,
    beatGroupQuarters: groups
  }
}

function attrsTimesigKey(measure: Element): string {
  const attr = Array.from(measure.children).find((c) => c.localName === 'attributes')
  if (!attr) return ''
  const time = Array.from(attr.children).find((c) => c.localName === 'time')
  return time ? `${text(time, 'beats')}/${text(time, 'beat-type')}` : ''
}

function metronomeBpm(metro: Element): number | null {
  const perMinute = Number(text(metro, 'per-minute'))
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null
  const dotCount = metro.getElementsByTagName('beat-unit-dot').length
  const unit = text(metro, 'beat-unit')
  const denom = unitToDenominator(unit)
  if (!denom) return perMinute
  const unitQuarters = (4 / denom) * (dotCount ? 1.5 : 1)
  return perMinute * unitQuarters
}

function unitToDenominator(unit: string): number | null {
  const map: Record<string, number> = {
    whole: 1,
    half: 2,
    quarter: 4,
    eighth: 8,
    '16th': 16,
    sixteenth: 16,
    '32nd': 32,
    '64th': 64
  }
  return map[unit] ?? null
}

function collectBarline(
  barline: Element,
  measureIndex: number,
  markers: BarlineMarker[],
  segno: Array<{ measureIndex: number; location: 'left' | 'right' }>,
  coda: Array<{ measureIndex: number; location: 'left' | 'right' }>,
  fine: Array<{ measureIndex: number; location: 'left' | 'right' }>,
  diagnostics: Diagnostic[]
) {
  const location = barline.getAttribute('location') === 'left' ? 'left' : 'right'
  const ending = firstLocal(barline, 'ending')
  const repeat = firstLocal(barline, 'repeat')
  if (ending) {
    const type = ending.getAttribute('type')
    const number = Number(ending.getAttribute('number')?.split(/\s*,\s*|\s*-\s*/)[0])
    if (type === 'start') markers.push({ measureIndex, location, type: 'ending-start', endingNumber: number })
    if (type === 'stop') markers.push({ measureIndex, location, type: 'ending-stop', endingNumber: number })
    if (type === 'discontinue') markers.push({ measureIndex, location, type: 'ending-discontinue', endingNumber: number })
  }
  if (repeat) {
    const direction = repeat.getAttribute('direction')
    const times = Number(repeat.getAttribute('times')) || undefined
    if (direction === 'forward') markers.push({ measureIndex, location, type: 'repeat-start', times })
    if (direction === 'backward') markers.push({ measureIndex, location, type: 'repeat-end', times })
  }
  if (firstLocal(barline, 'segno')) segno.push({ measureIndex, location })
  if (firstLocal(barline, 'coda')) coda.push({ measureIndex, location })
  if (firstLocal(barline, 'fine')) fine.push({ measureIndex, location })
  for (const child of Array.from(barline.children)) {
    if (
      ['ending', 'repeat', 'segno', 'coda', 'fine', 'wavy-line', 'fermata', 'bar-style', 'editorial'].includes(
        child.localName
      )
    ) {
      continue
    }
    diagnostics.push({
      level: 'warning',
      code: 'UNKNOWN_BARLINE_MARKER',
      measureIndex,
      message: `发现未用于跳转构造的小节线子元素 <${child.localName}>；已保留在原 XML 中，但演奏路径不会猜测其含义。`
    })
  }
}

function collectNavigationText(
  direction: Element,
  measureIndex: number,
  location: 'left' | 'right',
  jumps: JumpInstruction[],
  fine: Array<{ measureIndex: number; location: 'left' | 'right' }>,
  diagnostics: Diagnostic[]
) {
  const candidates = Array.from(direction.querySelectorAll('words,rehearsal'))
  for (const node of candidates) {
    const raw = node.textContent?.trim() ?? ''
    const normalized = raw.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    const parsedJump = parseJumpText(normalized)
    const isJumpText = /d\.?\s*[csp]\.?|da\s+capo|dal\s+segno|to\s+coda/i.test(normalized)
    if (!parsedJump && !isJumpText && /fine\b/i.test(normalized)) fine.push({ measureIndex, location })
    if (parsedJump) {
      // Target existence is validated after every part is scanned, because markers may live in another part.
      jumps.push({ measureIndex, location, raw: normalized, ...parsedJump })
    } else if (looksLikeNavigation(normalized)) {
      diagnostics.push({
        level: 'warning',
        code: 'UNKNOWN_NAVIGATION_TEXT',
        measureIndex,
        message: `无法闭合或不支持的导航文字“${normalized}”；未静默忽略。`
      })
    }
  }
}

function validateJumpInstructions(
  jumps: JumpInstruction[],
  segno: { measureIndex: number } | null,
  coda: { measureIndex: number } | null,
  fine: { measureIndex: number } | null,
  diagnostics: Diagnostic[]
) {
  for (const jump of jumps) {
    if (jump.target === 'segno' && !segno) {
      diagnostics.push({
        level: 'error',
        code: 'MISSING_JUMP_TARGET',
        measureIndex: jump.measureIndex,
        message: `“${jump.raw}”要求跳到 Segno，但乐谱中没有 Segno 记号。`
      })
    }
    if ((jump.target === 'coda' || jump.armsCoda) && !coda) {
      diagnostics.push({
        level: 'error',
        code: 'MISSING_JUMP_TARGET',
        measureIndex: jump.measureIndex,
        message: `“${jump.raw}”要求进入 Coda，但乐谱中没有 Coda 记号。`
      })
    }
    if (jump.stopAtFine && !fine) {
      diagnostics.push({
        level: 'error',
        code: 'MISSING_JUMP_TARGET',
        measureIndex: jump.measureIndex,
        message: `“${jump.raw}”要求至 Fine 结束，但乐谱中没有 Fine。`
      })
    }
  }
}

function parseJumpText(text: string): Omit<JumpInstruction, 'measureIndex' | 'location' | 'raw'> | null {
  const t = text.toLowerCase()
  const dc = /d\.\s*c\.|da\s+capo|d\s*c\b/.test(t)
  const ds = /d\.\s*s\.|dal\s+segno|d\s*s\b/.test(t)
  const toCoda = /to\s+coda|jump\s+at\s+coda/.test(t)
  if (!dc && !ds && !toCoda) return null
  const alCoda = /al\s+coda|alla\s+coda|coda/.test(t) && !toCoda
  const alFine = /al\s+fine|fine/.test(t)
  if (toCoda) return { kind: 'to-coda', target: 'coda', armsCoda: false, stopAtFine: false }
  if (ds) return { kind: 'ds', target: 'segno', armsCoda: alCoda, stopAtFine: alFine || !alCoda }
  return { kind: 'dc', target: 'head', armsCoda: alCoda, stopAtFine: alFine || !alCoda }
}

function looksLikeNavigation(text: string): boolean {
  return /d\.?\s*[csp]\.?|da\s+capo|dal\s+segno|segno|coda|fine|capo/i.test(text)
}

function dedupeMarkers(markers: BarlineMarker[]) {
  const seen = new Set<string>()
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i]
    const key = `${m.measureIndex}-${m.location}-${m.type}-${m.endingNumber ?? ''}-${m.times ?? ''}`
    if (seen.has(key)) markers.splice(i, 1)
    seen.add(key)
  }
  markers.sort((a, b) => a.measureIndex - b.measureIndex)
}

function validateEndingMarkers(markers: BarlineMarker[], measureCount: number, diagnostics: Diagnostic[]) {
  const starts = markers.filter((m) => m.type === 'ending-start')
  const stops = markers.filter((m) => m.type === 'ending-stop' || m.type === 'ending-discontinue')
  for (const s of starts) {
    if (!stops.some((e) => e.endingNumber === s.endingNumber && e.measureIndex >= s.measureIndex)) {
      diagnostics.push({
        level: 'error',
        code: 'ENDING_WITHOUT_REPEAT',
        measureIndex: s.measureIndex,
        message: `第 ${s.endingNumber} 跳房开始后没有 stop/discontinue，演奏路径无法闭合。`
      })
    }
  }
  for (const stop of stops) {
    if (!starts.some((s) => s.endingNumber === stop.endingNumber && s.measureIndex <= stop.measureIndex)) {
      diagnostics.push({
        level: 'error',
        code: 'ENDING_WITHOUT_REPEAT',
        measureIndex: stop.measureIndex,
        message: `第 ${stop.endingNumber} 跳房有结束但没有开始。`
      })
    }
  }
  if (markers.some((m) => m.measureIndex >= measureCount)) {
    diagnostics.push({ level: 'error', code: 'UNSUPPORTED_STRUCTURE', measureIndex: measureCount - 1, message: '存在超出小节范围的跳房记号。' })
  }
}

function buildEndingRanges(markers: BarlineMarker[], diagnostics: Diagnostic[]): EndingRange[] {
  const starts = markers.filter((m) => m.type === 'ending-start')
  const ranges: EndingRange[] = []
  for (const start of starts) {
    const stop = markers.find(
      (m) =>
        (m.type === 'ending-stop' || m.type === 'ending-discontinue') &&
        m.endingNumber === start.endingNumber &&
        m.measureIndex >= start.measureIndex
    )
    if (!stop) continue
    ranges.push({
      number: start.endingNumber!,
      startMeasure: start.location === 'left' ? start.measureIndex : start.measureIndex + 1,
      stopMeasure: stop.measureIndex,
      stopType: stop.type === 'ending-discontinue' ? 'discontinue' : 'stop'
    })
  }
  const byStart = new Map<number, EndingRange[]>()
  for (const r of ranges) {
    const arr = byStart.get(r.startMeasure) ?? []
    arr.push(r)
    byStart.set(r.startMeasure, arr)
  }
  for (const arr of byStart.values()) {
    if (arr.some((r) => r.number !== arr[0].number)) {
      diagnostics.push({
        level: 'warning',
        code: 'ENDING_WITHOUT_REPEAT',
        measureIndex: arr[0].startMeasure,
        message: `同一位置开始了多个不同跳房编号（${arr.map((r) => r.number).join(', ')}）；请确认 MusicXML 跳房标签。`
      })
    }
  }
  return ranges.sort((a, b) => a.startMeasure - b.startMeasure || a.number - b.number)
}

function validateRepeats(markers: BarlineMarker[], endings: EndingRange[], diagnostics: Diagnostic[]) {
  const starts = markers.filter((m) => m.type === 'repeat-start')
  const ends = markers.filter((m) => m.type === 'repeat-end')
  for (const s of starts) {
    if (!ends.some((e) => e.measureIndex >= s.measureIndex)) {
      diagnostics.push({
        level: 'warning',
        code: 'UNMATCHED_REPEAT_START',
        measureIndex: s.measureIndex,
        message: '前反复记号没有找到匹配的后反复记号；按曲首到该后反复处理。'
      })
    }
  }
  for (const e of ends) {
    if (!starts.some((s) => s.measureIndex <= e.measureIndex)) {
      diagnostics.push({
        level: 'info',
        code: 'UNMATCHED_REPEAT_START',
        measureIndex: e.measureIndex,
        message: '后反复记号没有前反复记号；将回到第 1 小节。'
      })
    }
  }
  for (const group of endingGroups(endings)) {
    const groupStart = Math.min(...group.map((e) => e.startMeasure))
    const groupEnd = Math.max(...group.map((e) => e.stopMeasure))
    const hasBackRepeat = ends.some((e) => e.measureIndex >= groupStart && e.measureIndex <= groupEnd)
    if (!hasBackRepeat) {
      diagnostics.push({
        level: 'error',
        code: 'ENDING_WITHOUT_REPEAT',
        measureIndex: groupStart,
        message: `跳房组 ${group.map((e) => e.number).join('/')} 内没有任何后反复记号，无法确定返回路径。`
      })
    }
  }
}

function endingGroups(endings: EndingRange[]): EndingRange[][] {
  const sorted = [...endings].sort((a, b) => a.startMeasure - b.startMeasure || a.number - b.number)
  const groups: EndingRange[][] = []
  for (const ending of sorted) {
    const group = groups.find((g) => Math.max(...g.map((e) => e.stopMeasure)) >= ending.startMeasure - 1)
    if (group) group.push(ending)
    else groups.push([ending])
  }
  return groups
}

function uniqueMarkerPosition(
  positions: Array<{ measureIndex: number; location: 'left' | 'right' }>,
  name: string,
  diagnostics: Diagnostic[]
): { measureIndex: number; location: 'left' | 'right' } | null {
  const keys = new Set(positions.map((p) => `${p.measureIndex}:${p.location}`))
  if (keys.size > 1) {
    diagnostics.push({
      level: 'error',
      code: 'DUPLICATE_MARKER',
      measureIndex: positions[1]?.measureIndex ?? positions[0].measureIndex,
      message: `${name} 记号在多个位置出现：${[...keys].join('、')}；跳转目标不唯一。`
    })
  }
  return positions[0] ?? null
}
