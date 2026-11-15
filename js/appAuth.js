export function createAppAuthHandlers({
  state,
  camera,
  evaluationCapture,
  storage,
  ui,
  training,
  navigation
}){
  return {
    async onAuthenticated(user){
      if (state.userId && state.userId !== user.id){
        camera.stop();
        evaluationCapture.clear();
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
      if (navigation.current() === "translator"){
        void camera.start().catch(error => {
          console.error("No se pudo iniciar la cámara y el reconocimiento.", error);
          ui.setSyncStatus(`No fue posible iniciar la cámara: ${error.message}`, "error");
        });
      }
    },
    async onSignedOut(){
      camera.stop();
      evaluationCapture.clear();
      storage.clearUser();
      state.userId = null;
      ui.clearForUser();
      ui.refreshFilterControls();
      training.refreshButtons();
      ui.setSyncStatus("Inicia sesión para sincronizar tu biblioteca.", "saved");
    }
  };
}
