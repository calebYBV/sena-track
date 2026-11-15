import { createUI } from "./ui.js";
import { createStorage } from "./storage.js";
import { createRecognition } from "./recognition.js";
import { createTraining } from "./training.js";
import { createEvaluationCapture } from "./evaluationCapture.js";
import { createLazyCamera } from "./cameraLoader.js";
import { createAppAuthHandlers } from "./appAuth.js";
import { DEFAULT_FILTER_CONFIG, normalizeActiveFilterConfig } from "./filters.js";
import { DEFAULT_AMBIGUITY_CONFIG, normalizeAmbiguityConfig } from "./recognition.js";
import {
  activateAppView,
  mountEdoContents,
  resolveAppView
} from "./navigation.js";

// Estado compartido, sin variables globales en window.
const state = {
  samples: [], motions: [], phrase: "", capState: null, motion: null,
  readoutLock: 0, cand: null, candCount: 0, candSince: null,
  committed: null, noHand: 0, noHandSince: null, neutralSince: null,
  ready: false, userId: null, filterConfig: { ...DEFAULT_FILTER_CONFIG },
  recognitionGeneration: 0,
  ambiguityConfig: normalizeAmbiguityConfig(DEFAULT_AMBIGUITY_CONFIG),
  recognitionEnabled: false,
  recognitionTimers: new Set(),
  lastRecognitionLabel: null,
  lastRecognitionAt: 0
};
const $ = id => document.getElementById(id);
mountEdoContents(document);
const video = $("video"), canvas = $("canvas"), ctx = canvas.getContext("2d");
const statusEl = $("status"), signEl = $("sign"), metaEl = $("meta"), holdBar = $("holdBar");
const phraseEl = $("phrase"), listEl = $("list"), trainBar = $("trainBar"), noteEl = $("note");
const countEl = $("count"), bannerEl = $("banner"), bannerText = $("bannerText"), bannerBar = $("bannerBar");


const dom = { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar,
  phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar };
let storage;
const ui = createUI({
  state, dom,
  savePreferences: () => storage.savePreferences(),
  deleteSign: (name, kind) => storage.deleteSign(name, kind)
});
storage = createStorage({ state, dom, ui });
storage.loadAll();
state.filterConfig = normalizeActiveFilterConfig(state.filterConfig);
const recognition = createRecognition({ state, dom });
ui.refreshReferences();
ui.refreshFilterControls();
const training = createTraining({ state, dom, ui, storage, recognition });
const evaluationCapture = createEvaluationCapture({
  state,
  dom,
  recognition,
  onUpdate: ({ message, counts, recording }) => {
    $("evalCaptureStatus").textContent =
      `Capturas: entrenamiento ${counts.training} · validación ${counts.validation} · prueba ${counts.test}. ${message}`;
    $("evalCaptureStart").disabled = recording;
    $("evalCaptureCancel").disabled = !recording;
    for (const id of ["evalTruth", "evalKind", "evalSplit", "evalDuration",
      "evalParticipant", "evalSession"]){
      $(id).disabled = recording;
    }
  }
});
state.evaluationCapture = evaluationCapture;
const camera = createLazyCamera({
  options: { state, dom, ui, training, recognition, evaluationCapture },
  onLoading: () => {
    statusEl.className = "status";
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Cargando módulo de cámara y reconocimiento…";
    $("cameraIndicatorText").textContent = "Cargando reconocimiento";
  },
  onUnavailable: error => {
    console.error("No se pudo cargar el módulo de cámara y reconocimiento.", error);
    statusEl.className = "status error";
    statusEl.classList.remove("hidden");
    statusEl.textContent =
      `No se pudo cargar el módulo de reconocimiento (MediaPipe): ${error.message}. Puedes seguir usando tu cuenta y biblioteca.`;
    $("cameraIndicator").classList.add("has-error");
    $("cameraIndicatorText").textContent = "Reconocimiento no disponible";
  },
  onStartError: error => {
    console.error("No se pudo iniciar la cámara y el reconocimiento.", error);
    statusEl.className = "status error";
    statusEl.classList.remove("hidden");
    statusEl.textContent =
      `No fue posible iniciar la cámara: ${error.message}. Puedes seguir usando tu cuenta y biblioteca.`;
    $("cameraIndicator").classList.add("has-error");
    $("cameraIndicatorText").textContent = "Cámara no disponible";
  }
});
function initializeNavigation(){
  const panels = [...document.querySelectorAll("[data-view-panel]")];
  const links = [...document.querySelectorAll(".quick-links [data-view]")];
  let currentView = null;
  const navigate = (view, focus = false) => {
    if (window.location.hash === "#edo"){
      window.history.replaceState(window.history.state, "", "#settings");
    }
    if (view === currentView) return;
    const previousView = currentView;
    currentView = view;
    activateAppView(panels, links, view);
    if (previousView === "translator" && view !== "translator"){
      state.recognitionEnabled = false;
      camera.stop();
      training.refreshButtons();
    } else if (previousView && view === "translator" && state.userId){
      void camera.start();
    }
    if (focus){
      document.querySelector(`[data-view-panel="${view}"] h1`)?.focus();
    }
  };
  window.addEventListener("hashchange", () => {
    navigate(resolveAppView(window.location.hash), true);
  });
  navigate(resolveAppView(window.location.hash));
  return { current: () => currentView };
}
const navigation = initializeNavigation();
state.onFilterChange = () => {
  ui.refreshFilterControls();
  training.resetForFilterChange();
  camera.resetFilters();
  recognition.prepareFilteredReferences(state.filterConfig);
  ui.updateComparison({
    detected: false,
    reason: "Filtro cambiado; regenerando referencias compatibles desde las capturas raw."
  });
};
state.onRecordingStart = camera.resetFilterHistory;
training.refreshButtons();

const authHandlers = createAppAuthHandlers({
  state, camera, evaluationCapture, storage, ui, training, navigation
});
export const onAuthenticated = authHandlers.onAuthenticated;
export const onSignedOut = authHandlers.onSignedOut;
