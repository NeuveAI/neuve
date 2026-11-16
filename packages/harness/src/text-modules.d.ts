/** Text files imported with `with { type: "text" }`, which Bun inlines (source runs and the binary). */
declare module "*.md" {
  const text: string;
  export default text;
}
