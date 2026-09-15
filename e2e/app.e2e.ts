import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function readProjects(page: Page) {
  return page.evaluate(() =>
    new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open('rehearsal-stand')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('projects', 'readonly')
        const all = tx.objectStore('projects').getAll()
        all.onsuccess = () => resolve(all.result)
        all.onerror = () => reject(all.error)
      }
    })
  )
}

async function seedLegacyProject(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '双跳房 · 变速 · 多声部共有小节' })).toBeVisible()
  await page.evaluate((xml) => {
    const project = {
      id: 'legacy-project-id',
      title: '旧版仅标记工程',
      fileName: 'legacy-project.musicxml',
      xml,
      markers: [{ id: 'legacy-marker-1', writtenMeasure: 0, label: '旧版标记必须保留', createdAt: 1 }],
      createdAt: 2,
      updatedAt: 3
    }
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('rehearsal-stand')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('projects', 'readwrite')
        tx.objectStore('projects').put(project)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, readFileSync(path.join(fixtureDir, 'legacy-project.musicxml'), 'utf8'))
}

async function installAudioProbe(page: Page) {
  await page.addInitScript(() => {
    const events: Array<Record<string, unknown>> = []
    ;(window as unknown as { __audioEvents: unknown[] }).__audioEvents = events
    const AudioContextCtor = window.AudioContext
    if (!AudioContextCtor) return

    class InstrumentedAudioContext extends AudioContextCtor {
      constructor() {
        super()
        events.push({ type: 'constructed', state: this.state })
        this.addEventListener('statechange', () => events.push({ type: 'statechange', state: this.state }))
        const originalCreateOscillator = this.createOscillator.bind(this)
        this.createOscillator = () => {
          const oscillator = originalCreateOscillator()
          const originalStart = oscillator.start.bind(oscillator)
          oscillator.start = (when?: number) => {
            events.push({ type: 'osc-start', when })
            return originalStart(when)
          }
          return oscillator
        }
      }
    }
    window.AudioContext = InstrumentedAudioContext as typeof AudioContext
  })
}

async function collectDownloads(page: Page, action: () => Promise<void>) {
  const events: import('@playwright/test').Download[] = []
  const listener = (download: import('@playwright/test').Download) => {
    if (!events.some((existing) => existing.suggestedFilename() === download.suggestedFilename())) events.push(download)
  }
  page.on('download', listener)
  await action()
  await expect.poll(() => events.length).toBeGreaterThanOrEqual(3)
  await page.waitForTimeout(500)
  page.off('download', listener)
  const results = await Promise.all(
    events.map(async (download) => ({
      filename: download.suggestedFilename(),
      content: readFileSync((await download.path())!, 'utf8')
    }))
  )
  const bySuffix = (suffix: string) => results.find((file) => file.filename.endsWith(suffix))
  return { results, bySuffix }
}

test('分部队列：独立速度/循环、刷新恢复、队列顺序隔离、失配阻塞和导入去重', async ({ page }) => {
  await installAudioProbe(page)
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await page.getByTestId('segment-name').fill('共享段落')
  await page.getByTestId('segment-start').selectOption({ index: 5 })
  await page.getByTestId('segment-end').selectOption({ index: 10 })
  await page.getByTestId('save-segment').click()

  await page.getByTestId('queue-name').fill('第一小提琴')
  await page.getByTestId('add-queue').click()
  await page.getByTestId('queue-name').fill('第二小提琴')
  await page.getByTestId('add-queue').click()
  const queueCards = page.getByTestId('queue-card')
  await expect(queueCards).toHaveCount(2)

  async function addToQueue(index: number, loops: string, tempo: string, duplicate = false) {
    const card = queueCards.nth(index)
    for (let i = 0; i < (duplicate ? 2 : 1); i += 1) {
      await card.locator('select').last().selectOption({ label: '共享段落' })
      await card.getByLabel('循环数').fill(loops)
      await card.getByLabel('速度倍率').fill(tempo)
      await card.getByRole('button', { name: '加入' }).click()
    }
  }
  await addToQueue(0, '2', '0.75', true)
  await addToQueue(1, '3', '1')
  await expect(queueCards.nth(0)).toContainText('×2')
  await expect(queueCards.nth(0)).toContainText('♩75%')
  await expect(queueCards.nth(1)).toContainText('×3')
  await expect(queueCards.nth(1)).toContainText('♩100%')

  await queueCards.nth(1).getByTestId('queue-play').click()
  await expect.poll(
    () => page.evaluate(() => ((window as unknown as { __audioEvents?: Array<{ type: string }> }).__audioEvents ?? []).filter((e) => e.type === 'osc-start').length),
    { timeout: 5_000 }
  ).toBeGreaterThanOrEqual(4)
  await page.getByRole('button', { name: '停止' }).click()
  await expect(queueCards.nth(1)).toContainText('循环1')
  await expect(queueCards.nth(0)).toContainText('未开始')

  await queueCards.nth(0).locator('.queue-items li').first().getByRole('button', { name: '↓' }).click()
  await expect(queueCards.nth(1)).toContainText('循环1')
  await expect(queueCards.nth(0)).toContainText('未开始')

  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  const reloaded = page.getByTestId('queue-card')
  await expect(reloaded.nth(1)).toContainText('循环1')
  await expect(reloaded.nth(0)).toContainText('未开始')

  const beforeVersion = await page.locator('.plan-header .pill').first().textContent()
  await page.getByRole('button', { name: '保存/更新工程' }).click()
  await expect(page.locator('.plan-header .pill').first()).toHaveText(beforeVersion ?? '')
  const downloaded = await collectDownloads(page, () => page.getByRole('button', { name: '导出 XML+标记+方案' }).click())
  const planFile = downloaded.bySuffix('rehearsal-plan.json')!
  const planBundle = JSON.parse(planFile.content)
  expect(planBundle.plan.queues).toHaveLength(2)
  expect(planBundle.plan.queues[0].items).toHaveLength(2)
  expect(planBundle.plan.queues[1].position).toBeTruthy()

  await page.evaluate(async (content) => {
    const file = new File([content], 'downloaded-plan.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector<HTMLInputElement>('input[data-testid="plan-file"]')!
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }, planFile.content)
  await expect(page.getByTestId('queue-card')).toHaveCount(2)
  await expect(page.getByTestId('queue-card').nth(0).locator('.queue-items li')).toHaveCount(2)
})

test('导航改变使到达位置消失：进入待处理状态，禁止误播；可逐项重绑/保留/删除', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await page.getByTestId('segment-name').fill('待失配段落')
  await page.getByTestId('segment-start').selectOption({ index: 5 })
  await page.getByTestId('segment-end').selectOption({ index: 9 })
  await page.getByTestId('save-segment').click()
  await expect(page.locator('.segment-card', { hasText: '待失配段落' })).toBeVisible()

  await page.locator('input[data-testid="score-file"]').setInputFiles(path.join(fixtureDir, 'modified-navigation.musicxml'))
  await expect(page.getByRole('heading', { name: '导航已修改' })).toBeVisible()
  await expect(page.locator('.plan-header')).toContainText('待处理失配')
  await expect(page.getByText('路径失配')).toBeVisible()
  await expect(page.locator('.mismatch-list')).toContainText('不能只按书面小节号自动改绑')
  const playButton = page.locator('.segment-card').getByTestId('segment-play')
  await expect(playButton).toBeDisabled()

  // The same written measures are offered as candidates, but only after explicit choice.
  const mismatches = await page.locator('.mismatch-list .diagnostic').count()
  for (let remaining = mismatches; remaining > 0; remaining -= 1) {
    const next = page.locator('.mismatch-list .diagnostic').first()
    await next.locator('select').selectOption({ index: 1 })
    await next.getByRole('button', { name: '重新绑定' }).click()
    await page.waitForTimeout(100)
  }
  await expect(page.locator('.plan-header')).toContainText('可播放')
  const stored = (await readProjects(page)) as Array<{ plan: { versions: unknown[]; segments: unknown[] } }>
  expect(stored.at(-1)?.plan.versions.length).toBeGreaterThan(1)
})

test('未知 note 子元素：诊断可见、原 XML 持久化、导出不丢符号', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[data-testid="score-file"]').setInputFiles(path.join(fixtureDir, 'unknown-note.musicxml'))
  await expect(page.getByRole('heading', { name: 'E2E 未知 note 子元素' })).toBeVisible()
  await expect(page.locator('.stat').filter({ hasText: '实际到达' })).toContainText('3')
  await page.getByRole('button', { name: /诊断/ }).click()
  const diagnostic = page.locator('.diagnostic', { hasText: 'alien-articulation' })
  await expect(diagnostic).toBeVisible()
  await expect(diagnostic).toContainText('UNKNOWN_XML_STRUCTURE')
  const projects = (await readProjects(page)) as Array<{ title: string; xml: string }>
  expect(projects.find((item) => item.title === 'E2E 未知 note 子元素')?.xml).toContain('rehearsal:alien-articulation')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  const downloaded = await collectDownloads(page, () => page.getByRole('button', { name: '导出 XML+标记+方案' }).click())
  const files = downloaded.results
  expect(downloaded.bySuffix('.musicxml')?.content).toContain('do-not-drop')
})

test('旧版仅含标记工程自动迁移：补齐默认方案，标记/XML/未知诊断/三文件导出仍回归', async ({ page }) => {
  await seedLegacyProject(page)
  await page.reload()
  await page.locator('select').first().selectOption('legacy-project-id')
  // The newest seeded legacy project should open automatically.
  await expect(page.getByRole('heading', { name: '旧版仅标记工程' })).toBeVisible()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await expect(page.getByTestId('plan-name')).toHaveValue('从旧标记工程迁移的默认方案')
  await expect(page.locator('.plan-header')).toContainText('v1')

  const stored = (await readProjects(page)) as Array<{
    schemaVersion: number
    markers: Array<{ label: string }>
    xml: string
    plan?: { migratedFromLegacyMarkers: boolean }
  }>
  const migrated = stored.find((project) => project.title === '旧版仅标记工程')!
  expect(migrated.schemaVersion).toBe(2)
  expect(migrated.markers[0].label).toBe('旧版标记必须保留')
  expect(migrated.plan?.migratedFromLegacyMarkers).toBe(true)
  expect(migrated.xml).toContain('<work-title>旧版仅标记工程</work-title>')

  await page.getByRole('button', { name: '标记', exact: true }).click()
  await expect(page.getByText('旧版标记必须保留')).toBeVisible()
  const downloads = await collectDownloads(page, () => page.getByRole('button', { name: '导出 XML+标记+方案' }).click())
  const files = downloads.results
  expect(files.map((file) => file.filename)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('.musicxml'),
      expect.stringContaining('rehearsal-markers.json'),
      expect.stringContaining('rehearsal-plan.json')
    ])
  )
})

test('共享段落路径变化：两个关联分部队列均待处理且逐项重绑只恢复对应队列', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await page.getByTestId('segment-name').fill('共享失配段落')
  await page.getByTestId('segment-start').selectOption({ index: 5 })
  await page.getByTestId('segment-end').selectOption({ index: 10 })
  await page.getByTestId('save-segment').click()

  await page.getByTestId('queue-name').fill('一提')
  await page.getByTestId('add-queue').click()
  await page.getByTestId('queue-name').fill('二提')
  await page.getByTestId('add-queue').click()
  const queues = page.getByTestId('queue-card')
  for (const index of [0, 1]) {
    const card = queues.nth(index)
    await card.locator('select').last().selectOption({ label: '共享失配段落' })
    await card.getByRole('button', { name: '加入' }).click()
  }
  await page.locator('input[data-testid="score-file"]').setInputFiles(path.join(fixtureDir, 'modified-navigation.musicxml'))
  await expect(page.locator('.plan-header')).toContainText('待处理失配')
  await expect(queues.nth(0)).toContainText('待处理 1')
  await expect(queues.nth(1)).toContainText('待处理 1')
  await expect(queues.nth(0).getByTestId('queue-play')).toBeDisabled()
  await expect(queues.nth(1).getByTestId('queue-play')).toBeDisabled()

  // Resolve only the first queue's explicit mismatch. The second must remain blocked.
  const firstQueueMismatch = page.locator('.mismatch-list .diagnostic', { hasText: '一提' }).first()
  await firstQueueMismatch.locator('select').selectOption({ index: 1 })
  await firstQueueMismatch.getByRole('button', { name: '重新绑定' }).click()
  await expect(queues.nth(0)).toContainText('待处理 0')
  await expect(queues.nth(1)).toContainText('待处理 1')
  await expect(queues.nth(1).getByTestId('queue-play')).toBeDisabled()
})
