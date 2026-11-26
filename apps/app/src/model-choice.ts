import { useEffect, useState, useSyncExternalStore } from "react";

import { toast } from "@ace/ui";
import type { Effort, ModelOption, ModelRef, PendingModel } from "@ace/channel/protocol";
import type { ChannelInfo, Listing } from "@ace/host/protocol";
import type { AccountStatus } from "@neuve/runtime/status";

import { publish } from "./details";
import { host } from "./host";
import { key, listed } from "./listed-models";

export const EFFORTS: Record<Effort, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

// One `models` request per channel at a time; every caller meanwhile takes its answer.
const asking = new Map<string, Promise<ModelOption[]>>();

function ask(channel: string): Promise<ModelOption[]> {
	let found = asking.get(channel);
	if (!found) {
		// Ask the channel itself: a hosted channel uses the service's credentials, not its workspace's.
		found = host.channel<ModelOption[]>(channel, { op: "models" }).finally(() => asking.delete(channel));
		asking.set(channel, found);
	}
	return found;
}

/**
 * The channel's models, asked again when the host's settings change and whenever `enabled` turns
 * on, which is how a refused channel's models recover, such as after a cloud workspace starts.
 */
export function useModels(channel: Listing, enabled: boolean) {
	const [models, setModels] = useState<ModelOption[]>();
	const [error, setError] = useState<string>();
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	// An offline channel can't answer; the conversation already says so.
	const offline = channel.state === "offline";
	useEffect(() => {
		if (status !== "open" || !enabled || offline) return;
		let active = true;
		ask(channel.id).then(
			(models) => {
				if (!active) return;
				setModels(models);
				setError(undefined);
			},
			(error: Error) => {
				if (!active) return;
				setModels([]);
				setError(error.message);
			},
		);
		return () => {
			active = false;
		};
	}, [channel.id, enabled, status, settingsVersion, offline]);
	return { models, error };
}

type Shown = {
	/** The picker's list: Automatic, then each model once, named with its provider where two share a name. */
	choices: { id: string; name: string; vendor: string }[];
	/** The picked row's id, or `auto` for a stored model no account offers, which runs Automatic. */
	model: string;
	/** The picked model's levels; absent for a model with none. */
	efforts?: { id: string; name: string }[];
	effort: Effort;
};

/** What the picker shows for `picked` and `requested`, from the channel's own list of models. */
export function shown(
	models: readonly ModelOption[],
	picked: string,
	requested: Effort,
	accounts?: readonly AccountStatus[],
	automatic?: ModelRef,
): Shown {
	const { rows, picked: kept } = listed(models, picked, accounts);
	const model = rows.length && !rows.some((value) => key(value) === kept) ? "auto" : kept;
	const levels = rows.find((value) => key(value) === model)?.efforts;
	const effort = requested === "off" || levels?.includes(requested) ? requested : "off";
	const efforts = levels && levels.some((level) => level !== "off")
		? (levels.includes("off") ? levels : ["off" as const, ...levels]).map((id) => ({
			id,
			name: id === "off" && !levels.includes("off") ? "Default" : EFFORTS[id],
		}))
		: undefined;
	const choices = rows.map((value) => ({ id: key(value), name: value.name, vendor: value.provider }));
	if (model !== "auto" && !choices.some((value) => value.id === model)) {
		choices.unshift({ id: model, name: model.split("/").slice(1).join("/"), vendor: "" });
	}
	// Automatic stays offered so a chat whose model lost its key can hand the choice back.
	choices.unshift({
		id: "auto",
		name: automatic ? `Automatic (${automatic.modelId})` : "Automatic",
		vendor: "",
	});
	return { choices, model, efforts, effort };
}

type Values = { model?: ModelRef; effort?: Effort; pending?: PendingModel };
type Answer = { model: ModelRef; effort: Effort; pending?: PendingModel };

const id = (model?: ModelRef) => model ? key(model) : "auto";

/**
 * A chat's model and effort as one picker shows and sets them: the composer's, and its agent's line.
 * `next` is what the chat's next run uses, the pending change over the running value; `running`
 * is there only while a pending change differs from it.
 */
export function useModelChoice(
	channel: string,
	chat: number,
	user: string,
	values: Values,
	models: readonly ModelOption[] | undefined,
	automatic?: ModelRef,
	options: { onPicked?: (model: string) => void; onProviders?: () => void } = {},
) {
	const accounts = useSyncExternalStore(host.subscribe, () => host.accounts);
	const target = {
		model: values.pending?.model ?? values.model,
		effort: values.pending?.effort ?? values.effort ?? "off",
	};
	// A pick shows until the chat reports a change, which follows the pick's own answer.
	const chosen = `${id(target.model)} ${target.effort}`;
	const [picking, setPicking] = useState<{ model: string; effort?: Effort; from: string; pending?: boolean }>();
	if (picking && picking.from !== chosen) setPicking(undefined);
	const list = models || [];
	const next = shown(list, picking?.model || id(target.model), picking?.effort || target.effort, accounts, automatic);
	const running = values.pending || picking?.pending
		? shown(list, id(values.model), values.effort ?? "off", accounts, automatic)
		: undefined;

	async function pick(model: string, effort?: Effort) {
		const from = chosen;
		setPicking({ model, effort, from });
		const [provider, ...rest] = model.split("/");
		try {
			const answer = await host.channel<Answer>(channel, {
				op: "select",
				chat,
				author: user,
				...(model === "auto"
					? { automatic: true }
					: { model: { provider: provider!, modelId: rest.join("/") } }),
				...(effort ? { effort } : {}),
			});
			// A busy chat keeps the change pending, which is what its next run uses.
			setPicking({
				model: key(answer.pending?.model ?? answer.model),
				effort: answer.pending?.effort ?? answer.effort,
				from,
				pending: !!answer.pending,
			});
			options.onPicked?.(model);
			// The chat's own watch hears the change; the channel's other views read it from its info.
			host.channel<ChannelInfo>(channel, { op: "info" }).then((info) => publish(channel, { info }), () => {});
		} catch (error) {
			setPicking(undefined);
			const { message } = error as Error;
			const { onProviders } = options;
			toast.error("Could not change the model", {
				description: message,
				...(onProviders && /provider key/i.test(message)
					? { action: { label: "Providers", onClick: onProviders } }
					: {}),
			});
		}
	}

	return { next, running, pick };
}
