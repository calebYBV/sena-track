import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initAuth } from "../js/auth.js";
import { createAuthBootstrap } from "../js/authBootstrap.js";
import { createAppAuthHandlers } from "../js/appAuth.js";
import { createLazyCamera } from "../js/cameraLoader.js";

class FakeElement {
  constructor(id){
    this.id = id;
    this.textContent = "";
    this.value = "";
    this.style = { display: "" };
    this.hidden = false;
    this.disabled = false;
    this.type = id === "lfPass" ? "password" : "text";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      values: new Set(),
      add: name => this.classList.values.add(name),
      remove: name => this.classList.values.delete(name),
      contains: name => this.classList.values.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.values.has(name);
        if (enabled) this.classList.values.add(name);
        else this.classList.values.delete(name);
        return enabled;
      }
    };
  }

  addEventListener(type, handler){
    const listeners = this.listeners.get(type) || [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value){ this.attributes.set(name, value); }
  getAttribute(name){ return this.attributes.get(name) ?? null; }
  removeAttribute(name){ this.attributes.delete(name); }
  focus(){ this.focused = true; }
  querySelectorAll(){ return this.controls || []; }

  async trigger(type){
    const event = { preventDefault(){ this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
}

function installDom(){
  const ids = [
    "loginScreen", "app", "logoutBtn", "loginForm", "lfMsg", "lfPass",
    "lfToggle", "authSubmit", "lfSignup", "lfForgot", "recoveryForm",
    "recoveryPass", "loginTitle", "lfNameField", "lfName", "lfGoogle",
    "lfApple", "lfUser", "recoveryPassConfirm"
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  elements.get("app").style.display = "none";
  elements.get("lfPass").type = "password";
  elements.get("loginForm").controls = [
    elements.get("lfUser"), elements.get("lfName"), elements.get("lfPass"),
    elements.get("lfToggle"), elements.get("authSubmit")
  ];
  elements.get("recoveryForm").controls = [
    elements.get("recoveryPass"), elements.get("recoveryPassConfirm")
  ];
  globalThis.document = { getElementById: id => elements.get(id) };
  globalThis.location = {
    hash: "", origin: "https://sena-track.example", pathname: "/", search: ""
  };
  globalThis.history = { replaceState(){} };
  return elements;
}

function createSupabase({ session = null, signInResult, onSignIn, onSignOut } = {}){
  const calls = { signIn: [], signUp: [], reset: [], update: [], signOut: 0 };
  let authListener;
  const user = { id: "user-1", email: "person@example.com" };
  const auth = {
    onAuthStateChange(listener){ authListener = listener; },
    getSession: async () => ({ data: { session }, error: null }),
    signInWithPassword: async credentials => {
      calls.signIn.push(credentials);
      onSignIn?.();
      const result = signInResult || { data: { user, session: { user } }, error: null };
      if (!result.error && result.data?.user){
        authListener?.("SIGNED_IN", { user: result.data.user });
      }
      return result;
    },
    signUp: async payload => {
      calls.signUp.push(payload);
      return { data: { user, session: null }, error: null };
    },
    resetPasswordForEmail: async (...args) => {
      calls.reset.push(args);
      return { error: null };
    },
    updateUser: async payload => {
      calls.update.push(payload);
      return { data: { user }, error: null };
    },
    signOut: async () => {
      calls.signOut++;
      authListener?.("SIGNED_OUT", null);
      onSignOut?.();
      return { error: null };
    }
  };
  return { client: { auth }, calls, user };
}

function startAuth(elements, supabase, callbacks = {}){
  return initAuth({
    onAuthenticated: callbacks.onAuthenticated || (async () => {}),
    onSignedOut: callbacks.onSignedOut || (async () => {}),
    getSupabaseClientImpl: async () => supabase.client,
    isSupabaseConfiguredImpl: () => true,
    authRequestTimeoutMs: callbacks.authRequestTimeoutMs
  });
}

test("authentication stays usable when MediaPipe's module import fails", async () => {
  const elements = installDom();
  let cameraError;
  const camera = createLazyCamera({
    importModule: async () => { throw new Error("CDN unavailable"); },
    options: {},
    onUnavailable: error => { cameraError = error; }
  });
  let authenticatedUser;
  const supabase = createSupabase();
  await startAuth(elements, supabase, {
    onAuthenticated: async user => {
      authenticatedUser = user;
      await camera.start();
    }
  });
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  assert.equal(supabase.calls.signIn.length, 1);
  assert.equal(authenticatedUser.id, "user-1");
  assert.equal(elements.get("app").style.display, "");
  assert.equal(elements.get("loginScreen").classList.contains("hidden"), true);
  assert.match(cameraError.message, /CDN unavailable/);
});

test("a pending MediaPipe import cannot delay successful application access", async () => {
  const elements = installDom();
  const supabase = createSupabase();
  let resolveCameraModule;
  let cameraStarted = false;
  const camera = createLazyCamera({
    importModule: () => new Promise(resolve => { resolveCameraModule = resolve; }),
    options: {},
    onUnavailable: error => { throw error; }
  });
  const handlers = createAppAuthHandlers({
    state: { userId: null },
    camera,
    evaluationCapture: { clear(){} },
    storage: {
      clearUser(){},
      async loadUserLibrary(){ return { cancelled: false }; }
    },
    ui: {
      clearForUser(){},
      refreshFilterControls(){},
      setSyncStatus(){},
      refreshReferences(){}
    },
    training: { refreshButtons(){} },
    navigation: { current: () => "translator" }
  });
  await startAuth(elements, supabase, {
    onAuthenticated: user => handlers.onAuthenticated(user)
  });
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  assert.equal(elements.get("app").style.display, "");
  assert.equal(typeof resolveCameraModule, "function");
  resolveCameraModule({
    createCamera: () => ({
      async start(){ cameraStarted = true; },
      stop(){},
      resetFilters(){},
      resetFilterHistory(){}
    })
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cameraStarted, true);
});

test("leaving the translator cancels a camera start that is still importing MediaPipe", async () => {
  let resolveCameraModule;
  let cameraStarted = false;
  const camera = createLazyCamera({
    importModule: () => new Promise(resolve => { resolveCameraModule = resolve; }),
    options: {},
    onUnavailable: error => { throw error; }
  });
  const starting = camera.start();
  await new Promise(resolve => setImmediate(resolve));
  camera.stop();
  resolveCameraModule({
    createCamera: () => ({
      async start(){ cameraStarted = true; },
      stop(){},
      resetFilters(){},
      resetFilterHistory(){}
    })
  });
  assert.equal(await starting, false);
  assert.equal(cameraStarted, false);
});

test("MediaPipe import failures can be retried without creating duplicate cameras", async () => {
  let attempts = 0;
  let cameraCreations = 0;
  let cameraStarts = 0;
  let reportedError;
  const camera = createLazyCamera({
    importModule: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary CDN failure");
      return {
        createCamera: () => {
          cameraCreations++;
          return {
            async start(){ cameraStarts++; return true; },
            stop(){},
            resetFilters(){},
            resetFilterHistory(){}
          };
        }
      };
    },
    options: {},
    onUnavailable: error => { reportedError = error; }
  });
  assert.equal(await camera.start(), false);
  assert.match(reportedError.message, /temporary CDN failure/);
  assert.equal(await camera.start(), true);
  assert.equal(await camera.start(), true);
  assert.equal(attempts, 2);
  assert.equal(cameraCreations, 1);
  assert.equal(cameraStarts, 2);
});

test("a restored session opens the application and initializes its user once", async () => {
  const elements = installDom();
  const user = { id: "restored-user", email: "person@example.com" };
  const supabase = createSupabase({ session: { user } });
  const accepted = [];
  await startAuth(elements, supabase, {
    onAuthenticated: async value => accepted.push(value.id)
  });
  assert.deepEqual(accepted, ["restored-user"]);
  assert.equal(elements.get("app").style.display, "");
});

test("submitting credentials calls signInWithPassword and rejects invalid credentials visibly", async () => {
  const elements = installDom();
  const supabase = createSupabase({
    signInResult: { data: { user: null, session: null }, error: new Error("Invalid login credentials") }
  });
  await startAuth(elements, supabase);
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  assert.equal(supabase.calls.signIn.length, 1);
  assert.match(elements.get("lfMsg").textContent, /Invalid login credentials/);
  assert.equal(elements.get("lfMsg").classList.contains("error"), true);
  assert.equal(elements.get("app").style.display, "none");
});

test("the auth-state event and submit result do not initialize the same user twice", async () => {
  const elements = installDom();
  const supabase = createSupabase();
  let accepted = 0;
  await startAuth(elements, supabase, {
    onAuthenticated: async () => { accepted++; }
  });
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, 1);
});

test("signup and password recovery continue to use Supabase Auth", async () => {
  const elements = installDom();
  const supabase = createSupabase();
  await startAuth(elements, supabase);
  await elements.get("lfSignup").trigger("click");
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfName").value = "Person";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  assert.equal(supabase.calls.signUp.length, 1);
  assert.equal(supabase.calls.signUp[0].options.data.display_name, "Person");

  elements.get("lfUser").value = "person@example.com";
  await elements.get("lfForgot").trigger("click");
  assert.equal(supabase.calls.reset.length, 1);
  assert.equal(supabase.calls.reset[0][0], "person@example.com");
  assert.match(elements.get("lfMsg").textContent, /recuperar la contraseña/);
});

test("the password-recovery callback accepts and saves a new password", async () => {
  const elements = installDom();
  globalThis.location.hash = "#type=recovery";
  const supabase = createSupabase();
  await startAuth(elements, supabase);
  assert.equal(elements.get("loginForm").hidden, true);
  assert.equal(elements.get("recoveryForm").hidden, false);
  elements.get("recoveryPass").value = "another-not-real-password";
  elements.get("recoveryPassConfirm").value = "another-not-real-password";
  await elements.get("recoveryForm").trigger("submit");
  assert.equal(supabase.calls.update.length, 1);
  assert.equal(supabase.calls.update[0].password, "another-not-real-password");
  assert.equal(elements.get("recoveryForm").hidden, true);
});

test("signing out clears the authenticated view", async () => {
  const elements = installDom();
  let signedOut = 0;
  const supabase = createSupabase();
  await startAuth(elements, supabase, { onSignedOut: async () => { signedOut++; } });
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  await elements.get("logoutBtn").trigger("click");
  assert.equal(supabase.calls.signOut, 1);
  assert.equal(signedOut, 1);
  assert.equal(elements.get("app").style.display, "none");
  assert.equal(elements.get("loginScreen").classList.contains("hidden"), false);
});

test("Google and Apple are explicitly disabled when OAuth is not implemented", async () => {
  const elements = installDom();
  await startAuth(elements, createSupabase());
  for (const provider of ["Google", "Apple"]){
    const button = elements.get(`lf${provider}`);
    assert.equal(button.disabled, true);
    assert.match(button.title, /no está disponible/);
    assert.match(button.textContent, /No disponible/);
  }
});

test("bootstrap initializes auth once and defers application imports until sign-in", async () => {
  let authCallbacks;
  let authInitializations = 0;
  let appImports = 0;
  let authenticated = 0;
  let signedOut = 0;
  const bootstrap = createAuthBootstrap({
    initAuthImpl: callbacks => {
      authInitializations++;
      authCallbacks = callbacks;
    },
    importApp: async () => {
      appImports++;
      return {
        onAuthenticated: async () => { authenticated++; },
        onSignedOut: async () => { signedOut++; }
      };
    }
  });
  bootstrap.start();
  bootstrap.start();
  assert.equal(authInitializations, 1);
  assert.equal(appImports, 0);
  await authCallbacks.onAuthenticated({ id: "user-1" });
  await authCallbacks.onAuthenticated({ id: "user-1" });
  await authCallbacks.onSignedOut();
  assert.equal(appImports, 1);
  assert.equal(authenticated, 2);
  assert.equal(signedOut, 1);
});

test("sign-out invalidates authentication callbacks waiting for the app import", async () => {
  let authCallbacks;
  let resolveApp;
  let authenticated = 0;
  const bootstrap = createAuthBootstrap({
    initAuthImpl: callbacks => { authCallbacks = callbacks; },
    importApp: () => new Promise(resolve => { resolveApp = resolve; })
  });
  bootstrap.start();
  const pendingAuthentication = authCallbacks.onAuthenticated({ id: "stale-user" });
  await authCallbacks.onSignedOut();
  resolveApp({ onAuthenticated: async () => { authenticated++; } });
  await pendingAuthentication;
  assert.equal(authenticated, 0);
});

test("password recovery invalidates any pending authenticated app import", async () => {
  let authCallbacks;
  let resolveApp;
  let authenticated = 0;
  const bootstrap = createAuthBootstrap({
    initAuthImpl: callbacks => { authCallbacks = callbacks; },
    importApp: () => new Promise(resolve => { resolveApp = resolve; })
  });
  bootstrap.start();
  const pendingAuthentication = authCallbacks.onAuthenticated({ id: "old-session" });
  authCallbacks.onPasswordRecovery();
  resolveApp({ onAuthenticated: async () => { authenticated++; } });
  await pendingAuthentication;
  assert.equal(authenticated, 0);
});

test("rapid account changes authenticate only the newest user after app import", async () => {
  let authCallbacks;
  let resolveApp;
  const authenticatedUsers = [];
  let appImports = 0;
  const bootstrap = createAuthBootstrap({
    initAuthImpl: callbacks => { authCallbacks = callbacks; },
    importApp: () => {
      appImports++;
      return new Promise(resolve => { resolveApp = resolve; });
    }
  });
  bootstrap.start();
  const firstUser = authCallbacks.onAuthenticated({ id: "first-user" });
  const secondUser = authCallbacks.onAuthenticated({ id: "current-user" });
  resolveApp({ onAuthenticated: async user => authenticatedUsers.push(user.id) });
  await Promise.all([firstUser, secondUser]);
  assert.equal(appImports, 1);
  assert.deepEqual(authenticatedUsers, ["current-user"]);
});

test("the HTML entrypoint starts authentication without statically importing the app", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<script type="module" src="\.\/js\/authBootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script type="module" src="\.\/js\/app\.js"><\/script>/);
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /import\s*\{\s*createCamera\s*\}\s*from\s*["']\.\/camera\.js["']/);
  assert.match(app, /createLazyCamera/);
});

test("a failed Supabase connection is reported without exposing credentials", async () => {
  const elements = installDom();
  const pending = initAuth({
    onAuthenticated: async () => {},
    onSignedOut: async () => {},
    getSupabaseClientImpl: async () => { throw new Error("network unavailable"); },
    isSupabaseConfiguredImpl: () => true
  });
  await pending;
  assert.match(elements.get("lfMsg").textContent, /No se pudo conectar con el servicio de autenticación/);
  assert.doesNotMatch(elements.get("lfMsg").textContent, /password|token/i);
});

test("a stalled Supabase SDK load reports an error and does not leave controls busy", async () => {
  const elements = installDom();
  await initAuth({
    onAuthenticated: async () => {},
    onSignedOut: async () => {},
    getSupabaseClientImpl: () => new Promise(() => {}),
    isSupabaseConfiguredImpl: () => true,
    authRequestTimeoutMs: 5
  });
  assert.match(elements.get("lfMsg").textContent, /no respondió a tiempo/);
  assert.equal(elements.get("authSubmit").disabled, false);
  await elements.get("loginForm").trigger("submit");
  assert.match(elements.get("lfMsg").textContent, /recarga la página/);
});

test("a stalled sign-in request returns an actionable error and re-enables submit", async () => {
  const elements = installDom();
  const supabase = createSupabase();
  supabase.client.auth.signInWithPassword = () => new Promise(() => {});
  await startAuth(elements, supabase, { authRequestTimeoutMs: 5 });
  elements.get("lfUser").value = "person@example.com";
  elements.get("lfPass").value = "not-a-real-password";
  await elements.get("loginForm").trigger("submit");
  assert.match(elements.get("lfMsg").textContent, /no respondió a tiempo/);
  assert.equal(elements.get("authSubmit").disabled, false);
});

test("switching users clears the previous library before loading the next account", async () => {
  const state = { userId: "account-a", samples: ["private-a"], motions: [] };
  const operations = [];
  const handlers = createAppAuthHandlers({
    state,
    camera: { stop(){ operations.push("camera.stop"); }, async start(){} },
    evaluationCapture: { clear(){ operations.push("capture.clear"); } },
    storage: {
      clearUser(){
        operations.push("library.clear");
        state.samples = [];
        state.motions = [];
      },
      async loadUserLibrary(id){
        operations.push(`library.load:${id}`);
        assert.deepEqual(state.samples, []);
        return { cancelled: false };
      }
    },
    ui: {
      clearForUser(){ operations.push("ui.clear"); },
      refreshFilterControls(){},
      setSyncStatus(){},
      refreshReferences(){ operations.push("references.refresh"); }
    },
    training: { refreshButtons(){} },
    navigation: { current: () => "settings" }
  });
  await handlers.onAuthenticated({ id: "account-b" });
  assert.equal(state.userId, "account-b");
  assert.deepEqual(operations.slice(0, 4), [
    "camera.stop", "capture.clear", "library.clear", "ui.clear"
  ]);
  assert.ok(operations.indexOf("library.clear") < operations.indexOf("library.load:account-b"));
});

test("a stale library load cannot refresh a different active account", async () => {
  const state = { userId: "account-a" };
  let resolveLibrary;
  let refreshes = 0;
  const handlers = createAppAuthHandlers({
    state,
    camera: { stop(){}, async start(){ refreshes++; } },
    evaluationCapture: { clear(){} },
    storage: {
      clearUser(){},
      loadUserLibrary: () => new Promise(resolve => { resolveLibrary = resolve; })
    },
    ui: {
      clearForUser(){},
      refreshFilterControls(){},
      setSyncStatus(){},
      refreshReferences(){ refreshes++; }
    },
    training: { refreshButtons(){ refreshes++; } },
    navigation: { current: () => "translator" }
  });
  const loading = handlers.onAuthenticated({ id: "account-b" });
  state.userId = "account-c";
  resolveLibrary({ cancelled: false });
  await loading;
  assert.equal(refreshes, 0);
});
