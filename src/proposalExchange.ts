import { sha256Text } from './crypto'
import { downloadText } from './exporter'
import { plainClone } from './plainClone'
import {
  createPendingMerge,
  createProposal,
  normalizeProposal,
  proposalHash,
  proposalMerged
} from './proposalService'
import { applyMerge, resolveConflict, unresolvedConflicts } from './mergeService'
import type {
  PlanExportBundle,
  ProposalExportBundle,
  RehearsalChangeProposal,
  RehearsalPlan,
  StoredProject
} from './types'

export async function exportProposal(
  xml: string,
  proposal: RehearsalChangeProposal,
  title: string,
  sourceFileName: string
) {
  const xmlSha256 = await sha256Text(xml)
  const normalized = normalizeProposal(plainClone(proposal))
  normalized.status = 'exported'
  const bundle: ProposalExportBundle = {
    schema: 'rehearsal-stand-proposal/v1',
    title,
    sourceFileName,
    xmlSha256,
    exportedAt: Date.now(),
    proposal: normalized
  }
  const safe = title.replace(/[^\p{L}\p{N}-]+/gu, '_')
  await downloadText(`${safe}.${proposal.id.slice(0, 8)}.proposal.json`, JSON.stringify(bundle, null, 2), 'application/json')
}

export async function importProposal(
  project: StoredProject,
  value: unknown
): Promise<{ status: 'duplicate' | 'wrong-score' | 'pending' | 'merged' | 'already-merged'; message: string; pendingId?: string }> {
  if (!value || typeof value !== 'object') return { status: 'wrong-score', message: '提案 JSON 不是对象。' }
  const bundle = value as ProposalExportBundle
  if (bundle.schema !== 'rehearsal-stand-proposal/v1') return { status: 'wrong-score', message: '提案 schema 不正确。' }
  const xmlHash = project.xmlSha256 ?? (await sha256Text(project.xml))
  if (bundle.xmlSha256 !== xmlHash && bundle.proposal.base.xmlSha256 !== xmlHash) {
    return { status: 'wrong-score', message: '提案基线乐谱摘要与当前乐谱不一致。' }
  }
  const proposal = normalizeProposal(plainClone(bundle.proposal))
  if (proposalMerged(project, proposal)) {
    return { status: 'already-merged', message: '该提案已合并，未再次应用。' }
  }
  if (!project.plan) return { status: 'wrong-score', message: '当前工程没有可合并方案。' }
  project.proposals = project.proposals ?? []
  if (!project.proposals.some((item) => item.id === proposal.id)) project.proposals.push(proposal)
  const pending = createPendingFromImport(project.plan, proposal)
  project.pendingMerges = project.pendingMerges ?? []
  const existingIndex = project.pendingMerges.findIndex((item) => item.proposal.id === proposal.id)
  if (existingIndex >= 0) project.pendingMerges[existingIndex] = pending
  else project.pendingMerges.push(pending)
  if (unresolvedConflicts(pending).length === 0 && project.plan) {
    const result = await applyMerge(project.plan, proposal, pending.conflicts)
    if (result.record) {
      project.mergeRecords = project.mergeRecords ?? []
      project.mergeRecords.push(result.record)
      project.pendingMerges = project.pendingMerges?.filter((item) => item.proposal.id !== proposal.id)
      proposal.status = 'merged'
      console.info('[proposal] applied', proposal.name, project.plan.queues.map((queue) => `${queue.name}:${queue.items.map((item) => item.tempoScale).join(',')}`))
      return { status: 'merged', message: '提案无冲突，已自动合并为新版本。' }
    }
    console.warn('[proposal] no record', proposal.name)
    return { status: 'pending', message: '提案需要进一步处理。', pendingId: pending.proposal.id }
  }
  return { status: 'pending', message: '提案存在需逐项决议的冲突，已保存待处理合并。', pendingId: pending.proposal.id }
}

function createPendingFromImport(plan: RehearsalPlan, proposal: RehearsalChangeProposal) {
  return createPendingMerge(plan, proposal)
}

export function planFromExport(bundle: PlanExportBundle): RehearsalPlan {
  return bundle.plan
}

export { applyMerge, resolveConflict, unresolvedConflicts, proposalHash, createProposal }
