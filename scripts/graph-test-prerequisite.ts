/**
 * Missing Graph prerequisites may skip package tests, but must fail checks. The one exception is a
 * check that declares it runs without Graph (`NEUVE_CHECK_WITHOUT_GRAPH=1`): the portable CI job,
 * which never checks out the separate Graph repository. Its Graph cases run in `bun run check`.
 */
export const graphTestPrerequisite = (input: {
  available: boolean;
  message: string;
}) => ({
  skip:
    !input.available &&
    (process.env.NEUVE_MODE !== "check" ||
      process.env.NEUVE_CHECK_WITHOUT_GRAPH === "1"),
  require() {
    if (!input.available) throw new Error(input.message);
  },
});
