import { JSDOM } from 'jsdom'
import { createSampleXml } from '../src/sampleScore'
import { parseMusicXml } from '../src/musicxmlParser'
import { buildPerformancePath } from '../src/pathBuilder'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.DOMParser = dom.window.DOMParser
globalThis.document = dom.window.document

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const score = parseMusicXml(createSampleXml(), 'sample.musicxml')
console.log('diagnostics:', score.diagnostics.map((d) => `${d.level}: ${d.message}`))
const path = buildPerformancePath(score)
console.log('path:', path.visits.map((v) => `${v.sequence + 1}:m${v.writtenMeasure + 1}${v.endingNumber ? `/ending${v.endingNumber}` : ''}`).join(' '))
assert(path.errors.length === 0, `sample path should close: ${path.errors.join('; ')}`)
assert(score.measures.length === 10, 'should parse 10 written measures')
assert(score.measures[0].isPickup, 'measure 0 should be detected as pickup')
assert(score.measures[3].voiceCount === 2, 'measure 4 should contain two voices')
assert(path.visits.map((v) => v.writtenMeasure).join(',') === [0, 1, 2, 3, 4, 1, 2, 3, 5, 6, 7, 8, 9].join(','), 'double-ending path should visit pickup once and first/second endings once each')
assert(path.pulses[0].pickup && path.pulses[0].beatLabel === '弱起1', 'first pulse belongs to pickup')
assert(path.visits.find((v) => v.writtenMeasure === 5)?.startTime !== undefined, 'tempo change visit exists')
const beforeTempoEnd = path.visits.find((v) => v.writtenMeasure === 4)!.startTime
const tempoVisit = path.visits.find((v) => v.writtenMeasure === 5)!
assert(tempoVisit.durationSeconds < beforeTempoEnd, 'tempo 140 makes a 4/4 measure shorter than an earlier 90bpm measure')

// Uncloseable jump: D.S. al Fine without Segno or Fine must be reported, never guessed.
const broken = `<?xml version="1.0"?><score-partwise version="4.0">
<part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><words>D.S. al Fine</words></direction-type><sound tempo="100"/></direction><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note><barline location="right"><repeat direction="backward"/></barline></measure>
</part></score-partwise>`
const brokenScore = parseMusicXml(broken, 'broken.xml')
const brokenPath = buildPerformancePath(brokenScore)
assert(brokenPath.errors.some((e) => e.includes('Segno')) || brokenPath.errors.some((e) => e.includes('Fine')), 'missing Segno/Fine must be reported as an uncloseable jump')
assert(brokenPath.errors.length >= 1, 'navigation problem is visible')

function simpleMeasure(number: number, body = ''): string {
  return `<measure number="${number}">${number === 1 ? `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><sound tempo="100"/>` : ''}${body}<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure>`
}
const dsFine = `<?xml version="1.0"?><score-partwise version="4.0">
<part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list>
<part id="P1">
${simpleMeasure(1)}
${simpleMeasure(2, '<barline location="left"><segno/></barline><barline location="right"><fine/></barline>')}
${simpleMeasure(3, '<direction><direction-type><words>D.S. al Fine</words></direction-type></direction>')}
${simpleMeasure(4)}
</part></score-partwise>`
const dsScore = parseMusicXml(dsFine, 'ds.xml')
const dsPath = buildPerformancePath(dsScore)
assert(dsPath.errors.length === 0, `D.S. al Fine path should close: ${dsPath.errors.join('; ')}`)
assert(dsPath.visits.map((v) => v.writtenMeasure).join(',') === '0,1,2,1', 'D.S. al Fine should revisit the Segno measure and stop at Fine')

console.log('smoke tests passed')
