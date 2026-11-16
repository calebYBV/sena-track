const UNDEFINED_KEY = "__sena_track_backup_undefined__";

function checkSnapshot(value, ancestors = new Set()){
  if (!value || typeof value !== "object") return;
  if (ancestors.has(value)) throw new TypeError("La copia contiene una referencia circular que no se puede respaldar.");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null){
    throw new TypeError("La copia contiene objetos que no se pueden respaldar sin pérdida.");
  }
  if (Object.getOwnPropertySymbols(value).length ||
      Array.isArray(value) && Object.keys(value).length !== value.length){
    throw new TypeError("La copia contiene datos que no se pueden respaldar sin pérdida.");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) checkSnapshot(child, ancestors);
  ancestors.delete(value);
}

function encodeSnapshot(snapshot){
  checkSnapshot(snapshot);
  return JSON.stringify(snapshot, (key, value) => {
    if (value === undefined) return { [UNDEFINED_KEY]: "undefined" };
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))){
      return { [UNDEFINED_KEY]: Object.is(value, -0) ? "-0" : String(value) };
    }
    if (typeof value === "bigint") return { [UNDEFINED_KEY]: `bigint:${value}` };
    if (typeof value === "function" || typeof value === "symbol"){
      throw new TypeError("La copia contiene datos que no se pueden respaldar sin pérdida.");
    }
    if (value && typeof value === "object" && !Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null){
      throw new TypeError("La copia contiene objetos que no se pueden respaldar sin pérdida.");
    }
    if (value && typeof value === "object" && Object.hasOwn(value, UNDEFINED_KEY)){
      throw new TypeError("La copia contiene una clave reservada para el respaldo.");
    }
    return value;
  });
}

function decodeSnapshot(value){
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, UNDEFINED_KEY)){
    const tag = value[UNDEFINED_KEY];
    if (tag === "undefined") return undefined;
    if (tag === "NaN") return NaN;
    if (tag === "Infinity") return Infinity;
    if (tag === "-Infinity") return -Infinity;
    if (tag === "-0") return -0;
    if (typeof tag === "string" && /^bigint:-?\d+$/.test(tag)) return BigInt(tag.slice(7));
    throw new Error("El respaldo contiene un valor codificado desconocido.");
  }
  for (const key of Object.keys(value)) value[key] = decodeSnapshot(value[key]);
  return value;
}

async function digest(text){
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function counts(cache){
  const result = Object.create(null);
  for (const sample of [...cache.samples, ...cache.motions]){
    const status = typeof sample?.syncStatus === "string" ? sample.syncStatus : "(sin estado)";
    result[status] = (result[status] || 0) + 1;
  }
  return result;
}

export async function createSampleBackup(cache, ownerId){
  if (!ownerId || cache?.userId !== ownerId ||
      !Array.isArray(cache.samples) || !Array.isArray(cache.motions)){
    throw new Error("No se pudo verificar la copia local de la cuenta autenticada.");
  }
  const snapshot = encodeSnapshot(cache);
  return {
    type: "sena-track-account-backup",
    version: 1,
    ownerId,
    createdAt: new Date().toISOString(),
    counts: counts(cache),
    sha256: await digest(snapshot),
    snapshot
  };
}

export async function readSampleBackup(backup, ownerId){
  if (backup?.type !== "sena-track-account-backup" || backup.version !== 1 ||
      !ownerId || backup.ownerId !== ownerId || typeof backup.snapshot !== "string"){
    throw new Error("El respaldo no es válido o pertenece a otra cuenta.");
  }
  if (await digest(backup.snapshot) !== backup.sha256){
    throw new Error("El respaldo no superó la comprobación SHA-256.");
  }
  let encoded;
  try { encoded = JSON.parse(backup.snapshot); }
  catch { throw new Error("El contenido del respaldo no es JSON válido."); }
  const cache = decodeSnapshot(encoded);
  if (cache?.userId !== ownerId || !Array.isArray(cache.samples) || !Array.isArray(cache.motions) ||
      JSON.stringify(counts(cache)) !== JSON.stringify(backup.counts)){
    throw new Error("El contenido o el resumen del respaldo no coincide.");
  }
  return cache;
}

function comparable(sample, ignoreId = false){
  const { syncStatus, verifiedUserId, syncIssue, ...content } = sample;
  if (ignoreId) delete content.syncId;
  return encodeSnapshot(content);
}

export function mergeLocalCaptures(cache, current){
  const result = {};
  for (const key of ["samples", "motions"]){
    const merged = [...cache[key]];
    const matched = new Set();
    for (const sample of current[key]){
      const index = merged.findIndex((existing, i) => {
        if (matched.has(i)) return false;
        if (sample.verifiedUserId && existing.verifiedUserId &&
            sample.verifiedUserId !== existing.verifiedUserId) return false;
        if (sample.syncId && existing.syncId && sample.syncId !== existing.syncId) return false;
        if (sample.captureId && existing.captureId && sample.captureId !== existing.captureId) return false;
        return comparable(existing, !sample.syncId || !existing.syncId) ===
          comparable(sample, !sample.syncId || !existing.syncId);
      });
      if (index >= 0) matched.add(index);
      else {
        const added = structuredClone(sample);
        merged.push(added);
        matched.add(merged.length - 1);
      }
    }
    result[key] = merged;
  }
  return result;
}

export function mergeBackupCaptures(cache, backup, { onAdd = sample => sample } = {}){
  const result = { samples: [...cache.samples], motions: [...cache.motions] };
  let added = 0;
  for (const [key, kind] of [["samples", "static"], ["motions", "motion"]]){
    const matchedAnonymous = new Set();
    for (const sample of backup[key]){
      if (!sample || typeof sample !== "object") throw new Error("El respaldo contiene una captura no recuperable automáticamente.");
      const other = result[key === "samples" ? "motions" : "samples"];
      if (other.some(existing => sample.syncId && existing?.syncId === sample.syncId ||
          sample.captureId && existing?.captureId === sample.captureId)){
        throw new Error("El identificador del respaldo ya pertenece a otro tipo de captura; no se modificó la cola.");
      }
      if ((cache.pendingDeletes || []).some(item => item.kind === kind && item.name === sample.l)){
        throw new Error("Hay una eliminación pendiente para una seña del respaldo; resuélvela antes de restaurar.");
      }
      const anonymous = !sample.syncId && !sample.captureId;
      const match = result[key].find(existing =>
        sample.syncId && existing.syncId === sample.syncId ||
        sample.captureId && existing.captureId === sample.captureId ||
        anonymous && !matchedAnonymous.has(existing) &&
          comparable(existing, true) === comparable(sample, true));
      if (match){
        if (sample.verifiedUserId && match.verifiedUserId &&
              sample.verifiedUserId !== match.verifiedUserId ||
            comparable(match, anonymous) !== comparable(sample, anonymous)){
          throw new Error("Una captura del respaldo tiene el mismo identificador que otra con contenido diferente; no se modificó la cola.");
        }
        if (anonymous) matchedAnonymous.add(match);
        continue;
      }
      const restored = onAdd(structuredClone(sample));
      result[key].push(restored);
      if (anonymous) matchedAnonymous.add(restored);
      added++;
    }
  }
  return { ...result, added };
}
