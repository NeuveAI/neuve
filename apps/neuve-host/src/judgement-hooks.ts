/** Root supplies the Records adapter; the host reports only branch observations. */
export interface JudgementBranchObservation {
  project: string;
  branch: string;
  base: string;
  head: string;
  previousHead?: string | undefined;
  reviewed: boolean;
  openPullRequest: boolean;
  trigger: "head" | "fetch" | "pull-request";
}
let observe: ((input: JudgementBranchObservation) => Promise<void>) | undefined;
export function configureJudgementPreparation(callback: typeof observe): void { observe = callback; }
export async function observeJudgementBranch(input: JudgementBranchObservation): Promise<void> {
  // Preparation must not fail the host action that discovered the head.
  await observe?.(input).catch(() => undefined);
}

let fetched: ((project: string) => Promise<void>) | undefined;
export function configureJudgementFetch(callback: typeof fetched): void { fetched = callback; }
export async function observeJudgementFetch(project: string): Promise<void> {
  await fetched?.(project).catch(() => undefined);
}
