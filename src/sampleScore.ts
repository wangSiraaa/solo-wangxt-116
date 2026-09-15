const SAMPLE_TITLE = '双跳房 · 变速 · 多声部共有小节'

export function createSampleXml(): string {
  const labels = ['弱起', 'A1', 'A2', 'A3', '1跳房', '2跳房/变速', 'B1', 'B2', 'B3', '尾声']
  const measures = labels
    .map((label, i) => {
      const number = i === 0 ? '0' : String(i)
      const measure = buildPartMeasure(number, i, label)
      return measure
    })
    .join('\n')
  const secondMeasures = labels
    .map((label, i) => buildBassMeasure(i === 0 ? '0' : String(i), i, label))
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${SAMPLE_TITLE}</work-title></work>
  <identification>
    <encoding><software>Pure-frontend Rehearsal Stand</software></encoding>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>高声部（同小节含两个声部）</part-name></score-part>
    <score-part id="P2"><part-name>低声部</part-name></score-part>
  </part-list>
  <part id="P1">${measures}</part>
  <part id="P2">${secondMeasures}</part>
</score-partwise>`
}

function buildPartMeasure(number: string, i: number, label: string): string {
  const attrs =
    i === 0
      ? `<attributes>
          <divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef>
        </attributes>
        <direction placement="above"><direction-type><words>♩ = 90</words></direction-type><sound tempo="90"/></direction>`
      : i === 5
        ? `<direction placement="above"><direction-type><words>加速 ♩ = 140</words></direction-type><sound tempo="140"/></direction>`
        : ''
  const rehearsal = `<direction placement="above"><direction-type><rehearsal>${label}</rehearsal></direction-type></direction>`
  const topPitches = ['C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B4', 'C5', 'D5', 'E5']
  const lowPitches = ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A4', 'B4', 'C5']
  const body =
    i === 0
      ? `${note(topPitches[i], 1, '1')}${barline(i)}`
      : `${note(topPitches[i], 2, '1')}${note(stepDown(topPitches[i]), 2, '1')}
         <backup><duration>4</duration></backup>
         ${note(lowPitches[i], 2, '2')}${note(stepDown(lowPitches[i]), 2, '2')}
         ${barline(i)}`
  return `<measure number="${number}">${attrs}${rehearsal}${body}</measure>`
}

function buildBassMeasure(number: string, i: number, _label: string): string {
  const attrs =
    i === 0
      ? `<attributes>
          <divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
          <clef><sign>F</sign><line>4</line></clef>
        </attributes>`
      : ''
  const pitches = ['C3', 'G2', 'A2', 'B2', 'C3', 'D3', 'E3', 'F3', 'G3', 'C3']
  const body = i === 0 ? `${note(pitches[i], 1, '1')}${barline(i)}` : `${note(pitches[i], 2, '1')}${note(stepDown(pitches[i]), 2, '1')}${barline(i)}`
  return `<measure number="${number}">${attrs}${body}</measure>`
}

function note(pitch: string, duration: number, voice: string): string {
  const { step, octave } = parsePitch(pitch)
  return `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${duration === 1 ? 'quarter' : 'half'}</type></note>`
}

function parsePitch(pitch: string): { step: string; octave: number } {
  return { step: pitch[0], octave: Number(pitch.slice(1)) }
}
function stepDown(pitch: string): string {
  const seq = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
  const { step, octave } = parsePitch(pitch)
  const idx = seq.indexOf(step)
  return idx === 0 ? `B${octave - 1}` : `${seq[idx - 1]}${octave}`
}

function barline(i: number): string {
  if (i === 1) return '<barline location="left"><repeat direction="forward"/></barline>'
  if (i === 4) {
    return `<barline location="left"><ending number="1" type="start"/></barline>
      <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>`
  }
  if (i === 5) return '<barline location="left"><ending number="2" type="start"/></barline>'
  if (i === 6) return '<barline location="right"><ending number="2" type="stop"/></barline>'
  return ''
}

export const sampleTitle = SAMPLE_TITLE
