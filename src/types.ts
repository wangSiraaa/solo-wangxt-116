export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface Diagnostic {
  level: DiagnosticLevel
  code:
    | 'MULTIPLE_TIME_SIGNATURES'
    | 'MISSING_TEMPO'
    | 'IRREGULAR_MEASURE'
    | 'UNKNOWN_NAVIGATION_TEXT'
    | 'UNKNOWN_XML_STRUCTURE'
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

export type PathActionKind =
  | 'start'
  | 'forward'
  | 'repeat-back'
  | 'ending-enter'
  | 'ending-leave'
  | 'ending-skip'
  | 'jump-dc'
  | 'jump-ds'
  | 'jump-to-coda'
  | 'jump-coda'
  | 'segno'
  | 'fine'
  | 'end'

export interface PathVisit {
  sequence: number
  visitKey: string
  writtenMeasure: number
  printedNumber: string
  startQuarter: number
  durationQuarters: number
  startTime: number
  durationSeconds: number
  pass: number
  endingNumber: number | null
  action: string
  actionKind: PathActionKind
  queueItemId?: string
  queueItemEnd?: boolean
  /** Content signature independent of the visit's current ordinal in the complete performance path. */
  structuralSignature: string
}

export interface TimedPulse {
  visitSequence: number
  visitKey: string
  loopIndex?: number
  queueItemId?: string
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

export interface PathSnapshotVisit {
  sequence: number
  visitKey: string
  structuralSignature: string
  writtenMeasure: number
  printedNumber: string
  pass: number
  endingNumber: number | null
  action: string
  actionKind: PathActionKind
  startTime: number
  durationSeconds: number
}

export interface RehearsalPathSnapshot {
  computedAt: number
  xmlSha256: string
  pathChecksum: string
  totalSeconds: number
  visits: PathSnapshotVisit[]
}

export interface SegmentEndpoint {
  visitKey: string
  sequence: number
  writtenMeasure: number
  printedNumber: string
  pass: number
  endingNumber: number | null
  actionKind: PathActionKind
  structuralSignature: string
}

export interface RehearsalSegment {
  id: string
  name: string
  start: SegmentEndpoint
  end: SegmentEndpoint
  loops: number
  createdAt: number
  updatedAt: number
  historical?: boolean
  note?: string
}

export interface SessionPosition {
  segmentId: string
  visitKey: string
  loopIndex: number
  measureQuarter: number
  updatedAt: number
  completed: boolean
}

export interface RehearsalSession {
  id: string
  name: string
  segmentIds: string[]
  segmentLoops: Record<string, number>
  position: SessionPosition | null
  createdAt: number
  updatedAt: number
}

export interface QueuePosition {
  queueId: string
  itemId: string
  segmentId: string
  visitKey: string
  loopIndex: number
  measureQuarter: number
  updatedAt: number
  completed: boolean
}

export interface QueueCompletion {
  id: string
  itemId: string
  segmentId: string
  segmentName: string
  loops: number
  tempoScale: number
  completedAt: number
}

export interface PartQueueItem {
  id: string
  segmentId: string
  segmentName: string
  start: SegmentEndpoint
  end: SegmentEndpoint
  loops: number
  /** Multiplier applied to the score's notated tempo: 0.5 = half speed, 1.25 = faster. */
  tempoScale: number
  status: 'ready' | 'pending' | 'historical'
  note?: string
  removedSegment?: boolean
  createdAt: number
  updatedAt: number
}

export interface PartQueue {
  id: string
  name: string
  items: PartQueueItem[]
  position: QueuePosition | null
  completions: QueueCompletion[]
  createdAt: number
  updatedAt: number
}

export type PlanMismatchKind = 'score-content' | 'missing-visit' | 'structural-signature'
export type PlanMismatchSubject = 'segment-start' | 'segment-end' | 'session-position' | 'queue-item' | 'queue-position'

export interface PlanMismatch {
  id: string
  kind: PlanMismatchKind
  subject: PlanMismatchSubject
  segmentId?: string
  sessionId?: string
  queueId?: string
  itemId?: string
  endpointSide?: 'start' | 'end'
  expected: SegmentEndpoint | (SessionPosition & { writtenMeasure?: number; printedNumber?: string })
  candidates: SegmentEndpoint[]
  message: string
  resolved: boolean
  resolution?: 'rebound' | 'historical' | 'deleted'
}

export interface RehearsalPlanVersion {
  id: string
  version: number
  createdAt: number
  changeSummary: string
  contentHash: string
  xmlSha256: string
  pathChecksum: string
  segments: RehearsalSegment[]
  sessions: RehearsalSession[]
  queues: PartQueue[]
  mismatches: PlanMismatch[]
}

export interface RehearsalPlan {
  id: string
  name: string
  xmlSha256: string
  pathChecksum: string
  status: 'ready' | 'pending-mismatch' | 'historical'
  currentSnapshot: RehearsalPathSnapshot
  segments: RehearsalSegment[]
  sessions: RehearsalSession[]
  queues: PartQueue[]
  mismatches: PlanMismatch[]
  versions: RehearsalPlanVersion[]
  createdAt: number
  updatedAt: number
  migratedFromLegacyMarkers?: boolean
}

export interface StoredProject {
  id: string
  title: string
  fileName: string
  xml: string
  xmlSha256?: string
  markers: RehearsalMarker[]
  plan?: RehearsalPlan | null
  schemaVersion?: 1 | 2
  updatedAt: number
  createdAt: number
}

export interface MarkerExportBundle {
  schema: 'rehearsal-stand-markers/v1'
  title: string
  sourceFileName: string
  xmlSha256?: string
  markers: RehearsalMarker[]
  exportedAt: number
}

export interface PlanExportBundle {
  schema: 'rehearsal-stand-plan/v1'
  title: string
  sourceFileName: string
  xmlSha256: string
  exportedAt: number
  plan: RehearsalPlan
}

export type ExportBundle = MarkerExportBundle | PlanExportBundle
