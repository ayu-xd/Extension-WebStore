const DB_NAME = "DMImagesDB";
const STORE_NAME = "images";
const DB_VERSION = 1;

class ImageStorage {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "username" });
        }
      };
    });
  }

  async saveImage(username, blob) {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      // Ensure lower case username for consistency
      const normalizedUsername = username.toLowerCase().trim();
      const request = store.put({ username: normalizedUsername, blob, updatedAt: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getImage(username) {
    const db = await this.init();
    const normalizedUsername = username.toLowerCase().trim();
    
    // First try exact match
    const exactResult = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(normalizedUsername);
      request.onsuccess = () => resolve(request.result ? request.result.blob : null);
      request.onerror = () => reject(request.error);
    });
    
    if (exactResult) return exactResult;
    
    // Clean target username (remove leading @, dots, dashes, underscores)
    const cleanTarget = normalizedUsername.replace(/^@/, '').replace(/[\._-]/g, '');

    // Fallback scan: matches extension-mismatches, dots vs dashes (e.g. "rok.petrina" vs "rok-petrina.png")
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      let found = null;
      console.log(`[ImageStorage] Fallback scan started for: "${normalizedUsername}" (cleanTarget: "${cleanTarget}")`);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const rawKey = cursor.value.username;
          // Strip image extensions (.png, .jpg, etc) and punctuation (., -, _) from stored key
          const cleanKey = rawKey.replace(/\.(png|jpg|jpeg|webp)$/i, '').replace(/^@/, '').replace(/[\._-]/g, '');

          console.log(`[ImageStorage] Comparing stored key "${rawKey}" (clean: "${cleanKey}") with target "${normalizedUsername}" (clean: "${cleanTarget}")`);
          
          if (
            cleanKey === cleanTarget ||
            rawKey.startsWith(normalizedUsername) ||
            normalizedUsername.startsWith(rawKey) ||
            cleanKey.startsWith(cleanTarget) ||
            cleanTarget.startsWith(cleanKey)
          ) {
            console.log(`[ImageStorage] Fuzzy match SUCCESS: "${rawKey}" matches "${normalizedUsername}"`);
            found = cursor.value.blob;
            resolve(found);
            return;
          }
          cursor.continue();
        } else {
          console.log(`[ImageStorage] Fallback scan completed. No match found for: "${normalizedUsername}"`);
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllImagesCount() {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll() {
    const db = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// Export for module environments, but also attach to globalThis for global access in extensions
if (typeof globalThis !== "undefined") {
  globalThis.ImageStorage = new ImageStorage();
}
