import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
	type Attachment,
	Button,
	ChatComposer,
	type ChatComposerHandle,
	serialize,
	toast,
	useLocalStorage,
	useMedia,
} from "@ace/ui";
import {
	type ChatMode,
	type Effort,
	MAX_IMAGES,
	type ModelOption,
	type ModelRef,
	type QueuedMessage,
} from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import {
	AGENT_ALIAS,
	hasAgentMention,
	normalizeAgentDraft,
	withAgentMention,
	withoutAgentMentions,
	withoutLeadingAgentMention,
} from "./agent-mention";
import { useAgentAvatar } from "./agent-avatar";
import { agentMode, askMode, useChatMode } from "./composer-mode";
import { host } from "./host";
import { attachments } from "./attachments";
import { key, modelChoices } from "./model-choices";

const AGENT_MODE = {
	id: "ace",
	name: AGENT_ALIAS.label,
	placeholder: "Ask the agent",
	mention: AGENT_ALIAS.name,
	mentionAliases: ["ace"],
};
const MODES = [
	{ id: "chat", name: "Chat", placeholder: "Mention @neuve to ask the agent" },
	// No mention marks Plan: its messages are for the agent because of their mode.
	{ id: "plan", name: "Plan", placeholder: "Plan with the agent", color: "var(--agent-plan)" },
	AGENT_MODE,
];
// A teammate the owner hasn't let invoke sees no @neuve; the stored mode brings it back with access.
const BLOCKED_MODES = [{
	id: "chat",
	name: "Chat",
	placeholder: "Message the channel (agent access is off)",
}];
const UNKNOWN_MODES = [{ id: "chat", name: "Chat", placeholder: "Message the channel" }];
export const EFFORTS: Record<Effort, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** The latest pick in this client, as `provider/id` or `auto`; new channels start on it. */
export const LAST_MODEL = `ace:last-model:${host.url}`;

export function lastModel(): ModelRef | undefined {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(LAST_MODEL) || "null");
		if (typeof value !== "string" || value === "auto") return;
		const [provider, ...rest] = value.split("/");
		return { provider: provider!, modelId: rest.join("/") };
	} catch {
		return;
	}
}
// Errors a provider gives for the model or its key, which another try with them would repeat.
const MODEL_FAULT =
	/\b(401|403|404)\b|api key|unauthori[sz]ed|authenticat|permission|does not exist|not found|access to/i;
const RETRY = "Try again.";

type Props = {
	channel: Listing;
	chat: number;
	/** The chat's stored mode, which a chat this browser hasn't remembered opens in; absent while unknown. */
	chatMode?: ChatMode;
	user: string;
	current?: ModelRef;
	currentEffort?: Effort;
	/** What the channel picks for a chat on Automatic. */
	automatic?: ModelRef;
	busy: boolean;
	/** What a pending send waits on, as its submit control's label. */
	waiting: string;
	/** Whether teammates may invoke agents; absent while unknown. */
	shared?: boolean;
	ready: boolean;
	draft?: string;
	onDraftLoaded: () => void;
	/** Messages withdrawn from the chat's queue; the user's own come back into the draft. */
	returned: QueuedMessage[];
	/** The error of the chat's latest run, when it failed and nothing has run since. */
	failure?: string;
	onProviders?: () => void;
	accessory?: ReactNode;
	/** Whether the chat has a plan, so `plan.md` refers to it. */
	plan?: boolean;
	/** People to suggest after @, by GitHub login. */
	members: { name: string; avatar?: string }[];
};

/** Below the composer: its attachment tray rises over the space above it and takes clicks there. */
export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div
			className="mt-2 flex items-center justify-between gap-3 px-3 text-xs text-muted-foreground"
			role="status"
		>
			<p>{children}</p>
			{action}
		</div>
	);
}

/** A failed admission keeps the draft and attachments available for retry. */
export function Composer(
	{
		channel,
		chat: id,
		chatMode,
		user,
		current,
		currentEffort,
		automatic,
		busy,
		waiting,
		shared,
		ready,
		draft,
		onDraftLoaded,
		returned,
		failure,
		onProviders,
		accessory,
		plan,
		members,
	}: Props,
) {
	const composer = useRef<ChatComposerHandle>(null);
	const sending = useRef(false);
	const typed = useRef(0);
	const [pending, setPending] = useState(false);
	const [attached, setAttached] = useState<Attachment[]>([]);
	const scope = `/channels/${channel.id}`;
	// Kept so a deliberate mode survives relaunch; until one is chosen here, the chat's own.
	const [stored, changeMode] = useChatMode(channel.id, id, chatMode);
	const [, setLast] = useLocalStorage(LAST_MODEL, "auto");
	// The channel refuses a blocked teammate's ask, stop, and kill too.
	const blocked = shared === false && channel.owner !== user;
	// Agent mode only once a teammate's access is known to be on, as it isn't while their Mac is offline.
	const agents = channel.owner === user || shared === true;
	const mode = agents ? stored : "chat";
	const agentic = !!agentMode(mode);
	const avatar = useAgentAvatar();
	const mentions = useMemo(
		() => agents ? [{ name: AGENT_ALIAS.name, avatar }, ...members] : members,
		[agents, members, avatar],
	);
	const [models, setModels] = useState<ModelOption[]>();
	const [modelError, setModelError] = useState<string>();
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	// An agent draft leads with the agent's mention, except in Plan, which has no marker.
	const agentDraft = (text: string) =>
		mode === "plan"
			? withoutLeadingAgentMention(normalizeAgentDraft(text))
			: withAgentMention(normalizeAgentDraft(text));
	useEffect(() => {
		if (!draft) return;
		composer.current?.set(agentDraft(draft));
		onDraftLoaded();
	}, [draft, onDraftLoaded]);
	// A saved agent draft keeps its words as a message; its mention returns with access, from the mode.
	useEffect(() => {
		if (!blocked) return;
		const doc = composer.current?.get();
		const text = doc ? serialize(doc) : "";
		if (hasAgentMention(text)) composer.current?.set(withoutAgentMentions(text));
	}, [blocked]);
	// Each withdrawn message returns once, ahead of whatever the user has typed since.
	const restored = useRef(new Set<number>());
	useEffect(() => {
		const mine = returned.filter((message) =>
			message.author === user && !restored.current.has(message.submission)
		);
		if (!mine.length) return;
		for (const message of mine) restored.current.add(message.submission);
		const doc = composer.current?.get();
		// One leading mention invokes the whole draft; an empty agent-mode composer holds only that.
		const text = [...mine.map((message) => message.text), doc ? serialize(doc) : ""]
			.map(withoutLeadingAgentMention).filter(Boolean).join("\n\n");
		composer.current?.set(
			blocked ? withoutAgentMentions(text) : agentDraft(text),
		);
		const images = mine.flatMap((message) => message.images || []);
		const files = mine.flatMap((message) => message.files || []);
		if (images.length || files.length) {
			setAttached((current) => [
				...current,
				...images.map((image, index) => ({
					id: crypto.randomUUID(),
					name: `Image ${index + 1}`,
					type: image.mimeType,
					preview: `data:${image.mimeType};base64,${image.data}`,
				})),
				...files.map(({ name, text }) => {
					const file = new File([text], name, { type: "text/plain" });
					return { id: crypto.randomUUID(), name, type: file.type, size: file.size, file };
				}),
			]);
		}
		toast(
			mine.length === 1
				? "Stopped before your queued message ran"
				: `Stopped before ${mine.length} of your queued messages ran`,
			{ description: `${mine.length === 1 ? "It's" : "They're"} back in the composer.` },
		);
	}, [returned, user, blocked]);
	// An offline channel can't answer; the conversation already says so, so don't blame providers.
	const offline = channel.state === "offline";
	useEffect(() => {
		// A chat that can't load can't answer either; asking again once it loads is how a refused
		// channel's models recover, such as after a cloud workspace starts or Try again.
		if (status !== "open" || !agentic || offline || !ready) return;
		let active = true;
		// Ask the channel itself: a hosted channel uses the service's credentials, not its workspace's.
		host.channel<ModelOption[]>(channel.id, { op: "models" }).then(
			(models) => {
				if (!active) return;
				setModels(models);
				setModelError(undefined);
			},
			(error: Error) => {
				if (!active) return;
				setModels([]);
				setModelError(error.message);
			},
		);
		return () => {
			active = false;
		};
	}, [channel.id, agentic, status, settingsVersion, offline, ready]);
	// The chat holds the pick, so details, the CLI and other clients name what its next run uses.
	// A pick shows until the chat's info reports a change, which follows the pick's own answer.
	const chosen = `${current ? key(current) : "auto"} ${currentEffort || "off"}`;
	const [picking, setPicking] = useState<{ model: string; effort?: Effort; from: string }>();
	if (picking && picking.from !== chosen) setPicking(undefined);
	const { model, choices, unoffered } = modelChoices(
		models,
		picking?.model || (current ? key(current) : "auto"),
		automatic,
	);
	const levels = models?.find((value) => key(value) === model)?.efforts;
	const requestedEffort = picking?.effort || currentEffort || "off";
	const effort = requestedEffort === "off" || levels?.includes(requestedEffort)
		? requestedEffort
		: "off";
	const efforts = levels && levels.some((level) => level !== "off")
		? (levels.includes("off") ? levels : ["off" as const, ...levels]).map((id) => ({
			id,
			name: id === "off" && !levels.includes("off") ? "Default" : EFFORTS[id],
		}))
		: undefined;
	// Formatting tools crowd a phone's composer; they stay one tap away.
	const phone = useMedia("(width < 40rem)");

	function attach(next: Attachment[]) {
		let images = 0;
		const kept = next.filter((item) => !item.type.startsWith("image/") || ++images <= MAX_IMAGES);
		if (kept.length < next.length) {
			const left = next.length - kept.length;
			toast(`A message can carry ${MAX_IMAGES} images`, {
				description: left === 1 ? "One image wasn't attached." : `${left} images weren't attached.`,
			});
		}
		setAttached(kept);
	}

	async function pick(next: string, nextEffort?: Effort) {
		const from = chosen;
		setPicking({ model: next, effort: nextEffort, from });
		const [provider, ...rest] = next.split("/");
		try {
			const result = await host.channel<{ model: ModelRef; effort: Effort }>(channel.id, {
				op: "select",
				chat: id,
				author: user,
				...(next === "auto"
					? { automatic: true }
					: { model: { provider: provider!, modelId: rest.join("/") } }),
				...(nextEffort ? { effort: nextEffort } : {}),
			});
			setPicking({ model: key(result.model), effort: result.effort, from });
			setLast(next);
		} catch (error) {
			setPicking(undefined);
			const { message } = error as Error;
			toast.error("Could not change the model", {
				description: message,
				...(onProviders && /provider key/i.test(message)
					? { action: { label: "Providers", onClick: onProviders } }
					: {}),
			});
		}
	}

	async function send(text: string, mode: string, attached: Attachment[]) {
		if (sending.current) return;
		// Posted, a blocked teammate's "@neuve" would read as an ask nobody answers.
		if (blocked && hasAgentMention(text)) {
			toast.error("Agent access is off", {
				description:
					"The owner hasn't let teammates ask this channel's agent. Remove the agent mention to send this as a message.",
			});
			return;
		}
		const carried = blocked ? undefined : agentMode(mode);
		const invoke = !blocked && (!!carried || hasAgentMention(text));
		const change = blocked ? undefined : askMode(mode, chatMode);
		const body = text.trim();
		if (!body && !attached.length) return;
		// The channel would refuse it for want of a key; setup keeps the draft for sending after.
		if (carried && models?.length === 0 && !modelError && onProviders) {
			return onProviders();
		}
		const doc = composer.current?.get();
		sending.current = true;
		setPending(true);
		try {
			const encoded = await attachments(attached);
			if (invoke) {
				// The chat holds the pick; asking without a model lets the channel replace one whose
				// provider lost its key.
				await host.channel(channel.id, {
					op: "ask",
					chat: id,
					author: user,
					text: body,
					...encoded,
					...(change ? { mode: change } : {}),
				});
			} else {
				await host.channel(channel.id, {
					op: "say",
					chat: id,
					author: user,
					text: body,
					...encoded,
				});
			}
			if (composer.current?.get() === doc) composer.current?.clear();
			const sent = new Set(attached);
			setAttached((current) => current.filter((value) => !sent.has(value)));
		} catch (error) {
			const { message } = error as Error;
			// Only a missing key is fixed in Providers; busy, access and size errors are not.
			const keys = invoke && onProviders && /provider key/i.test(message);
			toast.error(invoke ? "Could not invoke agent" : "Could not send message", {
				description: message,
				...(keys ? { action: { label: "Providers", onClick: onProviders } } : {}),
			});
		} finally {
			sending.current = false;
			setPending(false);
		}
	}

	// Retrying a model's own failure on that model would fail again, so it hands the choice back.
	const reset = !!failure && MODEL_FAULT.test(failure) && model !== "auto";
	async function retry() {
		if (sending.current) return;
		sending.current = true;
		setPending(true);
		try {
			await host.channel(channel.id, {
				op: "ask",
				chat: id,
				author: user,
				text: RETRY,
				...(reset ? { automatic: true } : {}),
			});
			if (reset) {
				toast("Switched this chat to Automatic", {
					description: `${model} failed, so Retry let Neuve choose the model.`,
				});
			}
		} catch (error) {
			toast.error("Could not retry", { description: (error as Error).message });
		} finally {
			sending.current = false;
			setPending(false);
		}
	}

	return (
		<>
			<ChatComposer
				ref={composer}
				accessory={accessory}
				scope={scope}
				tools={!phone}
				mic
				modes={agents ? MODES : blocked ? BLOCKED_MODES : UNKNOWN_MODES}
				mode={mode}
				onModeChange={changeMode}
				mentions={mentions}
				plan={plan}
				models={choices}
				model={model}
				onModelChange={(value) => void pick(value)}
				efforts={efforts}
				effort={effort}
				onEffortChange={(value) => void pick(model, value as Effort)}
				attachments={attached}
				onAttachmentsChange={attach}
				busy={busy}
				submitBusy={pending}
				submitLabel={waiting}
				onTypingChange={(value) => {
					// Watchers drop a typist after 5 s without a signal, so one every 3 s keeps them shown.
					if (!value || !ready || Date.now() - typed.current < 3000) return;
					typed.current = Date.now();
					host.channel(channel.id, { op: "typing", chat: id, author: user }).catch(() => {});
				}}
				canStop={busy && !blocked}
				onStop={() => void host.channel(channel.id, { op: "stop", chat: id, author: user })}
				canSend={ready && status === "open" && !pending}
				clearOnSend={false}
				onSend={({ doc, mode, attachments }) => void send(serialize(doc), mode, attachments)}
			/>
			{failure && !blocked && !busy && (
				<Notice
					action={
						<Button
							size="sm"
							variant="outline"
							disabled={!ready || status !== "open" || pending}
							onClick={() => void retry()}
						>
							Retry
						</Button>
					}
				>
					{reset
						? `The last run failed on ${model}. Retry switches this chat to Automatic.`
						: "The last run failed."}
				</Notice>
			)}
			{agentic && unoffered && (
				<Notice>{unoffered} is no longer offered, so this chat uses Automatic.</Notice>
			)}
			{agentic && !offline && models?.length === 0 && (
				<Notice
					action={onProviders && (
						<Button size="sm" variant="outline" onClick={onProviders}>
							{modelError ? "Provider settings" : "Set up a provider"}
						</Button>
					)}
				>
					{modelError || "Add a provider to use Neuve. You can still send messages in Chat mode."}
				</Notice>
			)}
		</>
	);
}
