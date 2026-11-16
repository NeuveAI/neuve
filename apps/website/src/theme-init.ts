/**
 * The theme follows the system unless the reader pinned one with the toggle.
 * THEME_INIT runs inline in <head>, before first paint, so the page never
 * flashes the wrong theme; the CSP allows it by its hash (src/build/csp.ts).
 * The `.dark` class on <html> switches Neuve's tokens (globals.css). It also
 * sets `.js`, so the motion's starting states apply before first paint and the
 * prerendered final state never flashes before the hero plays. If the module
 * bundle hasn't marked the page `.live` within READY_MS (it failed to load or
 * threw), `.js` comes off again and the page shows its rendered, final state.
 */
export const READY_MS = 3000;
export const THEME_STORAGE_KEY = "neuve-website-theme";

export const THEME_INIT = `(function(){var d=document.documentElement;d.classList.add("js");var m=!!window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var p=null;try{p=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}if(p==="dark"||(p!=="light"&&m))d.classList.add("dark");setTimeout(function(){if(!d.classList.contains("live"))d.classList.remove("js")},${READY_MS})})()`;
