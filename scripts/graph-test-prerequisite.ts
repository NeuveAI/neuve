/** Missing Graph prerequisites may skip package tests, but must fail checks. */
export const graphTestPrerequisite = (input: {
  available: boolean;
  message: string;
}) => ({
  skip: !input.available && process.env.NEUVE_MODE !== "check",
  require() {
    if (!input.available) throw new Error(input.message);
  },
});
