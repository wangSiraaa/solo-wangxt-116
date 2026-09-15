import type { RehearsalMarker, StoredProject } from './types'

const DB_NAME = 'rehearsal-stand'
const STORE = 'projects'
const VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
        request.onsuccess = () => {
          transaction.oncomplete = () => {
            db.close()
            resolve(request.result)
          }
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
      })
  )
}

export async function listProjects(): Promise<StoredProject[]> {
  const projects = await tx<StoredProject[]>('readonly', (store) => store.getAll() as IDBRequest<StoredProject[]>)
  return projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveProject(project: StoredProject): Promise<void> {
  await tx('readwrite', (store) => store.put(project))
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id))
}

export async function updateMarkers(id: string, markers: RehearsalMarker[]): Promise<void> {
  const project = await tx<StoredProject>('readonly', (store) => store.get(id) as IDBRequest<StoredProject>)
  project.markers = markers
  project.updatedAt = Date.now()
  await saveProject(project)
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
