/* The owner worker holds the fleet Web Lock for this database's entire life.
 * Only this module handles private checkpoint bytes. UI messages contain public
 * state and opaque protocol frames, never saved identity material.
 */
export async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('simple-crypts-fleet-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('fleet', {keyPath: 'serial'});
      request.result.createObjectStore('endpoints');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other fleet tabs before upgrading storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}

export function transaction(db, store, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode, {durability: 'strict'});
    let request;
    try { request = operation(tx.objectStore(store)); }
    catch (error) { tx.abort(); reject(error); return; }
    // Request success is insufficient: a later abort must still fail the call.
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export const rows = db => transaction(db, 'fleet', 'readonly', store => store.getAll());
export const saveRow = (db, row, create = false) =>
  transaction(db, 'fleet', 'readwrite', store => create ? store.add(row) : store.put(row));

export function endpointStorage(db, serial, role, fresh) {
  const key = `${role}:${serial}`;
  let first = fresh;
  return {
    load: () => transaction(db, 'endpoints', 'readonly', store => store.get(key)),
    async save(bytes) {
      await transaction(db, 'endpoints', 'readwrite', store =>
        first ? store.add(bytes, key) : store.put(bytes, key));
      first = false;
    },
  };
}
