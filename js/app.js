import { createUI } from "./ui.js";
import { createStorage } from "./storage.js";
import { createRecognition } from "./recognition.js";
import { createTraining } from "./training.js";
import { createCamera } from "./camera.js";
import { initAuth } from "./auth.js";
import { DEFAULT_FILTER_CONFIG, normalizeFilterConfig } from "./filters.js";
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
  recognitionMode: "edo", recognitionGeneration: 0,
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
state.filterConfig = normalizeFilterConfig(null);
const recognition = createRecognition({ state, dom });
ui.refreshReferences();
ui.refreshFilterControls();
const training = createTraining({ state, dom, ui, storage, recognition });
const camera = createCamera({ state, dom, ui, training, recognition });
state.onRecognitionModeChange = () => {
  training.resetRecognitionMode();
  camera.resetRecognitionMode();
};
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
  camera.resetFilters();
  recognition.prepareFilteredReferences(state.filterConfig);
};
state.onRecordingStart = camera.resetFilterHistory;
training.refreshButtons();
initAuth({
  onAuthenticated: async user => {
    if (state.userId && state.userId !== user.id){
      camera.stop();
      storage.clearUser();
      ui.clearForUser();
      ui.refreshFilterControls();
    }
    state.userId = user.id;
    ui.setSyncStatus("Cargando biblioteca…", "loading");
    const loaded = await storage.loadUserLibrary(user.id);
    if (loaded.cancelled || state.userId !== user.id) return;
    ui.refreshReferences();
    ui.refreshFilterControls();
    training.refreshButtons();
    if (navigation.current() === "translator") await camera.start();
  },
  onSignedOut: async () => {
    camera.stop();
    storage.clearUser();
    state.userId = null;
    ui.clearForUser();
    ui.refreshFilterControls();
    training.refreshButtons();
    ui.setSyncStatus("Inicia sesión para sincronizar tu biblioteca.", "saved");
  }
});
