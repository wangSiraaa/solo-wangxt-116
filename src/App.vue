<template>
  <div class="app-shell">
    <aside class="sidebar">
      <h1>排练乐谱台</h1>
      <p class="subtitle">Vue 3 + TypeScript + OSMD · 本地 IndexedDB · 不修改原 MusicXML</p>

      <div class="card">
        <h2>工程</h2>
        <div class="row">
          <button class="primary" @click="loadSample">载入双跳房/变速/多声部样例</button>
          <button @click="fileInput?.click()">打开 MusicXML</button>
          <input ref="fileInput" hidden type="file" accept=".xml,.musicxml,application/xml" @change="onFile" />
        </div>
        <label>IndexedDB 本地工程</label>
        <select v-if="projects.length" :value="currentProjectId" @change="openProject(($event.target as HTMLSelectElement).value)">
          <option value="">— 选择已保存工程 —</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">
            {{ p.title }} · {{ formatDate(p.updatedAt) }}
          </option>
        </select>
        <p v-else class="muted">尚无本地工程；打开或载入样例后自动保存。</p>
        <div class="row" style="margin-top: 9px">
          <button :disabled="!xml" @click="saveCurrent">保存/更新工程</button>
          <button class="danger" :disabled="!currentProjectId" @click="removeCurrent">删除</button>
          <button :disabled="!xml" @click="exportData">导出原 XML + 独立标记 JSON</button>
        </div>
      </div>

      <div class="card">
        <h2>节拍与光标</h2>
        <div class="stat-grid">
          <div class="stat"><b>{{ parsed?.measures.length ?? 0 }}</b><span>书面小节</span></div>
          <div class="stat"><b>{{ path.visits.length }}</b><span>实际到达次数</span></div>
          <div class="stat"><b>{{ formatTime(path.totalSeconds) }}</b><span>参考总时长</span></div>
        </div>
        <div class="row between" style="margin-top: 10px">
          <button class="primary" :disabled="Boolean(!path.visits.length || path.errors.length)" @click="togglePlay">
            {{ playing ? '停止' : '从当前书面小节播放节拍' }}
          </button>
          <select v-model.number="rate" style="width: 92px" :disabled="playing">
            <option :value="0.5">0.5×</option>
            <option :value="0.75">0.75×</option>
            <option :value="1">1×</option>
            <option :value="1.25">1.25×</option>
          </select>
        </div>
        <p class="muted">
          当前：<span class="current-pulse">{{ cursorLabel }}</span>
        </p>
      </div>

      <div class="card">
        <div class="tabs">
          <button :class="{ active: tab === 'measures' }" @click="tab = 'measures'">书面小节</button>
          <button :class="{ active: tab === 'path' }" @click="tab = 'path'">实际路径</button>
          <button :class="{ active: tab === 'markers' }" @click="tab = 'markers'">排练标记</button>
          <button :class="{ active: tab === 'diagnostics' }" @click="tab = 'diagnostics'">
            诊断 {{ errorCount ? `(${errorCount})` : '' }}
          </button>
        </div>

        <div v-if="tab === 'measures'" class="scrollbox">
          <table class="measure-table">
            <thead><tr><th>书面</th><th>时长/拍号</th><th>速度</th><th>声部</th><th>到达</th></tr></thead>
            <tbody>
              <tr
                v-for="m in parsed?.measures ?? []"
                :key="m.index"
                class="clickable"
                :class="{ active: selectedWritten === m.index }"
                @click="selectWritten(m.index)"
              >
                <td><b>{{ m.printedNumber}}</b><br /><span v-if="m.isPickup" class="pill">弱起</span></td>
                <td>{{ m.actualQuarters }}♩ / {{ m.timesig.beats }}/{{ m.timesig.beatType }}</td>
                <td>
                  <span v-for="t in m.tempoEvents" :key="t.quarterOffset">
                    {{ t.bpm }}@{{ t.quarterOffset }}♩
                  </span>
                </td>
                <td>{{ m.voiceCount }} 声部</td>
                <td>{{ visitsForWritten(m.index).length }} 次</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'path'" class="scrollbox">
          <table class="visit-table">
            <thead><tr><th>#</th><th>书面</th><th>遍/房</th><th>起(s)</th><th>动作</th></tr></thead>
            <tbody>
              <tr
                v-for="v in path.visits"
                :key="v.sequence"
                class="clickable"
                :class="{ active: currentVisit === v.sequence }"
                @click="selectVisit(v)"
              >
                <td>{{ v.sequence + 1 }}</td>
                <td>{{ v.printedNumber }}</td>
                <td>{{ v.pass }}<span v-if="v.endingNumber"> / 第{{ v.endingNumber }}房</span></td>
                <td>{{ v.startTime.toFixed(2) }}</td>
                <td>{{ v.action }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'markers'">
          <p class="muted">标记与 XML 分离保存；导出时原文件保持字节内容不变，标记写入 JSON。</p>
          <div class="row">
            <input v-model="newMarkerLabel" placeholder="例如：从这里接第二提琴进入" style="flex: 1" />
            <button :disabled="selectedWritten === null" @click="addMarker">加到书面第 {{ selectedWritten === null ? '?' : selectedWritten + 1 }} 小节</button>
          </div>
          <table class="marker-table" style="margin-top: 10px">
            <tbody>
              <tr v-for="marker in markers" :key="marker.id">
                <td><span class="pill">第 {{ marker.writtenMeasure + 1 }} 小节</span></td>
                <td>{{ marker.label }}</td>
                <td><button class="danger" @click="removeMarker(marker.id)">删</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="tab === 'diagnostics'">
          <p>
            <span class="badge" :class="path.errors.length ? 'error' : 'ok'">
              {{ path.errors.length ? '路径存在无法闭合问题' : '路径可闭合' }}
            </span>
            只从下方明确识别的记号构造跳转；不认识的导航文字会列警告，不静默忽略。
          </p>
          <div
            v-for="(d, i) in parsed?.diagnostics ?? []"
            :key="i"
            class="diagnostic"
            :class="d.level"
          >
            <span class="badge" :class="d.level">{{ levelText[d.level] }}</span>
            书面第 {{ d.measureIndex < 0 ? '—' : d.measureIndex + 1 }} 小节：{{ d.message }}
          </div>
        </div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="title">{{ parsed?.title ?? '未打开乐谱' }}</div>
          <div class="muted">
            选中书面小节：{{ selectedWritten === null ? '—' : selectedWritten + 1 }}；
            实际到达：{{ selectedVisits.length ? selectedVisits.map((v) => `第${v.sequence + 1}次/第${v.printedNumber}小节`).join('，') : '无' }}
          </div>
        </div>
        <div class="row">
          <button :disabled="!selectedVisit" @click="selectVisit(selectedVisit!)">定位光标</button>
        </div>
      </header>
      <section class="score-wrap">
        <div id="osmd-container" ref="scoreContainer"></div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { PathVisit, RehearsalMarker, StoredProject, TimedPulse } from './types'
import { parseMusicXml } from './musicxmlParser'
import { buildPerformancePath } from './pathBuilder'
import { createDisplay, type DisplayHandle } from './display'
import { Metronome } from './metronome'
import { createSampleXml } from './sampleScore'
import { createId, deleteProject, listProjects, saveProject } from './db'
import { exportOriginalAndMarkers } from './exporter'

const scoreContainer = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const display = shallowRef<DisplayHandle | null>(null)
const audioContext = shallowRef<AudioContext | null>(null)
const metronome = shallowRef<Metronome | null>(null)

const projects = ref<StoredProject[]>([])
const currentProjectId = ref('')
const xml = ref('')
const currentFileName = ref('sample.musicxml')
const markers = ref<RehearsalMarker[]>([])
const selectedWritten = ref<number | null>(null)
const selectedVisitSequence = ref<number | null>(null)
const currentVisit = ref<number | null>(null)
const currentPulse = shallowRef<TimedPulse | null>(null)
const playing = ref(false)
const rate = ref(1)
const tab = ref<'measures' | 'path' | 'markers' | 'diagnostics'>('path')
const newMarkerLabel = ref('')

const parsed = computed(() => (xml.value ? parseMusicXml(xml.value, currentFileName.value) : null))
const path = computed(() => (parsed.value ? buildPerformancePath(parsed.value) : { visits: [], pulses: [], totalSeconds: 0, errors: [] }))
const selectedVisits = computed(() =>
  selectedWritten.value === null ? [] : path.value.visits.filter((v) => v.writtenMeasure === selectedWritten.value)
)
const selectedVisit = computed(() =>
  selectedVisitSequence.value === null
    ? selectedVisits.value[0] ?? null
    : path.value.visits.find((v) => v.sequence === selectedVisitSequence.value) ?? null
)
const errorCount = computed(() => parsed.value?.diagnostics.filter((d) => d.level === 'error').length ?? 0)
const levelText = { error: '错误', warning: '警告', info: '信息' } as const
const cursorLabel = computed(() => {
  if (currentPulse.value) {
    return `第 ${currentPulse.value.printedNumber} 小节 ${currentPulse.value.beatLabel} 拍 · ♩=${currentPulse.value.bpm} · ${currentPulse.value.time.toFixed(2)}s`
  }
  if (selectedVisit.value) return `第 ${selectedVisit.value.printedNumber} 小节，等待播放`
  return '选择一个书面小节'
})

onMounted(async () => {
  if (scoreContainer.value) display.value = await createDisplay(scoreContainer.value)
  projects.value = await listProjects()
  const latest = projects.value[0]
  if (latest) {
    await openProject(latest.id)
  } else {
    loadSample()
  }
})

onBeforeUnmount(() => {
  metronome.value?.dispose()
  audioContext.value?.close()
})

watch(xml, async () => {
  if (xml.value && display.value) {
    try {
      await display.value.render(xml.value)
    } catch (err) {
      console.error(err)
    }
    await nextTick()
    if (selectedWritten.value !== null) display.value.showMeasure(selectedWritten.value)
  }
})

watch(selectedWritten, async (idx) => {
  if (idx === null) return
  await nextTick()
  if (selectedVisitSequence.value === null) display.value?.showMeasure(idx)
  const visit = path.value.visits.find((v) => v.writtenMeasure === idx)
  currentVisit.value = visit?.sequence ?? null
})

watch(path, (p) => {
  metronome.value?.setData(p.pulses, p.visits)
  if (currentVisit.value !== null && !p.visits.some((v) => v.sequence === currentVisit.value)) currentVisit.value = null
})

async function loadSample() {
  stopPlayback()
  currentFileName.value = 'double-ending-tempo-multivoice.musicxml'
  xml.value = createSampleXml()
  markers.value = [
    { id: createId(), writtenMeasure: 4, label: '第一遍：一房子后反复', createdAt: Date.now() },
    { id: createId(), writtenMeasure: 5, label: '第二遍：二房子，速度变 140', createdAt: Date.now() }
  ]
  currentProjectId.value = ''
  selectedWritten.value = 1
  selectedVisitSequence.value = null
  await persistProject()
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  stopPlayback()
  currentFileName.value = file.name
  xml.value = await file.text()
  markers.value = []
  currentProjectId.value = ''
  selectedWritten.value = 0
  selectedVisitSequence.value = null
  await persistProject()
  input.value = ''
}

async function openProject(id: string) {
  if (!id) return
  stopPlayback()
  const project = projects.value.find((p) => p.id === id)
  if (!project) return
  currentProjectId.value = id
  currentFileName.value = project.fileName
  xml.value = project.xml
  markers.value = project.markers
  selectedWritten.value = 0
  selectedVisitSequence.value = null
}

async function persistProject() {
  if (!xml.value) return
  const now = Date.now()
  const project: StoredProject = {
    id: currentProjectId.value || createId(),
    title: parseMusicXml(xml.value, currentFileName.value).title,
    fileName: currentFileName.value,
    xml: xml.value,
    markers: markers.value,
    createdAt: currentProjectId.value ? projects.value.find((p) => p.id === currentProjectId.value)?.createdAt ?? now : now,
    updatedAt: now
  }
  await saveProject(project)
  currentProjectId.value = project.id
  projects.value = await listProjects()
}

async function saveCurrent() {
  await persistProject()
}

async function removeCurrent() {
  if (!currentProjectId.value) return
  await deleteProject(currentProjectId.value)
  currentProjectId.value = ''
  projects.value = await listProjects()
}

async function exportData() {
  if (!parsed.value) return
  await exportOriginalAndMarkers(parsed.value.xml, markers.value, parsed.value.title, currentFileName.value)
}

function visitsForWritten(index: number): PathVisit[] {
  return path.value.visits.filter((v) => v.writtenMeasure === index)
}

function selectWritten(index: number) {
  selectedWritten.value = index
  selectedVisitSequence.value = null
}

function selectVisit(visit: PathVisit) {
  selectedVisitSequence.value = visit.sequence
  currentVisit.value = visit.sequence
  selectedWritten.value = visit.writtenMeasure
  display.value?.showMeasure(visit.writtenMeasure)
}

function ensureAudio(): { context: AudioContext; metro: Metronome } {
  if (!audioContext.value) {
    audioContext.value = new AudioContext()
    metronome.value = new Metronome({
      audio: audioContext.value,
      onPulse: (pulse, fraction) => {
        currentPulse.value = pulse
        currentVisit.value = pulse.visitSequence
        display.value?.showMeasure(pulse.writtenMeasure, fraction)
      },
      onVisit: (visit) => {
        currentVisit.value = visit.sequence
        display.value?.showMeasure(visit.writtenMeasure, 0)
      },
      onStop: () => {
        playing.value = false
      }
    })
    metronome.value.setData(path.value.pulses, path.value.visits)
  }
  return { context: audioContext.value, metro: metronome.value! }
}

function togglePlay() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!path.value.visits.length || path.value.errors.length) return
  const { context, metro } = ensureAudio()
  context.resume()
  const startVisit = selectedVisit.value ?? path.value.visits[0]
  currentVisit.value = startVisit.sequence
  metro.start(startVisit.sequence, rate.value)
  playing.value = true
}

function stopPlayback() {
  metronome.value?.stop(false)
  playing.value = false
}

async function addMarker() {
  if (selectedWritten.value === null || !newMarkerLabel.value.trim()) return
  markers.value.push({
    id: createId(),
    writtenMeasure: selectedWritten.value,
    label: newMarkerLabel.value.trim(),
    createdAt: Date.now()
  })
  newMarkerLabel.value = ''
  await persistProject()
}

async function removeMarker(id: string) {
  markers.value = markers.value.filter((m) => m.id !== id)
  await persistProject()
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
</script>
