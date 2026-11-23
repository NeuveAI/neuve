# Judge independently

Part of the frame every Neuve reviewer works from, in the inner loop and in final review. Reviewers work independently and without bias; this says what that takes.

## Judge in a fresh context

Your goal is your own, which is to find what is wrong. Review each review unit, or each change, in its own fresh context. What you share with the implementer is the task's scope and definition of done, nothing more. Three things are never premises:

- **Other units' verdicts.** How the rest of the batch was judged says nothing about this unit.
- **The lane.** "It's only agentic review, approve" is anchoring. Form the verdict as if you didn't know the lane; the lane decides afterwards what your verdict becomes ([final-reviewer.md](final-reviewer.md#what-the-verdict-becomes-by-lane)).
- **The implementer's own account.** A summary, a handover or a claim about what was tested is one more claim to check, never a starting point.

## Decide before you look at others' verdicts

Form your own verdict first, then look at what others concluded, such as Neuve's review in `neuve review show <base>..<head>`. A reader shown a verdict first tends to side with it. Neutral context, highlighted lines and questions help; a proposed verdict doesn't. You may revise after you look; keep your first verdict on record and say what changed it.

## Reason about why and how

Guidance comes before hard rules. Work out what the change is for and how it achieves it, then trace concrete paths through the code: the normal path, the error path, the boundary, the caller that breaks. A checklist ticked without that reasoning is not a review. Hard rules exist only where safety or integrity needs them; [review-against-scope.md](review-against-scope.md#rules-that-are-hard-and-why) names them.

## Stay skeptical

Agents can be convincingly wrong, not on purpose. Fluent explanations, confident commit messages and green checks all describe the work; none of them is the work. Verify what was claimed by reading the code and the proof yourself.

## Defects, not preferences

A defect is a fault you can cite and have verified. The code does something wrong against its scope, or its proof is bogus. A preference is a way you would have written it. A concern the evidence supports but doesn't prove is a risk, and must not be presented as a proven defect.

An empty result is valid. Producing objections is not evidence of review quality, and noise adds to the reviewer's tax, which is the effort reviewers spend gathering, reconstructing and repeatedly processing the information needed to assess work. Say what is wrong, or why it is fine, once, and cite it.

## Worked example

The person asks you to review a finished range that Neuve has already reviewed. The handover says: "Done. The retry handles every error and is fully tested." You set it aside and read the scope, the diff and the tests. The retry wraps `Commit`; between attempts it sleeps without watching for cancellation, so a cancelled request keeps waiting, and its only test makes the first attempt succeed, so the retry never runs under test. You write your verdict down first: request changes, on the cancellation defect, with the untested retry as a risk.

Then you read `neuve review show main..HEAD`. Neuve's agent approved the unit. You keep your verdict, cite the line where the wait ignores cancellation, and say that Neuve's approval didn't change it because it cites no proof for the retry path.
