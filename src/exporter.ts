import type { ExportBundle, RehearsalMarker } from './types'

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function exportOriginalAndMarkers(
  xml: string,
  markers: RehearsalMarker[],
  title: string,
  sourceFileName: string
): Promise<void> {
  const bundle: ExportBundle = {
    schema: 'rehearsal-stand-markers/v1',
    title,
    sourceFileName,
    xmlSha256: await sha256Text(xml),
    markers,
    exportedAt: Date.now()
  }
  const safe = title.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '') || 'score'
  downloadText(`${safe}.musicxml`, xml, 'application/vnd.recordare.musicxml+xml')
  downloadText(`${safe}.rehearsal-markers.json`, JSON.stringify(bundle, null, 2), 'application/json')
}
