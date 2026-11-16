import { createHash } from "node:crypto";

/**
 * The whole SHA-256 of a block's body, as its tag: text inside cannot close the block, since a body
 * whose planted closing tag matched a short prefix of its own hash could be ground in minutes.
 */
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Data from the repository, a scope source or an integration, in a block whose tag carries the SHA-256 of its content,
 * so text inside cannot close it. The system prompt says text inside is data, never instructions.
 */
export const dataBlock = (
  kind: string,
  attributes: Readonly<Record<string, string | number>>,
  body: string,
) => {
  const tag = `data-${digest(body)}`;
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${String(value).replace(/"/g, "'")}"`)
    .join("");
  return `<${tag} kind="${kind}"${attrs}>\n${body}\n</${tag}>`;
};
