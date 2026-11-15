async function loadCameraSafely({
  importModule = () => import("./camera.js"),
  options,
  onUnavailable
}){
  try {
    const { createCamera } = await importModule();
    return createCamera(options);
  } catch (error){
    onUnavailable(error);
    return {
      start: async () => false,
      stop: () => {},
      resetFilters: () => {},
      resetFilterHistory: () => {}
    };
  }
}

export function createLazyCamera({
  options,
  onLoading,
  onUnavailable,
  onStartError,
  importModule
}){
  let camera;
  let cameraPromise;
  let generation = 0;

  function load(){
    if (!cameraPromise){
      onLoading?.();
      cameraPromise = loadCameraSafely({
        options, onUnavailable, importModule
      }).then(instance => {
        camera = instance;
        return instance;
      });
    }
    return cameraPromise;
  }

  return {
    async start(){
      const startGeneration = ++generation;
      const instance = await load();
      if (startGeneration !== generation) return false;
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
