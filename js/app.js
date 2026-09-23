import { createUI } from "./ui.js";
import { createStorage } from "./storage.js";
import { createRecognition } from "./recognition.js";
import { createTraining } from "./training.js";
import { createCamera } from "./camera.js";
import { initAuth } from "./auth.js";

// Estado compartido, sin variables globales en window.
const state = {
  samples: [], motions: [], phrase: "", capState: null, motion: null,
  readoutLock: 0, cand: null, candCount: 0, committed: null, noHand: 0,
  ready: false
};
const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("canvas"), ctx = canvas.getContext("2d");
const statusEl = $("status"), signEl = $("sign"), metaEl = $("meta"), holdBar = $("holdBar");
const phraseEl = $("phrase"), listEl = $("list"), trainBar = $("trainBar"), noteEl = $("note");
const countEl = $("count"), bannerEl = $("banner"), bannerText = $("bannerText"), bannerBar = $("bannerBar");


const dom = { $, video, canvas, ctx, statusEl, signEl, metaEl, holdBar,
  phraseEl, listEl, trainBar, noteEl, countEl, bannerEl, bannerText, bannerBar };
const ui = createUI({ state, dom, saveAll: () => storage.saveAll() });
const storage = createStorage({ state, dom, ui });
const saved = storage.loadAll();
state.samples = saved.s;
state.motions = saved.m;
const recognition = createRecognition({ state, dom });
const training = createTraining({ state, dom, ui, storage, recognition });
const camera = createCamera({ state, dom, ui, training, recognition });
training.refreshButtons();
initAuth(camera.start);
