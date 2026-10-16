import { normalizeFilterConfig } from "./filters.js";
import {
  prepareSamplePayload,
  SAMPLE_FORMAT_VERSION,
  SAMPLE_STORAGE_THRESHOLD_BYTES,
  validateSample
} from "./sampleFormat.js";
import { getSupabaseClient } from "./supabaseClient.js";

export function createStorage({ state, dom, ui }){
  const { $, listEl } = dom;
  const { setNote, renderList, setSyncStatus } = ui;
  const STORE_KEY = "senas_mediapipe_v3";
  const PREVIOUS_KEY = "senas_mediapipe_v2";
  const OLD_KEY = "senas_mediapipe_v1";
  const CACHE_DB = "senaTrackSync";
  const CACHE_DB_VERSION = 1;
  const BUCKET = "sign-samples";
  let userId = null;
  let lastLocalLibrary = null;
  let syncPromise = null;
  let syncRequested = false;
  let userLoadToken = 0;
  let cacheDatabasePromise = null;

  function parseLibrary(data){
    if (data && Array.isArray(data.s)) return { s: data.s, m: data.m || [], filters: data.filters };
    if (data && (Array.isArray(data.static) || Array.isArray(data.motion))){
      return { s: data.static || [], m: data.motion || [], filters: data.filters };
    }
    return null;
  }

  function loadAll(){
    lastLocalLibrary = { s: [], m: [], filters: null };
    return lastLocalLibrary;
  }

  function readLegacyLocalLibrary(){
    for (const key of [STORE_KEY, PREVIOUS_KEY]){
      try {
        const library = parseLibrary(JSON.parse(localStorage.getItem(key)));
        if (library) return library;
      } catch (error){
        console.warn(`No se pudo leer ${key} de localStorage.`, error);
      }
    }
    try {
      const old = JSON.parse(localStorage.getItem(OLD_KEY));
      if (Array.isArray(old)) return { s: old, m: [], filters: null };
    } catch (error){
      console.warn(`No se pudo leer ${OLD_KEY} de localStorage.`, error);
    }
    return { s: [], m: [], filters: null };
  }

  function cacheKey(id = userId){
    if (!id) throw new Error("No hay una cuenta activa para guardar la biblioteca.");
    return id;
  }

  function currentSnapshot(){
    return {
      version: 1,
      samples: state.samples,
      motions: state.motions,
      filters: state.filterConfig,
      settings: readSettings(),
      pending: true,
      pendingDeletes: []
    };
  }

  function openCacheDatabase(){
    if (!globalThis.indexedDB) return Promise.reject(new Error("Este navegador no permite IndexedDB para la cola de sincronización."));
    if (!cacheDatabasePromise){
      cacheDatabasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_DB, CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("accounts")){
            database.createObjectStore("accounts", { keyPath: "userId" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("No se pudo abrir la cola IndexedDB."));
        request.onblocked = () => reject(new Error("La base IndexedDB está bloqueada por otra pestaña. Cierra pestañas antiguas y reintenta."));
      });
    }
    return cacheDatabasePromise;
  }

  async function readCache(id = userId){
    if (!id) return null;
    try {
      const database = await openCacheDatabase();
      const cache = await new Promise((resolve, reject) => {
        const transaction = database.transaction("accounts", "readonly");
        const request = transaction.objectStore("accounts").get(cacheKey(id));
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("No se pudo leer la cola IndexedDB."));
      });
      if (cache && Array.isArray(cache.samples) && Array.isArray(cache.motions)) return cache;
    } catch (error){
      console.error("No se pudo recuperar la copia local de la cuenta.", error);
      throw error;
    }
  }

  async function storeCache(cache, id = userId){
    const database = await openCacheDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("accounts", "readwrite");
      transaction.objectStore("accounts").put({ ...cache, userId: cacheKey(id) });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar la cola IndexedDB."));
      transaction.onabort = () => reject(transaction.error || new Error("Se canceló el guardado de la cola IndexedDB."));
    });
  }

  async function storePendingCache(cache){
    cache.revision = (await readCache())?.revision + 1 || 1;
    cache.pending = true;
    await storeCache(cache);
  }

  function readSettings(){
    return {
      filter_model: state.filterConfig.model,
      tau: state.filterConfig.tau,
      zeta: state.filterConfig.zeta,
      omega_n: state.filterConfig.omegaN,
      static_tolerance: Number($("tol").value),
      motion_tolerance: Number($("tolM").value),
      capture_duration: Number($("dur").value),
      speech_enabled: $("speechEnabled").checked,
      show_raw_points: state.filterConfig.compareVisual
    };
  }

  function applySettings(settings){
    if (!settings) return;
    state.filterConfig = normalizeFilterConfig({
      model: settings.filter_model ?? state.filterConfig.model,
      tau: settings.tau ?? state.filterConfig.tau,
      zeta: settings.zeta ?? state.filterConfig.zeta,
      omegaN: settings.omega_n ?? state.filterConfig.omegaN,
      compareVisual: settings.show_raw_points ?? state.filterConfig.compareVisual
    });
    $("tol").value = settings.static_tolerance ?? $("tol").value;
    $("tolM").value = settings.motion_tolerance ?? $("tolM").value;
    $("dur").value = settings.capture_duration ?? $("dur").value;
    $("speechEnabled").checked = settings.speech_enabled ?? $("speechEnabled").checked;
    ui.refreshFilterControls();
    ui.refreshGeneralControls();
    state.onFilterChange?.();
  }

  async function readRemoteLibrary(client, id){
    const { data: signs, error: signsError } = await client.from("signs")
      .select("id,name,kind,sign_language,visibility")
      .eq("owner_id", id);
    if (signsError) throw signsError;
    const signById = new Map(signs.map(sign => [sign.id, sign]));
    const signIds = signs.map(sign => sign.id);
    let records = [];
    if (signIds.length){
      const { data, error } = await client.from("sign_samples")
        .select("id,sign_id,client_id,format_version,required_components,hand_count,face_available,mediapipe_model,processing,handedness,coordinate_space,mirrored_display,image_width,image_height,captured_at,payload,storage_path")
        .in("sign_id", signIds);
      if (error) throw error;
      records = data;
    }

    const samples = [], motions = [];
    for (const record of records){
      const sign = signById.get(record.sign_id);
      if (!sign) throw new Error(`La muestra ${record.id} hace referencia a una seña que no se pudo cargar.`);
      let payload = record.payload;
      if (record.storage_path){
        const { data, error } = await client.storage.from(BUCKET).download(record.storage_path);
        if (error) throw error;
        try {
          payload = JSON.parse(await data.text());
        } catch (error){
          throw new Error(`El archivo ${record.storage_path} no contiene una muestra JSON válida: ${error.message}`);
        }
      }
      if (!payload || typeof payload !== "object") throw new Error(`La muestra ${record.id} no contiene datos.`);
      payload.l = sign.name;
      payload.kind = sign.kind;
      payload.syncId = record.client_id;
      if (![1, SAMPLE_FORMAT_VERSION].includes(payload.formatVersion) ||
          payload.formatVersion !== record.format_version){
        throw new Error(`La muestra ${record.id} usa una versión de formato no compatible.`);
      }
      validateSample(payload, sign.kind);
      payload.captureMeta = {
        handCount: record.hand_count,
        faceAvailable: record.face_available,
        mediapipeModel: record.mediapipe_model,
        processing: record.processing,
        handedness: record.handedness,
        coordinateSpace: record.coordinate_space,
        mirroredDisplay: record.mirrored_display,
        width: record.image_width,
        height: record.image_height,
        capturedAt: record.captured_at
      };
      if (record.format_version === 1){
        payload.legacyScope = "hands-only";
        payload.provenance = { ...(payload.provenance || {}), legacy: true, facialDataAvailable: false };
      }
      (sign.kind === "motion" ? motions : samples).push(payload);
    }

    const { data: settings, error: settingsError } = await client.from("user_settings")
      .select("filter_model,tau,zeta,omega_n,static_tolerance,motion_tolerance,capture_duration,speech_enabled,show_raw_points")
      .eq("user_id", id).maybeSingle();
    if (settingsError) throw settingsError;
    return { samples, motions, settings, pending: false, pendingDeletes: [] };
  }

  async function loadUserLibrary(id){
    userId = id;
    const loadToken = ++userLoadToken;
    let cached;
    try {
      cached = await readCache(id);
    } catch (error){
      setSyncStatus(`No se pudo abrir la cola local de sincronización: ${error.message}`, "error");
      return { samples: state.samples, motions: state.motions, loadError: error };
    }
    const initialRevision = cached?.revision;
    if (cached?.pending){
      state.samples = cached.samples.map(sample => ({ ...sample, syncStatus: "pending" }));
      state.motions = cached.motions.map(sample => ({ ...sample, syncStatus: "pending" }));
      applySettings(cached.settings);
      setSyncStatus("Pendiente de sincronización", "pending");
      renderList();
      void flushPending();
      return { samples: state.samples, motions: state.motions, settings: cached.settings, pending: true };
    }
    setSyncStatus("Cargando biblioteca…", "loading");
    try {
      const client = await getSupabaseClient();
      const remote = await readRemoteLibrary(client, id);
      if (userId !== id || userLoadToken !== loadToken){
        return { samples: [], motions: [], cancelled: true };
      }
      const newerCache = await readCache(id);
      if (newerCache?.pending && newerCache.revision !== initialRevision){
        state.samples = newerCache.samples.map(sample => ({ ...sample, syncStatus: "pending" }));
        state.motions = newerCache.motions.map(sample => ({ ...sample, syncStatus: "pending" }));
        applySettings(newerCache.settings);
        setSyncStatus("Pendiente de sincronización", "pending");
        renderList();
        void flushPending();
        return { samples: state.samples, motions: state.motions, settings: newerCache.settings, pending: true };
      }
      state.samples = remote.samples;
      state.motions = remote.motions;
      if (remote.settings) applySettings(remote.settings);
      try {
        await storeCache({
          version: 1, samples: remote.samples, motions: remote.motions,
          settings: remote.settings || readSettings(), pending: false, pendingDeletes: []
        });
        setSyncStatus("Biblioteca sincronizada", "saved");
      } catch (error){
        console.error("La biblioteca se cargó, pero no se pudo guardar su caché local.", error);
        setSyncStatus(`Biblioteca cargada, pero no se pudo actualizar la caché local: ${error.message}`, "error");
      }
      renderList();
      return remote;
    } catch (error){
      console.error("No se pudo cargar la biblioteca de Supabase.", error);
      if (userId !== id || userLoadToken !== loadToken){
        return { samples: [], motions: [], loadError: error, cancelled: true };
      }
      if (cached){
        state.samples = cached.samples;
        state.motions = cached.motions;
        applySettings(cached.settings);
        setSyncStatus(`Error al cargar; se usa la copia local. ${error.message}`, "error");
      } else {
        state.samples = [];
        state.motions = [];
        setSyncStatus(`Error al cargar la biblioteca. Reintenta cuando vuelva la conexión. ${error.message}`, "error");
      }
      renderList();
      return { samples: state.samples, motions: state.motions, settings: cached?.settings, loadError: error };
    }
  }

  async function ensureSampleId(sample){
    if (typeof sample.syncId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sample.syncId)){
      return sample.syncId;
    }
    const sampleWithoutSyncId = { ...sample };
    delete sampleWithoutSyncId.syncId;
    const source = JSON.stringify(sampleWithoutSyncId);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    sample.syncId = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return sample.syncId;
  }

  async function signId(client, id, sign, cache){
    const found = cache.find(item => item.name === sign.name &&
      item.kind === sign.kind && item.sign_language === sign.sign_language);
    if (found) return found.id;
    const { data, error } = await client.from("signs").insert({
      owner_id: id,
      name: sign.name,
      kind: sign.kind,
      sign_language: sign.sign_language,
      visibility: "private"
    }).select("id").single();
    if (error) throw error;
    cache.push({ ...sign, id: data.id });
    return data.id;
  }

  async function deleteRemoteSign(client, id, name, kind, clientIds = []){
    const { data: signs, error: signError } = await client.from("signs")
      .select("id").eq("owner_id", id).eq("name", name).eq("kind", kind);
    if (signError) throw signError;
    if (!signs.length){
      const storage = client.storage.from(BUCKET);
      const orphanPaths = [];
      for (const clientId of clientIds){
        const path = `${id}/${clientId}.json`;
        const { data: listed, error } = await storage.list(id, { search: `${clientId}.json`, limit: 10 });
        if (error) throw error;
        if (listed.some(item => item.name === `${clientId}.json`)) orphanPaths.push(path);
      }
      if (orphanPaths.length){
        const { error } = await storage.remove(orphanPaths);
        if (error) throw error;
      }
      return;
    }
    for (const sign of signs){
      const { data: records, error: recordsError } = await client.from("sign_samples")
        .select("client_id,storage_path").eq("sign_id", sign.id).not("storage_path", "is", null);
      if (recordsError) throw recordsError;
      const paths = new Set(records.map(record => record.storage_path));
      for (const removed of clientIds){
        const path = `${id}/${removed}.json`;
        if (paths.has(path)) continue;
        const { data: listed, error } = await client.storage.from(BUCKET)
          .list(id, { search: `${removed}.json`, limit: 10 });
        if (error) throw error;
        if (listed.some(item => item.name === `${removed}.json`)) paths.add(path);
      }
      const restore = [];
      for (const path of paths){
        const { data, error } = await client.storage.from(BUCKET).download(path);
        if (error) throw error;
        restore.push({ path, blob: data });
      }
      if (restore.length){
        const { error } = await client.storage.from(BUCKET).remove(restore.map(file => file.path));
        if (error) throw error;
      }
      const { error: deleteError } = await client.from("signs").delete()
        .eq("id", sign.id).eq("owner_id", id);
      if (deleteError){
        const rollbackErrors = [];
        for (const file of restore){
          const { error } = await client.storage.from(BUCKET).upload(file.path, file.blob, {
            contentType: "application/json"
          });
          if (error) rollbackErrors.push(error.message);
        }
        if (rollbackErrors.length){
          throw new Error(`No se pudo borrar la seña (${deleteError.message}) ni restaurar los archivos: ${rollbackErrors.join("; ")}`);
        }
        throw deleteError;
      }
    }
  }

  async function uploadSample(client, id, signIdValue, sample, kind, existingIds){
    const clientId = await ensureSampleId(sample);
    if (existingIds.has(clientId)) return;
    const { payload, bytes } = prepareSamplePayload(sample, kind);
    const meta = sample.captureMeta || {};
    const legacyHand = meta.handedness || sample.handedness;
    const legacyComponents = legacyHand === "Right"
      ? { left: false, right: true, face: false }
      : { left: true, right: false, face: false };
    const recordedHandCount = Number(meta.handCount);
    const fallbackHandCount = sample.components && !sample.components.left && !sample.components.right ? 0 : 1;
    const metadata = {
      owner_id: id,
      sign_id: signIdValue,
      client_id: clientId,
      hand_count: Math.min(2, Math.max(0, Math.floor(
        Number.isFinite(recordedHandCount) ? recordedHandCount : fallbackHandCount))),
      face_available: Boolean(meta.faceAvailable),
      format_version: SAMPLE_FORMAT_VERSION,
      required_components: sample.components || legacyComponents,
      mediapipe_model: meta.mediapipeModel || "hand_landmarker_float16_v1",
      processing: {
        source: sample.source || "legacy",
        filter: sample.filter || null,
        provenance: payload.provenance
      },
      handedness: meta.handedness || null,
      coordinate_space: meta.coordinateSpace || "mediapipe-normalized-image-v1",
      mirrored_display: meta.mirroredDisplay ?? true,
      image_width: Number.isInteger(meta.width) && meta.width > 0 ? meta.width : null,
      image_height: Number.isInteger(meta.height) && meta.height > 0 ? meta.height : null,
      captured_at: meta.capturedAt || new Date().toISOString()
    };
    if (bytes <= SAMPLE_STORAGE_THRESHOLD_BYTES){
      const { error } = await client.from("sign_samples").insert({ ...metadata, payload, storage_path: null });
      if (error) throw error;
    } else {
      const path = `${id}/${clientId}.json`;
      const storage = client.storage.from(BUCKET);
      const { data: objectList, error: listError } = await storage.list(id, { search: `${clientId}.json`, limit: 10 });
      if (listError) throw listError;
      if (objectList.some(object => object.name === `${clientId}.json`)){
        const { error } = await storage.remove([path]);
        if (error) throw error;
      }
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const { error: uploadError } = await storage.upload(path, blob, { contentType: "application/json" });
      if (uploadError) throw uploadError;
      const { error: insertError } = await client.from("sign_samples").insert({
        ...metadata, payload: null, storage_path: path
      });
      if (insertError){
        const { data: committed, error: verifyError } = await client.from("sign_samples")
          .select("storage_path").eq("owner_id", id).eq("client_id", clientId).maybeSingle();
        if (verifyError){
          throw new Error(`No se pudo confirmar el registro después del error de inserción (${insertError.message}): ${verifyError.message}. El reintento verificará esta muestra antes de duplicarla.`);
        }
        if (committed?.storage_path === path){
          existingIds.add(clientId);
          return;
        }
        const { error: cleanupError } = await storage.remove([path]);
        if (cleanupError){
          throw new Error(`No se pudo guardar la muestra (${insertError.message}); tampoco se pudo retirar el archivo temporal (${cleanupError.message}).`);
        }
        throw insertError;
      }
    }
    existingIds.add(clientId);
  }

  async function syncRemote(cache, id){
    if (!id) throw new Error("No hay una cuenta activa.");
    const client = await getSupabaseClient();
    for (const removed of cache.pendingDeletes || []){
      await deleteRemoteSign(client, id, removed.name, removed.kind, removed.clientIds);
    }
    const { data: existingSigns, error: existingSignsError } = await client.from("signs")
      .select("id,name,kind,sign_language").eq("owner_id", id);
    if (existingSignsError) throw existingSignsError;
    const signCache = existingSigns;
    const { data: existingSamples, error: existingSamplesError } = await client.from("sign_samples")
      .select("client_id").eq("owner_id", id);
    if (existingSamplesError) throw existingSamplesError;
    const existingIds = new Set(existingSamples.map(sample => sample.client_id));
    const all = [
      ...cache.samples.map(sample => ({ sample, kind: "static" })),
      ...cache.motions.map(sample => ({ sample, kind: "motion" }))
    ];
    for (const { sample, kind } of all){
      const sign = { name: sample.l.trim(), kind, sign_language: sample.signLanguage || "LSC" };
      const signIdValue = await signId(client, id, sign, signCache);
      await uploadSample(client, id, signIdValue, sample, kind, existingIds);
    }
    if (cache.settingsPending){
      await writeRemoteSettings(client, cache.settings, id);
    }
  }

  async function flushPending(){
    if (syncPromise){
      syncRequested = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      let succeeded = true;
      do {
        syncRequested = false;
        const id = userId;
        let cache;
        try {
          cache = await readCache(id);
        } catch (error){
          succeeded = false;
          if (userId === id) setSyncStatus(`No se pudo leer la cola local: ${error.message}`, "error");
          break;
        }
        if (!cache || !cache.pending) break;
        if (userId === id) setSyncStatus("Guardando…", "loading");
        try {
          await syncRemote(cache, id);
          const latest = await readCache(id);
          if (latest?.revision !== cache.revision){
            syncRequested = true;
            continue;
          }
          cache.pending = false;
          cache.pendingDeletes = [];
          cache.settingsPending = false;
          cache.samples = cache.samples.map(sample => ({ ...sample, syncStatus: "saved" }));
          cache.motions = cache.motions.map(sample => ({ ...sample, syncStatus: "saved" }));
          await storeCache(cache, id);
          if (userId === id){
            state.samples = cache.samples;
            state.motions = cache.motions;
            renderList();
          }
        } catch (error){
          succeeded = false;
          console.error("La sincronización con Supabase falló.", error);
          let latest;
          try { latest = await readCache(id); } catch (storageError){
            console.error("No se pudo comprobar la cola local tras el error de red.", storageError);
          }
          if (latest?.revision === cache.revision){
            latest.pending = true;
            try { await storeCache(latest, id); } catch (storageError){
              console.error("Tampoco se pudo conservar la cola local de sincronización.", storageError);
            }
          }
          if (userId === id) setSyncStatus(`Error: ${error.message}`, "error");
          break;
        }
      } while (syncRequested);
      if (succeeded && userId) setSyncStatus("Guardado en Supabase", "saved");
      return succeeded;
    })().finally(() => { syncPromise = null; });
    return syncPromise;
  }

  async function saveAll(){
    if (!userId) return false;
    const cache = await readCache() || currentSnapshot();
    cache.samples = state.samples;
    cache.motions = state.motions;
    cache.filters = state.filterConfig;
    cache.settings = readSettings();
    cache.settingsPending = true;
    try {
      await storePendingCache(cache);
    } catch (error){
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      throw error;
    }
    return flushPending();
  }

  async function writeRemoteSettings(client, settings, id){
    const { error } = await client.from("user_settings").upsert({
      user_id: id,
      ...settings
    }, { onConflict: "user_id" });
    if (error) throw error;
  }

  async function savePreferences(){
    if (!userId) return;
    const cache = await readCache() || currentSnapshot();
    cache.filters = state.filterConfig;
    cache.settings = readSettings();
    cache.settingsPending = true;
    try {
      await storePendingCache(cache);
    } catch (error){
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      return false;
    }
    await flushPending();
  }

  async function retrySync(){
    if (!userId) return false;
    const cache = await readCache();
    if (cache?.pending) return flushPending();
    const result = await loadUserLibrary(userId);
    return !result.loadError;
  }

  async function deleteSign(name, kind){
    const removedSamples = kind === "s"
      ? state.samples.filter(sample => sample.l === name)
      : state.motions.filter(sample => sample.l === name);
    const clientIds = await Promise.all(removedSamples.map(ensureSampleId));
    const nextSamples = kind === "s" ? state.samples.filter(sample => sample.l !== name) : state.samples;
    const nextMotions = kind === "m" ? state.motions.filter(sample => sample.l !== name) : state.motions;
    const cache = await readCache() || currentSnapshot();
    cache.samples = nextSamples;
    cache.motions = nextMotions;
    cache.pendingDeletes ||= [];
    const dbKind = kind === "s" ? "static" : "motion";
    const queued = cache.pendingDeletes.find(item => item.name === name && item.kind === dbKind);
    if (queued) queued.clientIds = [...new Set([...(queued.clientIds || []), ...clientIds])];
    else cache.pendingDeletes.push({ name, kind: dbKind, clientIds });
    try {
      await storePendingCache(cache);
    } catch (error){
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      throw error;
    }
    state.samples = nextSamples;
    state.motions = nextMotions;
    renderList();
    await flushPending();
  }

  async function importIntoState(library){
    const all = [...state.samples.map(sample => ({ sample, kind: "static" })),
      ...state.motions.map(sample => ({ sample, kind: "motion" }))];
    const known = new Set();
    for (const { sample, kind } of all){
      known.add(`${kind}:${await ensureSampleId(sample)}`);
    }
    const incoming = [...library.s.map(sample => ({ sample, kind: "static" })),
      ...library.m.map(sample => ({ sample, kind: "motion" }))];
    return Promise.all(incoming.map(async ({ sample, kind }) => {
      const id = await ensureSampleId(sample);
      const key = `${kind}:${id}`;
      if (known.has(key)) return false;
      known.add(key);
      (kind === "static" ? state.samples : state.motions).push({ ...sample, syncStatus: "pending" });
      return true;
    }));
  }

  async function importLibrary(library){
    if (!userId) throw new Error("Inicia sesión para importar ejemplos a tu biblioteca privada de Supabase.");
    const normalized = {
      s: library.s.map(sample => prepareSamplePayload(sample, "static").payload),
      m: library.m.map(sample => prepareSamplePayload(sample, "motion").payload),
      filters: library.filters
    };
    const imported = await importIntoState(normalized);
    if (library.filters){
      state.filterConfig = normalizeFilterConfig(library.filters);
      state.onFilterChange?.();
    }
    renderList();
    const added = imported.filter(Boolean).length;
    if (!added){
      if (library.filters) await savePreferences();
      setNote("No se añadieron señas: esos ejemplos ya están en tu biblioteca.");
      return false;
    }
    const saved = await saveAll();
    setNote(saved
      ? `${added} ejemplo(s) importados y guardados en Supabase.`
      : `${added} ejemplo(s) pendientes de sincronización; todavía no se usan para reconocer.`);
    return true;
  }

  function serializeLocal(){
    lastLocalLibrary = readLegacyLocalLibrary();
    const library = parseLibrary({
      s: lastLocalLibrary?.s || [],
      m: lastLocalLibrary?.m || [],
      filters: lastLocalLibrary?.filters || null
    });
    return library;
  }

  async function importLocalLibrary(){
    const library = serializeLocal();
    if (!library || (!library.s.length && !library.m.length)){
      setNote("No se encontraron señas guardadas localmente para importar.");
      return;
    }
    const imported = await importLibrary(library);
    if (imported) setNote("Señas locales importadas explícitamente; revisa el estado de sincronización.");
  }

  $("btnImportLocal").addEventListener("click", async () => {
    const library = serializeLocal();
    const staticCount = library?.s.length || 0;
    const motionCount = library?.m.length || 0;
    if (!staticCount && !motionCount){
      setNote("No se encontraron señas guardadas localmente para importar.");
      return;
    }
    const legacyCount = [...(library?.s || []), ...(library?.m || [])]
      .filter(sample => !sample.components).length;
    const message = `Se transferirán ${staticCount} ejemplo(s) fijo(s) y ${motionCount} movimiento(s) desde este navegador a la cuenta autenticada. ${legacyCount ? `${legacyCount} ejemplo(s) son heredados: podrían contener solo características y no coordenadas originales reprocesables. ` : ""}La copia local no se borrará. ¿Confirmas la transferencia?`;
    if (confirm(message)){
      try {
        await importLocalLibrary();
      } catch (error){
        console.error("No se pudo importar la biblioteca local.", error);
        setSyncStatus(`No se pudo preparar la importación: ${error.message}`, "error");
        setNote(`Importación incompleta: ${error.message}`);
      }
    }
  });

  $("syncRetry").addEventListener("click", () => { void retrySync(); });

  const exportButton = $("btnExport");
  exportButton.onclick = () => {
    const blob = new Blob([JSON.stringify({
      version: SAMPLE_FORMAT_VERSION,
      static: state.samples.filter(sample => sample.syncStatus !== "pending"),
      motion: state.motions.filter(sample => sample.syncStatus !== "pending"),
      filters: state.filterConfig
    })], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "mis-senas.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  $("btnImport").onclick = () => $("file").click();
  $("file").onchange = async event => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      const data = JSON.parse(await file.text());
      const library = Array.isArray(data) ? { s: data, m: [], filters: null } : parseLibrary(data);
      if (!library) throw new TypeError("El archivo no tiene el formato de biblioteca esperado.");
      for (const sample of library.s) prepareSamplePayload(sample, "static");
      for (const sample of library.m) prepareSamplePayload(sample, "motion");
      await importLibrary(library);
    } catch (error){
      console.error("No se pudo importar la biblioteca JSON.", error);
      alert(`No se pudo importar el archivo: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  };
  $("btnReset").onclick = async () => {
    if (!confirm("¿Borrar todas las señas de esta cuenta? Esta acción se sincroniza con Supabase.")) return;
    try {
      const names = new Map();
      for (const sample of state.samples){
        const key = `s:${sample.l}`;
        const group = names.get(key) || { name: sample.l, kind: "s", clientIds: [] };
        group.clientIds.push(await ensureSampleId(sample));
        names.set(key, group);
      }
      for (const sample of state.motions){
        const key = `m:${sample.l}`;
        const group = names.get(key) || { name: sample.l, kind: "m", clientIds: [] };
        group.clientIds.push(await ensureSampleId(sample));
        names.set(key, group);
      }
      const cache = await readCache() || currentSnapshot();
      cache.samples = [];
      cache.motions = [];
      cache.pendingDeletes = [...(cache.pendingDeletes || []), ...[...names.values()].map(({ name, kind, clientIds }) => ({
        name, kind: kind === "s" ? "static" : "motion", clientIds
      }))];
      await storePendingCache(cache);
      state.samples = [];
      state.motions = [];
    } catch (error){
      console.error("No se pudo preparar el borrado de la biblioteca.", error);
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      return;
    }
    renderList();
    await flushPending();
  };

  return {
    loadAll,
    loadUserLibrary,
    saveAll,
    savePreferences,
    deleteSign,
    importLibrary,
    importLocalLibrary,
    retrySync,
    clearUser(){
      userId = null;
      syncRequested = false;
      userLoadToken++;
      state.samples = [];
      state.motions = [];
      state.filterConfig = normalizeFilterConfig(null);
      $("tol").value = "0.8";
      $("tolM").value = "0.7";
      $("dur").value = "2";
      $("speechEnabled").checked = true;
      ui.refreshGeneralControls();
    }
  };
}
