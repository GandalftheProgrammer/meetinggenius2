
const DB_NAME = 'MeetingGeniusDB';
const STORE_NAME = 'audio_chunks';
const METADATA_STORE = 'session_metadata';

export interface SessionMetadata {
  id: string;
  title: string;
  startTime: number;
  lastUpdated: number;
  isActive: boolean;
}

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const startNewSession = async (title: string): Promise<string> => {
  const db = await openDB();
  const id = `session_${Date.now()}`;
  const metadata: SessionMetadata = {
    id,
    title: title || `Meeting ${new Date().toLocaleString()}`,
    startTime: Date.now(),
    lastUpdated: Date.now(),
    isActive: true
  };
  
  const tx = db.transaction([METADATA_STORE, STORE_NAME], 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  tx.objectStore(METADATA_STORE).put(metadata);
  
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(id);
  });
};

export const saveChunk = async (chunk: Blob) => {
  const db = await openDB();
  const tx = db.transaction([STORE_NAME, METADATA_STORE], 'readwrite');
  tx.objectStore(STORE_NAME).add(chunk);
  
  const metaStore = tx.objectStore(METADATA_STORE);
  const cursorRequest = metaStore.openCursor();
  cursorRequest.onsuccess = (e: any) => {
    const cursor = e.target.result;
    if (cursor) {
      const data = cursor.value;
      data.lastUpdated = Date.now();
      cursor.update(data);
    }
  };
};

export const getActiveSession = async (): Promise<SessionMetadata | null> => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(METADATA_STORE, 'readonly');
    const request = tx.objectStore(METADATA_STORE).getAll();
    request.onsuccess = () => {
      const active = request.result.find(s => s.isActive);
      resolve(active || null);
    };
  });
};

export const recoverAudio = async (): Promise<{blob: Blob, metadata: SessionMetadata} | null> => {
  const db = await openDB();
  
  // Haal de allerlaatste sessie op (onafhankelijk of deze nog 'actief' is)
  const metadata = await new Promise<SessionMetadata | null>((resolve) => {
    const tx = db.transaction(METADATA_STORE, 'readonly');
    const request = tx.objectStore(METADATA_STORE).getAll();
    request.onsuccess = () => {
      const all = request.result;
      resolve(all.length > 0 ? all[all.length - 1] : null);
    };
  });

  if (!metadata) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const chunks = request.result;
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: chunks[0].type });
      resolve({ blob, metadata });
    };
  });
};

export const clearSession = async () => {
  const db = await openDB();
  const tx = db.transaction([STORE_NAME, METADATA_STORE], 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  tx.objectStore(METADATA_STORE).clear();
};

export const markSessionComplete = async () => {
    const db = await openDB();
    const tx = db.transaction(METADATA_STORE, 'readwrite');
    const store = tx.objectStore(METADATA_STORE);
    const request = store.openCursor();
    request.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) {
            const data = cursor.value;
            data.isActive = false;
            cursor.update(data);
        }
    };
};
