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

async function collectDownloads(page: Page, action: () => Promise<void>, min = 3) {
  const events: import('@playwright/test').Download[] = []
  const listener = (download: import('@playwright/test').Download) => {
    if (!events.some((existing) => existing.suggestedFilename() === download.suggestedFilename())) events.push(download)
  }
  page.on('download', listener)
  await action()
  await expect.poll(() => events.length).toBeGreaterThanOrEqual(min)
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

test('三项队列逐项完成、刷新恢复、完整播放后历史不重复', async ({ page }) => {
  await installAudioProbe(page)
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()

  async function makeSegment(name: string, visitOption: number) {
    await page.getByTestId('segment-name').fill(name)
    await page.getByTestId('segment-start').selectOption({ index: visitOption })
    await page.getByTestId('segment-end').selectOption({ index: visitOption })
    await page.getByTestId('save-segment').click()
  }
  await makeSegment('短段一', 2)
  await makeSegment('短段二', 3)
  await makeSegment('短段三', 4)

  await page.getByTestId('queue-name').fill('长笛')
  await page.getByTestId('add-queue').click()
  const queue = page.getByTestId('queue-card').first()
  for (const name of ['短段一', '短段二', '短段三']) {
    await queue.locator('select').last().selectOption({ label: name })
    await queue.getByRole('button', { name: '加入' }).click()
  }
  await expect(queue.locator('.queue-items li')).toHaveCount(3)

  await queue.getByTestId('queue-play').click()
  await expect.poll(async () => {
    const projects = (await readProjects(page)) as Array<{
      plan?: { queues?: Array<{ completions: unknown[]; position?: { itemId: string; completed: boolean } }> }
    }>
    return projects.at(-1)?.plan?.queues?.[0]?.completions.length ?? 0
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: '停止' }).click()
  await expect(queue).toContainText('短段三')
  const projectsAtInterrupt = (await readProjects(page)) as Array<{
    plan?: { queues?: Array<{ completions: Array<{ segmentName: string }>; position?: { itemId: string } }> }
  }>
  const interruptedQueue = projectsAtInterrupt.at(-1)!.plan!.queues![0]
  expect(interruptedQueue.completions.map((c) => c.segmentName)).toEqual(['短段一', '短段二'])

  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  const restoredQueue = page.getByTestId('queue-card').first()
  await expect(restoredQueue).toContainText('短段三')
  await restoredQueue.getByTestId('queue-play').click()
  await expect(restoredQueue).toContainText('队列已完成')
  const completedProjects = (await readProjects(page)) as Array<{
    plan?: { queues?: Array<{ completions: Array<{ segmentName: string; loops: number; tempoScale: number }> }> }
  }>
  const completedQueue = completedProjects.at(-1)!.plan!.queues![0]
  expect(completedQueue.completions.map((c) => c.segmentName)).toEqual(['短段一', '短段二', '短段三'])

  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  const reopenedQueue = page.getByTestId('queue-card').first()
  await expect(reopenedQueue).toContainText('队列已完成')
  const downloaded = await collectDownloads(page, () => page.getByRole('button', { name: '导出 XML+标记+方案' }).click())
  const planFile = downloaded.bySuffix('rehearsal-plan.json')!
  await page.evaluate(async (content) => {
    const file = new File([content], 'plan.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector<HTMLInputElement>('input[data-testid="plan-file"]')!
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }, planFile.content)
  const reimportedProjects = (await readProjects(page)) as Array<{
    plan?: { queues?: Array<{ completions: unknown[] }> }
  }>
  expect(reimportedProjects.at(-1)?.plan?.queues?.[0]?.completions).toHaveLength(3)
})

async function setupProposalBase(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await page.getByTestId('segment-name').fill('共享段落')
  await page.getByTestId('segment-start').selectOption({ index: 5 })
  await page.getByTestId('segment-end').selectOption({ index: 10 })
  await page.getByTestId('save-segment').click()

  await page.getByTestId('queue-name').fill('一提')
  await page.getByTestId('add-queue').click()
  await page.getByTestId('queue-name').fill('二提')
  await page.getByTestId('add-queue').click()
  const queues = page.getByTestId('queue-card')
  for (const index of [0, 1]) {
    await queues.nth(index).locator('select').last().selectOption({ label: '共享段落' })
    await queues.nth(index).getByRole('button', { name: '加入' }).click()
  }
  return queues
}

async function exportProposalFromUI(page: Page, name: string) {
  const downloaded = await collectDownloads(
    page,
    async () => {
      await page.locator('[data-testid^="proposal-"]', { hasText: name }).getByTestId('export-proposal').click()
    },
    1
  )
  return downloaded.results[0].content
}

async function importProposalContent(page: Page, content: string) {
  await page.evaluate((text) => {
    const file = new File([text], 'proposal.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector<HTMLInputElement>('input[data-testid="proposal-file"]')!
    if (!input) throw new Error('missing proposal input')
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, content)
  await page.waitForTimeout(250)
}

async function importProposalContentViaPlanFile(page: Page, content: string) {
  await page.evaluate((text) => {
    const file = new File([text], 'proposal.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector<HTMLInputElement>('input[data-testid="plan-file"]')!
    if (!input) throw new Error('missing plan input')
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, content)
  await page.waitForTimeout(250)
}

test('变更提案：不同分部无冲突合并，重复/乱序导入幂等，历史不回退', async ({ page }) => {
  await setupProposalBase(page)
  const queues = page.getByTestId('queue-card')

  await page.getByPlaceholder('作者/分部').fill('一提')
  await page.getByPlaceholder('提案名称').fill('一提提速')
  await page.getByRole('button', { name: '基于当前版本建提案' }).click()
  const proposalCard = page.locator('[data-testid^="proposal-"]', { hasText: '一提提速' })
  await proposalCard.locator('.proposal-editor.active [data-testid="proposal-queue-select"]').selectOption({ label: '一提' })
  await proposalCard.locator('.proposal-editor.active [data-testid="proposal-item-select"]').selectOption({ label: '共享段落' })
  await proposalCard.locator('.proposal-editor.active [data-testid="proposal-item-tempo"]').fill('1.25')
  await proposalCard.locator('.proposal-editor.active [data-testid="proposal-item-apply"]').click()
  await page.waitForTimeout(100)
  const storedAfterA = (await readProjects(page)) as Array<{
    proposals?: Array<{ name: string; queues?: unknown[] }>
  }>
  const currentProject = storedAfterA.find((item) => item.proposals?.some((proposal) => proposal.name === '一提提速'))
  const editedA = currentProject?.proposals?.find((proposal) => proposal.name === '一提提速')
  expect(currentProject?.proposals?.some((proposal) => proposal.name === '一提提速')).toBe(true)
  expect(editedA).toBeTruthy()
  expect(editedA?.queues ?? []).toHaveLength(2)

  const proposalA = await exportProposalFromUI(page, '一提提速')
  const proposalBundleA = JSON.parse(proposalA) as {
    proposal: { queues: Array<{ name: string; items: Array<{ tempoScale: number }> }> }
  }
  expect(proposalBundleA.proposal.queues.find((queue) => queue.name === '一提')?.items[0]?.tempoScale).toBe(1.25)

  await page.getByPlaceholder('作者/分部').fill('二提')
  await page.getByPlaceholder('提案名称').fill('二提减速')
  await page.getByRole('button', { name: '基于当前版本建提案' }).click()
  const proposalB = page.locator('[data-testid^="proposal-"]', { hasText: '二提减速' })
  await proposalB.locator('.proposal-editor.active [data-testid="proposal-queue-select"]').selectOption({ label: '二提' })
  await proposalB.locator('.proposal-editor.active [data-testid="proposal-item-select"]').selectOption({ label: '共享段落' })
  await proposalB.locator('.proposal-editor.active [data-testid="proposal-item-tempo"]').fill('0.75')
  await proposalB.locator('.proposal-editor.active [data-testid="proposal-item-apply"]').click()
  const proposalBJson = await exportProposalFromUI(page, '二提减速')

  // Import in reverse order: B then A. Both touch different queues, so no conflict version is needed.
  for (const content of [proposalBJson, proposalA, proposalA]) {
    await importProposalContent(page, content)
  }
  await expect(queues.nth(0)).toContainText('♩125%')
  await expect(queues.nth(1)).toContainText('♩75%')
  const projects = (await readProjects(page)) as Array<{ mergeRecords?: unknown[]; proposals?: unknown[] }>
  expect(projects.at(-1)?.mergeRecords).toHaveLength(2)
  expect(projects.at(-1)?.proposals).toHaveLength(2)
})

test('变更提案：共享队列项同字段冲突可逐项决议，刷新保留，合并可撤销', async ({ page }) => {
  await setupProposalBase(page)

  async function makeProposal(author: string, name: string, tempo: string) {
    await page.getByPlaceholder('作者/分部').fill(author)
    await page.getByPlaceholder('提案名称').fill(name)
    await page.getByRole('button', { name: '基于当前版本建提案' }).click()
    const card = page.locator('[data-testid^="proposal-"]', { hasText: name })
    await card.locator('.proposal-editor.active [data-testid="proposal-queue-select"]').selectOption({ label: '一提' })
    await card.locator('.proposal-editor.active [data-testid="proposal-item-select"]').selectOption({ label: '共享段落' })
    await card.locator('.proposal-editor.active [data-testid="proposal-item-tempo"]').fill(tempo)
    await card.locator('.proposal-editor.active [data-testid="proposal-item-apply"]').click()
    return exportProposalFromUI(page, name)
  }
  const proposalA = await makeProposal('指挥', '指挥加速', '1.5')
  // Local conflicting modification after proposal export: same queue item, same field.
  const projectsBefore = (await readProjects(page)) as Array<{
    plan?: { queues?: Array<{ items: Array<{ id: string; tempoScale: number }> }> }
  }>
  const localItemId = projectsBefore.at(-1)?.plan?.queues?.[0]?.items[0]?.id
  await page.evaluate((itemId) => {
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('rehearsal-stand')
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('projects', 'readwrite')
        const get = tx.objectStore('projects').getAll()
        get.onsuccess = () => {
          const project = get.result.at(-1)
          const item = project.plan.queues[0].items.find((candidate: { id: string }) => candidate.id === itemId)
          item.tempoScale = 0.5
          tx.objectStore('projects').put(project)
        }
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, localItemId)
  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()

  await importProposalContent(page, proposalA)
  await expect(page.locator('[data-testid^="pending-merge-"]')).toBeVisible()
  await expect(page.locator('[data-testid^="pending-merge-"]')).toContainText('item.tempoScale')
  await expect(page.getByTestId('apply-merge')).toBeDisabled()

  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await expect(page.locator('[data-testid^="pending-merge-"]')).toBeVisible()
  const conflict = page.locator('[data-testid^="pending-merge-"] .diagnostic').first()
  await conflict.getByRole('button', { name: '采用提案' }).click()
  await page.getByTestId('apply-merge').click()
  await expect(page.getByTestId('queue-card').first()).toContainText('♩150%')

  const undo = page.getByTestId('undo-merge')
  await expect(undo).toBeVisible()
  await undo.click()
  await expect(page.getByTestId('undo-merge')).toHaveCount(0)
})

async function setupThreeItemRun(page: Page) {
  await installAudioProbe(page)
  await page.goto('/')
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  async function makeSegment(name: string, visitOption: number) {
    await page.getByTestId('segment-name').fill(name)
    await page.getByTestId('segment-start').selectOption({ index: visitOption })
    await page.getByTestId('segment-end').selectOption({ index: visitOption })
    await page.getByTestId('save-segment').click()
  }
  await makeSegment('短段一', 2)
  await makeSegment('短段二', 3)
  await makeSegment('短段三', 4)
  await page.getByTestId('queue-name').fill('长笛')
  await page.getByTestId('add-queue').click()
  const queue = page.getByTestId('queue-card').first()
  for (const name of ['短段一', '短段二', '短段三']) {
    await queue.locator('select').last().selectOption({ label: name })
    await queue.getByRole('button', { name: '加入' }).click()
  }
  await queue.getByTestId('queue-play').click()
  await expect(queue).toContainText('队列已完成')
  return queue
}

test('账本：篡改事件/缺失父链阻塞播放，不按书面小节猜测', async ({ page }) => {
  await setupThreeItemRun(page)
  // Tamper a ledger event payload directly in IndexedDB.
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('rehearsal-stand')
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('projects', 'readwrite')
        const get = tx.objectStore('projects').getAll()
        get.onsuccess = () => {
          const project = get.result.at(-1)
          const ledger = project.ledger
          const target = ledger.events.find((event: { type: string }) => event.type === 'queue.item-complete')
          target.summary = '被篡改'
          tx.objectStore('projects').put(project)
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
  })
  await page.reload()
  await page.getByRole('button', { name: '排练方案', exact: true }).click()
  await expect(page.getByTestId('ledger-panel')).toContainText('账本阻塞')
  const play = page.getByTestId('queue-card').first().getByTestId('queue-play')
  await expect(play).toBeDisabled()
})

test('账本：重复和乱序导入幂等，不产生重复完成记录', async ({ page }) => {
  const queue = await setupThreeItemRun(page)
  const exported = await collectDownloads(page, () => page.getByRole('button', { name: '导出 XML+标记+方案' }).click(), 4)
  const ledgerFile = exported.bySuffix('rehearsal-ledger.json')!
  const bundle = JSON.parse(ledgerFile.content) as {
    ledger: { events: Array<Record<string, unknown>> }
  }
  // Shuffle non-genesis events to create out-of-order payload; causal fold should apply 0
  // because the target ledger already contains them (duplicate by id).
  const shuffled = JSON.parse(JSON.stringify(bundle))
  shuffled.ledger.events = [...bundle.ledger.events].reverse()
  await page.evaluate((text) => {
    const file = new File([text], 'ledger.json', { type: 'application/json' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector<HTMLInputElement>('input[data-testid="plan-file"]')!
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, JSON.stringify(shuffled))
  await page.waitForTimeout(400)
  const projects = (await readProjects(page)) as Array<{
    plan?: { queues?: Array<{ completions: unknown[] }> }
  }>
  expect(projects.at(-1)?.plan?.queues?.[0]?.completions).toHaveLength(3)
  await expect(queue).toContainText('队列已完成')
})
