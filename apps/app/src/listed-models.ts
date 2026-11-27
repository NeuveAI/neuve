/**
 * Each model once per sign-in, named with its provider or account only where two rows share it.
 * The channel matches a model the owner names by the same rule, so it lives once, in the runtime.
 */
export { key, listed } from "@neuve/runtime/listed-models";
