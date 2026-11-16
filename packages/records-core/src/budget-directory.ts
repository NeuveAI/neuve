import { dirname, join } from "node:path";
import { registryPath } from "./registry.ts";

export const budgetDirectory = () => {
  if (process.env.NEUVE_BUDGET_DIRECTORY)
    return process.env.NEUVE_BUDGET_DIRECTORY;
  if (process.env.NEUVE_TEST_PROCESS === "1")
    throw new Error("Test processes require NEUVE_BUDGET_DIRECTORY");
  return join(dirname(registryPath()), "budget");
};
