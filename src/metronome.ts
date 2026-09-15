import type { PathVisit, TimedPulse } from './types'

export interface MetronomeOptions {
  audio: AudioContext
  onPulse?: (pulse: TimedPulse, measureFraction: number) => void
  onVisit?: (visit: PathVisit) => void
  onStop?: () => void
}

const LOOKAHEAD_SECONDS = 0.12
const INTERVAL_MS = 25

export class Metronome {
  private audio: AudioContext
  private timer: number | null = null
  private stopTimer: number | null = null
  private pulses: TimedPulse[] = []
  private visits: PathVisit[] = []
  private nextPulseIndex = 0
  private startAudioTime = 0
  private startPerformanceTime = 0
  private rate = 1
  private onPulse?: (pulse: TimedPulse, measureFraction: number) => void
  private onVisit?: (visit: PathVisit) => void
  private onStop?: () => void
  private scheduledVisitKeys = new Set<number>()

  constructor(options: MetronomeOptions) {
    this.audio = options.audio
    this.onPulse = options.onPulse
    this.onVisit = options.onVisit
    this.onStop = options.onStop
  }

  setData(pulses: TimedPulse[], visits: PathVisit[]) {
    this.pulses = pulses
    this.visits = visits
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(atVisitSequence = 0, rate = 1) {
    this.stop(false)
    const visit = this.visits.find((v) => v.sequence === atVisitSequence) ?? this.visits[0]
    if (!visit) return
    this.rate = rate
    const firstPulseIndex = this.pulses.findIndex((p) => p.visitSequence === visit.sequence)
    this.nextPulseIndex = firstPulseIndex >= 0 ? firstPulseIndex : 0
    const firstPulse = this.pulses[this.nextPulseIndex]
    if (!firstPulse) return
    this.scheduledVisitKeys = new Set()
    this.startAudioTime = this.audio.currentTime + 0.08
    this.startPerformanceTime = firstPulse.time
    this.timer = window.setInterval(() => this.schedule(), INTERVAL_MS)
    this.schedule()
  }

  stop(notify = true) {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (notify) this.onStop?.()
  }

  dispose() {
    this.stop(false)
  }

  private schedule() {
    if (!this.pulses.length) return
    const horizon = this.audio.currentTime + LOOKAHEAD_SECONDS
    while (this.nextPulseIndex < this.pulses.length) {
      const pulse = this.pulses[this.nextPulseIndex]
      const when = this.startAudioTime + ((pulse.time - this.startPerformanceTime) / this.rate)
      if (when > horizon) break
      this.scheduleClick(pulse, when)
      const visit = this.visits.find((v) => v.sequence === pulse.visitSequence)
      const fraction = visit && visit.durationQuarters > 0 ? pulse.measureQuarter / visit.durationQuarters : 0
      if (visit && !this.scheduledVisitKeys.has(visit.sequence)) {
        const visitTime = this.startAudioTime + ((visit.startTime - this.startPerformanceTime) / this.rate)
        this.scheduledVisitKeys.add(visit.sequence)
        window.setTimeout(() => this.onVisit?.(visit), Math.max(0, (visitTime - this.audio.currentTime) * 1000))
      }
      const visualDelay = Math.max(0, (when - this.audio.currentTime) * 1000)
      window.setTimeout(() => this.onPulse?.(pulse, fraction), visualDelay)
      this.nextPulseIndex += 1
    }
    if (this.timer !== null && this.nextPulseIndex >= this.pulses.length) {
      clearInterval(this.timer)
      this.timer = null
      const last = this.pulses[this.pulses.length - 1]
      const endAt = this.startAudioTime + ((last.time - this.startPerformanceTime) / this.rate) + 0.3 / this.rate
      this.stopTimer = window.setTimeout(() => this.stop(true), Math.max(0, (endAt - this.audio.currentTime) * 1000))
    }
  }

  private scheduleClick(pulse: TimedPulse, when: number) {
    const osc = this.audio.createOscillator()
    const gain = this.audio.createGain()
    osc.frequency.value = pulse.accent ? 1320 : pulse.pickup ? 760 : 990
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(pulse.accent ? 0.28 : 0.16, when + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)
    osc.connect(gain).connect(this.audio.destination)
    osc.start(when)
    osc.stop(when + 0.06)
  }
}
