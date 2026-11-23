/** @example "owner/project" */
export type REPO = `${string}/${string}`;

/** A sortable unique identifier. */
export type ULID = string;

/** UNIX seconds */
export type UNIX = number;

export type AgentMode = "interactive" | "plan" | "autopilot";

export type AgentSelection = {
	mode: AgentMode;
	custom?: { name: string; displayName: string };
};

/** Session actions the viewer may perform. */
export type Capabilities = {
	rename: boolean;
	archive: boolean;
	delete?: boolean;
	fork?: boolean;
	move?: boolean;
	/** The channel's workspace is a cloud container its host can stop and start. */
	compute?: boolean;
};

/** A tool call from an agent. */
export type Tool = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	status: "plan" | "start" | "pending" | "success" | "error";
	agent?: Tool.Agent;
	/** One line describing the group of consecutive calls this one belongs to. */
	caption?: string;
	/** A summary of all the work this call was part of, for the folded agent turn. */
	recap?: string;
	result?: { content: string; images?: string[] };
	children?: Tool[];
};

export namespace Tool {
	export type Agent = {
		kind: "subagent";
		id?: string;
		name: string;
		display?: string;
		description?: string;
		model?: string;
		status: "pending" | "running" | "success" | "error";
		durationMs?: number;
		totalToolCalls?: number;
		totalTokens?: number;
		preview?: string;
		error?: string;
	};
}

/** A timeline entry. */
export type Event =
	| Event.Message
	| Event.Neuve.Review.Card
	| Event.Neuve.Review.Told
	| Event.Neuve.Plan.Card
	| Event.Neuve.Build.Card
	| Event.Document
	| Event.Exec
	| Event.Exec.Abort
	| Event.User.Join
	| Event.User.Leave
	| Event.ReviewNewCommits
	| Event.Git.Commit
	| Event.Git.PR.New
	| Event.Git.PR.State
	| Event.Git.PR.Edit
	| Event.Git.PR.Review
	| Event.Git.PR.Comment
	| Event.Git.PR.ReviewComment
	| Event.Git.Issue.New
	| Event.Git.Issue.Comment
	| Event.Git.Issue.State
	| Event.Call.Start
	| Event.Call.End;

export namespace Event {
	export type ReviewNewCommits = KIND<"neuve:review:new-commits"> & {
		review: string; branch: string; reviewedHead: string; head: string; label: string;
	};

	type KIND<T extends string> = {
		id: string;
		uid: ULID;
		type: T;
		topic: string;
		created_at: UNIX;
		last_updated?: UNIX;
	};

	export type Sender = Sender.User<string | number> | Sender.Agent;

	/** The signed-in viewer; `own` lists additional sender values that belong to them. */
	export type Viewer = { id?: string | number; login: string; own?: readonly string[] };

	export namespace Sender {
		export type User<ID extends string | number = number> = {
			kind: "user";
			value: ID;
			display: string;
			/** Beside the name, such as whom a build's agent wrote to. */
			credit?: string;
		};

		export type Agent = {
			kind: "agent";
			/** @example "ace:bot" */
			value: string;
			/** @example "Ace" */
			display: string;
			/** Who asked for the run and what ran it, when someone other than its owner asked. */
			credit?: string;
		};
	}

	export type Document = KIND<"document"> & {
		sender: Event.Sender;
		name: string;
		aliases?: string[];
		format: "markdown";
		content: string;
	};

	export type Message =
		& KIND<"message">
		& { reactions?: Message.Reaction[] }
		& (Message.User | Message.Agent);

	export namespace Message {
		export type User = {
			sender: Event.Sender.User<string | number>;
			content: Content[];
			system?: { kind: "neuve:review:terminal"; review: string };
			agent?: AgentSelection;
		};

		export type Agent = {
			sender: Event.Sender.Agent;
			content: Array<Content | Content.Tool>;
			/** Execution identity keeps adjacent turns by the same agent separate. */
			run?: string;
			agent?: AgentSelection;
		};

		/** Special spans within text content; gaps between parts are plain text. */
		export type Part = {
			type: "mention" | "session" | "document" | "path" | "code";
			value: string;
			index: number;
		};

		export type Content = Content.Text | Content.Image | Content.File;

		export namespace Content {
			export type Text = { type: "text"; text: string; parts?: Part[] };
			export type Image = { type: "image"; image: string | { url: string } };
			export type File = {
				type: "file";
				name: string;
				file: string | { url: string };
				/** Contents carried with the message, which the block opens in a file view. */
				text?: string;
			};
			export type Tool = { type: "tool" } & import("./types").Tool;
		}

		export type Reaction = {
			/** Stable author identity. */
			from: string;
			/** Mutable author label. */
			display?: string;
			emoji: string;
		};
	}

	export namespace User {
		export type Join = KIND<"user:join"> & { sender: Event.Sender.User };
		export type Leave = KIND<"user:leave"> & { sender: Event.Sender.User };
	}

	export type Exec = KIND<"exec"> & {
		sender: Event.Sender.User;
		input: string;
		cwd?: string;
		pid?: number;
		stdout?: string;
		stderr?: string;
		exitCode?: number | string;
		executionTimeMs?: number | string;
	};

	export namespace Exec {
		export type Abort = KIND<"exec:abort"> & {
			sender: Event.Sender.User;
			target: Pick<Exec, "uid" | "input">;
		};
	}

	export namespace Git {
		/** @example "#42" */
		export type PRID = `#${number}`;

		export type Commit = KIND<"git:commit"> & {
			sha: string;
			message: string;
			authors: string[];
		};

		export namespace PR {
			export type New = KIND<"git:pr:new"> & {
				pr: PRID;
				url: string;
				title: string;
				draft: boolean;
			};

			export type State = KIND<"git:pr:state"> & {
				pr: PRID;
				value: "open" | "closed" | "merging" | "merged" | "draft" | "ready";
			};

			export type Edit = KIND<"git:pr:edit"> & {
				pr: PRID;
				title?: string;
				body?: string;
			};

			export type Review = KIND<"git:pr:review"> & {
				pr: PRID;
				action: "approved" | "commented" | "changes_requested" | "dismissed";
				review_id: number;
				reviewer: string;
				body?: string;
			};

			export type Comment = KIND<"git:pr:comment"> & {
				pr: PRID;
				url?: string;
				comment_id: number;
				author: string;
				body: string;
			};

			/** An inline review comment anchored to the diff. */
			export type ReviewComment = KIND<"git:pr:review:comment"> & {
				pr: PRID;
				url?: string;
				comment_id: number;
				author: string;
				body: string;
				path: string;
				line?: number;
				diff_hunk?: string;
				in_reply_to?: number;
			};
		}

		export namespace Issue {
			export type New = KIND<"git:issue:new"> & {
				/** @example "#12" */
				issue: string;
				url: string;
				title: string;
				author: string;
				body?: string;
			};

			export type Comment = KIND<"git:issue:comment"> & {
				issue: string;
				url?: string;
				comment_id: number;
				author: string;
				body: string;
			};

			export type State = KIND<"git:issue:state"> & {
				issue: string;
				url?: string;
				value: "open" | "closed";
			};
		}
	}

	export namespace Call {
		export type Start = KIND<"call:start"> & { sender: number };
		export type End = KIND<"call:end"> & { sender: number };
	}

	export namespace Neuve.Plan {
		/** The app's card for one plan, under the turn whose call last wrote it. */
		export type Card = KIND<"neuve:plan:card"> & { card: PlanCardView };
	}

	export namespace Neuve.Build {
		/** The app's card for the agents one approved plan started, right after that plan's card. */
		export type Card = KIND<"neuve:build:card"> & { card: BuildCardView };
	}

	export namespace Neuve.Review {
		/** The app's card for one review start call, placed under the turn that made it. */
		export type Card = KIND<"neuve:review:card"> & { call: string; card: ReviewCardView };

		/** The host told the agent that a review it was asked to report on has finished or stopped. */
		export type Told = KIND<"neuve:review:told"> & {
			review: string;
			/** Null when the chat doesn't hold the review's card. */
			phase: "finished" | "stopped" | null;
		};
	}
}

/** What a plan's card shows; `meta` is its second line, worked out by the app. */
export type PlanCardView = {
	plan: string;
	hash: string;
	title: string;
	state: "draft" | "approved" | "replaced";
	meta: string;
};

/** The role the host gave an agent it started for an approved plan. */
export type AgentRole = "implementer" | "reviewer";

/** One agent of a build as a line shows it: the name it goes by, its caption, and its state. */
export type AgentLineView = {
	chat: number;
	/** Its role, and its part where it has one. */
	name: string;
	caption?: string;
	state: "running" | "waiting" | "done" | "failed" | "stopped";
};

/** What a build's card shows; the app words its title and second line. */
export type BuildCardView = {
	build: string;
	/** Only where the person must act or is blocked; the agents' rows say the rest. */
	title?: string;
	/** Who stopped it and when, or why it cannot go on; nothing the plan's card above already says. */
	meta?: string;
	tone?: "error";
	agents: AgentLineView[];
	/** Whether any of its agents can still be stopped. */
	stoppable: boolean;
};

/** What a Neuve review card shows: a review card entry, or the start call still running. */
export type ReviewCardView =
	| { kind: "asked"; label: string }
	| { kind: "refused"; title: string; detail: string; fix: string }
	| {
		kind: "review";
		review: string;
		source: "branch" | "pull_request" | "lane";
		label: string;
		range: { branch: string; base: string; head: string; commits: number };
		recovered: boolean;
		phase: "queued" | "running" | "finished" | "stopped" | "connection_lost";
		stage: { done: number; of: number; name: string } | null;
		stages: string[];
		finished: {
			units: number;
			byReviewLane: { humanRequired: number; humanSuggested: number; agentic: number; static: number };
			needJudgment: number;
			complete: boolean;
			gaps: number;
			undecoded: number;
		} | null;
		stopped: { reason: string } | null;
		newCommits: { head: string } | null;
		/** Each link is null when it isn't a Review tab entry route; it then shows as plain text. */
		links: { batch: string | null; desk: string | null } | null;
	};
