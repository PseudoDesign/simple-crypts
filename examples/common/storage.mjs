/** @module examples/common/storage */
/* The owner worker holds the fleet Web Lock for this database's entire life.
 * Only this module handles private checkpoint bytes. UI messages contain public
 * state and opaque protocol frames, never saved identity material.
 */
/**
 * Open the versioned browser database; incompatible or failed stores reject instead of replacing identities. The owning worker holds the fleet Web Lock.
 * @returns {Promise<IDBDatabase>} Open database connection.
 */
export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('simple-crypts-fleet-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('fleet', { keyPath: 'serial' });
      request.result.createObjectStore('endpoints');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other fleet tabs before upgrading storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Run one object-store operation and resolve only after transaction completion.
 * @param {IDBDatabase} db Open database.
 * @param {string} store Object store name.
 * @param {IDBTransactionMode} mode Access mode.
 * @param {Function} operation Callback returning an IDBRequest.
 * @returns {Promise<*>} Request result after durable completion; aborts reject.
 */
export function transaction(db, store, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode, { durability: 'strict' });
    let request;
    try {
      request = operation(tx.objectStore(store));
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }
    // Request success is insufficient: a later abort must still fail the call.
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

/**
 * Read saved fleet rows after transaction completion.
 * @param {IDBDatabase} db Open database.
 * @returns {Promise<Array>} Copied saved row values.
 */
export const rows = (db) => transaction(db, 'fleet', 'readonly', (store) => store.getAll());
/**
 * Commit a fleet row, optionally requiring it to be absent.
 * @param {IDBDatabase} db Open database.
 * @param {object} row Serializable fleet row keyed by serial.
 * @param {boolean} [create=false] Use add instead of put to reject duplicates.
 * @returns {Promise<*>} Completion of the durable transaction.
 */
export const saveRow = (db, row, create = false) =>
  transaction(db, 'fleet', 'readwrite', (store) => (create ? store.add(row) : store.put(row)));

/**
 * Create callbacks for one endpoint namespace. Persist encoded records and nonce high-water marks, never raw native context memory.
 * @param {IDBDatabase} db Open database.
 * @param {string} serial Validated device serial.
 * @param {string} role Device or server namespace.
 * @param {boolean} fresh Whether initialization requires an absent endpoint record.
 * @returns {object} Asynchronous read/write callbacks used by the Wasm provider.
 */
export function endpointStorage(db, serial, role, fresh) {
  const key = `${role}:${serial}`;
  let first = fresh;
  return {
    load: () => transaction(db, 'endpoints', 'readonly', (store) => store.get(key)),
    async save(bytes) {
      await transaction(db, 'endpoints', 'readwrite', (store) =>
        first ? store.add(bytes, key) : store.put(bytes, key),
      );
      first = false;
    },
  };
}

// Clear both stores in one transaction while the worker still owns the fleet
// lock. Do not discard live endpoints until the deletion commits successfully.
/**
 * Delete all fleet and endpoint records in one durable transaction.
 * @param {IDBDatabase} db Open database; caller must stop endpoint instances first.
 * @returns {Promise<void>} Completion; aborts reject without reporting success.
 */
export function clearFleet(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['fleet', 'endpoints'], 'readwrite', { durability: 'strict' });
    tx.objectStore('fleet').clear();
    tx.objectStore('endpoints').clear();
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Reset transaction aborted'));
  });
}
