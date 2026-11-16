export const evaluateOperationalForkMarker = (
  input: Readonly<{
    expected: Readonly<{
      baselineTagTarget: string;
      upstreamRemoteUrl: string;
      originRemoteName: string;
      originRemoteUrl: string;
    }>;
    observed: Readonly<{
      tagType: string;
      tagTarget: string;
      upstreamFetch: string;
      upstreamPush: string;
      originFetch: string;
      remotes: readonly string[];
      descendsFromBaseline: boolean;
    }>;
  }>,
): Readonly<{ valid: boolean; checks: Readonly<Record<string, boolean>> }> => {
  const checks = {
    tag_is_annotated: input.observed.tagType === "tag",
    tag_target: input.observed.tagTarget === input.expected.baselineTagTarget,
    upstream_fetch:
      input.observed.upstreamFetch === input.expected.upstreamRemoteUrl,
    upstream_push_disabled: input.observed.upstreamPush === "DISABLED",
    origin_present: input.observed.remotes.includes(
      input.expected.originRemoteName,
    ),
    origin_fetch: input.observed.originFetch === input.expected.originRemoteUrl,
    engine_descends_from_baseline: input.observed.descendsFromBaseline,
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
  };
};
