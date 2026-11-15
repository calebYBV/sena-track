import { initAuth } from "./auth.js";

export function createAuthBootstrap({
  initAuthImpl = initAuth,
  importApp = () => import("./app.js")
} = {}){
  let started = false;
  let appPromise = null;
  let appModule = null;
  let authGeneration = 0;

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
          const generation = ++authGeneration;
          const app = await loadApp();
          if (generation !== authGeneration) return;
          await app.onAuthenticated(user);
        },
        onSignedOut: async () => {
          authGeneration++;
          await appModule?.onSignedOut?.();
        },
        onPasswordRecovery: () => {
          authGeneration++;
        }
      });
    }
  };
}

if (typeof document !== "undefined") createAuthBootstrap().start();
