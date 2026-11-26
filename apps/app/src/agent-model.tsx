import type { Effort, ModelOption } from "@ace/channel/protocol";
import { ModelPicker } from "@ace/ui";

import { useDetails } from "./details";
import { useModelChoice } from "./model-choice";

/** `models` is the channel's list, asked once for all its lines. */
type Props = { channel: string; models?: readonly ModelOption[]; user: string; chat: number; plain?: boolean };

/**
 * The model and effort an agent's chat runs on, on its line: the composer's picker for the
 * channel's owner and the same values as text for anyone else, with the running value first while
 * a change waits for the agent's next run.
 */
export function AgentModel({ channel, models, user, chat, plain }: Props) {
	const { info } = useDetails(channel);
	const value = info?.chats.find((entry) => entry.id === chat);
	const { next, running, pick } = useModelChoice(channel, chat, user, value ?? {}, models, info?.automatic);
	if (!value) return null;
	const owner = !plain && info?.owner === user;
	return (
		<span className="flex min-w-0 items-center gap-1 text-xs">
			{running && (
				<>
					<ModelPicker
						size="line"
						className="shrink"
						models={running.choices}
						model={running.model}
						efforts={running.efforts}
						effort={running.effort}
					/>
					<span aria-hidden className="shrink-0 text-muted-foreground">→</span>
				</>
			)}
			<ModelPicker
				size="line"
				// Above the work log row's own button, which lies under the line.
				className={owner ? "relative" : undefined}
				models={next.choices}
				model={next.model}
				efforts={next.efforts}
				effort={next.effort}
				onModelChange={owner ? (model) => void pick(model) : undefined}
				onEffortChange={owner ? (effort) => void pick(next.model, effort as Effort) : undefined}
			/>
		</span>
	);
}
