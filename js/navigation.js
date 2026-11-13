export const APP_VIEWS = ["translator", "settings", "edo"];

export function resolveAppView(hash){
  const requested = String(hash || "").replace(/^#/, "");
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

export function mountEdoView(document){
  const template = document.getElementById("edoContents");
  const target = document.querySelector("#edoView .edo-content");
  if (!template || !target) throw new Error("No se encontró la plantilla de la vista EDO.");
  target.append(template.content.cloneNode(true));
}
