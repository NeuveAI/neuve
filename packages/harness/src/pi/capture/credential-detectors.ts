import { createHmac, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import type { Json } from "./types.ts";
import { z } from "zod";
import {
  artifactRepresentation,
  type ArtifactSource,
} from "./representation.ts";

export const CredentialEpochId = z
  .string()
  .min(1)
  .max(128)
  .brand("CredentialEpochId");
export type CredentialEpochId = z.infer<typeof CredentialEpochId>;
const Role = z.enum(["header", "authorization-token", "cookie-value"]);
const Domain = z.enum(["string16", "raw-utf8", "raw-utf16le", "raw-utf16be"]);
type Domain = z.infer<typeof Domain>;
const Record = z
  .strictObject({
    domain: Domain,
    length: z.int().min(1).max(2_097_152),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    prefix: z.number().int().min(0).max(281_474_976_710_655),
    prefixLength: z.int().min(1).max(8),
    roles: z.array(Role).min(1).max(3),
  })
  .refine((record) => record.prefixLength === Math.min(8, record.length));
const Epoch = z.strictObject({
  id: CredentialEpochId,
  escapedThrough: z.int().positive().nullable(),
  records: z.array(Record).min(1).max(4096),
});
const State = z
  .strictObject({
    policy: z.literal("credential-detectors-v1"),
    epochs: z.array(Epoch).max(1024),
  })
  .refine(
    (state) =>
      new Set(state.epochs.map((epoch) => epoch.id)).size ===
      state.epochs.length,
  );
type Record = z.infer<typeof Record>;
type Epoch = z.infer<typeof Epoch>;
type State = z.infer<typeof State>;
const Envelope = z.strictObject({
  state: State,
  mac: z.string().regex(/^[a-f0-9]{64}$/),
});

export type UnavailableReason =
  | "budget"
  | "cancelled"
  | "unsupported"
  | "worker"
  | "invalid-metadata"
  | "private-store"
  | "ownership"
  | "closed";
export interface InspectionUnavailable {
  readonly status: "unavailable";
  readonly reason: UnavailableReason;
  readonly exposedEpochs: ReadonlyArray<CredentialEpochId>;
}
export const unavailable = (
  reason: UnavailableReason,
  exposedEpochs: ReadonlyArray<CredentialEpochId> = [],
): InspectionUnavailable => ({ status: "unavailable", reason, exposedEpochs });
class Incomplete extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Credential inspection unavailable (${reason})`);
  }
}
export interface InspectionLimits {
  readonly units: number;
  readonly fullChecks: number;
  readonly fullBytes: number;
  readonly matches: number;
  readonly parseUnits: number;
  readonly decodeUnits: number;
  readonly parseValueUnits: number;
  readonly depth: number;
  readonly yieldUnits: number;
}
export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = {
  units: 1_000_000_000,
  fullChecks: 100_000,
  fullBytes: 128 * 1024 * 1024,
  matches: 10_000,
  parseUnits: 64 * 1024 * 1024,
  decodeUnits: 64 * 1024 * 1024,
  parseValueUnits: 1024 * 1024,
  depth: 32,
  yieldUnits: 16_384,
};
const Limits = z.strictObject({
  units: z.int().nonnegative(),
  fullChecks: z.int().nonnegative(),
  fullBytes: z.int().nonnegative(),
  matches: z.int().nonnegative(),
  parseUnits: z.int().nonnegative(),
  decodeUnits: z.int().nonnegative(),
  parseValueUnits: z.int().positive(),
  depth: z.int().nonnegative(),
  yieldUnits: z.int().min(1).max(65_536),
});
export class InspectionBudget {
  onProgress: ((units: number) => void) | undefined;
  #revision = 0;
  #reported = -1;
  onExposure: ((epoch: CredentialEpochId) => void) | undefined;
  readonly #limits: InspectionLimits;
  readonly #signal: AbortSignal | undefined;
  readonly #used = {
    units: 0,
    fullChecks: 0,
    fullBytes: 0,
    matches: 0,
    parseUnits: 0,
    decodeUnits: 0,
  };
  #sinceYield = 0;
  #timerYield = -Infinity;
  #failed = false;
  #exhausted: keyof InspectionBudget["usage"] | undefined;
  constructor(
    limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
    signal?: AbortSignal,
    readonly deadline?: number,
  ) {
    this.#limits = Limits.parse(limits);
    this.#signal = signal;
  }
  progress(): void {
    this.onProgress?.(this.#revision);
  }
  dispose(): void {}

  get signal(): AbortSignal | undefined {
    return this.#signal;
  }
  get limits(): InspectionLimits {
    return this.#limits;
  }
  charge(kind: keyof InspectionBudget["usage"], amount: number): void {
    if (
      this.#signal?.aborted ||
      (this.deadline !== undefined && performance.now() >= this.deadline)
    )
      throw new Incomplete("cancelled");
    if (
      this.#failed ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      this.#used[kind] + amount > this.#limits[kind]
    ) {
      this.#exhausted ??= kind;
      this.#failed = true;
      throw new Incomplete("budget");
    }
    this.#used[kind] += amount;
    if (amount > 0) this.#revision++;
  }
  get exhausted(): keyof InspectionBudget["usage"] | undefined {
    return this.#exhausted;
  }
  get usage(): Readonly<{
    units: number;
    fullChecks: number;
    fullBytes: number;
    matches: number;
    parseUnits: number;
    decodeUnits: number;
  }> {
    return { ...this.#used };
  }
  async checkpoint(units: number, signal?: AbortSignal): Promise<void> {
    if (
      signal?.aborted ||
      this.#signal?.aborted ||
      (this.deadline !== undefined && performance.now() >= this.deadline)
    )
      throw new Incomplete("cancelled");
    if (this.#reported !== this.#revision) {
      this.#reported = this.#revision;
      this.progress();
    }
    this.#sinceYield += units;
    if (this.#sinceYield >= this.#limits.yieldUnits) {
      this.#sinceYield = 0;
      // Every checkpoint yields. Service timers on the first yield and after each
      // millisecond of work; immediate turns avoid a timer floor per checkpoint.
      const timer = performance.now() - this.#timerYield >= 1;
      await new Promise<void>((resolve) => {
        if (timer) setTimeout(resolve, 0);
        else setImmediate(resolve);
      });
      if (timer) this.#timerYield = performance.now();
      if (
        signal?.aborted ||
        this.#signal?.aborted ||
        (this.deadline !== undefined && performance.now() >= this.deadline)
      )
        throw new Incomplete("cancelled");
    }
  }
}
export interface MatchInterval {
  readonly start: number;
  readonly end: number;
  readonly epoch: CredentialEpochId;
  readonly roles: ReadonlyArray<z.infer<typeof Role>>;
  readonly domain: Domain;
  readonly view: "text" | "raw" | "utf8-decoded" | "declared-text";
  /** Each span contains the JSON string whose decoded contents hold the next span. */
  readonly jsonPath: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
}
export interface CompleteInspection {
  readonly status: "complete";
  readonly epochs: ReadonlyArray<CredentialEpochId>;
  readonly matches: ReadonlyArray<MatchInterval>;
}
export type InspectionResult = CompleteInspection | InspectionUnavailable;
export const inspectionFailure = (
  error: unknown,
  exposedEpochs: ReadonlyArray<CredentialEpochId> = [],
): InspectionUnavailable =>
  unavailable(
    error instanceof Incomplete ? error.reason : "invalid-metadata",
    exposedEpochs,
  );
interface ScanProgress {
  readonly matches: MatchInterval[];
  readonly observed: Set<CredentialEpochId>;
}
const bytesOf = (text: string, domain: Domain): Buffer => {
  const bytes = Buffer.from(text, domain === "raw-utf8" ? "utf8" : "utf16le");
  return domain === "raw-utf16be" ? bytes.swap16() : bytes;
};
const unitAt = (source: string | Uint8Array, position: number): number =>
  typeof source === "string"
    ? source.charCodeAt(position)
    : (source[position] ?? 0);
const sourceBytes = (
  source: string | Uint8Array,
  start: number,
  length: number,
): Uint8Array =>
  typeof source === "string"
    ? Buffer.from(source.slice(start, start + length), "utf16le")
    : source.subarray(start, start + length);

export class CredentialJson {
  readonly #text: string;
  private constructor(text: string) {
    this.#text = text;
  }
  static serialize(value: unknown): CredentialJson {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      throw new Error("Credential JSON serialization unavailable");
    }
    if (typeof text !== "string")
      throw new Error("Credential JSON serialization failed");
    return new CredentialJson(text);
  }
  static parse(text: string): {
    readonly value: unknown;
    readonly source: CredentialJson;
  } {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new SyntaxError("Credential JSON source is invalid");
      throw new Error("Credential JSON validation unavailable");
    }
    return { value, source: new CredentialJson(text) };
  }
  contents(): string {
    return this.#text;
  }
  toJSON(): string {
    return "[Credential JSON source]";
  }
  [inspect.custom](): string {
    return this.toJSON();
  }
}

export class CredentialDetectors {
  readonly #key: Buffer;
  #state: State;
  readonly #tables = new Map<Domain, { a: Uint32Array; b: Uint32Array }>();
  readonly #base: number;
  #destroyed = false;
  private constructor(key: Uint8Array, state: State) {
    if (key.byteLength !== 32) throw new Incomplete("invalid-metadata");
    this.#key = Buffer.from(key);
    this.#state = state;
    this.#base =
      (this.#hmac("prefix-parameters-v1", Buffer.alloc(0)).readUInt32LE(0) |
        1) >>>
      0;
  }
  static empty(key: Uint8Array): CredentialDetectors {
    return new CredentialDetectors(key, {
      policy: "credential-detectors-v1",
      epochs: [],
    });
  }
  static restorePrivate(
    key: Uint8Array,
    bytes: Uint8Array,
    budget?: InspectionBudget,
  ): CredentialDetectors {
    try {
      if (bytes.byteLength > 8 * 1024 * 1024)
        throw new Incomplete("invalid-metadata");
      budget?.charge("parseUnits", bytes.byteLength);
      budget?.charge("fullChecks", 1);
      budget?.charge("fullBytes", bytes.byteLength);
      const envelope = Envelope.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const expected = createHmac("sha256", key)
        .update("credential-detector-state-v1\0")
        .update(JSON.stringify(envelope.state))
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(envelope.mac, "hex")))
        throw new Incomplete("invalid-metadata");
      return new CredentialDetectors(key, envelope.state);
    } catch (error) {
      if (error instanceof Incomplete) throw error;
      throw new Incomplete("invalid-metadata");
    }
  }
  encodePrivate(budget?: InspectionBudget): Uint8Array {
    if (this.#destroyed) throw new Incomplete("closed");
    const encoded = JSON.stringify(this.#state);
    budget?.charge("parseUnits", encoded.length);
    budget?.charge("fullChecks", 1);
    budget?.charge("fullBytes", Buffer.byteLength(encoded));
    return new TextEncoder().encode(
      JSON.stringify({
        state: this.#state,
        mac: this.#hmac(
          "credential-detector-state-v1",
          Buffer.from(encoded),
        ).toString("hex"),
      }),
    );
  }
  get epochIds(): ReadonlyArray<CredentialEpochId> {
    return this.#state.epochs.map((epoch) => epoch.id);
  }
  forkPrivate(): CredentialDetectors {
    if (this.#destroyed) throw new Incomplete("closed");
    const fork = new CredentialDetectors(this.#key, this.#state);
    for (const [domain, table] of this.#tables) fork.#tables.set(domain, table);
    return fork;
  }
  toJSON(): string {
    return "[Private credential detectors]";
  }
  [inspect.custom](): string {
    return this.toJSON();
  }
  destroy(): void {
    this.#destroyed = true;
    this.#key.fill(0);
    this.#tables.clear();
    this.#state = { policy: "credential-detectors-v1", epochs: [] };
  }
  async #checkpoint(
    budget: InspectionBudget,
    units: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#destroyed) throw new Incomplete("closed");
    await budget.checkpoint(units, signal);
    if (this.#destroyed) throw new Incomplete("closed");
  }
  #hmac(domain: string, bytes: Uint8Array): Buffer {
    return createHmac("sha256", this.#key)
      .update(domain)
      .update("\0")
      .update(bytes)
      .digest();
  }
  async #table(domain: Domain, budget: InspectionBudget, signal?: AbortSignal) {
    const known = this.#tables.get(domain);
    if (known) return known;
    const size = domain === "string16" ? 65_536 : 256;
    const a = new Uint32Array(size),
      b = new Uint32Array(size),
      input = Buffer.alloc(4);
    for (let code = 0; code < size; code++) {
      budget.charge("units", 1);
      input.writeUInt32LE(code);
      const digest = this.#hmac(`prefix-weight-v1:${domain}`, input);
      a[code] = digest.readUInt32LE(0);
      b[code] = digest.readUInt32LE(4);
      if ((code + 1) % 2048 === 0) await this.#checkpoint(budget, 2048, signal);
    }
    const table = { a, b };
    this.#tables.set(domain, table);
    return table;
  }
  #prefix(
    source: string | Uint8Array,
    length: number,
    table: { a: Uint32Array; b: Uint32Array },
  ): number {
    let x = 0,
      y = 0;
    for (let position = 0; position < length; position++) {
      const code = unitAt(source, position);
      x = (Math.imul(x, this.#base) + (table.a[code] ?? 0)) >>> 0;
      y = (Math.imul(y, this.#base) + (table.b[code] ?? 0)) >>> 0;
    }
    return (x & 65535) * 4294967296 + y;
  }
  async register(input: {
    readonly epoch: CredentialEpochId;
    readonly headers: Headers;
    readonly budget: InspectionBudget;
    readonly escapedUnits?: number;
    readonly deduplicate?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly status: "registered"; readonly epoch: CredentialEpochId }
    | InspectionUnavailable
  > {
    try {
      if (this.#destroyed) throw new Incomplete("closed");
      const existing = this.#state.epochs.find(
        (epoch) => epoch.id === input.epoch,
      );
      const bound = input.escapedUnits ?? 262_144;
      if (
        !Number.isSafeInteger(bound) ||
        bound < 8192 ||
        bound > 1_048_576 ||
        this.#state.epochs.length >= 1024
      )
        throw new Incomplete("budget");
      const materials: Array<{ value: string; role: z.infer<typeof Role> }> =
        [];
      let headerUnits = 0;
      for (const [name, value] of input.headers) {
        headerUnits += name.length + value.length;
        if (headerUnits > 65_536) throw new Incomplete("budget");
        if (!/authorization|api[-_]?key|cookie/i.test(name) || value === "")
          continue;
        materials.push({ value, role: "header" });
        if (/authorization/i.test(name))
          materials.push({
            value: value.replace(/^\S+\s+/, ""),
            role: "authorization-token",
          });
        if (/cookie/i.test(name))
          for (const cookie of value.split(";")) {
            const separator = cookie.indexOf("=");
            if (separator >= 0)
              materials.push({
                value: cookie.slice(separator + 1).trim(),
                role: "cookie-value",
              });
          }
      }
      const records = new Map<string, Record>();
      let escapedThrough: number | null = null;
      for (const material of materials) {
        if (material.value.length > bound) throw new Incomplete("budget");
        let value = material.value;
        while (value !== "" && value.length <= bound) {
          for (const domain of Domain.options) {
            input.budget.charge("fullChecks", 1);
            input.budget.charge(
              "fullBytes",
              domain === "raw-utf8"
                ? Buffer.byteLength(value, "utf8")
                : value.length * 2,
            );
            const bytes = bytesOf(value, domain);
            const digest = this.#hmac(`full-v1:${domain}`, bytes).toString(
              "hex",
            );
            const source = domain === "string16" ? value : bytes;
            const id = `${domain}:${digest}:${source.length}`;
            const previous = records.get(id);
            if (previous) {
              if (!previous.roles.includes(material.role))
                previous.roles.push(material.role);
              continue;
            }
            const table = await this.#table(domain, input.budget, input.signal);
            const prefixLength = Math.min(8, source.length);
            records.set(id, {
              domain,
              length: source.length,
              digest,
              prefixLength,
              prefix: this.#prefix(source, prefixLength, table),
              roles: [material.role],
            });
          }
          if (records.size > 4096) throw new Incomplete("budget");
          await this.#checkpoint(input.budget, value.length, input.signal);
          const next = JSON.stringify(value).slice(1, -1);
          if (next === value) break;
          if (next.length > bound) {
            escapedThrough = bound;
            break;
          }
          value = next;
        }
      }
      if (records.size === 0) throw new Incomplete("invalid-metadata");
      const candidate = Epoch.parse({
        id: input.epoch,
        escapedThrough,
        records: [...records.values()],
      });
      if (input.deduplicate && !existing) {
        const equivalent = this.#state.epochs.find(
          (epoch) =>
            epoch.escapedThrough === candidate.escapedThrough &&
            JSON.stringify(epoch.records) === JSON.stringify(candidate.records),
        );
        if (equivalent) return { status: "registered", epoch: equivalent.id };
      }
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate))
        throw new Incomplete("invalid-metadata");
      const descriptor = {
        policy: "credential-detectors-v1",
        epochs: existing
          ? this.#state.epochs
          : [...this.#state.epochs, candidate],
      };
      input.budget.charge("parseUnits", JSON.stringify(descriptor).length);
      const next = State.parse(descriptor);
      if (JSON.stringify(next).length > 8 * 1024 * 1024)
        throw new Incomplete("budget");
      this.#state = next;
      return { status: "registered", epoch: input.epoch };
    } catch (error) {
      return inspectionFailure(error);
    }
  }
  async #scan(
    source: string | Uint8Array,
    domain: Domain,
    budget: InspectionBudget,
    progress: ScanProgress,
    jsonPath: MatchInterval["jsonPath"],
    view: MatchInterval["view"],
    signal?: AbortSignal,
  ): Promise<void> {
    const grouped = new Map<
      number,
      Map<number, Array<{ record: Record; epoch: CredentialEpochId }>>
    >();
    for (const epoch of this.#state.epochs) {
      if (epoch.escapedThrough !== null && source.length > epoch.escapedThrough)
        throw new Incomplete("unsupported");
      for (const record of epoch.records) {
        budget.charge("units", 1);
        await this.#checkpoint(budget, 1, signal);
        if (record.domain !== domain) continue;
        const buckets = grouped.get(record.prefixLength) ?? new Map();
        grouped.set(record.prefixLength, buckets);
        const records = buckets.get(record.prefix) ?? [];
        records.push({ record, epoch: epoch.id });
        buckets.set(record.prefix, records);
      }
    }
    const table = await this.#table(domain, budget, signal);
    for (const [length, buckets] of grouped) {
      if (source.length < length) continue;
      let x = 0,
        y = 0,
        power = 1;
      for (let index = 1; index < length; index++)
        power = Math.imul(power, this.#base) >>> 0;
      for (let index = 0; index < length; index++) {
        const code = unitAt(source, index);
        x = (Math.imul(x, this.#base) + (table.a[code] ?? 0)) >>> 0;
        y = (Math.imul(y, this.#base) + (table.b[code] ?? 0)) >>> 0;
      }
      for (let position = 0; position + length <= source.length; position++) {
        budget.charge("units", 1);
        const candidates = buckets.get((x & 65535) * 4294967296 + y);
        const digests =
          candidates === undefined ? undefined : new Map<number, Buffer>();
        if (candidates)
          for (const { record, epoch } of candidates) {
            if (position + record.length > source.length) continue;
            let digest = digests?.get(record.length);
            if (!digest) {
              budget.charge("fullChecks", 1);
              budget.charge(
                "fullBytes",
                typeof source === "string" ? record.length * 2 : record.length,
              );
              const bytes = sourceBytes(source, position, record.length);
              digest = this.#hmac(`full-v1:${domain}`, bytes);
              digests?.set(record.length, digest);
            }
            if (timingSafeEqual(digest, Buffer.from(record.digest, "hex"))) {
              progress.observed.add(epoch);
              budget.onExposure?.(epoch);
              budget.charge("matches", 1);
              progress.matches.push({
                start: position,
                end: position + record.length,
                domain,
                epoch,
                roles: [...record.roles],
                jsonPath,
                view,
              });
            }
          }
        if (position + length < source.length) {
          const old = unitAt(source, position),
            next = unitAt(source, position + length);
          x =
            (Math.imul(
              (x - Math.imul(table.a[old] ?? 0, power)) >>> 0,
              this.#base,
            ) +
              (table.a[next] ?? 0)) >>>
            0;
          y =
            (Math.imul(
              (y - Math.imul(table.b[old] ?? 0, power)) >>> 0,
              this.#base,
            ) +
              (table.b[next] ?? 0)) >>>
            0;
        }
        if ((position + 1) % 4096 === 0)
          await this.#checkpoint(budget, 4096, signal);
      }
      await this.#checkpoint(
        budget,
        Math.max(0, source.length - length + 1) % 4096,
        signal,
      );
    }
  }
  async #text(
    text: string,
    budget: InspectionBudget,
    progress: ScanProgress,
    path: MatchInterval["jsonPath"],
    view: MatchInterval["view"],
    signal?: AbortSignal,
    trustedRoot = false,
  ): Promise<void> {
    if (path.length > budget.limits.depth) throw new Incomplete("budget");
    await this.#scan(text, "string16", budget, progress, path, view, signal);
    let leading = 0;
    while (leading < text.length && /\s/.test(text[leading] ?? "")) {
      leading++;
      if (leading % 4096 === 0) {
        budget.charge("units", 4096);
        await this.#checkpoint(budget, 4096, signal);
      }
    }
    if (!["{", "[", '"'].includes(text[leading] ?? "")) return;
    if (!trustedRoot && text.length > budget.limits.parseValueUnits)
      throw new Incomplete("unsupported");
    budget.charge("parseUnits", text.length);
    await this.#checkpoint(budget, text.length, signal);
    if (!trustedRoot) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw new Incomplete("unsupported");
      }
      if (
        typeof parsed !== "string" &&
        (typeof parsed !== "object" || parsed === null)
      )
        return;
    }
    const quoted = /"(?:[^"\\]|\\.)*"/gs;
    for (const match of text.matchAll(quoted)) {
      const value: unknown = JSON.parse(match[0]);
      if (typeof value !== "string") throw new Incomplete("invalid-metadata");
      await this.#text(
        value,
        budget,
        progress,
        [...path, { start: match.index, end: match.index + match[0].length }],
        view,
        signal,
      );
    }
  }
  async inspectText(input: {
    readonly text: string;
    readonly budget: InspectionBudget;
    readonly signal?: AbortSignal;
  }): Promise<InspectionResult> {
    const snapshot = this.#state;
    const progress: ScanProgress = { matches: [], observed: new Set() };
    try {
      if (this.#destroyed) throw new Incomplete("closed");
      if (this.#state.epochs.length === 0)
        throw new Incomplete("invalid-metadata");
      await this.#checkpoint(input.budget, 0, input.signal);
      await this.#text(
        input.text,
        input.budget,
        progress,
        [],
        "text",
        input.signal,
      );
      await this.#checkpoint(input.budget, 0, input.signal);
      if (this.#state !== snapshot) throw new Incomplete("invalid-metadata");
      return {
        status: "complete",
        epochs: snapshot.epochs.map((epoch) => epoch.id),
        matches: progress.matches,
      };
    } catch (error) {
      return inspectionFailure(error, [...progress.observed]);
    }
  }
  async inspectJson(input: {
    readonly json: CredentialJson;
    readonly budget: InspectionBudget;
    readonly signal?: AbortSignal;
  }): Promise<InspectionResult> {
    const snapshot = this.#state;
    const progress: ScanProgress = { matches: [], observed: new Set() };
    try {
      if (this.#destroyed) throw new Incomplete("closed");
      if (
        !(input.json instanceof CredentialJson) ||
        this.#state.epochs.length === 0
      )
        throw new Incomplete("invalid-metadata");
      await this.#text(
        input.json.contents(),
        input.budget,
        progress,
        [],
        "text",
        input.signal,
        true,
      );
      await this.#checkpoint(input.budget, 0, input.signal);
      if (this.#state !== snapshot) throw new Incomplete("invalid-metadata");
      return {
        status: "complete",
        epochs: snapshot.epochs.map((epoch) => epoch.id),
        matches: progress.matches,
      };
    } catch (error) {
      return inspectionFailure(error, [...progress.observed]);
    }
  }
  /** Borrows a stable caller-owned snapshot until resolution; the result is not a content certificate. */
  async inspectArtifact(
    input: ArtifactSource & {
      readonly budget: InspectionBudget;
      readonly signal?: AbortSignal;
    },
  ): Promise<InspectionResult> {
    const snapshot = this.#state;
    const progress: ScanProgress = { matches: [], observed: new Set() };
    try {
      if (this.#destroyed) throw new Incomplete("closed");
      if (this.#state.epochs.length === 0)
        throw new Incomplete("invalid-metadata");
      await this.#checkpoint(input.budget, 0, input.signal);
      for (const domain of [
        "raw-utf8",
        "raw-utf16le",
        "raw-utf16be",
      ] satisfies ReadonlyArray<Domain>)
        await this.#scan(
          input.bytes,
          domain,
          input.budget,
          progress,
          [],
          "raw",
          input.signal,
        );
      input.budget.charge("decodeUnits", input.bytes.byteLength * 2);
      await this.#text(
        new TextDecoder().decode(input.bytes),
        input.budget,
        progress,
        [],
        "utf8-decoded",
        input.signal,
      );
      if (input.mediaType.length > 4096) throw new Incomplete("unsupported");
      input.budget.charge("decodeUnits", input.bytes.byteLength * 2);
      const representation = artifactRepresentation(input);
      if (representation._tag === "Malformed")
        throw new Incomplete("unsupported");
      if (representation._tag === "Text")
        await this.#text(
          representation.text,
          input.budget,
          progress,
          [],
          "declared-text",
          input.signal,
        );
      await this.#checkpoint(input.budget, 0, input.signal);
      if (this.#state !== snapshot) throw new Incomplete("invalid-metadata");
      return {
        status: "complete",
        epochs: snapshot.epochs.map((epoch) => epoch.id),
        matches: progress.matches,
      };
    } catch (error) {
      return inspectionFailure(error, [...progress.observed]);
    }
  }
}

export type CredentialSource =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly json: CredentialJson }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mediaType: string;
    };
