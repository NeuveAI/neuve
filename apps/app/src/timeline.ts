import {
  type AgentName,
  PLAN_COMMENT_TOOL,
  PLAN_TOOL,
  type QueuedMessage,
  type Reactions,
} from "@ace/channel/protocol";
import type { Listing, People } from "@ace/host/protocol";
import type { Event } from "@ace/ui";

import { AGENT_ALIAS, withAgentMention } from "./agent-mention";
import { agentAuthor, agentName, mentionName } from "./build-card";
import { placement } from "./placement";
import { planTool } from "./plan-card";
import { commentWords, type Said } from "./plan-comments";
import {
  type ReviewCards,
  reviewNotice,
  reviewTool,
  wakeNote,
  wakePhase,
} from "./review-card";
import type { Item, Tool } from "./transcript";

/** The sender value of this channel's agent, which also keys its avatar. */
export const AGENT = "ace:agent";

/**
 * Channels on the viewed channel's host keyed by the author their agent's messages carry. The prefix
 * outlives renames, so messages sent before one still find their channel.
 */
export function sources(
  channels: Listing[],
  host: string,
): Map<string, Listing> {
  return new Map(
    channels.flatMap((channel) =>
      channel.host === host && channel.prefix
        ? [[`agent@${channel.prefix}`, channel]]
        : [],
    ),
  );
}

/**
 * Human authors are Tailscale logins; without a known GitHub login, the name before the domain
 * reads as a handle. A build's agent goes by its role; other agent authors name the chat or
 * channel after the `@`, so they stay whole.
 */
export function authorName(
  author: string,
  people: People,
  channels: Map<string, Listing>,
  agents?: ReadonlyMap<string, AgentName>,
): string {
  const agent = agents?.get(author);
  if (agent) return agentName(agent);
  const source = channels.get(author);
  if (source) return `#${source.name}`;
  if (author.startsWith("agent@")) return author;
  return people[author] || author.split("@")[0]!;
}

/**
 * People get withdrawn messages back as drafts. Another channel's agent has no composer, so its
 * message stays withdrawn, and naming that channel tells whoever stopped where to follow up.
 */
function withdrawal(
  messages: QueuedMessage[],
  people: People,
  channels: Map<string, Listing>,
  roles: ReadonlyMap<string, AgentName>,
): string {
  const names = (authors: string[]) =>
    [...new Set(authors)]
      .map((author) => authorName(author, people, channels, roles))
      .join(", ");
  // The host's review wake belongs to no person, so it is neither returned nor named.
  const notes = messages.filter((message) => reviewNotice(message));
  const others = messages.filter((message) => !message.system);
  const humans = others.filter(
    (message) => !message.author.startsWith("agent@"),
  );
  const agents = others.filter((message) =>
    message.author.startsWith("agent@"),
  );
  const lines = [];
  if (humans.length) {
    const many = humans.length > 1;
    lines.push(
      `Returned ${humans.length} queued ${many ? "messages" : "message"} to ${names(
        humans.map((message) => message.author),
      )} as ${many ? "drafts" : "a draft"}.`,
    );
  }
  if (agents.length) {
    const count =
      agents.length === 1
        ? "a queued message"
        : `${agents.length} queued messages`;
    lines.push(
      `Withdrew ${count} from ${names(agents.map((message) => message.author))}.`,
    );
  }
  if (notes.length)
    lines.push("Withdrew Neuve's note telling the agent the review ended.");
  return lines.join(" ");
}

/**
 * Who asked for a teammate's run and what ran it, written for the viewer. A local channel's agents
 * run as its owner on the owner's host with the owner's model keys; a hosted or cloud channel's
 * service runs them with its own keys.
 */
export function credit(
  asker: string,
  channel: Listing,
  user: string,
  people: People,
  channels: Map<string, Listing>,
): string | undefined {
  if (asker === channel.owner || asker.startsWith("agent@")) return;
  const name = (login: string) =>
    login === user ? "you" : authorName(login, people, channels);
  const place = placement(channel);
  const where =
    place.kind === "cloud"
      ? `ran in a cloud container on ${place.service} with its key`
      : place.kind === "hosted"
        ? `ran on ${place.workspace} with ${place.service}'s key`
        : channel.owner === user
          ? `ran on your ${place.host} with your key`
          : `ran on ${name(channel.owner)}'s ${place.host} with their key`;
  return `asked by ${name(asker)} · ${where}`;
}

const NOT_RUN = "Not run";

/** The agent's answer to a plan comment, which is its words to the person, not a tool's output. */
function commentAnswer(tool: Tool) {
  if (tool.name !== PLAN_COMMENT_TOOL || !tool.result || tool.result.error)
    return;
  const { text } = tool.args as { text?: unknown };
  return typeof text === "string" ? text : undefined;
}

function tool(
  tool: Tool,
  busy: boolean,
  reviews: ReviewCards,
  caption?: string,
  recap?: string,
): Event.Message.Content.Tool {
  const status = tool.result
    ? tool.result.error
      ? "error"
      : "success"
    : busy
      ? "start"
      : "error";
  // Neuve's review tools and the plan's writing tool read as one plain line; their state lives in their card.
  const review = reviewTool(tool, reviews) ?? planTool(tool);
  return {
    type: "tool",
    id: tool.call,
    name: review?.name ?? tool.name,
    arguments: review
      ? review.summary
        ? { summary: review.summary }
        : {}
      : ((tool.args ?? {}) as Record<string, unknown>),
    status,
    ...(tool.unrun ? { caption: NOT_RUN } : caption ? { caption } : {}),
    ...(recap ? { recap } : {}),
    ...(tool.unrun
      ? {
          result: {
            content: `${NOT_RUN}: the run ended while the agent was writing this call.`,
          },
        }
      : {}),
    ...(tool.result
      ? {
          result: {
            content: review?.result ?? tool.result.text,
            ...(tool.result.images
              ? {
                  images: tool.result.images.map(
                    (image) => `data:${image.mimeType};base64,${image.data}`,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(!tool.result && tool.progress
      ? {
          result: {
            content: tool.progress.truncated
              ? `… earlier output not shown\n${tool.progress.text}`
              : tool.progress.text,
          },
        }
      : {}),
  };
}

/**
 * Channel transcript items in the shape the original timeline renders. The streamed draft joins
 * the timeline as the newest agent message so it is laid out and scrolled like the rest.
 */
/**
 * A message's text as the timeline draws it. A send of plan comments is drawn as the person's own
 * words from `sends`, and the channel names no one in it, so no `@name` in it is drawn as a mention.
 */
export function withMention(
  item: { entry?: number; invoked: boolean; text: string },
  sends: ReadonlyMap<number, Said[]>,
) {
  let said = item.entry === undefined ? undefined : sends.get(item.entry);
  // A word joiner after the @ keeps the words as written and makes them no mention token.
  if (said)
    return commentWords(said, true).replace(
      /(^|[\s([{])@(?=[\w-])/gm,
      "$1@\u2060",
    );
  return item.invoked ? withAgentMention(item.text) : item.text;
}

export function toEvents(
  items: Item[],
  topic: string,
  busy: boolean,
  draft: { text: string; model?: string },
  people: People,
  channels: Map<string, Listing>,
  captions: Record<string, string>,
  recaps: Record<string, string>,
  reactions: Reactions,
  by: (asker: string) => string | undefined,
  reviews: ReviewCards,
  sends: ReadonlyMap<number, Said[]> = new Map(),
  agents: ReadonlyMap<string, AgentName> = new Map(),
  /** The build's agent this chat is, whose replies go by its role. */
  self?: { author: string; agent: AgentName },
): Event[] {
  // A run answers the newest message that invoked it, as the channel's run end reports.
  let asker: string | undefined;
  const name = (author: string) => authorName(author, people, channels, agents);
  // The parts are the only names drawn as mentions: an agent's name only where `listed`, the
  // agents the message reached, holds it. The parser decides where a mention sits, so any `@name`,
  // bold included, is offered here.
  const names = new Set([...agents.values()].map(mentionName));
  const text = (
    value: string,
    listed: ReadonlySet<string> = new Set(),
  ): Event.Message.Content.Text => {
    const parts = [...value.matchAll(/@([\w-]+)/g)].flatMap((match) => {
      const name = match[1]!.toLowerCase();
      return names.has(name) && !listed.has(name)
        ? []
        : [{ type: "mention" as const, value: match[1]!, index: match.index }];
    });
    return { type: "text", text: value, parts };
  };
  const sender = (model: string | undefined): Event.Sender.Agent => {
    const value = [model, asker && by(asker)].filter(Boolean).join(" · ");
    return {
      kind: "agent",
      value: self?.author ?? AGENT,
      display: self ? agentName(self.agent) : AGENT_ALIAS.label,
      ...(value ? { credit: value } : {}),
    };
  };
  const events = items.map((item) => {
    const reacted =
      item.entry === undefined ? undefined : reactions[item.entry];
    const base = {
      id: `${topic}::${item.key}`,
      uid: item.key,
      type: "message",
      topic,
      created_at: Math.floor(item.at / 1000),
      ...(reacted
        ? {
            reactions: reacted.map(({ from, emoji }) => ({
              from,
              display: name(from),
              emoji,
            })),
          }
        : {}),
    } as const;
    // The host's notify wake reads as a quiet Neuve row, and the run it starts was asked by no one.
    const wake = wakeNote(item);
    if (wake) {
      asker = undefined;
      return {
        ...base,
        type: "neuve:review:told",
        review: wake.review,
        phase: wakePhase(reviews, wake.review),
      } as Event;
    }
    if (item.kind === "message") {
      // The host's brief to a build's agent is Neuve's, and the run it starts was asked by no one.
      const brief = item.system?.kind === "neuve:build:brief";
      if (brief) asker = undefined;
      else if (item.invoked) asker = item.author;
      const listed = new Set(
        (item.agents ?? []).flatMap((chat) => {
          const agent = agents.get(agentAuthor(chat));
          return agent ? [mentionName(agent)] : [];
        }),
      );
      return {
        ...base,
        sender: brief
          ? { kind: "user", value: AGENT, display: AGENT_ALIAS.label }
          : { kind: "user", value: item.author, display: name(item.author) },
        ...(item.edited && !item.deleted
          ? { last_updated: Math.floor(item.edited / 1000) }
          : {}),
        content: item.deleted
          ? [text("Message deleted")]
          : [
              // Every input to a build's agent asks that agent, so no @neuve is drawn there.
              text(
                brief || self ? item.text : withMention(item, sends),
                listed,
              ),
              ...(item.images || []).map((image) => ({
                type: "image" as const,
                image: `data:${image.mimeType};base64,${image.data}`,
              })),
              // Contents travel in the transcript, not at a URL; the block opens them.
              ...(item.files || []).map((file) => ({
                type: "file" as const,
                name: file.name,
                file: "",
                text: file.text,
              })),
            ],
      } as Event;
    }
    if (item.kind === "review-commits") {
      const { review, branch, reviewedHead, head, label } = item;
      return {
        ...base,
        type: "neuve:review:new-commits",
        review,
        branch,
        reviewedHead,
        head,
        label,
      } as Event;
    }
    // Models narrate before calling tools, so the text introduces the group that follows it.
    const content: Event.Message.Agent["content"] = item.text
      ? [text(item.text)]
      : [];
    for (const call of item.tools) {
      const answer = commentAnswer(call);
      content.push(
        answer === undefined
          ? tool(call, busy, reviews, captions[call.call], recaps[call.call])
          : text(answer),
      );
    }
    for (const call of item.tools) {
      const name =
        (reviewTool(call, reviews) ?? planTool(call))?.name ?? call.name;
      if (call.result?.interrupted) {
        content.push(
          text(
            `The channel restarted while ${name} ran, so it may have partially run.`,
          ),
        );
      }
      if (call.result?.handoff) {
        content.push(
          text(`Stopped ${name} for a message from another channel.`),
        );
      }
    }
    if (item.error) content.push(text(`Run failed: ${item.error}`));
    if (item.stopped) {
      content.push(
        text(item.stopper ? `Stopped by ${name(item.stopper)}.` : "Stopped."),
      );
    }
    if (item.withdrawn)
      content.push(text(withdrawal(item.withdrawn, people, channels, agents)));
    return {
      ...base,
      sender: sender(item.model),
      content,
      // Each reply carries the mode its own run ran in, so earlier replies keep their label. A turn
      // that only wrote the plan sends no reply, but the plan tool succeeds only in plan mode.
      ...(item.mode === "plan" ||
      item.tools.some(
        (tool) => tool.name === PLAN_TOOL && tool.result && !tool.result.error,
      )
        ? { agent: { mode: "plan" } }
        : {}),
    } as Event;
  });
  if (!draft.text) return events;
  events.push({
    id: `${topic}::draft`,
    uid: "draft",
    type: "message",
    topic,
    created_at: Math.floor(Date.now() / 1000),
    sender: sender(draft.model),
    content: [text(draft.text)],
    streaming: true,
  } as Event);
  return events;
}
