import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRecognition } from "../js/recognition.js";
import { createStorage } from "../js/storage.js";
import { prepareSamplePayload } from "../js/sampleFormat.js";
import { readSampleBackup } from "../js/sampleBackup.js";

globalThis.crypto ||= webcrypto;

const vector = value => Array(63).fill(value);

function staticSample(label, value = 0, syncStatus = "pending"){
  return {
    l: label, kind: "static", formatVersion: 1, f: vector(value),
    filter: {
      model: "first", tau: 0.06,
      method: "explicit-euler-substeps-tau-quarter", version: 1
    },
    syncStatus
  };
}

function remoteSign(ownerId, id, name){
  return {
    id, owner_id: ownerId, name, kind: "static",
    sign_language: "LSC", visibility: "private"
  };
}

function remoteSample(ownerId, signId, clientId, payload = staticSample("A", 0)){
  return {
    id: `row-${clientId}`, owner_id: ownerId, sign_id: signId, client_id: clientId,
    format_version: 1, required_components: { left: true, right: false, face: false },
    hand_count: 1, face_available: false, mediapipe_model: "test-model",
    processing: {
      source: "legacy",
      filter: {
        model: "first",
        tau: 0.06,
        method: "explicit-euler-substeps-tau-quarter",
        version: 1
      }
    }, handedness: "Left",
    coordinate_space: "mediapipe-normalized-image-v1", mirrored_display: true,
    image_width: 640, image_height: 480, captured_at: "2026-01-01T00:00:00Z",
    payload: { formatVersion: 1, f: payload.f || vector(0) }, storage_path: null
  };
}

class MemoryIndexedDB {
  constructor({ failOpens = 0 } = {}){
    this.records = new Map();
    this.failOpens = failOpens;
    this.openCount = 0;
    this.database = {
      objectStoreNames: { contains: () => true },
      createObjectStore(){},
      transaction: () => {
        const transaction = {};
        const store = {
          get: key => {
            const request = {};
            queueMicrotask(() => {
              request.result = structuredClone(this.records.get(key));
              request.onsuccess?.();
            });
            return request;
          },
          put: value => {
            if (this.failNextPut){
              this.failNextPut = false;
              transaction.error = new Error("IndexedDB write failed");
              queueMicrotask(() => transaction.onabort?.());
              return;
            }
            this.records.set(value.userId, structuredClone(value));
            this.onPut?.(structuredClone(value));
            queueMicrotask(() => transaction.oncomplete?.());
          }
        };
        transaction.objectStore = () => store;
        return transaction;
      }
    };
  }

  open(){
    this.openCount++;
    const request = {};
    queueMicrotask(() => {
      if (this.failOpens){
        this.failOpens--;
        request.error = new Error("IndexedDB temporalmente indisponible");
        request.onerror?.();
        return;
      }
      request.result = this.database;
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

class Query {
  constructor(database, table){
    this.database = database;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.eqFields = new Set();
  }
  select(){ return this; }
  eq(key, value){
    this.eqFields.add(key);
    this.filters.push(row => row[key] === value);
    return this;
  }
  in(key, values){ this.filters.push(row => values.includes(row[key])); return this; }
  gt(key, value){ this.filters.push(row => row[key] > value); return this; }
  order(key){ this.orderKey = key; return this; }
  limit(value){ this.limitValue = value; return this; }
  not(key, operator, value){
    this.filters.push(row => operator === "is" && value === null
      ? row[key] !== null : true);
    return this;
  }
  insert(value){ this.action = "insert"; this.value = value; return this; }
  upsert(value){ this.action = "upsert"; this.value = value; return this; }
  delete(){ this.action = "delete"; return this; }
  single(){ return Promise.resolve(this.run()).then(result => ({
    ...result,
    data: Array.isArray(result.data) ? result.data[0] || null : result.data
  })); }
  maybeSingle(){ return this.single(); }
  then(resolve, reject){
    const gate = this.table === "signs" && this.action === "select"
      ? this.database.signReadGate : null;
    if (gate) this.database.signReadStarted?.();
    return Promise.resolve(gate).then(() => this.run()).then(resolve, reject);
  }

  rows(){
    if (this.table === "user_settings"){
      return this.database.settings ? [this.database.settings] : [];
    }
    return this.database[this.table] || [];
  }

  run(){
    const { database, table, action } = this;
    if (action === "delete" && table === "sign_samples" && database.beforeSampleDelete){
      const beforeDelete = database.beforeSampleDelete;
      database.beforeSampleDelete = null;
      return Promise.resolve(beforeDelete()).then(() => this.run());
    }
    if (action === "insert" && table === "sign_samples" && database.beforeSampleInsert){
      const beforeInsert = database.beforeSampleInsert;
      database.beforeSampleInsert = null;
      return Promise.resolve(beforeInsert()).then(() => this.run());
    }
    if (action === "select"){
      if (table === "signs" && database.failSignRead){
        return { data: null, error: new Error("Supabase signs unavailable") };
      }
      if (table === "user_settings" && database.failSettingsRead){
        return { data: null, error: new Error("Supabase settings unavailable") };
      }
      if (table === "sign_samples" && database.failSampleVerify &&
          this.eqFields.has("client_id")){
        return { data: null, error: new Error("Supabase sample verification unavailable") };
      }
      const rows = this.rows().filter(row => this.filters.every(filter => filter(row)));
      if (this.orderKey) rows.sort((a, b) => a[this.orderKey] < b[this.orderKey] ? -1 : a[this.orderKey] > b[this.orderKey] ? 1 : 0);
      return {
        data: this.limitValue ? rows.slice(0, Math.min(this.limitValue, database.maxRows || this.limitValue)) : rows,
        error: null
      };
    }
    if (action === "upsert"){
      if (database.failSettingsWrite){
        return { data: null, error: new Error("Supabase settings write failed") };
      }
      database.settings = this.value;
      return { data: this.value, error: null };
    }
    if (action === "delete"){
      if (table === "sign_samples"){
        database.sampleDeleteAttempts++;
        if (database.sampleDeleteAttempts === database.failSampleDeleteAt){
          return { data: null, error: { message: "Delete forbidden", status: 403 } };
        }
      }
      const removed = this.rows().filter(row => this.filters.every(filter => filter(row)));
      database[table] = this.rows().filter(row => !removed.includes(row));
      if (table === "signs"){
        const ids = new Set(removed.map(row => row.id));
        database.sign_samples = database.sign_samples.filter(row => !ids.has(row.sign_id));
      }
      return { data: removed, error: null };
    }
    if (action === "insert"){
      if (table === "sign_samples" && database.failSampleInsert){
        return { data: null, error: database.sampleInsertError || new Error("Supabase sample insert failed") };
      }
      if (table === "sign_samples"){
        database.sampleInsertAttempts++;
        if (database.sampleInsertAttempts === database.failSampleInsertAt){
          return { data: null, error: new Error("Network request failed") };
        }
      }
      const rows = Array.isArray(this.value) ? this.value : [this.value];
      if (table === "sign_samples" && rows.some(row =>
        database.sign_samples.some(saved =>
          saved.owner_id === row.owner_id && saved.client_id === row.client_id))){
        return { data: null, error: new Error("Duplicate client_id") };
      }
      const inserted = rows.map(row => ({
        ...structuredClone(row),
        id: row.id || `${table}-${++database.nextId}`
      }));
      database[table].push(...inserted);
      if (table === "sign_samples") database.afterSampleInsert?.();
      if (table === "sign_samples" && database.sampleInsertAttempts === database.loseInsertResponseAt){
        return { data: null, error: new Error("Network response lost") };
      }
      return { data: inserted, error: null };
    }
    return { data: null, error: new Error(`Unsupported operation ${action} on ${table}`) };
  }
}

function makeClient(database){
  return {
    from: table => new Query(database, table),
    storage: {
      from: () => ({
        async download(path){
          if (database.downloadErrors?.has(path)){
            return { data: null, error: database.downloadErrors.get(path) };
          }
          const blob = database.files.get(path);
          return blob
            ? { data: blob, error: null }
            : { data: null, error: { message: "Object not found", status: 404 } };
        },
        async list(folder, { search } = {}){
          if (database.failStorageList) return { data: null, error: { message: "Storage list forbidden", status: 403 } };
          const names = [...database.files.keys()]
            .filter(path => path.startsWith(`${folder}/`))
            .map(path => ({ name: path.slice(folder.length + 1) }))
            .filter(item => !search || item.name.includes(search));
          return { data: names, error: null };
        },
        async remove(paths){
          database.storageRemoveCalls++;
          for (const path of paths) database.files.delete(path);
          return { error: null };
        },
        async upload(path, blob){
          if (database.failStorageUpload){
            return { error: new Error("Storage upload unavailable") };
          }
          database.files.set(path, blob);
          return { error: null };
        }
      })
    }
  };
}

function makeDatabase(){
  return {
    signs: [remoteSign("account-a", "sign-a", "A")],
    sign_samples: [remoteSample("account-a", "sign-a", "capture-a")],
    settings: null,
    files: new Map(),
    nextId: 0,
    failSignRead: false,
    failSettingsRead: false,
    failSettingsWrite: false,
    failSampleInsert: false,
    sampleInsertError: null,
    sampleInsertAttempts: 0,
    failSampleInsertAt: null,
    loseInsertResponseAt: null,
    failSampleVerify: false,
    failStorageUpload: false,
    beforeSampleInsert: null,
    storageRemoveCalls: 0,
    sampleDeleteAttempts: 0,
    failSampleDeleteAt: null,
    beforeSampleDelete: null
  };
}

function makeHarness({
  database = makeDatabase(),
  indexedDB = new MemoryIndexedDB(),
  accountId = "account-a",
  initialSamples = [],
  confirmImpl = () => true
} = {}){
  globalThis.indexedDB = indexedDB;
  const elements = new Map();
  for (const id of ["tol", "tolM", "dur", "speechEnabled", "btnImportLocal",
    "syncRetry", "syncDeletes", "syncDeletesStatus", "btnExport", "btnBackup", "btnRestoreBackup", "backupFile", "backupSummary", "btnImport", "file", "btnReset"]){
    elements.set(id, {
      value: id === "tol" ? "0.8" : id === "tolM" ? "0.7" : id === "dur" ? "2" : "",
      checked: true,
      addEventListener(){},
      classList: { add(){}, remove(){}, toggle(){} },
      setAttribute(){},
      click(){}
    });
  }
  const state = {
    userId: accountId,
    samples: initialSamples,
    motions: [],
    filterConfig: { model: "first", tau: 0.06, compareVisual: false },
    ambiguityConfig: { absoluteMargin: 0.04, relativeMargin: 0.08 }
  };
  const statuses = [];
  const issues = [];
  const ui = {
    setNote(){},
    renderList(){},
    setSyncStatus(text, status){ statuses.push({ text, status }); },
    setSyncIssues(details){ issues.push(details); },
    refreshAmbiguityControls(){},
    refreshFilterControls(){},
    refreshGeneralControls(){}
  };
  const storage = createStorage({
    state,
    dom: { $: id => elements.get(id), listEl: {} },
    ui,
    getSupabaseClientImpl: async () => makeClient(database),
    confirmImpl
  });
  return { state, storage, statuses, issues, database, indexedDB, elements };
}

function recognitionFor(state){
  return createRecognition({
    state,
    dom: { $: id => ({ value: id === "tol" ? "0.8" : "0.7" }),
      video: { videoWidth: 640, videoHeight: 480 } }
  });
}

function deferred(){
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function motionSample(clientId){
  return {
    l: "Saludos", kind: "motion", formatVersion: 2, syncId: clientId,
    s: Array.from({ length: 24 }, () => Array(65).fill(0.1)),
    rawFrames: Array.from({ length: 8 }, (_, i) => ({
      lm: Array.from({ length: 21 }, () => [0.1, 0.2, 0.3]),
      hand: "Left", time: i * 33
    })),
    syncStatus: "pending"
  };
}

function incidentDatabase(){
  const database = makeDatabase();
  database.signs.push({ ...remoteSign("account-a", "sign-motion", "Saludos"), kind: "motion" });
  database.sign_samples.push(remoteSample("account-a", "sign-a", "inline-2"));
  for (let i = 0; i < 171; i++){
    const record = remoteSample("account-a", "sign-a", `available-${i}`);
    record.storage_path = `account-a/available-${i}.json`;
    database.files.set(record.storage_path, new Blob([JSON.stringify(record.payload)]));
    record.payload = null;
    database.sign_samples.push(record);
  }
  for (let i = 0; i < 17; i++){
    const record = remoteSample("account-a", "sign-motion", `missing-${i}`);
    record.format_version = 2;
    record.payload = null;
    record.storage_path = `account-a/missing-${i}.json`;
    database.sign_samples.push(record);
  }
  return database;
}

test("17 unavailable motion objects do not block 173 valid references or destroy cached captures", async () => {
  const database = incidentDatabase();
  const indexedDB = new MemoryIndexedDB();
  const local = motionSample("missing-0");
  local.syncStatus = "saved";
  local.verifiedUserId = "account-a";
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: false,
    samples: [], motions: [local], pendingDeletes: []
  });
  const before = structuredClone(indexedDB.records.get("account-a"));
  const harness = makeHarness({ database, indexedDB });
  const result = await harness.storage.loadUserLibrary("account-a");

  assert.equal(database.sign_samples.length, 190);
  assert.equal(result.invalidReferences.length, 17);
  assert.equal(result.samples.length, 173);
  assert.equal(harness.state.samples.length, 173);
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
  assert.deepEqual(indexedDB.records.get("account-a"), before);
  assert.equal(harness.state.motions[0].syncStatus, "local");
  assert.equal(harness.issues.at(-1).length, 17);
  assert.match(harness.issues.at(-1)[0], /missing-0.*Posible copia local completa/);
  assert.match(harness.issues.at(-1)[1], /missing-1.*No se encontró una copia local/);
  assert.match(harness.statuses.at(-1).text, /17 referencia/);
  assert.equal(await harness.storage.retrySync(), false);
  assert.deepEqual(indexedDB.records.get("account-a"), before);
  assert.equal(database.storageRemoveCalls, 0);
});

test("pending queue skips missing objects, syncs other captures and reconciles a partial manual recovery", async () => {
  const database = incidentDatabase();
  const indexedDB = new MemoryIndexedDB();
  const local = motionSample("missing-0");
  const otherPending = Array.from({ length: 162 }, (_, i) =>
    staticSample("Carga", 0.1 + i / 10000));
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: otherPending, motions: [local], pendingDeletes: []
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.retrySync(), false);
  const cache = indexedDB.records.get("account-a");
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "saved").length, 162);
  assert.equal(cache.motions[0].syncStatus, "pending");
  assert.deepEqual(cache.motions[0].rawFrames, local.rawFrames);
  assert.equal(harness.state.samples.length, 335);
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
  assert.equal(database.sign_samples.length, 352);
  assert.equal(database.files.size, 171);
  assert.equal(harness.issues.at(-1).length, 17);
  assert.equal(database.storageRemoveCalls, 0);

  const path = "account-a/missing-0.json";
  database.files.set(path, new Blob([JSON.stringify(prepareSamplePayload(local, "motion").payload)]));
  const file = await database.files.get(path).text();
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(indexedDB.records.get("account-a").motions[0].syncStatus, "saved");
  assert.equal(harness.issues.at(-1).length, 16);
  assert.equal(await database.files.get(path).text(), file);
  assert.equal(database.sign_samples.length, 352);
  assert.equal(database.storageRemoveCalls, 0);
});

test("failed downloads report their actual cause and reject mismatched local candidates", async () => {
  const database = incidentDatabase();
  const indexedDB = new MemoryIndexedDB();
  const local = motionSample("missing-0");
  local.verifiedUserId = "account-b";
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: false,
    samples: [], motions: [local], pendingDeletes: []
  });
  database.downloadErrors = new Map([
    ["account-a/missing-0.json", new Error("permission denied")]
  ]);
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.match(harness.issues.at(-1)[0], /permission denied.*No se encontró una copia local/);
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
});

test("recovery candidates require matching kind, route, format and complete valid coordinates", async () => {
  const database = incidentDatabase();
  const indexedDB = new MemoryIndexedDB();
  const candidates = Array.from({ length: 5 }, (_, i) => motionSample(`missing-${i}`));
  candidates[0].kind = "static";
  database.sign_samples.find(row => row.client_id === "missing-1").storage_path = "account-a/other.json";
  candidates[2].formatVersion = 1;
  candidates[3].rawFrames[0].lm = [];
  delete candidates[4].rawFrames;
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: false,
    samples: [], motions: candidates, pendingDeletes: []
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  for (const detail of harness.issues.at(-1).slice(0, 5)){
    assert.match(detail, /No se encontró una copia local completa coincidente/);
  }
  assert.equal(database.files.size, 171);
  assert.equal(database.storageRemoveCalls, 0);
});

test("loading an accessible object does not overwrite a different local capture with the same id", async () => {
  const database = makeDatabase();
  database.signs.push({ ...remoteSign("account-a", "sign-motion", "Saludos"), kind: "motion" });
  const local = motionSample("capture-motion");
  local.syncStatus = "saved";
  local.verifiedUserId = "account-a";
  const remote = motionSample("capture-motion");
  remote.rawFrames[0].lm[0][0] = 0.9;
  const path = "account-a/capture-motion.json";
  database.files.set(path, new Blob([JSON.stringify(prepareSamplePayload(remote, "motion").payload)]));
  const record = remoteSample("account-a", "sign-motion", "capture-motion");
  record.format_version = 2;
  record.payload = null;
  record.storage_path = path;
  database.sign_samples.push(record);
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: false,
    samples: [], motions: [local], pendingDeletes: []
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.deepEqual(indexedDB.records.get("account-a").motions[0], local);
  assert.equal(harness.state.motions[0].rawFrames[0].lm[0][0], 0.1);
  assert.equal(await harness.storage.savePreferences(), true);
  assert.deepEqual(indexedDB.records.get("account-a").motions[0].rawFrames, local.rawFrames);
});

test("confirmed Supabase samples are restored as recognized references", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.equal(harness.state.samples[0].filter.model, "first");
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
});

test("legacy remote references without compatible filter metadata are preserved but not recognized", async () => {
  const database = makeDatabase();
  delete database.sign_samples[0].processing.filter;
  delete database.sign_samples[0].payload.filter;
  const harness = makeHarness({ database });

  await harness.storage.loadUserLibrary("account-a");

  assert.equal(harness.state.samples.length, 1);
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.equal(recognitionFor(harness.state).classify(vector(0)), null);
});

test("a failed preference write and reload do not mark confirmed samples pending", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.database.failSettingsWrite = true;
  harness.state.filterConfig.tau = 0.08;
  assert.equal(await harness.storage.savePreferences(), false);
  assert.match(harness.statuses.at(-1).text, /preferencias en Supabase/);
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.equal(harness.indexedDB.records.get("account-a").pending, true);
  assert.equal(harness.indexedDB.records.get("account-a").settingsPending, true);
  assert.equal(harness.indexedDB.records.get("account-a").samples[0].syncStatus, "saved");

  const reloaded = makeHarness({
    database: harness.database,
    indexedDB: harness.indexedDB
  });
  await reloaded.storage.loadUserLibrary("account-a");
  assert.equal(reloaded.state.samples[0].syncStatus, "local");
  assert.equal(recognitionFor(reloaded.state).classify(vector(0)), null);
  assert.equal(await reloaded.storage.retrySync(), false);

  harness.database.failSettingsWrite = false;
  assert.equal(await reloaded.storage.retrySync(), true);
  assert.equal(reloaded.database.sign_samples.length, 1);
});

test("a settings read error does not discard an otherwise valid remote library", async () => {
  const database = makeDatabase();
  database.failSettingsRead = true;
  const harness = makeHarness({ database });
  const result = await harness.storage.loadUserLibrary("account-a");
  assert.equal(result.loadError, undefined);
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
  assert.match(harness.statuses.at(-1).text, /no se pudieron cargar las preferencias/);
});

test("legacy second-order preferences migrate to first order without reusing old parameters", async () => {
  const database = makeDatabase();
  database.settings = {
    user_id: "account-a",
    filter_model: "second",
    tau: 0.13,
    zeta: 1.4,
    omega_n: 22,
    static_tolerance: 0.8,
    motion_tolerance: 0.7,
    capture_duration: 2,
    speech_enabled: true,
    show_raw_points: false
  };
  const harness = makeHarness({ database });

  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.filterConfig.model, "first");
  assert.equal(harness.state.filterConfig.tau, 0.13);
  assert.equal("zeta" in harness.state.filterConfig, false);
  assert.equal("omegaN" in harness.state.filterConfig, false);

  assert.equal(await harness.storage.savePreferences(), true);
  assert.equal(database.settings.filter_model, "first");
  assert.equal(database.settings.tau, 0.13);
  assert.equal("zeta" in database.settings, false);
  assert.equal("omega_n" in database.settings, false);
});

test("new samples remain excluded after an upload error and are available after retry", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  harness.database.failSampleInsert = true;

  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.equal(harness.state.samples[1].syncStatus, "pending");
  assert.equal(recognitionFor(harness.state).classify(vector(0.1))?.label, "A");
  assert.match(harness.statuses.at(-1).text, /Supabase sample insert failed/);

  const reloaded = makeHarness({
    database: harness.database,
    indexedDB: harness.indexedDB
  });
  await reloaded.storage.loadUserLibrary("account-a");
  assert.equal(await reloaded.storage.retrySync(), false);
  assert.equal(reloaded.state.samples[0].syncStatus, "local");
  assert.equal(reloaded.state.samples[1].syncStatus, "pending");
  assert.equal(recognitionFor(reloaded.state).classify(vector(0.1))?.label, "A");

  harness.database.failSampleInsert = false;
  assert.equal(await reloaded.storage.retrySync(), true);
  assert.equal(reloaded.state.samples[1].syncStatus, "saved");
  assert.equal(recognitionFor(reloaded.state).classify(vector(0.1))?.label, "B");
});

test("network failure during load preserves the error and a later retry recovers", async () => {
  const database = makeDatabase();
  database.failSignRead = true;
  const harness = makeHarness({ database });
  const first = await harness.storage.loadUserLibrary("account-a");
  assert.ok(first.loadError);
  assert.match(harness.statuses.at(-1).text, /Supabase signs unavailable/);

  database.failSignRead = false;
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
});

test("a transient IndexedDB failure does not block remote recognition or future recovery", async () => {
  const indexedDB = new MemoryIndexedDB({ failOpens: 1 });
  const harness = makeHarness({ indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples[0].syncStatus, "saved");
  assert.match(harness.statuses.at(-1).text, /no se pudo leer la copia local/);
  assert.equal(await harness.storage.retrySync(), true);
  assert.ok(indexedDB.openCount >= 2);
  assert.equal(harness.indexedDB.records.get("account-a").samples[0].syncStatus, "saved");
});

test("a cache owned by another account is neither loaded nor overwritten", async () => {
  const indexedDB = new MemoryIndexedDB();
  const foreignCache = {
    userId: "account-a", version: 1, samples: [staticSample("Private A", 0, "saved")],
    motions: [], pending: true, pendingDeletes: []
  };
  indexedDB.records.set("account-b", foreignCache);
  const database = makeDatabase();
  database.signs.push(remoteSign("account-b", "sign-b", "B"));
  database.sign_samples.push(remoteSample("account-b", "sign-b", "capture-b",
    staticSample("B").f));
  const harness = makeHarness({ database, indexedDB, accountId: "account-b" });
  await harness.storage.loadUserLibrary("account-b");
  assert.deepEqual(harness.state.samples.map(sample => sample.l), ["B"]);
  assert.equal(indexedDB.records.get("account-b").samples[0].l, "Private A");
  assert.match(harness.statuses.at(-1).text, /no se pudo leer la copia local/);
});

test("unverified local captures are preserved but never uploaded or recognized", async () => {
  const indexedDB = new MemoryIndexedDB();
  const unverified = staticSample("Local sin verificar", 0.2);
  delete unverified.syncStatus;
  indexedDB.records.set("account-a", {
    userId: "account-a",
    version: 1,
    samples: [unverified],
    motions: [],
    pending: true,
    settingsPending: true,
    settings: {},
    pendingDeletes: []
  });
  const database = makeDatabase();
  database.failSettingsWrite = true;
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples[0].syncStatus, "unverified");
  assert.equal(recognitionFor(harness.state).classify(vector(0.2)), null);
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(database.sign_samples.length, 1);
  assert.equal(indexedDB.records.get("account-a").samples[0].l, "Local sin verificar");
});

test("corrupt remote references are reported and skipped without losing valid captures", async () => {
  const database = makeDatabase();
  database.signs.push(remoteSign("account-a", "sign-b", "Corrupta"));
  database.sign_samples.push(remoteSample("account-a", "sign-b", "capture-corrupt", {
    f: [NaN]
  }));
  const harness = makeHarness({ database });
  const result = await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples.length, 1);
  assert.equal(harness.state.samples[0].l, "A");
  assert.equal(result.invalidReferences.length, 1);
  assert.match(harness.statuses.at(-1).text, /referencia\(s\) remota\(s\) no disponibles o inválidas/);
});

test("successful retries do not duplicate signs or captures", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  harness.database.failSampleInsert = true;
  assert.equal(await harness.storage.saveAll(), false);
  harness.database.failSampleInsert = false;
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(harness.database.signs.filter(sign => sign.name === "B").length, 1);
  assert.equal(harness.database.sign_samples.filter(sample =>
    sample.owner_id === "account-a").length, 2);
});

test("pending deletions survive retries and require separate confirmation", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.database.failSignRead = true;
  await harness.storage.deleteSign("A", "all");

  const queued = harness.indexedDB.records.get("account-a");
  assert.equal(queued.pending, true);
  assert.deepEqual(queued.pendingDeletes[0].clientIds, ["capture-a"]);
  assert.equal(harness.state.samples.length, 0);

  harness.database.failSignRead = false;
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(harness.database.sign_samples.length, 1);
  assert.deepEqual(harness.indexedDB.records.get("account-a").pendingDeletes, queued.pendingDeletes);
  assert.equal(await harness.storage.reviewPendingDeletes(), true);
  assert.equal(harness.database.signs.length, 1);
  assert.equal(harness.database.sign_samples.length, 0);
  assert.deepEqual(harness.indexedDB.records.get("account-a").pendingDeletes, []);
});

test("cancelling deletion confirmation never removes records, objects or queued captures", async () => {
  const harness = makeHarness({ confirmImpl: () => false });
  await harness.storage.loadUserLibrary("account-a");
  await harness.storage.deleteSign("A", "all");
  const before = structuredClone(harness.indexedDB.records.get("account-a"));
  assert.equal(await harness.storage.reviewPendingDeletes(), false);
  assert.deepEqual(harness.indexedDB.records.get("account-a"), before);
  assert.equal(harness.database.sign_samples.length, 1);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
  assert.equal(harness.database.storageRemoveCalls, 0);
});

test("local deletion refuses to discard newer cache-only captures of the same sign", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const cache = harness.indexedDB.records.get("account-a");
  cache.samples.push({ ...staticSample("A", 0.6), syncId: "newer-local" });
  const before = structuredClone(cache);
  await assert.rejects(harness.storage.deleteSign("A", "all"), /capturas adicionales/);
  assert.deepEqual(harness.indexedDB.records.get("account-a"), before);
  assert.equal(harness.state.samples.length, 1);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
});

test("local deletion preserves cache-only captures of other signs", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const sample = { ...staticSample("Otra", 0.6), syncId: "newer-local" };
  harness.indexedDB.records.get("account-a").samples.push(sample);
  harness.database.failSignRead = true;
  await harness.storage.deleteSign("A", "all");
  assert.deepEqual(harness.indexedDB.records.get("account-a").samples[0], sample);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
});

test("confirmed deletion targets only queued records and preserves newer samples and Storage", async () => {
  const database = makeDatabase();
  database.sign_samples.push(remoteSample("account-a", "sign-a", "newer"));
  database.files.set("account-a/capture-a.json", new Blob(["synthetic"]));
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [], motions: [],
    pendingDeletes: [{ name: "A", kind: "static", clientIds: ["capture-a"] }]
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(database.sign_samples.length, 2);
  assert.equal(await harness.storage.reviewPendingDeletes(), true);
  assert.deepEqual(database.sign_samples.map(record => record.client_id), ["newer"]);
  assert.equal(database.signs.length, 1);
  assert.equal(database.files.size, 1);
  assert.equal(database.storageRemoveCalls, 0);
  assert.deepEqual(indexedDB.records.get("account-a").pendingDeletes, []);
});

test("a stale deletion confirmation does not remove any remote records", async () => {
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [], motions: [],
    pendingDeletes: [{ name: "A", kind: "static", clientIds: ["capture-a"] }]
  });
  const harness = makeHarness({ indexedDB, confirmImpl: () => {
    indexedDB.records.get("account-a").revision++;
    return true;
  } });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.reviewPendingDeletes(), false);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
  assert.match(harness.statuses.at(-1).text, /cola cambió/);
  assert.equal(indexedDB.records.get("account-a").pendingDeletes.length, 1);
});

test("a partially failed confirmed deletion preserves the queue and reports uncertain remote state", async () => {
  const database = makeDatabase();
  database.sign_samples.push(remoteSample("account-a", "sign-a", "capture-two"));
  database.failSampleDeleteAt = 2;
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [], motions: [],
    pendingDeletes: [{ name: "A", kind: "static", clientIds: ["capture-a", "capture-two"] }]
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.reviewPendingDeletes(), false);
  assert.equal(indexedDB.records.get("account-a").pendingDeletes.length, 1);
  assert.equal(database.sign_samples.length, 1);
  assert.match(harness.statuses.at(-1).text, /Delete forbidden.*HTTP: 403.*podrían haberse eliminado/);
  assert.equal(database.storageRemoveCalls, 0);
});

test("preference and capture syncs never execute queued deletions", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  await harness.storage.deleteSign("A", "all");
  harness.state.samples.push(staticSample("Nueva", 0.2));
  assert.equal(await harness.storage.savePreferences(), false);
  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
  assert.equal(harness.database.sign_samples.length, 2);
  assert.equal(harness.indexedDB.records.get("account-a").samples[0].syncStatus, "saved");
  assert.equal(harness.indexedDB.records.get("account-a").pendingDeletes.length, 1);
});

test("a retry cannot upload or confirm a local capture also queued for deletion", async () => {
  const indexedDB = new MemoryIndexedDB();
  const sample = { ...staticSample("A", 0.2), syncId: "capture-a" };
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [sample], motions: [],
    pendingDeletes: [{ name: "A", kind: "static", clientIds: ["capture-a"] }]
  });
  const harness = makeHarness({ indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.retrySync(), false);
  assert.deepEqual(indexedDB.records.get("account-a").samples[0], sample);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
  assert.match(harness.issues.at(-1).join(" "), /captura también figura en una eliminación pendiente/);
  assert.equal(await harness.storage.reviewPendingDeletes(), false);
  assert.equal(harness.database.sampleDeleteAttempts, 0);
  assert.deepEqual(indexedDB.records.get("account-a").samples[0], sample);
});

test("general retry cannot race a separately confirmed deletion", async () => {
  const entered = deferred(), release = deferred();
  const database = makeDatabase();
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [], motions: [],
    pendingDeletes: [{ name: "A", kind: "static", clientIds: ["capture-a"] }]
  });
  database.beforeSampleDelete = async () => { entered.resolve(); await release.promise; };
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  const deletion = harness.storage.reviewPendingDeletes();
  await entered.promise;
  assert.equal(await harness.storage.retrySync(), false);
  assert.match(harness.statuses.at(-1).text, /Espera a que termine/);
  release.resolve();
  assert.equal(await deletion, true);
  assert.equal(database.sampleDeleteAttempts, 1);
});

test("a retry reuses an existing valid Storage capture without overwriting it", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const components = { left: false, right: false, face: true };
  const faceLandmarks = Array.from({ length: 478 }, (_, index) => [
    index / 1000, index / 2000, index / 3000
  ]);
  const rawFrames = Array.from({ length: 8 }, (_, index) => ({
    time: index * 33,
    presence: { Left: false, Right: false, face: true, faceFeatures: true },
    faceLandmarks,
    faceFeatures: Array(32).fill(index / 10),
    hands: {}
  }));
  harness.state.samples.push({
    l: "Facial grande",
    kind: "static",
    formatVersion: 2,
    source: "paired-raw-and-filtered-v2",
    components,
    rawFrames,
    filteredFrames: structuredClone(rawFrames),
    h: { hands: {}, placement: null, face: Array(32).fill(0) },
    rh: { hands: {}, placement: null, face: Array(32).fill(0) },
    syncStatus: "pending"
  });
  harness.database.failStorageUpload = true;
  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.database.files.size, 0);
  assert.match(harness.statuses.at(-1).text, /Subida a Storage: Storage upload unavailable/);

  harness.database.failStorageUpload = false;
  harness.database.failSampleInsert = true;
  harness.database.failSampleVerify = true;
  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.database.files.size, 1);
  const [path] = harness.database.files.keys();
  const originalContent = await harness.database.files.get(path).text();

  harness.database.failSampleInsert = false;
  harness.database.failSampleVerify = false;
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(await harness.database.files.get(path).text(), originalContent);
  assert.equal(harness.database.storageRemoveCalls, 0);
  assert.equal(harness.database.sign_samples.filter(sample =>
    sample.owner_id === "account-a").length, 2);
});

test("concurrent preference and capture writes preserve the pending sign snapshot", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.database.failSettingsWrite = true;
  harness.state.samples.push(staticSample("New Capture", 0.1));
  const [captureResult, preferenceResult] = await Promise.all([
    harness.storage.saveAll(),
    harness.storage.savePreferences()
  ]);
  assert.equal(captureResult, false);
  assert.equal(preferenceResult, false);
  const cached = harness.indexedDB.records.get("account-a");
  assert.equal(cached.pending, true);
  assert.equal(cached.samples.length, 2);
  assert.equal(cached.samples[1].l, "New Capture");
  assert.equal(cached.samples[1].syncStatus, "saved");
  assert.equal(cached.settingsPending, true);
});

test("an in-flight sync cannot replace a capture queued at a newer revision", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  let releaseRead;
  harness.database.signReadGate = new Promise(resolve => { releaseRead = resolve; });
  let startedRead;
  const started = new Promise(resolve => { startedRead = resolve; });
  harness.database.signReadStarted = startedRead;

  harness.state.samples.push(staticSample("First queued", 0.1));
  const firstSave = harness.storage.saveAll();
  await started;
  harness.state.samples.push(staticSample("Second queued", 0.2));
  const secondSave = harness.storage.saveAll();
  releaseRead();
  const results = await Promise.all([firstSave, secondSave]);
  assert.deepEqual(results, [true, true]);
  const cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.pending, false);
  assert.deepEqual(cache.samples.map(sample => sample.l),
    ["A", "First queued", "Second queued"]);
  assert.equal(harness.database.sign_samples.length, 3);
  assert.equal(new Set(harness.database.sign_samples.map(row => row.client_id)).size, 3);
  assert.equal(harness.database.storageRemoveCalls, 0);
});
test("preference updates during an upload preserve the capture and newest settings", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  const entered = deferred();
  const release = deferred();
  const queued = deferred();
  harness.database.beforeSampleInsert = async () => {
    entered.resolve();
    await release.promise;
  };
  harness.indexedDB.onPut = cache => {
    if (cache.settings?.tau === 0.08 && cache.samples.some(sample => sample.l === "B")){
      queued.resolve();
    }
  };

  const upload = harness.storage.saveAll();
  await entered.promise;
  harness.state.filterConfig.tau = 0.08;
  const preferences = harness.storage.savePreferences();
  await queued.promise;
  release.resolve();

  assert.deepEqual(await Promise.all([upload, preferences]), [true, true]);
  const cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.settings.tau, 0.08);
  assert.deepEqual(cache.samples.map(sample => sample.l), ["A", "B"]);
  assert.ok(cache.samples.every(sample => sample.verifiedUserId === "account-a"));
  assert.equal(harness.database.sign_samples.length, 2);
});

test("a capture made during synchronization is not replaced by an older snapshot", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  const entered = deferred();
  const release = deferred();
  harness.database.beforeSampleInsert = async () => {
    entered.resolve();
    await release.promise;
  };

  const firstSave = harness.storage.saveAll();
  await entered.promise;
  harness.state.samples.push(staticSample("C", 0.2));
  const secondSave = harness.storage.saveAll();
  release.resolve();

  assert.deepEqual(await Promise.all([firstSave, secondSave]), [true, true]);
  const cache = harness.indexedDB.records.get("account-a");
  assert.deepEqual(cache.samples.map(sample => sample.l).sort(), ["A", "B", "C"]);
  assert.ok(cache.samples.every(sample => sample.verifiedUserId === "account-a"));
  assert.equal(harness.database.sign_samples.length, 3);
  assert.equal(harness.database.signs.filter(sign => sign.name === "B").length, 1);
  assert.equal(harness.database.signs.filter(sign => sign.name === "C").length, 1);
});

test("saving preserves cache-only captures and the original pending state of invalid data", async () => {
  const indexedDB = new MemoryIndexedDB();
  const invalid = { ...staticSample("Invalid", 0), syncId: "invalid-pending", f: [1] };
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [invalid], motions: [], pendingDeletes: []
  });
  const database = makeDatabase();
  database.failSignRead = true;
  const harness = makeHarness({ indexedDB, database });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples[0].syncStatus, "invalid");
  const cacheOnly = { ...staticSample("Otra pestaña", 0.3), syncId: "cache-only" };
  indexedDB.records.get("account-a").samples.push(cacheOnly);
  harness.state.samples.push(staticSample("Nueva", 0.2));
  assert.equal(await harness.storage.saveAll(), false);
  const saved = indexedDB.records.get("account-a").samples;
  assert.deepEqual(saved[0], invalid);
  assert.deepEqual(saved[1], cacheOnly);
  assert.equal(saved[2].l, "Nueva");
});

test("concurrent cache revisions preserve samples, preferences, and pending deletions", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const cache = harness.indexedDB.records.get("account-a");
  cache.pending = true;
  cache.pendingDeletes = [{ name: "Seña en cola", kind: "static", clientIds: ["keep-id"] }];
  const startingRevision = cache.revision;
  harness.database.failSignRead = true;
  harness.state.samples.push(staticSample("B", 0.1));
  harness.state.filterConfig.tau = 0.11;

  const results = await Promise.all([
    harness.storage.saveAll(),
    harness.storage.savePreferences()
  ]);
  const latest = harness.indexedDB.records.get("account-a");

  assert.deepEqual(results, [false, false]);
  assert.ok(latest.revision >= startingRevision + 2);
  assert.deepEqual(latest.samples.map(sample => sample.l), ["A", "B"]);
  assert.equal(latest.settings.tau, 0.11);
  assert.deepEqual(latest.pendingDeletes, [
    { name: "Seña en cola", kind: "static", clientIds: ["keep-id"] }
  ]);
});

test("162 captures retain verified progress after a network failure and recover without duplicates", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(...Array.from({ length: 162 }, (_, i) =>
    staticSample("Carga", 0.1 + i / 10000)));
  harness.database.failSampleInsertAt = 20;

  assert.equal(await harness.storage.saveAll(), false);
  let cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.samples.length, 163);
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "saved").length, 162);
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "pending").length, 1);
  assert.equal(harness.database.sign_samples.length, 162);
  assert.equal(recognitionFor(harness.state).classify(vector(0.1))?.label, "Carga");
  assert.match(harness.issues.at(-1).join(" "), /Muestra 20 de 162.*Inserción de muestra.*Network request failed/);

  const reloaded = makeHarness({ database: harness.database, indexedDB: harness.indexedDB });
  await reloaded.storage.loadUserLibrary("account-a");
  assert.equal(recognitionFor(reloaded.state).classify(vector(0.1))?.label, "Carga");
  assert.equal(await reloaded.storage.retrySync(), true);
  cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.samples.length, 163);
  assert.ok(cache.samples.every(sample => sample.syncStatus === "saved" && sample.verifiedUserId === "account-a"));
  assert.equal(harness.database.sign_samples.length, 163);
  assert.equal(new Set(harness.database.sign_samples.map(row => row.client_id)).size, 163);
  assert.equal(harness.database.storageRemoveCalls, 0);
});

test("a lost insertion response is reconciled by persisted content on retry", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(...Array.from({ length: 162 }, (_, i) =>
    staticSample("Carga", 0.1 + i / 10000)));
  harness.database.loseInsertResponseAt = 20;

  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.database.sign_samples.length, 163);
  assert.equal(harness.indexedDB.records.get("account-a").samples.filter(
    sample => sample.syncStatus === "pending").length, 1);
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(harness.database.sign_samples.length, 163);
  assert.equal(new Set(harness.database.sign_samples.map(row => row.client_id)).size, 163);
});

test("a matching identifier with different persisted content remains pending", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const sample = staticSample("A", 0.7);
  sample.syncId = "capture-a";
  harness.state.samples.push(sample);

  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
  assert.deepEqual(harness.indexedDB.records.get("account-a").samples[1].f, vector(0.7));
  assert.deepEqual(harness.database.sign_samples[0].payload.f, vector(0));
  assert.match(harness.statuses.at(-1).text, /no coincide con la copia local/);
});

test("reconciliation does not mask a different label stored inside the remote payload", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  harness.database.loseInsertResponseAt = 1;
  assert.equal(await harness.storage.saveAll(), false);
  const inserted = harness.database.sign_samples[1];
  inserted.payload.l = "Otro contenido";

  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
  assert.equal(inserted.payload.l, "Otro contenido");
  assert.match(harness.statuses.at(-1).text, /no coincide con la copia local/);
});

test("a failed IndexedDB checkpoint retains the capture and reconciles the remote insert", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  harness.database.afterSampleInsert = () => {
    harness.indexedDB.failNextPut = true;
    harness.database.afterSampleInsert = null;
  };
  assert.equal(await harness.storage.saveAll(), false);
  const pending = harness.indexedDB.records.get("account-a").samples[1];
  assert.equal(pending.syncStatus, "pending");
  assert.ok(pending.syncId);
  assert.equal(harness.database.sign_samples.length, 2);
  assert.match(harness.statuses.at(-1).text, /IndexedDB write failed/);
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "saved");
  assert.equal(harness.database.sign_samples.length, 2);
});

test("permission errors report the failed operation and Supabase code without confirming the sample", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  harness.database.failSampleInsert = true;
  harness.database.sampleInsertError = { message: "row-level security policy", code: "42501" };
  assert.equal(await harness.storage.saveAll(), false);
  assert.match(harness.statuses.at(-1).text, /Inserción de muestra.*row-level security policy.*código: 42501/);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
  assert.equal(harness.database.sign_samples.length, 1);
});

test("a capture not yet queued while an upload finishes is not discarded", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(staticSample("B", 0.1));
  const entered = deferred();
  const release = deferred();
  harness.database.beforeSampleInsert = async () => {
    entered.resolve();
    await release.promise;
  };
  const saving = harness.storage.saveAll();
  await entered.promise;
  harness.state.samples.push(staticSample("C", 0.2));
  release.resolve();
  assert.equal(await saving, true);
  assert.deepEqual(harness.state.samples.map(sample => sample.l), ["A", "B", "C"]);
  assert.equal(harness.state.samples[2].syncStatus, "pending");
  assert.equal(await harness.storage.saveAll(), true);
  assert.deepEqual(harness.indexedDB.records.get("account-a").samples.map(sample => sample.l), ["A", "B", "C"]);
});

test("private backup preserves all statuses and restores missing pending captures without duplicates", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.database.failSignRead = true;
  const pending = { ...staticSample("Pendiente"), syncId: "pending-1", extra: undefined };
  harness.state.samples.push(pending, { ...staticSample("Inválida", 0, "invalid"), syncId: "invalid-1", f: [NaN] },
    { ...staticSample("Sin verificar", 0, "unverified"), syncId: "unverified-1" });
  assert.equal(await harness.storage.saveAll(), false);
  const backup = await harness.storage.exportBackup();
  assert.deepEqual({ ...backup.counts }, { saved: 1, pending: 1, invalid: 1, unverified: 1 });
  const decoded = await readSampleBackup(backup, "account-a");
  assert.ok(Number.isNaN(decoded.samples[2].f[0]));
  const cache = harness.indexedDB.records.get("account-a");
  cache.samples = cache.samples.filter(sample => sample.syncId !== "pending-1");
  assert.equal(await harness.storage.restoreBackup(backup), 1);
  assert.deepEqual(harness.indexedDB.records.get("account-a").samples.at(-1), pending);
  assert.equal(await harness.storage.restoreBackup(backup), 0);
  assert.equal(harness.database.sign_samples.length, 1);
});

test("private backup rejects tampering, foreign accounts and conflicting captures without writes", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const backup = await harness.storage.exportBackup();
  const before = structuredClone(harness.indexedDB.records.get("account-a"));
  await assert.rejects(harness.storage.restoreBackup({ ...backup, snapshot: backup.snapshot + " " }), /SHA-256/);
  await assert.rejects(harness.storage.restoreBackup({ ...backup, ownerId: "account-b" }), /otra cuenta/);
  harness.indexedDB.records.get("account-a").samples[0].f[0] = 9;
  const modified = structuredClone(harness.indexedDB.records.get("account-a"));
  await assert.rejects(harness.storage.restoreBackup(backup), /contenido diferente/);
  assert.deepEqual(harness.indexedDB.records.get("account-a"), modified);
  assert.notDeepEqual(modified, before);
});

test("paginated reads include captures when the server enforces a lower page limit", async () => {
  const database = makeDatabase();
  database.maxRows = 2;
  for (let i = 0; i < 6; i++){
    const sign = remoteSign("account-a", `sign-${i}`, `Sign ${i}`);
    database.signs.push(sign);
    database.sign_samples.push(remoteSample("account-a", sign.id, `extra-${i}`));
  }
  const harness = makeHarness({ database });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples.length, 7);
});

test("a conflicting or invalid capture does not prevent independent captures from syncing", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push({ ...staticSample("A", 0.9), syncId: "capture-a" },
    { ...staticSample("Inválida"), f: [1] }, staticSample("Correcta", 0.3));
  assert.equal(await harness.storage.saveAll(), false);
  const cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.samples[1].syncStatus, "pending");
  assert.equal(cache.samples[2].syncStatus, "pending");
  assert.equal(cache.samples[3].syncStatus, "saved");
  assert.match(harness.issues.at(-1).join(" "), /no coincide.*Contenido incompatible/);
});

test("a successful insert is not confirmed when the subsequent read fails or content differs", async () => {
  for (const corrupt of [false, true]){
    const harness = makeHarness();
    await harness.storage.loadUserLibrary("account-a");
    harness.state.samples.push(staticSample("B", 0.1));
    harness.database.afterSampleInsert = () => {
      if (corrupt) harness.database.sign_samples.at(-1).payload.f[0] = 0.9;
      else harness.database.failSampleVerify = true;
    };
    assert.equal(await harness.storage.saveAll(), false);
    assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
    assert.match(harness.statuses.at(-1).text, corrupt ? /contenido remoto no coincide/i : /verification unavailable/);
  }
});

test("a foreign ownership marker is preserved but never uploaded", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push({ ...staticSample("Ajena"), verifiedUserId: "account-b" });
  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
  assert.equal(harness.database.sign_samples.length, 1);
  assert.match(harness.statuses.at(-1).text, /otra cuenta/);
});

test("verified remote content does not authorize a pending local capture marked as another owner", async () => {
  const sample = { ...staticSample("A", 0.2), syncId: "capture-a", verifiedUserId: "account-b" };
  const database = makeDatabase();
  database.sign_samples[0].format_version = 2;
  database.sign_samples[0].payload = prepareSamplePayload(sample, "static").payload;
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [sample], motions: [], pendingDeletes: []
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.retrySync(), false);
  assert.equal(harness.state.samples[0].syncStatus, "pending");
  assert.equal(indexedDB.records.get("account-a").samples[0].syncStatus, "pending");
  assert.equal(recognitionFor(harness.state).classify(vector(0.2)), null);
});

test("backup restores multiple anonymous captures and matches one later assigned a sync id", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.database.failSignRead = true;
  harness.state.samples.push(staticSample("Sin identificador", 0.4), staticSample("Sin identificador", 0.4));
  assert.equal(await harness.storage.saveAll(), false);
  const backup = await harness.storage.exportBackup();
  const cache = harness.indexedDB.records.get("account-a");
  cache.samples.pop();
  cache.samples.at(-1).syncId = "assigned-after-backup";
  cache.samples.at(-1).syncStatus = "saved";
  assert.equal(await harness.storage.restoreBackup(backup), 1);
  assert.equal(await harness.storage.restoreBackup(backup), 0);
  assert.equal(harness.indexedDB.records.get("account-a").samples.length, 3);
});

test("a backup from one authenticated account cannot be restored into another", async () => {
  const indexedDB = new MemoryIndexedDB();
  const database = makeDatabase();
  const first = makeHarness({ indexedDB, database });
  await first.storage.loadUserLibrary("account-a");
  const backup = await first.storage.exportBackup();
  const second = makeHarness({ indexedDB, database, accountId: "account-b" });
  await second.storage.loadUserLibrary("account-b");
  const before = structuredClone(indexedDB.records.get("account-b"));
  await assert.rejects(second.storage.restoreBackup(backup), /otra cuenta/);
  assert.deepEqual(indexedDB.records.get("account-b"), before);
});

test("loading a pending queue does not upload before the user can create a backup", async () => {
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [staticSample("Pendiente")], motions: [], pendingDeletes: []
  });
  const harness = makeHarness({ indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.database.sampleInsertAttempts, 0);
  assert.equal((await harness.storage.exportBackup()).counts.pending, 1);
  assert.equal(await harness.storage.retrySync(), true);
  assert.equal(harness.database.sampleInsertAttempts, 1);
});

test("143 pending local captures are backed up offline without changing the queue", async () => {
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: Array.from({ length: 143 }, (_, i) =>
      ({ ...staticSample("Sintética", i / 1000), syncId: `capture-${i}` })),
    motions: [], pendingDeletes: []
  });
  const before = structuredClone(indexedDB.records.get("account-a"));
  const database = makeDatabase();
  database.failSignRead = true;
  const harness = makeHarness({ indexedDB, database });
  await harness.storage.loadUserLibrary("account-a");
  const backup = await harness.storage.exportBackup();
  assert.equal(backup.counts.pending, 143);
  assert.deepEqual(await readSampleBackup(JSON.parse(JSON.stringify(backup)), "account-a"), before);
  assert.deepEqual(indexedDB.records.get("account-a"), before);
  assert.equal(database.sampleInsertAttempts, 0);
});

test("the backup button displays all status counts in the settings view", async () => {
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [staticSample("Pendiente")], motions: [], pendingDeletes: []
  });
  const harness = makeHarness({ indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  let downloaded;
  try {
    globalThis.document = { createElement: () => ({ click(){ downloaded = true; } }) };
    URL.createObjectURL = () => "blob:synthetic";
    await harness.elements.get("btnBackup").onclick();
    assert.equal(downloaded, true);
    const text = harness.elements.get("backupSummary").textContent;
    assert.match(text, /saved: 0.*local: 0.*pending: 1.*invalid: 0.*unverified: 0/);
  } finally {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate;
  }
});

test("restoring a missing confirmed entry does not trust a backup as remote proof or discard live captures", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const backup = await harness.storage.exportBackup();
  harness.indexedDB.records.get("account-a").samples = [];
  harness.state.samples = [staticSample("Aún no en cola", 0.3)];
  assert.equal(await harness.storage.restoreBackup(backup), 1);
  assert.equal(harness.indexedDB.records.get("account-a").samples[0].syncStatus, "unverified");
  assert.equal(harness.state.samples[0].l, "Aún no en cola");
  assert.equal(harness.state.samples[1].syncStatus, "unverified");
  assert.equal(recognitionFor(harness.state).classify(vector(0)), null);
  assert.equal(await harness.storage.restoreBackup(backup), 0);
});

test("a 403 on Storage download keeps a large capture pending and reports permissions", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  const sample = staticSample("Grande");
  sample.extra = "x".repeat(70_000);
  sample.syncId = "large-403";
  harness.state.samples.push(sample);
  harness.database.downloadErrors = new Map([
    ["account-a/large-403.json", { message: "Storage forbidden", status: 403 }]
  ]);
  assert.equal(await harness.storage.saveAll(), false);
  assert.equal(harness.indexedDB.records.get("account-a").samples[1].syncStatus, "pending");
  assert.match(harness.statuses.at(-1).text, /Storage forbidden.*HTTP: 403.*Permisos/);
  assert.equal(harness.database.files.size, 0);
});

test("a remote payload with inconsistent required components is not recognized", async () => {
  const database = makeDatabase();
  const components = { left: true, right: false, face: false };
  const frame = {
    time: 0, presence: { Left: true, Right: false, face: false, faceFeatures: false },
    hands: { Left: Array.from({ length: 21 }, () => [0, 0, 0]) }
  };
  const frames = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(frame), time: i }));
  const descriptor = { hands: { Left: vector(0) } };
  database.sign_samples[0].format_version = 2;
  database.sign_samples[0].required_components = { left: false, right: true, face: false };
  database.sign_samples[0].payload = {
    l: "A", kind: "static", formatVersion: 2, components,
    rawFrames: frames, filteredFrames: structuredClone(frames),
    h: descriptor, rh: descriptor
  };
  const harness = makeHarness({ database });
  const result = await harness.storage.loadUserLibrary("account-a");
  assert.equal(harness.state.samples.length, 0);
  assert.match(result.invalidReferences[0], /componentes incompatibles/);
});

test("missing object during a queued deletion cannot hide verified references or block uploads", async () => {
  const database = incidentDatabase();
  const indexedDB = new MemoryIndexedDB();
  indexedDB.records.set("account-a", {
    userId: "account-a", version: 1, revision: 1, pending: true,
    samples: [staticSample("Nueva", 0.1)], motions: [],
    pendingDeletes: [{ name: "Saludos", kind: "motion", clientIds: ["missing-0"] }]
  });
  const harness = makeHarness({ database, indexedDB });
  await harness.storage.loadUserLibrary("account-a");
  assert.equal(await harness.storage.retrySync(), false);
  const cache = indexedDB.records.get("account-a");
  assert.equal(cache.samples[0].syncStatus, "saved");
  assert.equal(cache.pending, true);
  assert.equal(cache.pendingDeletes.length, 1);
  assert.equal(database.signs.some(sign => sign.name === "Saludos"), true);
  assert.equal(database.storageRemoveCalls, 0);
  assert.equal(database.sign_samples.length, 191);
  assert.equal(recognitionFor(harness.state).classify(vector(0))?.label, "A");
  assert.match(harness.issues.at(-1).join(" "), /eliminaciones pendientes.*Revisar eliminaciones/i);
});

test("a failed sample upload does not block other captures and remains available for retry", async () => {
  const harness = makeHarness();
  await harness.storage.loadUserLibrary("account-a");
  harness.state.samples.push(...Array.from({ length: 4 }, (_, i) => staticSample("Carga", 0.1 + i * 0.01)));
  harness.database.failSampleInsertAt = 2;
  assert.equal(await harness.storage.saveAll(), false);
  let cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "pending").length, 1);
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "saved").length, 4);
  assert.equal(harness.database.sign_samples.length, 4);
  assert.equal(await harness.storage.retrySync(), true);
  cache = harness.indexedDB.records.get("account-a");
  assert.equal(cache.samples.filter(sample => sample.syncStatus === "pending").length, 0);
  assert.equal(harness.database.sign_samples.length, 5);
});
