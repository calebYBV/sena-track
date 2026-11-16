import { validateSample } from "./sampleFormat.js";

export function isSampleRecognizable(sample){
  return sample?.syncStatus !== "pending" &&
    sample?.syncStatus !== "unverified" &&
    sample?.syncStatus !== "invalid";
}

export function restoreCachedSample(sample, kind){
  let syncStatus = sample?.syncStatus;
  try {
    validateSample(sample, kind);
  } catch (error){
    return {
      ...sample,
      syncStatus: syncStatus === "pending" ? "pending" : "invalid",
      syncIssue: error.message
    };
  }
  if (syncStatus === "pending" || syncStatus === "local") return sample;
  if (syncStatus === "saved") return { ...sample, syncStatus: "local" };
  if (typeof sample.syncId === "string" && sample.syncId.length){
    return { ...sample, syncStatus: "local" };
  }
  return { ...sample, syncStatus: "unverified" };
}
