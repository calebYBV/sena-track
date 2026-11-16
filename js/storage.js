import { normalizeActiveFilterConfig } from "./filters.js";
import { DEFAULT_AMBIGUITY_CONFIG, normalizeAmbiguityConfig } from "./recognition.js";
import {
  prepareSamplePayload,
  SAMPLE_FORMAT_VERSION,
  SAMPLE_STORAGE_THRESHOLD_BYTES,
  validateSample
} from "./sampleFormat.js";
import { isSampleRecognizable, restoreCachedSample } from "./sampleSync.js";
import { getSupabaseClient } from "./supabaseClient.js";

export function createStorage({
  state, dom, ui,
  getSupabaseClientImpl = getSupabaseClient
}){
  const { $, listEl } = dom;
  const { setNote, renderList, setSyncStatus, setSyncIssues } = ui;
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
  let cacheWriteTail = Promise.resolve();

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
      ambiguity: state.ambiguityConfig,
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
      }).catch(error => {
        cacheDatabasePromise = null;
        throw error;
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
      if (cache && cache.userId !== id){
        throw new Error("La copia local no pertenece a la cuenta autenticada; no se utilizará.");
      }
      if (cache){
        if (!Array.isArray(cache.samples) || !Array.isArray(cache.motions)){
          throw new Error("La copia local tiene una estructura inválida; se conservará sin sobrescribirla.");
        }
        return cache;
      }
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

  // Serialize every local read-modify-write as one unit. A revision number
  // by itself does not prevent concurrent writers from losing a newer snapshot.
  function withCacheWrite(work){
    const result = cacheWriteTail.then(work, work);
    cacheWriteTail = result.catch(() => {});
    return result;
  }

  function updatePendingCache(mutate, id = userId){
    return withCacheWrite(async () => {
      if (!id || id !== userId) throw new Error("La cuenta cambió durante la operación.");
      const cache = await readCache(id) || currentSnapshot();
      await mutate(cache);
      cache.revision = (Number.isFinite(cache.revision) ? cache.revision : 0) + 1;
      cache.pending = true;
      await storeCache(cache, id);
      return cache;
    });
  }

  function readSettings(){
    return {
      filter_model: "first",
      tau: state.filterConfig.tau,
      static_tolerance: Number($("tol").value),
      motion_tolerance: Number($("tolM").value),
      capture_duration: Number($("dur").value),
      speech_enabled: $("speechEnabled").checked,
      show_raw_points: state.filterConfig.compareVisual
    };
  }

  function applySettings(settings){
    if (!settings) return;
    state.filterConfig = normalizeActiveFilterConfig({
      model: settings.filter_model ?? state.filterConfig.model,
      tau: settings.tau ?? state.filterConfig.tau,
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

  function restoreCachedLibrary(cache, id){
    const options = {
      ownerId: id,
      cacheUserId: cache.userId,
      cachePending: cache.pending
    };
    return {
      samples: cache.samples.map(sample => restoreCachedSample(sample, "static", options)),
      motions: cache.motions.map(sample => restoreCachedSample(sample, "motion", options))
    };
  }

  async function readRemoteLibrary(client, id){
    const { data: signs, error: signsError } = await client.from("signs")
      .select("id,name,kind,sign_language,visibility")
      .eq("owner_id", id);
    if (signsError) throw new Error(`Lectura de señas en Supabase: ${signsError.message}`, { cause: signsError });
    const signById = new Map(signs.map(sign => [sign.id, sign]));
    const signIds = signs.map(sign => sign.id);
    let records = [];
    if (signIds.length){
      const { data, error } = await client.from("sign_samples")
        .select("id,owner_id,sign_id,client_id,format_version,required_components,hand_count,face_available,mediapipe_model,processing,handedness,coordinate_space,mirrored_display,image_width,image_height,captured_at,payload,storage_path")
        .eq("owner_id", id).in("sign_id", signIds);
      if (error) throw new Error(`Lectura de muestras en Supabase: ${error.message}`, { cause: error });
      records = data;
    }

    const samples = [], motions = [];
    const invalidReferences = [];
    const unavailableObjects = [];
    const persistedPayloads = new Map();
    for (const record of records){
      if (record.owner_id !== id){
        invalidReferences.push(`La muestra ${record.id} no pertenece a la cuenta actual.`);
        continue;
      }
      const sign = signById.get(record.sign_id);
      if (!sign){
        invalidReferences.push(`La muestra ${record.id} hace referencia a una seña que no se pudo cargar.`);
        continue;
      }
      let payload = structuredClone(record.payload);
      if (record.storage_path){
        let data, error;
        try {
          ({ data, error } = await client.storage.from(BUCKET).download(record.storage_path));
        } catch (downloadError){
          error = downloadError;
        }
        if (error || !data){
          const message = error?.message || "La descarga no devolvió datos.";
          invalidReferences.push(`Muestra ${record.id} de «${sign.name}»: Storage ${record.storage_path}: ${message}`);
          unavailableObjects.push({ record, sign, message });
          continue;
        }
        try {
          payload = JSON.parse(await data.text());
        } catch (error){
          invalidReferences.push(`El archivo ${record.storage_path} no contiene una muestra JSON válida: ${error.message}`);
          continue;
        }
      }
      if (!payload || typeof payload !== "object"){
        invalidReferences.push(`La muestra ${record.id} no contiene datos.`);
        continue;
      }
      const persistedPayload = structuredClone(payload);
      payload.l = sign.name;
      payload.kind = sign.kind;
      payload.syncId = record.client_id;
      if (![1, SAMPLE_FORMAT_VERSION].includes(payload.formatVersion) ||
          payload.formatVersion !== record.format_version){
        invalidReferences.push(`La muestra ${record.id} usa una versión de formato no compatible.`);
        continue;
      }
      try {
        validateSample(payload, sign.kind);
      } catch (error){
        invalidReferences.push(`La muestra ${record.id} no es válida: ${error.message}`);
        continue;
      }
      persistedPayloads.set(record.client_id, persistedPayload);
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
      if (!payload.filter && record.processing?.filter &&
          typeof record.processing.filter === "object"){
        payload.filter = record.processing.filter;
      }
      if (record.format_version === 1){
        payload.legacyScope = "hands-only";
        payload.provenance = { ...(payload.provenance || {}), legacy: true, facialDataAvailable: false };
      }
      payload.syncStatus = "saved";
      payload.verifiedUserId = id;
      (sign.kind === "motion" ? motions : samples).push(payload);
    }

    let settings, settingsError;
    try {
      const result = await client.from("user_settings")
        .select("filter_model,tau,static_tolerance,motion_tolerance,capture_duration,speech_enabled,show_raw_points")
        .eq("user_id", id).maybeSingle();
      settings = result.data;
      settingsError = result.error;
    } catch (error){
      settingsError = error;
    }
    return {
      samples, motions, settings: settingsError ? null : settings,
      settingsError, invalidReferences, unavailableObjects, persistedPayloads, pending: false, pendingDeletes: []
    };
  }

  function localRecoveryCandidate(cache, id, { record, sign }){
    if (!cache || cache.userId !== id || record.owner_id !== id ||
        record.storage_path !== `${id}/${record.client_id}.json` ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(record.client_id)) return false;
    const candidates = sign.kind === "static" ? cache.samples : cache.motions;
    return candidates.some(sample => {
      if (sample.syncId !== record.client_id || sample.l !== sign.name ||
          sample.kind !== sign.kind || sample.verifiedUserId && sample.verifiedUserId !== id ||
          (sample.signLanguage || "LSC") !== sign.sign_language ||
          sample.formatVersion !== record.format_version ||
          !Array.isArray(sample.rawFrames) && !Array.isArray(sample.lm) ||
          sample.components && canonicalJson(sample.components) !== canonicalJson(record.required_components) ||
          sample.captureMeta?.capturedAt && sample.captureMeta.capturedAt !== record.captured_at) return false;
      try {
        validateSample(sample, sign.kind);
        return true;
      } catch {
        return false;
      }
    });
  }

  function reportRemoteIssues(remote, cache, id, extraIssues = []){
    const details = remote.unavailableObjects.map(issue => {
      const { record, sign, message } = issue;
      const candidate = localRecoveryCandidate(cache, id, issue);
      return `«${sign.name}» (${sign.kind}), registro ${record.id}, client_id ${record.client_id}, ruta ${record.storage_path}: ${message}. ` +
        (candidate
          ? "Posible copia local completa coincidente; requiere revisión manual y autorización. No se puede verificar el contenido remoto."
          : "No se encontró una copia local completa coincidente; requiere recuperación manual.");
    });
    const unavailableMessages = new Set(remote.unavailableObjects.map(issue =>
      `Muestra ${issue.record.id} de «${issue.sign.name}»: Storage ${issue.record.storage_path}: ${issue.message}`));
    details.push(...remote.invalidReferences.filter(message => !unavailableMessages.has(message)));
    details.push(...extraIssues);
    setSyncIssues?.(details);
  }

  // Verify stored content before releasing a pending local capture for recognition.
  function mergeRemoteIntoState(remote, cache){
    const deleted = cache?.pendingDeletes || [];
    for (const [key, kind] of [["samples", "static"], ["motions", "motion"]]){
      const byId = new Map(state[key].map((sample, i) => [sample.syncId, i]));
      const updated = [...state[key]];
      for (const verified of remote[key]){
        if (deleted.some(item => item.kind === kind && item.name === verified.l)) continue;
        const index = byId.get(verified.syncId);
        if (index === undefined){
          byId.set(verified.syncId, updated.length);
          updated.push(verified);
          continue;
        }
        const local = updated[index];
        if (local.syncStatus !== "pending" || local.l !== verified.l) continue;
        try {
          const actual = remote.persistedPayloads.get(verified.syncId);
          if (actual && canonicalJson(prepareSamplePayload(local, kind).payload) === canonicalJson(actual)){
            updated[index] = verified;
          }
        } catch {
          // Keep the original local sample when the identity cannot be verified.
        }
      }
      state[key] = updated;
    }
  }

  function preserveCachedCaptures(cached, remote){
    const samples = [...(cached || [])];
    const ids = new Set(samples.map(sample => sample.syncId).filter(Boolean));
    for (const sample of remote){
      if (!ids.has(sample.syncId)){
        samples.push(sample);
        ids.add(sample.syncId);
      }
    }
    return samples;
  }

  async function loadUserLibrary(id){
    const previousOwner = userId;
    userId = id;
    const loadToken = ++userLoadToken;
    let cached, cacheReadError = null, cacheWriteError = null;
    try {
      cached = await readCache(id);
    } catch (error){
      cacheReadError = error;
      console.error("No se pudo leer la copia local; se intentará cargar la biblioteca remota.", error);
    }
    const initialRevision = cached?.revision;
    if (cached?.pending){
      ({ samples: state.samples, motions: state.motions } = restoreCachedLibrary(cached, id));
      state.ambiguityConfig = normalizeAmbiguityConfig(cached.ambiguity);
      ui.refreshAmbiguityControls();
      applySettings(cached.settings);
      setSyncStatus(pendingStatus(cached), "pending");
      renderList();
      void flushPending();
      return { samples: state.samples, motions: state.motions, settings: cached.settings, pending: true };
    }
    setSyncStatus("Cargando biblioteca…", "loading");
    try {
      const client = await getSupabaseClientImpl();
      const remote = await readRemoteLibrary(client, id);
      if (userId !== id || userLoadToken !== loadToken){
        return { samples: [], motions: [], cancelled: true };
      }
      const newerCache = cacheReadError ? null : await readCache(id);
      if (newerCache?.pending && newerCache.revision !== initialRevision){
        ({ samples: state.samples, motions: state.motions } = restoreCachedLibrary(newerCache, id));
        state.ambiguityConfig = normalizeAmbiguityConfig(newerCache.ambiguity);
        ui.refreshAmbiguityControls();
        applySettings(newerCache.settings);
        setSyncStatus(pendingStatus(newerCache), "pending");
        renderList();
        void flushPending();
        return { samples: state.samples, motions: state.motions, settings: newerCache.settings, pending: true };
      }
      if (cached){
        ({ samples: state.samples, motions: state.motions } = restoreCachedLibrary(cached, id));
        mergeRemoteIntoState(remote, cached);
      } else {
        state.samples = remote.samples;
        state.motions = remote.motions;
      }
      reportRemoteIssues(remote, cached, id);
      state.ambiguityConfig = normalizeAmbiguityConfig(cached?.ambiguity || DEFAULT_AMBIGUITY_CONFIG);
      ui.refreshAmbiguityControls();
      const effectiveSettings = remote.settings || cached?.settings;
      if (effectiveSettings) applySettings(effectiveSettings);
      if (!cacheReadError && !remote.invalidReferences.length){
        try {
          const stored = await withCacheWrite(async () => {
            const latest = await readCache(id);
            if ((latest?.revision ?? null) !== (initialRevision ?? null)) return false;
            const nextCache = {
            version: 1,
            samples: preserveCachedCaptures(latest?.samples, remote.samples),
            motions: preserveCachedCaptures(latest?.motions, remote.motions),
            ambiguity: state.ambiguityConfig,
            settings: effectiveSettings || readSettings(),
            settingsPending: cached?.settingsPending || false,
            pending: cached?.pending || false,
            pendingDeletes: cached?.pendingDeletes || [],
            revision: (latest?.revision || 0) + 1
            };
            await storeCache(nextCache, id);
            return nextCache;
          });
          if (!stored){
            const latest = await readCache(id);
            if (latest?.pending){
              ({ samples: state.samples, motions: state.motions } = restoreCachedLibrary(latest, id));
              state.ambiguityConfig = normalizeAmbiguityConfig(latest.ambiguity);
              applySettings(latest.settings);
              setSyncStatus(pendingStatus(latest), "pending");
              renderList();
              void flushPending();
              return { samples: state.samples, motions: state.motions, settings: latest.settings, pending: true };
            }
          }
        } catch (error){
          cacheWriteError = error;
          console.error("La biblioteca se cargó, pero no se pudo guardar su caché local.", error);
        }
      }
      if (remote.invalidReferences.length){
        setSyncStatus(
          `Biblioteca parcialmente disponible; ${remote.invalidReferences.length} referencia(s) remota(s) no disponibles o inválidas. Consulta los detalles; se conservaron los datos locales.` +
            (cacheReadError ? ` No se pudo comprobar la copia local: ${cacheReadError.message}` : ""),
          "error"
        );
      } else if (remote.settingsError){
        setSyncStatus(
          `Biblioteca disponible; no se pudieron cargar las preferencias de Supabase: ${remote.settingsError.message}`,
          "error"
        );
      } else if (cacheReadError){
        setSyncStatus(`Biblioteca disponible; no se pudo leer la copia local: ${cacheReadError.message}`, "error");
      } else if (cacheWriteError){
        setSyncStatus(`Biblioteca disponible; no se pudo actualizar la copia local: ${cacheWriteError.message}`, "error");
      } else if (!cached?.pending){
        setSyncStatus("Biblioteca sincronizada", "saved");
      }
      renderList();
      return { ...remote, settings: effectiveSettings };
    } catch (error){
      console.error("No se pudo cargar la biblioteca de Supabase.", error);
      if (userId !== id || userLoadToken !== loadToken){
        return { samples: [], motions: [], loadError: error, cancelled: true };
      }
      if (cached){
        ({ samples: state.samples, motions: state.motions } = restoreCachedLibrary(cached, id));
        state.ambiguityConfig = normalizeAmbiguityConfig(cached.ambiguity);
        ui.refreshAmbiguityControls();
        applySettings(cached.settings);
        setSyncStatus(`Error al cargar; se usa la copia local. ${error.message}`, "error");
      } else {
        state.samples = previousOwner === id
          ? state.samples : [];
        state.motions = previousOwner === id
          ? state.motions : [];
        setSyncStatus(
          `Error al cargar la biblioteca. Reintenta cuando vuelva la conexión. ${error.message}` +
          (cacheReadError ? ` No se pudo recuperar la copia local: ${cacheReadError.message}` : ""),
          "error"
        );
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
    if (existingIds.has(clientId)){
      throw new Error(`La captura ${clientId} ya existe, pero no se pudo verificar su contenido.`);
    }
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
      if (error) throw new Error(`Inserción de muestra en Supabase: ${error.message}`, { cause: error });
    } else {
      const path = `${id}/${clientId}.json`;
      const storage = client.storage.from(BUCKET);
      const { data: objectList, error: listError } = await storage.list(id, { search: `${clientId}.json`, limit: 10 });
      if (listError) throw new Error(`Consulta de Storage: ${listError.message}`, { cause: listError });
      if (objectList.some(object => object.name === `${clientId}.json`)){
        const { data: existingBlob, error } = await storage.download(path);
        if (error) throw new Error(`Descarga de Storage: ${error.message}`, { cause: error });
        let existingPayload;
        try {
          existingPayload = JSON.parse(await existingBlob.text());
        } catch (error){
          throw new Error(`El archivo existente ${path} no se puede validar y se conservará: ${error.message}`);
        }
        if (JSON.stringify(existingPayload) !== JSON.stringify(payload)){
          throw new Error(`Ya existe una captura diferente en ${path}; no se sobrescribió.`);
        }
      } else {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        const { error: uploadError } = await storage.upload(path, blob, { contentType: "application/json" });
        if (uploadError) throw new Error(`Subida a Storage: ${uploadError.message}`, { cause: uploadError });
      }
      const { error: insertError } = await client.from("sign_samples").insert({
        ...metadata, payload: null, storage_path: path
      });
      if (insertError){
        const { data: committed, error: verifyError } = await client.from("sign_samples")
          .select("sign_id,storage_path").eq("owner_id", id).eq("client_id", clientId).maybeSingle();
        if (verifyError){
          throw new Error(`No se pudo confirmar el registro después del error de inserción (${insertError.message}): ${verifyError.message}. El reintento verificará esta muestra antes de duplicarla.`);
        }
        if (committed?.storage_path === path && committed.sign_id === signIdValue){
          existingIds.add(clientId);
          return;
        }
        if (committed){
          throw new Error(`La captura ya existe con otra ruta de Storage (${insertError.message}); se conservaron ambos archivos y el reintento verificará el registro.`);
        }
        throw new Error(`No se pudo registrar la captura (${insertError.message}); se conservó el archivo ${path} para que el reintento no pierda los datos.`);
      }
    }
    existingIds.add(clientId);
  }

  function canonicalJson(value){
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? "null").join(",")}]`;
    if (value && typeof value === "object"){
      return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  async function checkpointSample(cache, id, kind, before, sample){
    const committed = await withCacheWrite(async () => {
      const latest = await readCache(id);
      if (!latest || latest.revision !== cache.revision) return false;
      const revision = (Number.isFinite(cache.revision) ? cache.revision : 0) + 1;
      await storeCache({ ...cache, revision }, id);
      cache.revision = revision;
      return true;
    });
    if (!committed) return false;
    if (userId === id){
      const key = kind === "static" ? "samples" : "motions";
      const previous = JSON.stringify(before);
      state[key] = state[key].map(item =>
        item.syncId === before.syncId && item.l === before.l &&
          JSON.stringify(item) === previous ? structuredClone(sample) : item);
      renderList();
    }
    return true;
  }

  async function syncRemote(cache, id){
    if (!id) throw new Error("No hay una cuenta activa.");
    const client = await getSupabaseClientImpl();
    // Always recover valid references before processing potentially failing deletes.
    const remote = await readRemoteLibrary(client, id);
    if (userId !== id) return false;
    const latest = await readCache(id);
    if (!latest || latest.revision !== cache.revision) return false;
    mergeRemoteIntoState(remote, latest);
    reportRemoteIssues(remote, latest, id);
    renderList();
    const deferredDeletes = [];
    const syncIssues = [];
    for (const removed of cache.pendingDeletes || []){
      try {
        await deleteRemoteSign(client, id, removed.name, removed.kind, removed.clientIds);
      } catch (error){
        deferredDeletes.push(removed);
        syncIssues.push(`Eliminación en espera de «${removed.name}» (${removed.kind}): ${error.message}`);
      }
    }
    const verifiedByClientId = new Map(
      [...remote.samples, ...remote.motions].map(sample => [sample.syncId, sample])
    );
    const { data: existingSigns, error: existingSignsError } = await client.from("signs")
      .select("id,name,kind,sign_language").eq("owner_id", id);
    if (existingSignsError) throw new Error(`Consulta de señas en Supabase: ${existingSignsError.message}`, { cause: existingSignsError });
    const signCache = existingSigns;
    const { data: existingSamples, error: existingSamplesError } = await client.from("sign_samples")
      .select("client_id").eq("owner_id", id);
    if (existingSamplesError) throw new Error(`Consulta de identificadores en Supabase: ${existingSamplesError.message}`, { cause: existingSamplesError });
    const existingIds = new Set(existingSamples.map(sample => sample.client_id));
    const unavailableIds = new Set(remote.unavailableObjects.map(({ record }) => record.client_id));
    let blocked = 0;
    const all = [
      ...cache.samples.map(sample => ({ sample, kind: "static" })),
      ...cache.motions.map(sample => ({ sample, kind: "motion" }))
    ].filter(({ sample }) => sample.syncStatus === "pending");
    for (const [index, { sample, kind }] of all.entries()){
      if (userId !== id) return false;
      if (userId === id) setSyncStatus(
        `Sincronizando muestra ${index + 1} de ${all.length}; ${pendingStatus(cache).replace(/^Pendiente: /, "")}…`,
        "loading"
      );
      let retrySnapshot = structuredClone(sample);
      try {
        const beforeId = structuredClone(sample);
        await ensureSampleId(sample);
        if (beforeId.syncId !== sample.syncId &&
            !await checkpointSample(cache, id, kind, beforeId, sample)) return false;
        retrySnapshot = structuredClone(sample);
        const remotelyConfirmed = verifiedByClientId.get(sample.syncId);
        if (remotelyConfirmed){
          const localPayload = prepareSamplePayload(sample, kind).payload;
          if (remotelyConfirmed.kind !== kind || remotelyConfirmed.l !== sample.l ||
              canonicalJson(remote.persistedPayloads.get(sample.syncId)) !== canonicalJson(localPayload)){
            throw new Error(`La captura ${sample.syncId} existe en Supabase, pero no coincide con la copia local; se conservaron ambos datos.`);
          }
        } else {
          if (existingIds.has(sample.syncId)){
            if (unavailableIds.has(sample.syncId)){
              blocked++;
              continue;
            }
            throw new Error(`La captura ${sample.syncId} existe en Supabase, pero su referencia no pudo validarse; se conservó la copia local.`);
          }
          const sign = { name: sample.l.trim(), kind, sign_language: sample.signLanguage || "LSC" };
          let signIdValue;
          try {
            signIdValue = await signId(client, id, sign, signCache);
          } catch (error){
            throw new Error(`Inserción de seña en Supabase: ${error.message}`, { cause: error });
          }
          await uploadSample(client, id, signIdValue, sample, kind, existingIds);
          verifiedByClientId.set(sample.syncId, { ...sample, kind });
          remote.persistedPayloads.set(sample.syncId, prepareSamplePayload(sample, kind).payload);
        }
        const beforeConfirmation = structuredClone(sample);
        sample.syncStatus = "saved";
        sample.verifiedUserId = id;
        if (!await checkpointSample(cache, id, kind, beforeConfirmation, sample)) return false;
      } catch (error){
        // An individual failure is not an instruction to abandon other captures.
        for (const key of Object.keys(sample)){
          if (!(key in retrySnapshot)) delete sample[key];
        }
        Object.assign(sample, retrySnapshot);
        sample.syncStatus = "pending";
        blocked++;
        if (syncIssues.length < 25){
          syncIssues.push(`Muestra ${index + 1} de ${all.length} («${sample.l}»): ${error.message}${errorDetails(error)}`);
        }
      }
    }
    if (cache.settingsPending){
      const latest = await readCache(id);
      if (latest?.revision !== cache.revision) return false;
    }
    if (cache.settingsPending){
      try {
        await writeRemoteSettings(client, cache.settings, id);
      } catch (error){
        throw new Error(`No se pudieron guardar las preferencias en Supabase: ${error.message}`);
      }
    }
    reportRemoteIssues(remote, cache, id, syncIssues);
    return { blocked, deferredDeletes, invalidReferences: remote.invalidReferences.length, syncIssues };
  }

  function pendingStatus(cache){
    const samples = [...(cache.samples || []), ...(cache.motions || [])];
    const pendingSamples = samples.filter(sample => sample.syncStatus === "pending").length;
    const preferences = cache.settingsPending ? "preferencias pendientes" : "";
    const deletions = cache.pendingDeletes?.length ? "eliminaciones pendientes" : "";
    const details = [
      pendingSamples ? `${pendingSamples} muestra(s) pendiente(s) de subida` : "",
      preferences,
      deletions
    ].filter(Boolean);
    return details.length ? `Pendiente: ${details.join(" · ")}` :
      "No hay operaciones de sincronización pendientes.";
  }

  function errorDetails(error){
    const details = [];
    for (let current = error; current; current = current.cause){
      for (const [label, value] of [["código", current.code], ["HTTP", current.status], ["detalle", current.details], ["pista", current.hint]]){
        if (value && !details.includes(`${label}: ${value}`)) details.push(`${label}: ${value}`);
      }
    }
    return details.length ? ` (${details.join("; ")})` : "";
  }

  async function flushPending(){
    if (syncPromise){
      syncRequested = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      let succeeded = true;
      let preferencesSynced = false;
      let lastSyncedUserId = null;
      let unresolvedReferences = 0;
      let unresolvedOperations = 0;
      let lastSyncIssues = [];
      let lastPendingStatus = "";
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
        if (userId === id) setSyncStatus(`Sincronizando: ${pendingStatus(cache).replace(/^Pendiente: /, "")}…`, "loading");
        try {
          const completed = await syncRemote(cache, id);
          if (!completed){
            syncRequested = true;
            continue;
          }
          const hadPendingSettings = Boolean(cache.settingsPending);
          const committed = await withCacheWrite(async () => {
            const latest = await readCache(id);
            if (!latest || latest.revision !== cache.revision) return false;
            // The remote write finished for this exact revision. Never commit a
            // stale snapshot over a capture, preference, or deletion queued later.
            const remaining = [...cache.samples, ...cache.motions].filter(sample => sample.syncStatus === "pending").length;
            if (remaining !== completed.blocked){
              throw new Error("Quedan muestras sin confirmar; se conserva la cola local.");
            }
            cache.pendingDeletes = completed.deferredDeletes;
            cache.pending = remaining > 0 || cache.pendingDeletes.length > 0;
            cache.settingsPending = false;
            cache.revision = (Number.isFinite(latest.revision) ? latest.revision : 0) + 1;
            await storeCache(cache, id);
            return true;
          });
          if (!committed){
            syncRequested = true;
            continue;
          }
          preferencesSynced ||= hadPendingSettings;
          lastSyncedUserId = id;
          unresolvedReferences = completed.invalidReferences;
          unresolvedOperations = completed.blocked + completed.deferredDeletes.length;
          lastSyncIssues = completed.syncIssues;
          lastPendingStatus = pendingStatus(cache);
        } catch (error){
          succeeded = false;
          console.error("La sincronización con Supabase falló.", error);
          let latest;
          try { latest = await readCache(id); } catch (storageError){
            console.error("No se pudo comprobar la cola local tras el error de red.", storageError);
          }
          if (userId === id) setSyncStatus(
            `Error de sincronización: ${error.message}${errorDetails(error)}. ${latest ? pendingStatus(latest) : "No se pudo comprobar la cola local."}`,
            "error"
          );
          break;
        }
      } while (syncRequested);
      if (succeeded && userId && userId === lastSyncedUserId){
        if (unresolvedReferences || unresolvedOperations){
          succeeded = false;
          setSyncStatus(
            `Biblioteca parcialmente disponible; ${unresolvedReferences} referencia(s) remota(s) no disponibles o inválidas; ${unresolvedOperations} operación(es) aún pendientes. ${lastPendingStatus}. ${lastSyncIssues[0] || ""} Consulta los detalles; las capturas se conservaron.`,
            "error"
          );
        } else {
          setSyncStatus(preferencesSynced
            ? "Biblioteca y preferencias sincronizadas"
            : "Biblioteca sincronizada en Supabase", "saved");
        }
      }
      return succeeded;
    })().finally(() => { syncPromise = null; });
    return syncPromise;
  }

  async function saveAll(){
    if (!userId) return false;
    try {
      await updatePendingCache(cache => {
        cache.samples = state.samples;
        cache.motions = state.motions;
        cache.filters = state.filterConfig;
        cache.ambiguity = state.ambiguityConfig;
        cache.settings = readSettings();
        cache.settingsPending = true;
      });
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
    try {
      await updatePendingCache(cache => {
        // Preference writes must never replace a newer capture or deletion queue.
        cache.filters = state.filterConfig;
        cache.ambiguity = state.ambiguityConfig;
        cache.settings = readSettings();
        cache.settingsPending = true;
      });
    } catch (error){
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      return false;
    }
    return flushPending();
  }

  async function retrySync(){
    if (!userId) return false;
    try {
      const cache = await readCache();
      if (cache?.pending) return flushPending();
      const result = await loadUserLibrary(userId);
      return !result.loadError && !result.invalidReferences?.length;
    } catch (error){
      setSyncStatus(`No se pudo reanudar la sincronización: ${error.message}`, "error");
      return false;
    }
  }

  async function deleteSign(name, kind){
    const kinds = kind === "all" ? ["s", "m"] : [kind];
    const removedByKind = new Map([
      ["s", kinds.includes("s") ? state.samples.filter(sample => sample.l === name) : []],
      ["m", kinds.includes("m") ? state.motions.filter(sample => sample.l === name) : []]
    ]);
    const clientIdsByKind = new Map(await Promise.all(
      [...removedByKind].map(async ([sampleKind, examples]) => [
        sampleKind, await Promise.all(examples.map(ensureSampleId))
      ])
    ));
    const nextSamples = kinds.includes("s")
      ? state.samples.filter(sample => sample.l !== name) : state.samples;
    const nextMotions = kinds.includes("m")
      ? state.motions.filter(sample => sample.l !== name) : state.motions;
    let cache;
    try {
      cache = await updatePendingCache(cache => {
        cache.samples = nextSamples;
        cache.motions = nextMotions;
        cache.pendingDeletes ||= [];
        for (const [sampleKind, clientIds] of clientIdsByKind){
          if (!clientIds.length) continue;
          const dbKind = sampleKind === "s" ? "static" : "motion";
          const queued = cache.pendingDeletes.find(item => item.name === name && item.kind === dbKind);
          if (queued) queued.clientIds = [...new Set([...(queued.clientIds || []), ...clientIds])];
          else cache.pendingDeletes.push({ name, kind: dbKind, clientIds });
        }
      });
    } catch (error){
      setSyncStatus(`No se pudo guardar la cola local: ${error.message}`, "error");
      throw error;
    }
    state.samples = cache.samples;
    state.motions = cache.motions;
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
      state.filterConfig = normalizeActiveFilterConfig(library.filters);
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
      static: state.samples.filter(sample => isSampleRecognizable(sample, userId)),
      motion: state.motions.filter(sample => isSampleRecognizable(sample, userId)),
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
      await updatePendingCache(cache => {
        cache.samples = [];
        cache.motions = [];
        cache.pendingDeletes = [...(cache.pendingDeletes || []), ...[...names.values()].map(({ name, kind, clientIds }) => ({
          name, kind: kind === "s" ? "static" : "motion", clientIds
        }))];
      });
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
      setSyncIssues?.([]);
      state.samples = [];
      state.motions = [];
      state.filterConfig = normalizeActiveFilterConfig(null);
      state.ambiguityConfig = normalizeAmbiguityConfig(DEFAULT_AMBIGUITY_CONFIG);
      $("tol").value = "0.8";
      $("tolM").value = "0.7";
      $("dur").value = "2";
      $("speechEnabled").checked = true;
      ui.refreshGeneralControls();
      ui.refreshAmbiguityControls();
    }
  };
}
