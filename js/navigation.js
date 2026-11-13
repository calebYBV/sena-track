export const APP_VIEWS = ["translator", "settings"];

export function resolveAppView(hash){
  const requested = String(hash || "").replace(/^#/, "");
  if (requested === "edo") return "settings";
  return APP_VIEWS.includes(requested) ? requested : "translator";
}

export function activateAppView(panels, links, view){
  if (!APP_VIEWS.includes(view)) throw new RangeError(`Vista desconocida: ${view}`);
  for (const panel of panels){
    panel.hidden = panel.dataset.viewPanel !== view;
  }
  for (const link of links){
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

export function mountEdoContents(document){
  const template = document.getElementById("edoContents");
  const translator = document.getElementById("translatorView");
  const settings = document.getElementById("settingsView");
  const librarySettings = document.getElementById("librarySettings");
  if (!template || !translator || !settings || !librarySettings){
    throw new Error("No se encontraron los destinos para la comparación y configuración EDO.");
  }
  const content = template.content.cloneNode(true);
  const comparison = content.querySelector(".workspace-right");
  const settingsPanels = [...content.querySelectorAll(".edo-settings, .experimental-evaluation")];
  if (!comparison || settingsPanels.length !== 2){
    throw new Error("La plantilla EDO no contiene todos los paneles requeridos.");
  }
  translator.append(comparison);
  settings.insertBefore(settingsPanels[0], librarySettings);
  settings.append(settingsPanels[1]);
}
