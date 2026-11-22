import { UI } from "../content";
import { byId } from "./motion";

/** Copy buttons copy the install version shown: the icon becomes a check for 1600ms; if the clipboard is refused, that text is selected instead. */
export function initCopy() {
  const live = byId("live");
  document.querySelectorAll<HTMLButtonElement>(".copybtn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const lbl = btn.querySelector(".lbl");
      const pre = [
        ...(btn.closest(".install")?.querySelectorAll("pre") ?? []),
      ].find((p) => p.getClientRects().length > 0);
      const text = pre?.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add("ok");
        if (lbl) lbl.textContent = UI.copied;
        live.textContent = UI.copiedLive;
      } catch {
        if (pre) {
          const r = document.createRange();
          r.selectNodeContents(pre);
          const s = getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
        }
        if (lbl) lbl.textContent = UI.selected;
        live.textContent = UI.selectedLive;
      }
      setTimeout(() => {
        btn.classList.remove("ok");
        if (lbl) lbl.textContent = UI.copy;
        live.textContent = "";
      }, 1600);
    }),
  );
}
