export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface Diagnostic {
  level: DiagnosticLevel
  code:
    | 'MULTIPLE_TIME_SIGNATURES'
    | 'MISSING_TEMPO'
    | 'IRREGULAR_MEASURE'
    | 'UNKNOWN_NAVIGATION_TEXT'
    | 'UNKNOWN_BARLINE_MARKER'
    | 'UNMATCHED_REPEAT_START'
    | 'ENDING_WITHOUT_REPEAT'
    | 'DUPLICATE_MARKER'
    | 'MISSING_JUMP_TARGET'
    | 'JUMP_TARGET_UNREACHED'
    | 'UNARMED_CODA'
    | 'UNREACHED_FINE'
    | 'UNSUPPORTED_STRUCTURE'
    | 'EMPTY_SCORE'
  measureIndex: number
  message: string
  elementPath?: string
}

export interface TimeSignature {
  beats: number
  beatType: number
  /** beat unit duration measured in quarter notes */
  beatUnitQuarters: number
  nominalQuarters: number
  beatGroupQuarters: number[]
}

export interface TempoEvent {
  measureIndex: number
  quarterOffset: number
  bpm: number
  source: string
}

export interface EndingRange {
  number: number
  startMeasure: number
  stopMeasure: number
  /** MusicXML ending type: start / stop / discontinue */
  stopType: 'stop' | 'discontinue'
}

export interface BarlineMarker {
  measureIndex: number
  location: 'left' | 'right'
  type:
    | 'repeat-start'
    | 'repeat-end'
    | 'segno'
    | 'coda'
    | 'fine'
    | 'ending-start'
    | 'ending-stop'
    | 'ending-discontinue'
  endingNumber?: number
  times?: number
  text?: string
}

export type JumpKind = 'dc' | 'ds' | 'to-coda'
export type JumpTargetKind = 'head' | 'segno' | 'coda'

export interface JumpInstruction {
  measureIndex: number
  location: 'left' | 'right'
  kind: JumpKind
  target: JumpTargetKind
  /** DS al Coda / DC al Coda arms an automatic coda jump after the target. */
  armsCoda: boolean
  stopAtFine: boolean
  raw: string
}

export interface ParsedMeasure {
  index: number
  printedNumber: string
  actualQuarters: number
  nominalQuarters: number
  isPickup: boolean
  isShortOrIrregular: boolean
  timesig: TimeSignature
  tempoEvents: TempoEvent[]
  voiceCount: number
  partIds: string[]
}

export interface ParsedScore {
  title: string
  partIds: string[]
  partNames: Record<string, string>
  divisionsByPart: Record<string, number>
  measures: ParsedMeasure[]
  markers: BarlineMarker[]
  segno: { measureIndex: number; location: 'left' | 'right' } | null
  coda: { measureIndex: number; location: 'left' | 'right' } | null
  fine: { measureIndex: number; location: 'left' | 'right' } | null
  jumps: JumpInstruction[]
  endings: EndingRange[]
  diagnostics: Diagnostic[]
  xml: string
}

export interface PathVisit {
  sequence: number
  writtenMeasure: number
  printedNumber: string
  startQuarter: number
  durationQuarters: number
  startTime: number
  durationSeconds: number
  pass: number
  endingNumber: number | null
  action: string
}

export interface TimedPulse {
  visitSequence: number
  writtenMeasure: number
  printedNumber: string
  measureQuarter: number
  performanceQuarter: number
  time: number
  beatLabel: string
  accent: boolean
  pickup: boolean
  bpm: number
}

export interface PerformancePath {
  visits: PathVisit[]
  pulses: TimedPulse[]
  totalSeconds: number
  errors: string[]
}

export interface RehearsalMarker {
  id: string
  writtenMeasure: number
  label: string
  createdAt: number
}

export interface StoredProject {
  id: string
  title: string
  fileName: string
  xml: string
  markers: RehearsalMarker[]
  updatedAt: number
  createdAt: number
}

export interface ExportBundle {
  schema: 'rehearsal-stand-markers/v1'
  title: string
  sourceFileName: string
  xmlSha256?: string
  markers: RehearsalMarker[]
  exportedAt: number
}
