/**
 * Prints the M4 model registry as JSON for the Modal runner, so the Python side never restates a
 * pin. Each model's input formats become templates by calling them with placeholder strings:
 * `{path}`, `{text}` and `{query}` are the only substitutions, applied once each by the runner.
 *
 *   bun packages/evaluation/modal/registry.ts > registry.json
 */
import { MODELS } from "../src/retrieval-bench/models.ts";

const PATH = "\u0000PATH\u0000";
const TEXT = "\u0000TEXT\u0000";
const QUERY = "\u0000QUERY\u0000";

const template = (value: string) =>
  value.replaceAll(PATH, "{path}").replaceAll(TEXT, "{text}").replaceAll(QUERY, "{query}");

const registry = Object.fromEntries(
  Object.entries(MODELS).map(([id, model]) => [
    id,
    {
      ...model,
      format: {
        recipe: model.format.recipe,
        query: template(model.format.query(QUERY)),
        document: template(model.format.document(PATH, TEXT)),
      },
    },
  ]),
);

console.log(JSON.stringify(registry, null, 2));
