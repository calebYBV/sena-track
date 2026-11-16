import { validateSample } from "./sampleFormat.js";

const RECOGNIZABLE_STATUSES = new Set(["saved", "local"]);
const VALID_SYNC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSampleRecognizable(sample){
  return Boolean(sample && RECOGNIZABLE_STATUSES.has(sample.syncStatus));
}

export function restoreCachedSample(sample, kind){
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
  // Only previously confirmed, account-scoped cache entries can be used offline.
  // An arbitrary syncId by itself is not proof of a successful upload.
  const confirmed = RECOGNIZABLE_STATUSES.has(originalStatus) &&
    typeof sample.syncId === "string" && VALID_SYNC_ID.test(sample.syncId);
  if (confirmed){
    return { ...sample, syncStatus: "local", syncIssue: undefined };
  }
  return {
    ...sample,
    syncStatus: "unverified",
    syncIssue: "No se pudo confirmar que esta captura local estuviera guardada en la cuenta."
  };
}
