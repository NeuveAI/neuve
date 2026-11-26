import { type ComponentProps, type ReactNode, useState } from "react";

import { Button, Input } from "@ace/ui";
import type { CredentialStatus } from "@ace/host/protocol";

export function Link({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-primary underline-offset-2 hover:underline"
		>
			{children}
		</a>
	);
}

export function Page({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-8">{children}</div>;
}

/** A titled list of rows separated by hairlines, with an optional control beside the title. */
export function Group({ title, action, children }: {
	title?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col" aria-label={title}>
			{(title || action) && (
				<div className="flex min-h-7 items-center justify-between gap-2 pb-1">
					{title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
					{action && <div className="ml-auto">{action}</div>}
				</div>
			)}
			<div className="flex flex-col divide-y divide-border/60">{children}</div>
		</section>
	);
}

/** Label and at most one line of description on the left, controls on the right. */
export function Row({ label, description, children, footer, id }: {
	label: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	/** Full-width content under the row: inline forms, confirmations, and action results. */
	footer?: ReactNode;
	id?: string;
}) {
	return (
		<div className="flex flex-col gap-2 py-3">
			<div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-6">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div id={id} className="text-sm text-foreground">{label}</div>
					{description && (
						<div className="text-xs/relaxed break-words text-pretty text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
			</div>
			{footer}
		</div>
	);
}

/** A read-only value in a row's control slot. */
export function Value({ children }: { children: ReactNode }) {
	return <span role="status" className="text-xs text-muted-foreground">{children}</span>;
}

/** A text setting saved explicitly; Save appears once the draft differs from the saved value. */
export function TextRow({ label, description, saved, onSave, footer, disabled, ...props }:
	& Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onSubmit">
	& {
		label: string;
		description?: ReactNode;
		saved?: string;
		onSave: (value: string) => Promise<void>;
		footer?: ReactNode;
	})
{
	const [draft, setDraft] = useState<string>();
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const value = draft ?? (saved || "");
	const dirty = draft !== undefined && draft.trim() !== (saved || "");
	const locked = saved === undefined || disabled || action.busy;

	async function save() {
		setAction({ busy: true });
		try {
			await onSave(value.trim());
			setDraft(undefined);
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			label={label}
			description={description}
			footer={(footer || action.error) && (
				<>
					{footer}
					{action.error && <Problem>{action.error}</Problem>}
				</>
			)}
		>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Input
					spellCheck={false}
					aria-label={label}
					className="h-7 w-64 text-xs"
					value={value}
					disabled={locked}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape" || draft === undefined) return;
						// Escape discards the draft before it reaches the dialog.
						event.stopPropagation();
						setDraft(undefined);
					}}
					{...props}
				/>
				{dirty && <Button type="submit" disabled={locked}>Save</Button>}
			</form>
		</Row>
	);
}

const sources = {
	keychain: "Saved in Keychain",
	environment: "From the environment",
	missing: "Not set",
	unavailable: "Keychain access needed",
};

/** A secret Ace finds as it finds a provider key: in the environment or in Keychain. */
export function KeyRow({ id, label, subject, status, disabled, onSave, onRemove, onCheck }: {
	id: string;
	label: string;
	/** What the controls name, such as "Anthropic key". */
	subject: string;
	status: CredentialStatus & { rejected?: true };
	disabled: boolean;
	onSave: (value: string) => Promise<unknown>;
	onRemove: () => Promise<unknown>;
	onCheck?: () => Promise<unknown>;
}) {
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [action, setAction] = useState<{ busy?: boolean; error?: string; message?: string }>({});
	const locked = disabled || action.busy;

	async function run(op: "save" | "check" | "remove") {
		setAction({ busy: true });
		try {
			await (op === "save" ? onSave(value) : op === "check" ? onCheck!() : onRemove());
			if (op === "save") {
				setValue("");
				setEditing(false);
			}
			setConfirm(false);
			setAction({
				message: op === "check"
					? "Connection verified."
					: op === "remove"
					? "Key removed."
					: "Key saved.",
			});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			id={`${id}-label`}
			label={label}
			description={`${
				status.override ? `${status.override} overrides Keychain` : sources[status.source]
			}${status.rejected ? `, but ${label} rejected it` : ""}`}
			footer={
				<>
					{editing && (
						<form
							className="flex flex-col gap-2 @md:flex-row"
							onSubmit={(event) => {
								event.preventDefault();
								void run("save");
							}}
						>
							<Input
								id={id}
								autoFocus
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								aria-label={subject}
								value={value}
								maxLength={4096}
								disabled={locked}
								placeholder="API key"
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Escape" || action.busy) return;
									// Escape cancels the key form before it reaches the dialog.
									event.stopPropagation();
									setEditing(false);
									setValue("");
								}}
							/>
							<div className="flex shrink-0 gap-2">
								<Button type="submit" disabled={locked || !value.trim()}>
									{onCheck ? "Check and save" : "Save"}
								</Button>
								<Button
									type="button"
									variant="ghost"
									disabled={action.busy}
									onClick={() => {
										setEditing(false);
										setValue("");
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					)}
					{confirm && (
						<Confirm
							action="Remove key"
							busy={locked}
							onConfirm={() => void run("remove")}
							onCancel={() => setConfirm(false)}
						>
							Remove the saved {subject}?
						</Confirm>
					)}
					{status.waiting && <Status>{status.waiting}…</Status>}
					{status.error && <Problem>{status.error}</Problem>}
					{action.busy && onCheck && <Status>Checking…</Status>}
					{action.error && <Problem>{action.error}</Problem>}
					{action.message && <Status>{action.message}</Status>}
				</>
			}
		>
			{onCheck && (status.source === "keychain" || status.source === "environment") && (
				<Button
					variant="outline"
					aria-label={`Check ${label} connection`}
					disabled={locked}
					onClick={() => void run("check")}
				>
					Check
				</Button>
			)}
			{/* A saved key would go unused while the environment overrides it. */}
			{!editing && !status.override && (
				<Button
					variant="outline"
					aria-label={`${status.stored ? "Replace" : "Add"} ${subject}`}
					disabled={locked}
					onClick={() => {
						setConfirm(false);
						setEditing(true);
					}}
				>
					{status.stored ? "Replace" : "Add key"}
				</Button>
			)}
			{status.stored && !confirm && (
				<Button
					variant="ghost"
					aria-label={`Remove ${subject}…`}
					disabled={locked}
					onClick={() => {
						setEditing(false);
						setConfirm(true);
					}}
				>
					Remove…
				</Button>
			)}
		</Row>
	);
}

export function Segmented<T extends string>({ value, options, onChange, ...props }: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
	"aria-labelledby": string;
}) {
	return (
		<div role="radiogroup" className="inline-flex h-7 rounded-md bg-muted p-0.5" {...props}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					onClick={() => onChange(option.value)}
					className="rounded-[5px] px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs motion-reduce:transition-none"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Select({ className, ...props }: ComponentProps<"select">) {
	return (
		<select
			className={`h-7 max-w-full min-w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 ${
				className || ""
			}`}
			{...props}
		/>
	);
}

/** An inline confirmation for a destructive action, shown in a row's footer. */
export function Confirm({ children, action, busy, onConfirm, onCancel }: {
	children: ReactNode;
	action: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-xs @md:flex-row @md:items-center @md:justify-between">
			<p>{children}</p>
			<div className="flex shrink-0 gap-2">
				<Button variant="destructive" disabled={busy} onClick={onConfirm}>{action}</Button>
				<Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
			</div>
		</div>
	);
}

/** A time today, or a date and time when older, so a stale sync doesn't read as recent. */
export function when(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

export function Status({ children }: { children: ReactNode }) {
	return <p role="status" className="text-xs/relaxed text-muted-foreground">{children}</p>;
}

export function Problem({ children }: { children: ReactNode }) {
	return <p role="alert" className="text-xs/relaxed break-words text-destructive">{children}</p>;
}
