/** Ace and standalone Neuve enter the same review command and Records admission. */
export async function runAceReviewCommand(
  args: readonly string[],
): Promise<number | undefined> {
  if (args[0] !== "review") return undefined;
  const { runReviewCli } = await import("./review-cli.ts");
  return runReviewCli(args.slice(1));
}
