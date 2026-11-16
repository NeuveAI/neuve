import "./fixtures/memory-secrets";
import {startHost as nativeStartHost, type HostOptions} from "../src/host";
export type {Host, HostOptions} from "../src/host";
/** Every test uses the real host on loopback; fixtures never open tailnet listeners. */
export const startHost = (options: HostOptions) => nativeStartHost({...options, loopback: true});
