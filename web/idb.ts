// Tiny IndexedDB key/value store: the design library lives here (far more room than localStorage).
const open = () => new Promise<IDBDatabase>((ok, no) => {
  const r = indexedDB.open('motionex', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
let db: Promise<IDBDatabase> | null = null;
const store = async (mode: IDBTransactionMode) => (await (db ??= open())).transaction('kv', mode).objectStore('kv');
export const idb = {
  async get<T>(k: string): Promise<T | undefined> { const s = await store('readonly'); return new Promise((ok, no) => { const r = s.get(k); r.onsuccess = () => ok(r.result as T); r.onerror = () => no(r.error); }); },
  async set(k: string, v: unknown): Promise<void> { const s = await store('readwrite'); return new Promise((ok, no) => { const r = s.put(v, k); r.onsuccess = () => ok(); r.onerror = () => no(r.error); }); },
};
