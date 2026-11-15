export function createLazyCamera({
  options,
  onLoading,
  onUnavailable,
  onStartError,
  importModule = () => import("./camera.js")
}){
  let camera;
  let cameraPromise;
  let generation = 0;

  function load(){
    if (camera) return Promise.resolve(camera);
    if (!cameraPromise){
      onLoading?.();
      let pending;
      pending = Promise.resolve().then(importModule)
        .then(({ createCamera }) => createCamera(options))
        .then(instance => {
          camera = instance;
          return instance;
        })
        .catch(error => {
          if (cameraPromise === pending) cameraPromise = null;
          onUnavailable(error);
          return null;
        });
      cameraPromise = pending;
    }
    return cameraPromise;
  }

  return {
    async start(){
      const startGeneration = ++generation;
      const instance = await load();
      if (startGeneration !== generation) return false;
      if (!instance) return false;
      try {
        return await instance.start();
      } catch (error){
        onStartError?.(error);
        return false;
      }
    },
    stop(){
      generation++;
      camera?.stop();
    },
    resetFilters(){ camera?.resetFilters(); },
    resetFilterHistory(){ camera?.resetFilterHistory(); }
  };
}
