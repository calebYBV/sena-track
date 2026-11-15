import { initAuth } from "./auth.js";

export function createAuthBootstrap({
  initAuthImpl = initAuth,
  importApp = () => import("./app.js")
} = {}){
  let started = false;
  let appPromise = null;
  let appModule = null;

  function loadApp(){
    if (!appPromise){
      appPromise = importApp().then(module => {
        appModule = module;
        return module;
      }).catch(error => {
        appPromise = null;
        throw error;
      });
    }
    return appPromise;
  }

  return {
    start(){
      if (started) return;
      started = true;
      initAuthImpl({
        onAuthenticated: async user => {
          const app = await loadApp();
          await app.onAuthenticated(user);
        },
        onSignedOut: async () => {
          await appModule?.onSignedOut?.();
        }
      });
    }
  };
}

if (typeof document !== "undefined") createAuthBootstrap().start();
