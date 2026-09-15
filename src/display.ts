import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import type { GraphicalMeasure, GraphicalMusicPage, GraphicalMusicSheet } from 'opensheetmusicdisplay'

interface OSMDInternals {
  graphic?: GraphicalMusicSheet
}

export interface DisplayHandle {
  render: (xml: string) => Promise<void>
  showMeasure: (measureIndex: number, pulseFraction?: number) => void
  clearCursor: () => void
  dispose: () => void
}

interface PageGeometry {
  page: GraphicalMusicPage
  index: number
  svg: SVGSVGElement
  scaleX: number
  scaleY: number
}

export async function createDisplay(container: HTMLElement): Promise<DisplayHandle> {
  const osmd = new OpenSheetMusicDisplay(container, {
    autoResize: true,
    backend: 'svg',
    drawTitle: true,
    drawPartNames: true,
    drawSubtitle: false,
    drawComposer: false,
    drawCredits: false,
    drawMetronomeMarks: true,
    drawMeasureNumbers: true,
    followCursor: false
  })

  function internals(): OSMDInternals {
    return osmd as unknown as OSMDInternals
  }

  function clearCursor() {
    container.querySelectorAll('.rehearsal-highlight,.rehearsal-cursor-line').forEach((el) => el.remove())
  }

  function measuresAt(measureIndex: number): GraphicalMeasure[] {
    return internals().graphic?.MeasureList[measureIndex]?.filter(Boolean) ?? []
  }

  function pageGeometryForY(y: number): PageGeometry | null {
    const pages = internals().graphic?.MusicPages ?? []
    const svgs = Array.from(container.querySelectorAll<SVGSVGElement>('svg'))
    const index = pages.findIndex((page) => {
      const rect = page.PositionAndShape.BoundingRectangle
      return y >= rect.y - 1 && y <= rect.y + rect.height + 1
    })
    const page = pages[index]
    const svg = svgs[index]
    if (!page || !svg) return null
    const pageRect = page.PositionAndShape.BoundingRectangle
    const width = Number(svg.getAttribute('width')) || svg.clientWidth
    const height = Number(svg.getAttribute('height')) || svg.clientHeight
    return {
      page,
      index,
      svg,
      scaleX: width / pageRect.width,
      scaleY: height / pageRect.height
    }
  }

  function appendRectangle(
    geometry: PageGeometry,
    x: number,
    y: number,
    width: number,
    height: number,
    className: string
  ): SVGRectElement {
    const pageRect = geometry.page.PositionAndShape.BoundingRectangle
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('x', String((x - pageRect.x) * geometry.scaleX))
    rect.setAttribute('y', String((y - pageRect.y) * geometry.scaleY))
    rect.setAttribute('width', String(width * geometry.scaleX))
    rect.setAttribute('height', String(height * geometry.scaleY))
    rect.setAttribute('class', className)
    geometry.svg.appendChild(rect)
    return rect
  }

  function showMeasure(measureIndex: number, pulseFraction = 0) {
    clearCursor()
    const graphic = internals().graphic
    const measures = measuresAt(measureIndex)
    if (!graphic || !measures.length) return

    const first = measures[0]
    const measureBox = first.PositionAndShape.BoundingRectangle
    const cursorX = measureBox.x + measureBox.width * pulseFraction
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let cursorElement: SVGRectElement | null = null

    for (const measure of measures) {
      const box = measure.PositionAndShape.BoundingRectangle
      const geometry = pageGeometryForY(box.y + box.height / 2)
      if (!geometry) continue
      appendRectangle(geometry, box.x, box.y, box.width, box.height, 'rehearsal-highlight')
      minY = Math.min(minY, box.y)
      maxY = Math.max(maxY, box.y + box.height)
    }

    if (Number.isFinite(minY)) {
      const geometry = pageGeometryForY(minY)
      if (geometry) {
        cursorElement = appendRectangle(geometry, cursorX - 0.06, minY, 0.12, maxY - minY, 'rehearsal-cursor-line')
      }
    }
    cursorElement?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }

  return {
    async render(xml: string) {
      clearCursor()
      await osmd.load(xml)
      osmd.render()
    },
    showMeasure,
    clearCursor,
    dispose() {
      clearCursor()
    }
  }
}
