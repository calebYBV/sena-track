import { createUI } from "./ui.js";
import { createStorage } from "./storage.js";
import { createRecognition } from "./recognition.js";
import { createTraining } from "./training.js";
import { createCamera } from "./camera.js";
import { initAuth } from "./auth.js";
import { DEFAULT_FILTER_CONFIG, normalizeFilterConfig } from "./filters.js";

// Estado compartido, sin variables globales en window.
const state = {
  samples: [], motions: [], phrase: "", capState: null, motion: null,
  readoutLock: 0, cand: null, candCount: 0, committed: null, noHand: 0,
  ready: false, userId: null, filterConfig: { ...DEFAULT_FILTER_CONFIG }
};
const $ = id => document.getElementById(id);
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
state.onFilterChange = () => {
  ui.refreshFilterControls();
  camera.resetFilters();
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
    await camera.start();
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
