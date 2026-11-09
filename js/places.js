// Address suggestions while typing (Google Places via the ri-places function). Fails quietly: if anything goes wrong the box just works as a plain text field.
import { FN, SUPABASE_ANON } from "./config.js";
export function attachPlaces(input) {
  if (!input || input.dataset.places) return; input.dataset.places = "1";
  const box = document.createElement("div"); box.className = "places"; box.hidden = true; box.setAttribute("role", "listbox");
  input.parentElement.style.position = "relative"; input.insertAdjacentElement("afterend", box);
  const session = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  let timer = null, seq = 0;
  const hide = () => { box.hidden = true; box.innerHTML = ""; };
  async function ask() {
    const q = input.value.trim(); if (q.length < 4) return hide();
    const my = ++seq;
    try {
      const r = await fetch(FN + "ri-places", { method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON }, body: JSON.stringify({ q, session }) });
      const d = await r.json(); if (my !== seq) return;
      const list = d.suggestions || []; if (!list.length) return hide();
      box.innerHTML = ""; list.forEach((t) => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "option"); b.textContent = t.replace(/, USA$/, ""); b.addEventListener("pointerdown", (e) => { e.preventDefault(); input.value = b.textContent; input.dispatchEvent(new Event("input", { bubbles: true })); hide(); }); box.appendChild(b); });
      box.hidden = false;
    } catch { hide(); }
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(ask, 250); });
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}
