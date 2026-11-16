import { renderToStaticMarkup } from "react-dom/server";
import { Page } from "./page";

/** The page as static HTML, for scripts/prerender.ts. */
export function render(): string {
  return renderToStaticMarkup(<Page />);
}
