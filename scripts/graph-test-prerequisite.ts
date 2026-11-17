/**
 * Missing Graph prerequisites may skip package tests, but must fail checks. PR CI, including forks,
 * downloads the public pinned engine. Every check must run its Graph cases.
 */
export const graphTestPrerequisite = (input: {
  available: boolean;
  message: string;
}) => ({
  skip: !input.available && process.env.NEUVE_MODE !== "check",
  require() {
    if (!input.available) throw new Error(input.message);
  },
});
