import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { RecordEvent } from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { mintUlid } from "./ids.ts";

/**
 * Actor identity without auth (D21, 6.6). A fingerprint is sha256 over the canonical JSON of a version
 * tag, the actor's kind and its identifying inputs. The kind is part of the hashed input, so an agent
 * fingerprint can never equal a human one whatever its harness or session, and canonical JSON keeps
 * every input separate. It is for attribution only.
 */
const fingerprint = (...parts: ReadonlyArray<string | null>) =>
  sha256Hex(canonicalJson(["neuve-actor/2", ...parts]));

/** The external harnesses capture supports; a `--session` override must name one of them. */
export const AGENT_HARNESSES = ["claude-code", "codex"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];
export const isAgentHarness = (value: string): value is AgentHarness =>
  (AGENT_HARNESSES as ReadonlyArray<string>).includes(value);

/** An agent session in an external harness, or one of its subagents: harness + session (+ subagent). */
export const agentFingerprint = (input: {
  readonly harness: string;
  readonly sessionId: string;
  readonly subagentId?: string | undefined;
}) =>
  fingerprint(
    "agent",
    input.harness,
    input.sessionId,
    input.subagentId ?? null,
  );

export const ACE_CHANNEL_HARNESS = "neuve-pi";
export const ACE_CHAT_VARIABLE = "NEUVE_ACE_CHAT";

export const aceChatIdentity = (channel: string, chat: number) => {
  const identity = {
    harness: ACE_CHANNEL_HARNESS,
    sessionId: channel,
    subagentId: String(chat),
  };
  return { ...identity, actorId: agentFingerprint(identity) };
};

export const aceChatEnvironment = (channel: string, chat: number) => ({
  [ACE_CHAT_VARIABLE]: `${channel}/${chat}`,
});

export const readAceChat = (channel: string, value: string | undefined) => {
  const match = /^(.*)\/(0|[1-9]\d*)$/.exec(value ?? "");
  if (match?.[1] !== channel) return;
  const chat = Number(match[2]);
  if (Number.isSafeInteger(chat)) return aceChatIdentity(channel, chat);
};

type ActorRegistration = Extract<RecordEvent, { kind: "actor.registered@1" }>;

export const actorRegistration = (
  actor: string,
  payload: ActorRegistration["payload"],
): ActorRegistration => ({
  id: mintUlid(),
  kind: "actor.registered@1",
  idempotencyKey: `actor:${actor}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
  actor,
  occurredAt: new Date().toISOString(),
  payload,
});

export const agentRegistration = (
  input: Parameters<typeof agentFingerprint>[0],
) =>
  actorRegistration(agentFingerprint(input), {
    actorKind: "agent",
    harness: input.harness,
    sessionId: input.sessionId,
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
  });

/** Git treats email addresses case-insensitively in practice, so they are compared trimmed and lowercased. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** A human, identified by git email. */
export const humanFingerprint = (email: string) =>
  fingerprint("human", normalizeEmail(email));

/**
 * Stands in for the actor of a change when no actor can be named: the hook could not read the process
 * table, or several sessions claimed it. It is never registered, so it never appears as an agent or a
 * human; a commit carrying it records that its actor is unknown rather than guessing (D23).
 */
export const UNRESOLVED_ACTOR = fingerprint("unresolved");

const BITS_PER_WORD = 11;
/** 2,048 words (the BIP-39 English list), so each word carries 11 bits of the fingerprint. */
const WORDS: ReadonlyArray<string> = wordlist;
if (WORDS.length !== 1 << BITS_PER_WORD)
  throw new Error(`Alias word list has ${WORDS.length} words, expected 2048`);

/** The fingerprint's 256 bits hold 23 whole words. */
export const MAX_ALIAS_WORDS = Math.floor(256 / BITS_PER_WORD);
export const BASE_ALIAS_WORDS = 3;

/**
 * The first `count` words drawn from the fingerprint, 11 bits each from the most significant bit.
 * Identical on every machine, since it depends only on the fingerprint and the word list.
 */
export const aliasWords = (actorId: string, count: number): string => {
  if (!/^[0-9a-f]{64}$/.test(actorId))
    throw new TypeError("Expected a 64-digit hex fingerprint");
  if (count < 1 || count > MAX_ALIAS_WORDS)
    throw new RangeError(`An alias has 1 to ${MAX_ALIAS_WORDS} words`);
  const bits = BigInt(`0x${actorId}`);
  const words: Array<string> = [];
  for (let index = 0; index < count; index += 1) {
    const shift = BigInt(256 - BITS_PER_WORD * (index + 1));
    words.push(WORDS[Number((bits >> shift) & 0x7ffn)]!);
  }
  return words.join("-");
};

/** The three-word alias every actor starts from (D22). */
export const baseAlias = (actorId: string) =>
  aliasWords(actorId, BASE_ALIAS_WORDS);

/**
 * Aliases for every actor sharing one base alias, given in registration order (earliest first). The
 * first holder keeps the three words; each later one takes the shortest longer alias no earlier
 * holder has (D22). The result depends only on the set and its order, so a rebuild reproduces it.
 */
export const assignAliases = (
  holders: ReadonlyArray<string>,
): ReadonlyMap<string, string> => {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  for (const actorId of holders) {
    for (let count = BASE_ALIAS_WORDS; count <= MAX_ALIAS_WORDS; count += 1) {
      const alias = aliasWords(actorId, count);
      if (taken.has(alias)) continue;
      assigned.set(actorId, alias);
      taken.add(alias);
      break;
    }
    // Only fingerprints equal in their first 253 bits get here; the fingerprint itself is unique.
    if (!assigned.has(actorId)) assigned.set(actorId, actorId);
  }
  return assigned;
};
