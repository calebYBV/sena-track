import { validateSample } from "./sampleFormat.js";

const RECOGNIZABLE_STATUSES = new Set(["saved", "local"]);
const VALID_SYNC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSampleRecognizable(sample, ownerId){
  if (!sample || !RECOGNIZABLE_STATUSES.has(sample.syncStatus)) return false;
  if (ownerId == null) return true;
  return sample.verifiedUserId === ownerId &&
    typeof sample.syncId === "string" && VALID_SYNC_ID.test(sample.syncId);
}

export function restoreCachedSample(sample, kind, {
  ownerId,
  cacheUserId
} = {}){
  const originalStatus = sample?.syncStatus;
  try {
    validateSample(sample, kind);
  } catch (error){
    return {
      ...sample,
      syncStatus: "invalid",
      syncIssue: error.message
    };
  }
  if (originalStatus === "pending"){
    return { ...sample, syncStatus: "pending" };
  }
  const accountVerified = ownerId == null ||
    (sample.verifiedUserId === ownerId || cacheUserId === ownerId);
  const confirmed = RECOGNIZABLE_STATUSES.has(originalStatus) && accountVerified &&
    typeof sample.syncId === "string" && VALID_SYNC_ID.test(sample.syncId);
  if (confirmed){
    return {
      ...sample,
      syncStatus: "local",
      ...(ownerId == null ? {} : { verifiedUserId: ownerId }),
      syncIssue: undefined
    };
  }
  return {
    ...sample,
    syncStatus: "unverified",
    syncIssue: "No se pudo confirmar que esta captura local estuviera guardada en la cuenta."
  };
}
