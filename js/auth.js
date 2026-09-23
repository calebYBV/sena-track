export function initAuth(start) {

  const AUTH_KEY = "senaTrackAuth";
  const loginScreen = document.getElementById("loginScreen");
  const appEl = document.getElementById("app");
  const logoutBtn = document.getElementById("logoutBtn");
  const form = document.getElementById("loginForm");
  const msg = document.getElementById("lfMsg");
  const pass = document.getElementById("lfPass");
  const toggle = document.getElementById("lfToggle");

  function enterApp(){
    loginScreen.classList.add("hidden");
    appEl.style.display = "";
    logoutBtn.classList.remove("hidden");
    start();
  }

  // Si ya había una sesión guardada en este navegador, entra directo
  if (localStorage.getItem(AUTH_KEY) === "1"){
    enterApp();
  }

  form.addEventListener("submit", function(e){
    e.preventDefault();
    const user = document.getElementById("lfUser").value.trim();
    const p = pass.value;
    if (!user || !p){
      msg.style.color = "#c0392b";
      msg.textContent = "Completa usuario y contraseña.";
      return;
    }
    localStorage.setItem(AUTH_KEY, "1");
    msg.style.color = "";
    msg.textContent = "¡Bienvenido a Seña-Track!";
    setTimeout(enterApp, 400);
  });

  toggle.addEventListener("click", function(){
    if (pass.type === "password"){ pass.type = "text"; toggle.textContent = "Ocultar"; }
    else { pass.type = "password"; toggle.textContent = "Ver"; }
  });

  document.getElementById("lfGoogle").addEventListener("click", function(){
    localStorage.setItem(AUTH_KEY, "1");
    msg.style.color = "";
    msg.textContent = "Conectando con Google…";
    setTimeout(enterApp, 500);
  });
  document.getElementById("lfApple").addEventListener("click", function(){
    localStorage.setItem(AUTH_KEY, "1");
    msg.style.color = "";
    msg.textContent = "Conectando con Apple…";
    setTimeout(enterApp, 500);
  });

  document.getElementById("lfForgot").addEventListener("click", function(e){
    e.preventDefault();
    msg.style.color = "";
    msg.textContent = "Escribe cualquier usuario y contraseña para entrar (demo).";
  });
  document.getElementById("lfSignup").addEventListener("click", function(e){
    e.preventDefault();
    msg.style.color = "";
    msg.textContent = "Escribe cualquier usuario y contraseña para registrarte (demo).";
  });

  logoutBtn.addEventListener("click", function(){
    localStorage.removeItem(AUTH_KEY);
    location.reload();
  });

}
