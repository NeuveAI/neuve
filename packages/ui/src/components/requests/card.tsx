import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The shell's measures in px. Cards the timeline places before they mount work out their height
 * from these, so the shell draws with the same numbers.
 */
export const CARD = {
	border: 1,
	padX: 12,
	headPadY: 10,
	titleLine: 20,
	metaGap: 2,
	metaLine: 16,
	bodyPadY: 12,
	footPadY: 10,
} as const;

/**
 * The shell of a card that asks a person for something: a question, a review, a plan to approve.
 * Its head, then body parts and a footer, each divided from the one above.
 */
export function RequestCard(
	{ tone, className, ...props }: ComponentPropsWithRef<"section"> & { tone?: "error" },
) {
	return (
		<section
			{...props}
			className={cn(
				"rounded-xl squircle border bg-background text-sm text-foreground shadow-composer",
				tone === "error" ? "border-destructive/40" : "border-border",
				className,
			)}
		/>
	);
}

/** The card's title, the line under it, and anything kept at its end. */
export function RequestCardHead(
	{ title, meta, aside, metaProps }: {
		title: ReactNode;
		meta?: ReactNode;
		aside?: ReactNode;
		metaProps?: ComponentPropsWithRef<"p">;
	},
) {
	return (
		<header
			className="flex items-start justify-between gap-3"
			style={{ paddingInline: CARD.padX, paddingBlock: CARD.headPadY }}
		>
			<div className="min-w-0 flex-1">
				<p className="flex min-w-0 items-center gap-2 leading-5 font-medium">{title}</p>
				{meta !== undefined && (
					<p
						{...metaProps}
						className={cn("text-xs leading-4 text-muted-foreground", metaProps?.className)}
						style={{ marginBlockStart: CARD.metaGap, ...metaProps?.style }}
					>
						{meta}
					</p>
				)}
			</div>
			{aside}
		</header>
	);
}

/** A part of the card under its head; `bare` leaves out the padding. */
export function RequestCardBody(
	{ bare, className, style, ...props }: ComponentPropsWithRef<"div"> & { bare?: boolean },
) {
	return (
		<div
			{...props}
			className={cn("border-t border-border", className)}
			style={bare ? style : { paddingInline: CARD.padX, paddingBlock: CARD.bodyPadY, ...style }}
		/>
	);
}

export function RequestCardFooter({ className, style, ...props }: ComponentPropsWithRef<"footer">) {
	return (
		<footer
			{...props}
			className={cn("flex border-t border-border", className)}
			style={{ paddingInline: CARD.padX, paddingBlock: CARD.footPadY, ...style }}
		/>
	);
}
