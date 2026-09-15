import { sha256Text } from './crypto'
import type { MarkerExportBundle, PlanExportBundle, RehearsalMarker, RehearsalPlan } from './types'

export async function downloadText(filename: string, text: string, mime: string): Promise<void> {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { sha256Text }

export async function exportProjectArtifacts(
  xml: string,
  markers: RehearsalMarker[],
  plan: RehearsalPlan | null,
  title: string,
  sourceFileName: string
): Promise<void> {
  const xmlSha256 = await sha256Text(xml)
  const markerBundle: MarkerExportBundle = {
    schema: 'rehearsal-stand-markers/v1',
    title,
    sourceFileName,
    xmlSha256,
    markers,
    exportedAt: Date.now()
  }
  const safe = safeFilename(title)
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 120))
  await downloadText(`${safe}.musicxml`, xml, 'application/vnd.recordare.musicxml+xml')
  await sleep()
  await downloadText(`${safe}.rehearsal-markers.json`, JSON.stringify(markerBundle, null, 2), 'application/json')
  if (plan) {
    await sleep()
    const planBundle: PlanExportBundle = {
      schema: 'rehearsal-stand-plan/v1',
      title,
      sourceFileName,
      xmlSha256,
      exportedAt: Date.now(),
      plan
    }
    await sleep()
    await downloadText(`${safe}.rehearsal-plan.json`, JSON.stringify(planBundle, null, 2), 'application/json')
  }
}

function safeFilename(title: string): string {
  return title.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '') || 'score'
}
