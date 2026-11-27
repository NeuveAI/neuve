import { Toolbar } from "@base-ui/react/toolbar";
import * as fuzzysort from "fuzzysort";
import { type ReactElement, useMemo, useRef, useState } from "react";

import { IconCheckMicro, IconChevronDownMicro } from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "../../ui/combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

/** A selectable model (e.g. Opus, Sonnet). */
export type Model = { id: string; name: string; vendor?: string };

/** A reasoning effort accepted by the selected model. */
export type Effort = { id: string; name: string };

type ModelPickerProps = {
	models: Model[];
	model?: string;
	/** Omitted, the model and effort show as text. */
	onModelChange?: (model: string) => void;
	/** Reasoning efforts for the selected model. Omit to show the model alone. */
	efforts?: Effort[];
	effort?: string;
	onEffortChange?: (effort: string) => void;
	/** Where a choice returns focus, such as the composer's editor. */
	onDone?: () => void;
	/** The composer's toolbar holds its triggers; a line's are plain buttons. */
	toolbar?: boolean;
	size?: "line";
	className?: string;
};

function text(model: Model) {
	return [model.name, model.id, model.vendor].filter(Boolean).join(" ");
}

const TRIGGER = { composer: "h-6.5 px-2", line: "h-5 px-1 text-xs" };

/** The one model and effort picker: the composer's, and an agent's line's. */
export function ModelPicker(
	{ models, model, onModelChange, efforts, effort, onEffortChange, onDone, toolbar, size, className }: ModelPickerProps,
) {
	let selected = models.find(item => item.id === model) ?? models[0];
	let level = efforts?.find(item => item.id === effort);
	let trigger = TRIGGER[size ?? "composer"];
	let wrap = (button: ReactElement) => toolbar ? <Toolbar.Button render={button} /> : button;
	if (!onModelChange) {
		return (
			<span className={cn("flex min-w-0 items-center gap-1 text-muted-foreground", className)}>
				<span className="truncate">{selected?.name}</span>
				{level && <span className="shrink-0">· {level.name}</span>}
			</span>
		);
	}
	return (
		<span className={cn("flex min-w-0 items-center gap-0.5", className)}>
			<ModelMenu models={models} selected={selected} onChange={onModelChange} wrap={wrap} trigger={trigger} />
			{level && onEffortChange && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={wrap(
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Reasoning effort: ${level.name}`}
								className={cn("shrink-0 text-muted-foreground", trigger)}
							/>,
						)}
					>
						<span className="truncate">{level.name}</span>
						<IconChevronDownMicro className="size-3 transition-transform duration-150 group-data-[popup-open]/button:scale-y-[-1]" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" sideOffset={6} className="min-w-36">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
							{efforts?.map(entry => (
								<DropdownMenuItem
									key={entry.id}
									onClick={() => {
										onEffortChange(entry.id);
										onDone?.();
									}}
								>
									<span className="min-w-0 flex-1 truncate">{entry.name}</span>
									{entry.id === effort && <IconCheckMicro className="size-3" />}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</span>
	);
}

function ModelMenu(
	{ models, selected, onChange, wrap, trigger }: {
		models: Model[];
		selected?: Model;
		onChange: (model: string) => void;
		wrap: (button: ReactElement) => ReactElement;
		trigger: string;
	},
) {
	let [query, setQuery] = useState("");
	let [open, setOpen] = useState(false);
	let [keys, setKeys] = useState(false);
	let anchor = useRef<HTMLSpanElement | null>(null);
	// A pick applies once the menu has closed, so the trigger's label doesn't change under the closing menu.
	let picked = useRef<string | undefined>(undefined);
	let results = useMemo(() => {
		let q = query.trim();
		if (!q) return models;
		let values = models.map(item => ({ item, value: text(item) }));
		return fuzzysort.go(q, values, { key: "value" }).map(match => match.obj.item);
	}, [models, query]);

	function commit() {
		let next = picked.current;
		picked.current = undefined;
		if (next && next !== selected?.id) onChange(next);
	}

	return (
		<Combobox<Model>
			items={models}
			filteredItems={results}
			value={selected}
			inputValue={query}
			open={open}
			autoHighlight={query.trim().length > 0}
			itemToStringLabel={item => item.name}
			itemToStringValue={item => item.id}
			isItemEqualToValue={(item, value) => item.id === value.id}
			onOpenChange={next => {
				setOpen(next);
				if (!next) return;
				setKeys(false);
				setQuery("");
				commit();
			}}
			onOpenChangeComplete={next => {
				if (next) return;
				setQuery("");
				commit();
			}}
			onInputValueChange={setQuery}
			onValueChange={next => {
				if (!next || next.id === selected?.id) return;
				picked.current = next.id;
				setOpen(false);
			}}
		>
			<span ref={anchor} className="inline-flex min-w-0">
				<ComboboxTrigger
					render={wrap(
						<Button
							variant="ghost"
							size="sm"
							className={cn("-ml-0.5 min-w-0 shrink text-muted-foreground", trigger)}
						/>,
					)}
				>
					<span className="truncate max-inline-[13rem]">{selected?.name}</span>
				</ComboboxTrigger>
			</span>
			<ComboboxContent
				anchor={anchor}
				align="start"
				sideOffset={6}
				initialFocus={type => {
					setKeys(type === "keyboard");
					return true;
				}}
				finalFocus={false}
				className="w-[18rem] max-w-[calc(100vw-2rem)]"
			>
				<ComboboxInput
					placeholder="Search models"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					showClear
					showTrigger={false}
					className={cn(
						!keys
							&& "has-[[data-slot=input-group-control]:focus-visible]:border-inherit has-[[data-slot=input-group-control]:focus-visible]:ring-0",
					)}
				/>
				<ComboboxEmpty>No models found</ComboboxEmpty>
				<ComboboxList className="scrollbar-muted max-h-56">
					{item => (
						<ComboboxItem
							key={item.id}
							value={item}
							aria-current={item.id === selected?.id ? "true" : undefined}
							className="group/model pr-7 data-selected:bg-primary data-selected:font-medium data-selected:text-primary-foreground data-selected:**:text-primary-foreground"
						>
							<span className="min-w-0 flex-1 truncate">{item.name}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
