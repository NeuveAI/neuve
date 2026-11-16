import { useState } from "react";

import { NOT_ALLOWED, useReviewActions } from "../requests/review";
import { Button } from "../../ui/button";
import { SystemLine } from "./system-view";

/** The new-commit row's line: which branch moved past the review, and a new review on request. */
function ReviewNewCommitsLine(
	{ review, branch, head, label }: { review: string; branch: string; head: string; label: string },
) {
	let actions = useReviewActions();
	let [asking, setAsking] = useState(false);
	let short = head.slice(0, 7);
	let allowed = !!actions?.mayAsk;
	return (
		<SystemLine className="text-muted-foreground">
			{/* The sentence truncates as a whole, so the branch reads first and the button keeps its room. */}
			<span
				className="min-w-20 flex-1 truncate"
				title={`New commit on ${branch} after the review: ${short}`}
			>
				New commit on <code className="text-xs text-foreground">{branch}</code> after the review:{" "}
				<code className="text-xs text-foreground">{short}</code>
			</span>
			{actions && (
				<Button
					variant="link"
					size="sm"
					className="mx-1 h-auto min-w-0 truncate px-1 aria-disabled:opacity-50"
					aria-disabled={!allowed || asking || undefined}
					title={allowed ? undefined : NOT_ALLOWED}
					onClick={() => {
						if (!allowed || asking) return;
						setAsking(true);
						void actions.again(review, label).finally(() => setAsking(false));
					}}
				>
					{asking ? "Asking…" : "Request a new review"}
				</Button>
			)}
		</SystemLine>
	);
}

export { ReviewNewCommitsLine };
