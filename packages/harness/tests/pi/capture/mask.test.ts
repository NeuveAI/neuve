// Why: the raw-capture mask ran over serialized JSON, so an email right after an escape (`\nann@…`)
// took the escape's letter with it and left records that no longer parse (6 of 14,260, review
// parity §7). These pin the stored-record boundary: masking over parsed strings keeps every record
// readable with its keys and escapes, and input that is not JSON is reported, not repaired.
import { expect, test } from "bun:test";
import {
  maskJson,
  maskJsonText,
  maskRecord,
  withholdReasoning,
} from "../../../src/pi/capture/mask.ts";
import type { Json } from "../../../src/pi/capture/types.ts";

test("masks emails inside escaped strings and keeps keys, quotes, arrays, null and numbers", () => {
  const text = JSON.stringify({
    "ann@example.com": "key stays",
    note: 'line one\nann@example.com said "ship it"\tthen left',
    nested: [[`path\\to\\bob@example.org`], null, 42, 1.5, true],
    pasted: "sk-ant-abcdefghijklmnop",
  });
  const masked = maskJsonText(text);
  expect(masked).toEqual({
    _tag: "Masked",
    text: JSON.stringify({
      "ann@example.com": "key stays",
      note: 'line one\n<email> said "ship it"\tthen left',
      nested: [["path\\to\\<email>"], null, 42, 1.5, true],
      pasted: "sk-ant-<masked>",
    }),
  });
});

const frozen = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};

test("a credential key keeps its name and loses its value, and the input is never changed", () => {
  const input = frozen(
    JSON.parse(
      '{"headers":{"Authorization":"Bearer abc","x-api-key":"k1"},"api_key":"plain","refreshToken":{"value":"r"},"__proto__":{"note":"ann@example.com"},"input_tokens":12,"password":null}',
    ) as Json,
  );
  const before = JSON.stringify(input);
  const masked = maskJson(input);
  expect(JSON.stringify(masked)).toBe(
    '{"headers":{"Authorization":"<masked>","x-api-key":"<masked>"},"api_key":"<masked>","refreshToken":"<masked>","__proto__":{"note":"<email>"},"input_tokens":12,"password":null}',
  );
  expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
  expect(JSON.stringify(input)).toBe(before);
});

// Synthetic reasoning only: real summaries are never printed. Each opaque or readable reasoning
// field carries an email-shaped string, so a mask that ran inside it would show.
const REASONING = {
  input: [
    {
      type: "reasoning",
      encrypted_content: "gAAAA-ann@example.com",
      summary: [{ type: "summary_text", text: "synthetic ann@example.com" }],
    },
  ],
  pi: {
    type: "thinking",
    thinking: "synthetic ann@example.com",
    thinkingSignature: '{"id":"rs_1","by":"ann@example.com"}',
  },
  anthropic: [
    { type: "thinking", thinking: "synthetic plan", signature: "EqQB@x.io" },
    { type: "redacted_thinking", data: "EmwKAh" },
    { type: "text", text: "mail ann@example.com", signature: "kept@x.io" },
  ],
  events: [
    {
      name: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        delta: "ann@example.com",
      },
    },
    { name: "rate_limits", data: { owner: "ann@example.com" } },
    {
      name: "content_block_delta",
      data: {
        type: "content_block_delta",
        delta: {
          type: "thinking_delta",
          thinking: "synthetic ann@example.com",
        },
      },
    },
    {
      name: "content_block_delta",
      data: {
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: "Sig@x.io" },
      },
    },
  ],
} as const;

test("a restricted capture keeps provider continuation and reasoning byte for byte and masks the rest", () => {
  const input = frozen(REASONING as unknown as Json);
  expect(maskRecord(input, [])).toEqual({
    ...REASONING,
    anthropic: [
      REASONING.anthropic[0],
      REASONING.anthropic[1],
      { type: "text", text: "mail <email>", signature: "<email>" },
    ],
    events: [
      REASONING.events[0],
      { name: "rate_limits", data: { owner: "<email>" } },
      REASONING.events[2],
      REASONING.events[3],
    ],
  });
});

test("a portable copy withholds every continuation and reasoning payload and says so", () => {
  const input = frozen(REASONING as unknown as Json);
  expect(withholdReasoning(maskRecord(input, []))).toEqual({
    input: [
      {
        type: "reasoning",
        encrypted_content: "<withheld: encrypted reasoning, 21 characters>",
        summary: [
          {
            type: "summary_text",
            text: "<withheld: reasoning summary, 25 characters>",
          },
        ],
      },
    ],
    pi: {
      type: "thinking",
      thinking: "<withheld: reasoning summary, 25 characters>",
      thinkingSignature: "<withheld: encrypted reasoning, 36 characters>",
    },
    anthropic: [
      {
        type: "thinking",
        thinking: "<withheld: reasoning summary, 14 characters>",
        signature: "<withheld: encrypted reasoning, 9 characters>",
      },
      {
        type: "redacted_thinking",
        data: "<withheld: encrypted reasoning, 6 characters>",
      },
      { type: "text", text: "mail <email>", signature: "<email>" },
    ],
    events: [
      {
        name: "response.reasoning_summary_text.delta",
        data: {
          type: "response.reasoning_summary_text.delta",
          delta: "<withheld: reasoning summary, 15 characters>",
        },
      },
      { name: "rate_limits", data: { owner: "<email>" } },
      {
        name: "content_block_delta",
        data: {
          type: "content_block_delta",
          delta: {
            type: "thinking_delta",
            thinking: "<withheld: reasoning summary, 25 characters>",
          },
        },
      },
      {
        name: "content_block_delta",
        data: {
          type: "content_block_delta",
          delta: {
            type: "signature_delta",
            signature: "<withheld: encrypted reasoning, 8 characters>",
          },
        },
      },
    ],
  });
});

test("portable withholding traverses native content roles and nested JSON while preserving ordinary payloads", () => {
  const ordinary = {
    reasoning: "user explanation",
    summary: "user summary",
    thinking: "user thought",
    content: "ordinary content",
    metadata: { reasoning: true, summary: false },
    model: { reasoning: true },
  };
  const provider = {
    type: "reasoning",
    id: "rs_wrapped",
    summary: [
      { type: "summary_text", text: "private first" },
      { type: "summary_text", text: "private second" },
    ],
    encrypted_content: "opaque continuation",
  };
  const withheld = {
    ...provider,
    summary: [
      {
        type: "summary_text",
        text: "<withheld: reasoning summary, 13 characters>",
      },
      {
        type: "summary_text",
        text: "<withheld: reasoning summary, 14 characters>",
      },
    ],
    encrypted_content: "<withheld: encrypted reasoning, 19 characters>",
  };
  for (const role of ["user", "system", "toolResult"]) {
    const payload = { ordinary, provider, native: REASONING.pi };
    const expected = {
      ordinary,
      provider: withheld,
      native: {
        type: "thinking",
        thinking: "<withheld: reasoning summary, 25 characters>",
        thinkingSignature: "<withheld: encrypted reasoning, 36 characters>",
      },
    };
    for (const depth of [1, 2]) {
      const encode = (value: Json): Json => {
        let encoded = value;
        for (let i = 0; i < depth; i++) encoded = JSON.stringify(encoded);
        return encoded;
      };
      for (const blocks of [false, true]) {
        const content = (value: Json): Json =>
          blocks ? [{ type: "text", text: encode(value) }] : encode(value);
        const input = frozen({ role, content: content(payload) });
        const before = JSON.stringify(input);
        const portable = withholdReasoning(input);
        expect(portable).toEqual({ role, content: content(expected) });
        expect(JSON.stringify(portable)).not.toContain("private first");
        expect(JSON.stringify(portable)).not.toContain("opaque continuation");
        expect(JSON.stringify(portable)).not.toContain("ann@example.com");
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  }
});

test("text with nothing to mask comes back byte for byte", () => {
  const text = '{ "a" : "caf\\u00e9", "b": [1, 2.50] }';
  expect(maskJsonText(text)).toEqual({ _tag: "Masked", text });
});

test("text that is not JSON is malformed, never masked as text", () => {
  const result = maskJsonText('{"note": "ann@example.com"');
  expect(result._tag).toBe("Malformed");
});
