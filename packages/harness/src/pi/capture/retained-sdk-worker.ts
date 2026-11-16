import { runInspectionWorker } from "./inspection-worker.ts";
import { runRetainedSdkWorker } from "./retained-sdk.ts";

runRetainedSdkWorker();

runInspectionWorker();
