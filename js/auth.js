import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";

export function initAuth({ onAuthenticated, onSignedOut, onPasswordRecovery }){
  const loginScreen = document.getElementById("loginScreen");
  const appEl = document.getElementById("app");
  const logoutBtn = document.getElementById("logoutBtn");
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("lfMsg");
  const password = document.getElementById("lfPass");
  const toggle = document.getElementById("lfToggle");
  const submit = document.getElementById("authSubmit");
  const signupLink = document.getElementById("lfSignup");
  const forgotLink = document.getElementById("lfForgot");
  const recoveryForm = document.getElementById("recoveryForm");
  const recoveryPassword = document.getElementById("recoveryPass");
  let supabase;
  let mode = "signin";
  let currentUserId = null;
  let handlingUser = null;
  let recoveryMode = false;
  let clearPromise = null;
  let authGeneration = 0;
  recoveryMode = new URLSearchParams(location.hash.slice(1)).get("type") === "recovery";

  const showMessage = (text, error = false) => {
    msg.textContent = text;
    msg.classList.toggle("error", error);
  };
  const setBusy = busy => {
    for (const control of form.querySelectorAll("input, button")){
      control.disabled = busy;
    }
    signupLink.setAttribute("aria-disabled", String(busy));
    forgotLink.setAttribute("aria-disabled", String(busy));
  };
  const setMode = next => {
    mode = next;
    const signup = mode === "signup";
    document.getElementById("loginTitle").textContent = signup ? "Crear cuenta" : "Iniciar sesión";
    document.getElementById("lfNameField").hidden = !signup;
    document.getElementById("lfName").required = signup;
    password.autocomplete = signup ? "new-password" : "current-password";
    submit.textContent = signup ? "Registrarme" : "Ingresar";
    signupLink.textContent = signup ? "Ya tengo una cuenta" : "Crear una cuenta";
    showMessage("");
  };

  async function acceptUser(user){
    if (!user || recoveryMode || handlingUser === user.id) return;
    if (currentUserId === user.id && appEl.style.display !== "none") return;
    const generation = ++authGeneration;
    handlingUser = user.id;
    loginScreen.classList.add("hidden");
    appEl.style.display = "";
    logoutBtn.classList.remove("hidden");
    try {
      await onAuthenticated(user);
      if (generation !== authGeneration) return;
      currentUserId = user.id;
    } catch (error){
      if (generation !== authGeneration) return;
      showMessage(`No se pudo preparar la sesión: ${error.message}`, true);
      appEl.style.display = "none";
      loginScreen.classList.remove("hidden");
      logoutBtn.classList.add("hidden");
    } finally {
      if (generation === authGeneration) handlingUser = null;
    }
  }

  function clearSession(){
    if (clearPromise) return clearPromise;
    clearPromise = (async () => {
      authGeneration++;
      recoveryMode = false;
      currentUserId = null;
      handlingUser = null;
      await onSignedOut();
      appEl.style.display = "none";
      loginScreen.classList.remove("hidden");
      logoutBtn.classList.add("hidden");
      recoveryForm.hidden = true;
      form.hidden = false;
      showMessage("Sesión cerrada.");
    })().finally(() => { clearPromise = null; });
    return clearPromise;
  }

  for (const provider of ["Google", "Apple"]){
    const button = document.getElementById(`lf${provider}`);
    button.disabled = true;
    button.title = `${provider} no está disponible; el flujo OAuth todavía no está integrado.`;
    button.textContent = `Continuar con ${provider} · No disponible`;
  }

  if (!isSupabaseConfigured()){
    showMessage("Configura la URL del proyecto y la clave publishable en js/supabaseConfig.js para activar la autenticación.", true);
    setBusy(true);
    for (const provider of ["Google", "Apple"]){
      document.getElementById(`lf${provider}`).disabled = true;
    }
  } else {
    setBusy(true);
    if (recoveryMode){
      form.hidden = true;
      recoveryForm.hidden = false;
      showMessage("Elige una contraseña nueva para completar la recuperación.");
    } else showMessage("Conectando con Supabase…");
    void (async () => {
      try {
        supabase = await getSupabaseClient();
        supabase.auth.onAuthStateChange((event, session) => {
          if (event === "PASSWORD_RECOVERY"){
            recoveryMode = true;
            form.hidden = true;
            recoveryForm.hidden = false;
            showMessage("Elige una contraseña nueva para completar la recuperación.");
            onPasswordRecovery?.();
            return;
          }
          if (event === "SIGNED_OUT"){
            void clearSession();
            return;
          }
          if (session?.user && !recoveryMode) void acceptUser(session.user);
        });
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (data.session?.user) await acceptUser(data.session.user);
        else if (!recoveryMode) showMessage("Ingresa con tu correo y contraseña.");
        setBusy(false);
      } catch (error){
        showMessage(`No se pudo inicializar Supabase Auth: ${error.message}`, true);
        setBusy(false);
      }
    })();
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!supabase){
      showMessage("Supabase Auth no está disponible. Recarga la página e inténtalo de nuevo.", true);
      return;
    }
    const email = document.getElementById("lfUser").value.trim();
    const passwordValue = password.value;
    if (!email || !passwordValue){
      showMessage("Completa el correo y la contraseña.", true);
      return;
    }
    setBusy(true);
    showMessage(mode === "signup" ? "Creando cuenta…" : "Iniciando sesión…");
    try {
      let result;
      if (mode === "signup"){
        const displayName = document.getElementById("lfName").value.trim();
        result = await supabase.auth.signUp({
          email,
          password: passwordValue,
          options: {
            data: { display_name: displayName },
            emailRedirectTo: `${location.origin}${location.pathname}`
          }
        });
        if (result.error) throw result.error;
        if (!result.data.session){
          showMessage("Cuenta creada. Revisa tu correo y confirma la dirección antes de iniciar sesión.");
        } else showMessage("Cuenta creada. Cargando tu biblioteca…");
      } else {
        result = await supabase.auth.signInWithPassword({ email, password: passwordValue });
        if (result.error) throw result.error;
        showMessage("Acceso correcto. Cargando tu biblioteca…");
        if (result.data.user) await acceptUser(result.data.user);
      }
    } catch (error){
      showMessage(error.message || "No se pudo completar la autenticación.", true);
    } finally {
      setBusy(false);
    }
  });

  signupLink.addEventListener("click", event => {
    event.preventDefault();
    if (signupLink.getAttribute("aria-disabled") === "true") return;
    setMode(mode === "signup" ? "signin" : "signup");
  });

  forgotLink.addEventListener("click", async event => {
    event.preventDefault();
    if (!supabase) return;
    const email = document.getElementById("lfUser").value.trim();
    if (!email){
      showMessage("Escribe tu correo para enviarte el enlace de recuperación.", true);
      document.getElementById("lfUser").focus();
      return;
    }
    forgotLink.setAttribute("aria-disabled", "true");
    showMessage("Enviando enlace de recuperación…");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}${location.pathname}`
      });
      if (error) throw error;
      showMessage("Si el correo está registrado, recibirás instrucciones para recuperar la contraseña.");
    } catch (error){
      showMessage(`No se pudo enviar el enlace: ${error.message}`, true);
    } finally {
      forgotLink.setAttribute("aria-disabled", "false");
    }
  });

  recoveryForm.addEventListener("submit", async event => {
    event.preventDefault();
    const nextPassword = recoveryPassword.value;
    if (nextPassword.length < 8){
      showMessage("La nueva contraseña debe tener al menos 8 caracteres.", true);
      return;
    }
    if (nextPassword !== document.getElementById("recoveryPassConfirm").value){
      showMessage("Las contraseñas no coinciden.", true);
      return;
    }
    showMessage("Actualizando contraseña…");
    try {
      const { data, error } = await supabase.auth.updateUser({ password: nextPassword });
      if (error) throw error;
      recoveryMode = false;
      recoveryForm.hidden = true;
      form.hidden = false;
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      showMessage("Contraseña actualizada. Cargando tu biblioteca…");
      if (data.user) await acceptUser(data.user);
    } catch (error){
      showMessage(`No se pudo actualizar la contraseña: ${error.message}`, true);
    }
  });

  toggle.addEventListener("click", () => {
    const reveal = password.type === "password";
    password.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Ocultar" : "Ver";
  });

  logoutBtn.addEventListener("click", async () => {
    if (!supabase) return;
    logoutBtn.disabled = true;
    try {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
      await clearSession();
    } catch (error){
      showMessage(`No se pudo cerrar sesión en Supabase: ${error.message}`, true);
    } finally {
      logoutBtn.disabled = false;
    }
  });
}
