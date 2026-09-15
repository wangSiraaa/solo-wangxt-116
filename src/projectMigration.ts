import type { PartQueue, PlanExportBundle, RehearsalPlan, StoredProject } from './types'
import { canonicalJson, sha256Text } from './crypto'
import { fullQueueHash, queueContentHash } from './queueService'
import { plainClone } from './plainClone'

type PlanImportShape = PlanExportBundle

export interface ProjectMigration {
  project: StoredProject
  migrated: boolean
  message?: string
}

export function isLegacyProject(project: StoredProject): boolean {
  return !project.plan || project.schemaVersion !== 2
}

/**
 * One-time browser-side migration for builds that stored marker-only projects before
 * named rehearsal plans existed. The plan is filled lazily on first open because its
 * path snapshot requires parsing the XML.
 */
export function markProjectForPlanMigration(project: StoredProject): StoredProject {
  if (!isLegacyProject(project)) return project
  return {
    ...project,
    schemaVersion: 1,
    plan: null
  }
}

export async function migrateLegacyProject(
  project: StoredProject,
  plan: RehearsalPlan
): Promise<StoredProject> {
  return {
    ...project,
    schemaVersion: 2,
    plan,
    updatedAt: Math.max(project.updatedAt, Date.now())
  }
}

export async function importPlanBundle(
  local: StoredProject | undefined,
  bundle: {
    title: string
    sourceFileName: string
    xmlSha256: string
    plan: RehearsalPlan
    exportedAt: number
  }
): Promise<{ project?: StoredProject; status: 'imported' | 'duplicate' | 'newer-local' | 'wrong-score'; message: string }> {
  if (!local) {
    return {
      status: 'wrong-score',
      message: '请先打开与方案摘要一致的乐谱工程，再导入方案。'
    }
  }
  const localXmlHash = local.xmlSha256 ?? (await sha256Text(local.xml))
  if (localXmlHash !== bundle.xmlSha256) {
    return { status: 'wrong-score', message: '方案 XML 摘要与当前乐谱不一致，已拒绝导入。' }
  }

  const localPlan = local.plan
  if (!localPlan) {
    return {
      project: { ...local, schemaVersion: 2, plan: bundle.plan, updatedAt: bundle.exportedAt },
      status: 'imported',
      message: '已导入方案。'
    }
  }

  const incomingVersion = bundle.plan.versions[0]?.version ?? 1
  const localVersion = localPlan.versions[0]?.version ?? 1

  const incomingQueues: PartQueue[] = Array.isArray(bundle.plan.queues) ? bundle.plan.queues : []
  const localQueues: PartQueue[] = Array.isArray(localPlan.queues) ? localPlan.queues : []
  const localByContent = new Map(localQueues.map((queue) => [queueContentHash(queue), queue]))
  let addedQueues = 0
  const mergedQueues = localQueues.map((queue) => plainClone(queue))
  for (const incomingQueue of incomingQueues) {
    const contentHash = queueContentHash(incomingQueue)
    const existing = localByContent.get(contentHash)
    if (!existing) {
      mergedQueues.push(plainClone(incomingQueue))
      addedQueues += 1
      continue
    }
    const localUpdated = new Date(existing.updatedAt).getTime()
    const incomingUpdated = new Date(incomingQueue.updatedAt).getTime()
    if (localUpdated > incomingUpdated) {
      return { status: 'newer-local', message: `本部分队“${existing.name}”比导入文件更新，已避免覆盖。` }
    }
    if (fullQueueHash(existing) === fullQueueHash(incomingQueue)) continue
    const index = mergedQueues.findIndex((queue) => queue.id === existing.id)
    if (index >= 0) mergedQueues[index] = plainClone(incomingQueue)
  }

  if (!addedQueues && incomingVersion <= localVersion && localPlan.pathChecksum === bundle.plan.pathChecksum) {
    const incomingHash = bundle.plan.versions[0]?.contentHash
    const localHash = localPlan.versions[0]?.contentHash
    if (incomingHash === localHash || localPlan.versions.some((version) => version.contentHash === incomingHash)) {
      return { status: 'duplicate', message: '该方案版本已存在，未创建重复段落或版本。' }
    }
  }
  if (localPlan.updatedAt > bundle.exportedAt) {
    return { status: 'newer-local', message: '本地方案比导入文件更新，已避免覆盖。' }
  }

  const mergedPlan: RehearsalPlan = {
    ...plainClone(bundle.plan),
    queues: mergedQueues
  }

  return {
    project: { ...local, schemaVersion: 2, plan: mergedPlan, updatedAt: bundle.exportedAt },
    status: 'imported',
    message: addedQueues ? `已导入 ${addedQueues} 个新分部队列。` : '已合并方案队列。'
  }
}

export async function validateImportedPlan(value: unknown): Promise<{ ok: true; bundle: PlanImportShape } | { ok: false; message: string }> {
  if (!value || typeof value !== 'object') return { ok: false, message: '导入文件不是 JSON 对象。' }
  const bundle = value as PlanImportShape
  if (bundle.schema !== 'rehearsal-stand-plan/v1') return { ok: false, message: '方案 schema 不是 rehearsal-stand-plan/v1。' }
  if (!bundle.xmlSha256 || !/^[a-f0-9]{64}$/.test(bundle.xmlSha256)) return { ok: false, message: '缺少有效的乐谱 SHA-256 摘要。' }
  if (!bundle.plan?.id || !bundle.plan.currentSnapshot?.visits?.length) return { ok: false, message: '方案快照为空或结构不完整。' }
  return { ok: true, bundle }
}

export function planImportCanonical(value: unknown): string {
  return canonicalJson(value)
}
