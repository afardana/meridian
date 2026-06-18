/**
 * Shared single-document store used by the non-state JSON stores.
 *
 * Same cache + ordered write-through model as state.js, factored out so each
 * store module keeps its existing synchronous load()/save() API while gaining a
 * Postgres backend. Backend is chosen by PERSIST_BACKEND (db/pool.js usePg()):
 *   • json — the legacy atomic file write (behaviour unchanged)
 *   • pg   — one jsonb row in kv_store keyed by the store name
 *
 * For the json backend get() lazily loads, so scripts/CLI that touch a store
 * need no init. For the pg backend the cache must be primed first — call
 * initAllDocStores() once at process startup (wired into index.js boot).
 */

import fs from "fs";
import { usePg, query } from "./pool.js";

const _stores = [];

/**
 * @param {string} name   stable key (e.g. "lessons"); used as the kv_store key
 * @param {string} file   absolute path to the legacy JSON file
 * @param {() => any} emptyValue factory returning the default document
 */
export function makeDocStore(name, file, emptyValue) {
  let cache = null;
  let writeChain = Promise.resolve();
  const tmpFile = `${file}.tmp`;

  function readFile() {
    if (!fs.existsSync(file)) return emptyValue();
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return emptyValue();
    }
  }

  async function init() {
    if (usePg()) {
      const { rows } = await query("SELECT doc FROM kv_store WHERE key = $1", [name]);
      cache = rows[0]?.doc ?? emptyValue();
    } else {
      cache = readFile();
    }
    return cache;
  }

  function get() {
    if (cache) return cache;
    if (usePg()) {
      throw new Error(`doc store "${name}" not initialised — call initAllDocStores() at startup (pg backend).`);
    }
    cache = readFile();
    return cache;
  }

  function set(value) {
    cache = value;
    if (usePg()) {
      const snapshot = JSON.stringify(value);
      writeChain = writeChain
        .then(() => query(
          "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
            "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
          [name, snapshot]
        ))
        .catch((err) => console.error(`[db] failed to persist kv_store "${name}":`, err.message));
    } else {
      // Atomic file write (temp + rename).
      const json = JSON.stringify(value, null, 2);
      const dir = file.substring(0, file.lastIndexOf("/"));
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, file);
    }
  }

  function flush() {
    return writeChain;
  }

  const store = { name, init, get, set, flush };
  _stores.push(store);
  return store;
}

/** Initialise every registered doc store. Await once at startup for the pg backend. */
export async function initAllDocStores() {
  for (const s of _stores) await s.init();
}

/** Drain pending async writes across all doc stores. Call before process exit. */
export async function flushAllDocStores() {
  await Promise.all(_stores.map((s) => s.flush()));
}
