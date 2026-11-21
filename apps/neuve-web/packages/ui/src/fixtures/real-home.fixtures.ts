import type { HomeData } from "@workspace/ui/neuve/home/home-data"

/*
 * The Neuve repository's own reviews as Records held them on 16 November
 * 2026, read through the home page's BFF load
 * (apps/web/src/server/home.server.ts): the first page of every review, and
 * the first page of the "Waiting on you" filter. Each batch carries its batch
 * digest from the review's packet of record. Stories pin "now" and the time
 * zone so the day groups read the same everywhere.
 */

/** The moment the fixtures were read, for the day groups. */
export const HOME_NOW = new Date("2026-11-16T09:00:00.000Z")
export const HOME_TIME_ZONE = "Europe/Stockholm"

export const realHome: HomeData = {
  repo: "neuve",
  reviews: [
    {
      id: "01M7GPPG03898A506GQTKA1HNF",
      title: "Preserve listed member whitespace",
      range: "4b6e18c..8d08921",
      at: "2026-11-15T22:57:46.713Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7GPPN3Z0008FDRZEAZVNN3C",
          title: "Preserve listed member whitespace",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            "The batch connects untouched command output to archive validation, so boundary spaces are no longer lost before checks run. Validation retains listing entries and reports name/type count mismatches, while quoted path diagnostics expose empty and whitespace-padded names. These changes together support checking actual listed names rather than normalized ones.",
          toCheck: "3 checkpoints across this batch's units: 3 without proof.",
          asked: 1,
          deskUnitId: "01M7GPPN3Z000FG24G801KNCCM",
        },
        {
          id: "01M7GPPN3Z0006BD76XC1TC5BP",
          title: "Cover space-padded members",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            "The batch adds regression cases expecting release validation to reject a leading-space first archive member and space-only first and last members. Their expected diagnostics retain whitespace, so the coverage depends on the listing reaching validation without trimming away boundary spaces; the supplied change shows the cases rather than a passing run.",
          toCheck: "2 checkpoints across this batch's units: 2 without proof.",
          asked: 0,
          deskUnitId: "01M7GPPN3Z000BK205M3QG9H7F",
        },
      ],
    },
    {
      id: "01M7G6Q4VTRBC9YFQKDKP77MCR",
      title: "Refusal and cleanup hardening",
      range: "915c55d..4b6e18c",
      at: "2026-11-15T18:18:42.349Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7G6QADR000EH9DQ1C6CW40V",
          title: "Refusal and cleanup hardening",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            "Release archive inspection now refuses nonregular members, duplicate names and bare release-folder entries, extending rejection toward the installer's refusal policy. It also reports unreadable paths and rejects owner-inaccessible folders. These checks combine with pre-extraction refusal so rejected archives need not proceed to extraction. For failures encountered during inspection, failure reporting is paired with permission-repair cleanup: folder unlocking and temporary-tree removal support cleanup after a locked folder, rather than leaving temporary work behind on that failure path.",
          toCheck: "3 checkpoints across this batch's units: 3 without proof.",
          removes: [
            "Admission now excludes nonregular members, duplicate names and bare release-folder entries",
          ],
          asked: 2,
          deskUnitId: "01M7G6QADR00027J1K5Z1W78WZ",
        },
        {
          id: "01M7G6QADR000DNQPB53YC7G67",
          title: "Release failure regression tests",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            "This batch extends release failure-path coverage toward installer-aligned refusals and cleanup after a locked-folder failure. The test setup gains more archive-header and member construction options, alongside crafted-folder fixtures, to support exercising failures rather than relying only on successful release execution. These fixtures underpin the expanded release regression scenarios; the intended observation is both rejection and subsequent cleanup.",
          toCheck: "3 checkpoints across this batch's units: 3 without proof.",
          asked: 0,
          deskUnitId: "01M7G6QADR00073NKBJQ9K5KD0",
        },
      ],
    },
    {
      id: "01M7G1DW9HA09VK04PMHKRGYZT",
      title: "Tar-based archive validation",
      range: "815f5d9..915c55d",
      at: "2026-11-15T16:45:30.821Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7G1E01J00075NRG8XDP13CJ",
          title: "Tar-based archive validation",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Tar-based archive validation". imports in release.ts: 1 line added and 3 removed. ArchiveInspection in release.ts: 8 lines added and 3 removed. memberProblems in release.ts: 14 lines added. treeProblems in release.ts: 19 lines added. listed in release.ts: 3 lines added. inspectArchive in release.ts: 89 lines added and 187 removed. checkMeasured in release.ts: 19 lines added and 31 removed. runRelease in release.ts: 14 lines added and 8 removed.',
          removes: [
            "Publication now also requires the extracted archive-member guard to pass",
          ],
          asked: 1,
          deskUnitId: "01M7G1E01J00059HK7GFJ75QNE",
        },
        {
          id: "01M7G1E01J0007WF9WMEH6FKHG",
          title: "Release archive regression tests",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Release archive regression tests". imports in release-from.test.ts: 1 line added. release-from.test.ts at line 423: 3 lines added. tarHeader in release-from.test.ts: 29 lines added. padded in release-from.test.ts: 2 lines added. tarMember in release-from.test.ts: 2 lines added. "a CLI with a quarantine mark is never run, and the release is refused" in release-from.test.ts: 1 line added. paxSizeZero in release-from.test.ts: 11 lines added. release-from.test.ts at line 470: 46 lines added. release-from.test.ts at line 516: 52 lines added.',
          asked: 1,
          deskUnitId: "01M7G1E01J0001S1X8W515RB4M",
        },
      ],
    },
    {
      id: "01M7FVY9SPVNC8QAM7PR9W8ZPZ",
      title: "Checked archive upload",
      range: "908ec3a..815f5d9",
      at: "2026-11-15T15:09:36.181Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 2,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7FVYDSR0006CZCF3CF2D7F0",
          title: "Checked archive upload",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Checked archive upload". imports in release.ts: 2 lines added. release.ts at line 40: 4 lines added and 3 removed. ArchiveMember in release.ts: 5 lines added. tarField in release.ts: 6 lines added. archiveMembersGuard in release.ts: 47 lines added. MEASURED_FILES in release.ts: 1 line added. checkMeasured in release.ts: 23 lines added and 8 removed. publish in release.ts: 8 lines added and 4 removed. tarSize in release.ts: 12 lines added. archiveMembers in release.ts: 85 lines added. runRelease in release.ts: 6 lines added and 7 removed.',
          removes: [
            "Member checks now gate metadata extraction and built-CLI execution",
          ],
          asked: 2,
          deskUnitId: "01M7FVYDSR000F8NEP46VCS2PW",
        },
        {
          id: "01M7FVYDSR000CDFQSTDK75G2S",
          title: "Upload invocation instrumentation",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Upload invocation instrumentation". ghInvocations in release-fixture.ts: 13 lines added. git in release-fixture.ts: 1 line added. releaseCheckout in release-fixture.ts: 2 lines added and 1 removed.',
          asked: 1,
          deskUnitId: "01M7FVYDSR000FBRDN4166460C",
        },
        {
          id: "01M7FVYDSR000AQVNFYB54DJPG",
          title: "Release upload regression tests",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 2,
            },
          ],
          digest:
            '2 units in 2 files for "Release upload regression tests". imports in release-command.test.ts: 1 line added and 1 removed. release-command.test.ts at line 17: 1 line added. ghCalls in release-command.test.ts: 1 line added and 3 removed. "with every guard passing, the release is one gh release create of a prerelease o" in release-command.test.ts: 10 lines added and 1 removed. "a dry run builds the files and prints the GitHub step, and creates nothing on Gi" in release-command.test.ts: 1 line added and 1 removed. imports in release-from.test.ts: 5 lines added and 4 removed. release-from.test.ts at line 11: 9 lines added. release-from.test.ts at line 30: 1 line added. measuredFolder in release-from.test.ts: 12 lines added and 2 removed. ghCalls in release-from.test.ts: 1 line added and 3 removed. createCall in release-from.test.ts: 2 lines added and 2 removed. expectUploadFrom in release-from.test.ts: 13 lines added. "a matching folder is uploaded as it is, on this commit, with nothing built" in release-from.test.ts: 3 lines added and 1 removed. "a dry run with --from runs every check and prints the upload of the three files," in release-from.test.ts: 1 line added and 1 removed. "an archive measured at an earlier commit ships from a later main with --target, " in release-from.test.ts: 2 lines added and 1 removed. "gh uploads the checked files from a folder whose path holds #, [, * and a space" in release-from.test.ts: 12 lines added. release-from.test.ts at line 372: 35 lines added. release-from.test.ts at line 407: 14 lines added. "a CLI with a quarantine mark is never run, and the release is refused" in release-from.test.ts: 1 line added.',
          asked: 0,
          deskUnitId: "01M7FVYDSR000F2ZPNF4CEB3DS",
        },
      ],
    },
    {
      id: "01M7FPCXK2HDD8E9WP1SJJM7TS",
      title: "Ship measured artifacts",
      range: "a443a2d..908ec3a",
      at: "2026-11-15T13:32:45.239Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 3,
        },
        {
          lane: "agentic-review",
          count: 2,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7FPD2AP00072D1W67MEXA58",
          title: "Ship measured artifacts",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Ship measured artifacts". release.ts at line 3: 2 lines added. imports in release.ts: 1 line removed. release.ts at line 15: 4 lines added. release.ts at line 28: 13 lines added and 4 removed. ReleaseOptions in release.ts: 4 lines added. builtCliGuard in release.ts: 16 lines added and 3 removed. MEASURED_FILES in release.ts: 2 lines added. checkMeasured in release.ts: 174 lines added. quote in release.ts: 9 lines added. publish in release.ts: 52 lines added. runRelease in release.ts: 86 lines added and 38 removed. release.ts at line 775: 9 lines added. release.ts at line 784: 6 lines added and 4 removed.',
          removes: [
            "The built-CLI guard no longer runs executables carrying a quarantine mark",
          ],
          asked: 1,
          deskUnitId: "01M7FPD2AP000155Y88SG6J5C0",
        },
        {
          id: "01M7FPD2AP000FAAA34BZW4XTM",
          title: "Verify existing-folder shipping",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Verify existing-folder shipping". imports in release-from.test.ts: 12 lines added. release-from.test.ts at line 13: 5 lines added. release-from.test.ts at line 18: 10 lines added. release-from.test.ts at line 28: 2 lines added. release-from.test.ts at line 30: 2 lines added. release-from.test.ts at line 32: 2 lines added. Measured in release-from.test.ts: 5 lines added. release-from.test.ts at line 95: 2 lines added. output in release-from.test.ts: 1 line added. release in release-from.test.ts: 13 lines added. ghCalls in release-from.test.ts: 4 lines added. uploads in release-from.test.ts: 2 lines added. createCall in release-from.test.ts: 6 lines added. advanceMain in release-from.test.ts: 19 lines added. release-from.test.ts at line 142: 6 lines added. release-from.test.ts at line 148: 1 line added. "a matching folder is uploaded as it is, on this commit, with nothing built" in release-from.test.ts: 29 lines added. "a dry run with --from runs every check and prints the upload of the three files," in release-from.test.ts: 13 lines added. release-from.test.ts at line 191: 78 lines added. release-from.test.ts at line 269: 16 lines added. "--target goes with --from only, and --from takes no --out" in release-from.test.ts: 18 lines added. measuredFolder in release-from.test.ts: 56 lines added. "an archive measured at an earlier commit ships from a later main with --target, " in release-from.test.ts: 20 lines added. "--from refuses a target that isn\'t on origin/main, even when the archive was bui" in release-from.test.ts: 19 lines added. "a CLI with a quarantine mark is never run, and the release is refused" in release-from.test.ts: 18 lines added.',
          asked: 1,
          deskUnitId: "01M7FPD2AP0006HRKQBX8MQC2M",
        },
        {
          id: "01M7FPD2AP00055DWBAANXYBXY",
          title: "Share release test setup",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 2 files for "Share release test setup". release-command.test.ts at line 17: 3 lines added and 1 removed. release-command.test.ts at line 46: 1 line removed. git in release-command.test.ts: 15 lines removed. Checkout in release-command.test.ts: 8 lines removed. release-command.test.ts at line 140: 1 line removed. makeCheckout in release-command.test.ts: 68 lines removed. release-command.test.ts at line 76: 1 line added and 1 removed. imports in release-fixture.ts: 3 lines added and 2 removed. git in release-fixture.ts: 17 lines added. Checkout in release-fixture.ts: 8 lines added. releaseCheckout in release-fixture.ts: 69 lines added.',
          removes: [
            "This change removes git in release-command.test.ts (15 lines).",
            "This change removes Checkout in release-command.test.ts (8 lines).",
            "This change removes makeCheckout in release-command.test.ts (68 lines).",
          ],
          asked: 1,
          deskUnitId: "01M7FPD2AP000DAZ5H8Z8JFKFV",
        },
      ],
    },
    {
      id: "01M7FGWXY7JMZDD7CX3HN37412",
      title: "Clean stored briefing prose",
      range: "1fb4016..da3ff80",
      at: "2026-11-15T11:56:42.068Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7FGWYJC000DJAANZ3VYZ6P0",
          title: "Clean stored briefing prose",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Clean stored briefing prose". briefedFrom in briefing-settle.ts: 8 lines added and 4 removed. wholeSentences in briefing-settle.ts: 24 lines added. unitLeadOf in briefing-settle.ts: 3 lines added and 2 removed. digestFrom in briefing-settle.ts: 1 line added and 1 removed. briefing.ts at line 1404: 4 lines added and 3 removed. readings-briefing.test.ts at line 52: 1 line added. "a behaviour title passes; only a path-like title or code\'s own wording is refuse" in readings-briefing.test.ts: 6 lines added. "a second sentence over the bound is dropped whole, at the answer stage and at se" in readings-briefing.test.ts: 100 lines added. "the lead\'s trim counts code points, keeps astral characters whole and never cuts" in readings-briefing.test.ts: 1 line added.',
          removes: [
            "Selected briefing text can lose an ellipsis-ended partial sentence",
            "Unit leads discard eligible trailing partial sentences before bounding",
            "Digest text discards eligible trailing partial sentences before linking",
            "Metadata matching no longer accepts changed counts or arbitrary colon-count prose",
          ],
          asked: 2,
          deskUnitId: "01M7FGWYJC00050VEY67PXW281",
        },
        {
          id: "01M7FGWYJC0005WHN9515V54WF",
          title: "Preserve grouped section outcomes",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Preserve grouped section outcomes". settled.ts at line 6: 1 line added. imports in settled.ts: 1 line added and 1 removed. settled.ts at line 61: 2 lines added. settled.ts at line 78: 2 lines added. SettledGuided in settled.ts: 21 lines added and 3 removed. SettledSectionReview in settled.ts: 8 lines added. SettledSectionNote in settled.ts: 6 lines added. SECTION_MESSAGE in settled.ts: 2 lines added. settled.ts at line 420: 1 line added. settled.ts at line 479: 14 lines added. StoredGuided in settled.ts: 1 line added. settled.ts at line 504: 7 lines added and 2 removed. settled.ts at line 1712: 9 lines added. settled.ts at line 1721: 1 line added. settled.ts at line 1722: 4 lines added. settled.ts at line 1726: 1 line added. withoutCodes in settled.ts: 13 lines added. wholeExplained in settled.ts: 14 lines added. heldRowsOf in settled.ts: 1 line added. sentence in settled.ts: 2 lines added and 1 removed. unsureReason in settled.ts: 6 lines added. unsureNote in settled.ts: 3 lines added and 2 removed. sectionMessage in settled.ts: 16 lines added. guidedOf in settled.ts: 127 lines added and 40 removed. briefedOf in settled.ts: 2 lines added and 1 removed. settledBatches in settled.ts: 2 lines added and 1 removed. readings-settled.test.ts at line 37: 3 lines added. "the review message and the suggestion of a decided human-required unit; review w" in readings-settled.test.ts: 12 lines added. readings-settled.test.ts at line 1826: 2 lines added and 2 removed. readings-settled.test.ts at line 1828: 1 line added and 1 removed. mixedCollected in readings-settled.test.ts: 9 lines added and 3 removed. "a fully undecided unit keeps its notes alone and adds each section\'s reason; a s" in readings-settled.test.ts: 18 lines added. "a section\'s message is its own checked line, plain, at most 300 characters at a " in readings-settled.test.ts: 51 lines added. "through the real publisher: a mixed unit\'s section reviews and section notes rea" in readings-settle',
          removes: [
            "Assessment-derived briefing prose can lose a trailing partial sentence",
            "Stored explanations can lose trailing partial sentences on either side",
          ],
          asked: 2,
          deskUnitId: "01M7FGWYJC0002JHJH1X2XFR3F",
        },
        {
          id: "01M7FGWYJC00080K46Q1A8CEKT",
          title: "Consolidate file lane units",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Consolidate file lane units". BatchSection in units.ts: 5 lines added and 4 removed. unitVerdict in units.ts: 2 lines added and 1 removed. unitRequirements in units.ts: 1 line added and 1 removed. composeUnits in units.ts: 9 lines added and 10 removed. "a unit requests changes if any section does, approves only if all do, and an und" in readings-units.test.ts: 2 lines added and 9 removed. "a file\'s decided and undecided sections in one lane are one unit with no verdict" in readings-units.test.ts: 9 lines added and 13 removed. "an undecided section that requests changes gives its unit no verdict" in readings-units.test.ts: 29 lines added. "each lane\'s approval and request become the disposition applyLane defines" in readings-units.test.ts: 1 line added.',
          asked: 2,
          deskUnitId: "01M7FGWYJC0005W8Z60KV22JR2",
        },
        {
          id: "01M7FGWYJC000D7321CGDKKSEG",
          title: "Remove evaluation dependency symlink",
          unitCount: 1,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Remove evaluation dependency symlink". node_modules at line 1: 1 line removed.',
          removes: [
            "The existing external node_modules reference is no longer available",
          ],
          asked: 1,
          deskUnitId: "01M7FGWYJC0007T17C0994FK0Q",
        },
      ],
    },
    {
      id: "01M7E8B0TK992YTZMGH04BGCBG",
      title: "Precise readable briefings",
      range: "b5e7a20..1fb4016",
      at: "2026-11-15T00:07:50.055Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 5,
        },
        {
          lane: "agentic-review",
          count: 2,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E8B1EK0008MGMY6VJE1CJ6",
          title: "Precise readable briefings",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 3,
            },
          ],
          digest:
            '3 units in 3 files for "Precise readable briefings". undangled in briefing-settle.ts: 2 lines added and 2 removed. cutText in briefing-settle.ts: 3 lines added and 3 removed. HunkRange in briefing-settle.ts: 14 lines added. citeSide in briefing-settle.ts: 7 lines added. narrowedCite in briefing-settle.ts: 28 lines added. imports in briefing.ts: 1 line removed. briefing.ts at line 33: 7 lines added. briefing.ts at line 40: 2 lines added. hunkRangesOf in briefing.ts: 1 line removed. HunkRange in briefing.ts: 10 lines removed. HunkSides in briefing.ts: 1 line removed. citeSide in briefing.ts: 6 lines removed. PartSection in briefing.ts: 1 line added. resolveCite in briefing.ts: 1 line removed. narrowedCite in briefing.ts: 27 lines removed. briefing.ts at line 1400: 13 lines added and 7 removed. settled.ts at line 6: 1 line added. settled.ts at line 60: 3 lines added. heldRowsOf in settled.ts: 23 lines added. rowEvidence in settled.ts: 47 lines added and 5 removed. guidedOf in settled.ts: 6 lines added. settledBatches in settled.ts: 3 lines added.',
          removes: [
            "This change removes HunkRange in briefing.ts (10 lines).",
            "This change removes citeSide in briefing.ts (6 lines).",
            "This change removes narrowedCite in briefing.ts (27 lines).",
            "Evidence links clip to owned rows or omit shared-hunk fallbacks instead of always linking…",
            "Guided evidence generation receives unit ownership and review-wide row constraints",
            "Settled batch output applies review-wide ownership constraints to Guided evidence",
          ],
          asked: 3,
          deskUnitId: "01M7E8B1EK0002PFFDV8ZRQ0NN",
        },
        {
          id: "01M7E8B1EK000757QR54D4ZARH",
          title: "Citation scope regressions",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Citation scope regressions". imports in readings-settled.test.ts: 1 line removed. readings-settled.test.ts at line 8: 6 lines added. readings-settled.test.ts at line 36: 1 line added. lineAt in readings-settled.test.ts: 2 lines added. hunkAt in readings-settled.test.ts: 1 line added. "Guided rows: the linked rows on the strongest basis, the worst status of the uni" in readings-settled.test.ts: 4 lines added and 4 removed. "a repaired met keeps its reading text and cites under Missing" in readings-settled.test.ts: 1 line added and 1 removed. "a not-met row is unchanged, with its reading carried and no proof state" in readings-settled.test.ts: 1 line added and 1 removed. "through the real publisher: a Missing row\'s proof state and reading reach Record" in readings-settled.test.ts: 2 lines added and 2 removed. "two sections, one with a met-refused reading and one with no evidence or no answ" in readings-settled.test.ts: 1 line added and 1 removed. "two sections read apart, met and not-met: both readings are kept within bounds" in readings-settled.test.ts: 2 lines added and 2 removed. "Guided row evidence cites the lines it read: a span inside one row, a clip, an o" in readings-settled.test.ts: 59 lines added. "Guided row evidence narrows only into the unit\'s own rows: another unit\'s hunk o" in readings-settled.test.ts: 104 lines added.',
          asked: 1,
          deskUnitId: "01M7E8B1EK000EFRK6BC2QTJK1",
        },
        {
          id: "01M7E8B1EK0005R0N32NZC6A48",
          title: "Readable output regressions",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Readable output regressions". "a cite of a hunk\'s lines and the sections\' behaviour titles reach Records\' read," in readings-briefing-boundary.test.ts: 6 lines added and 2 removed. "a behaviour title passes; only a path-like title or code\'s own wording is refuse" in readings-briefing.test.ts: 13 lines added and 6 removed. "the lead\'s trim counts code points, keeps astral characters whole and never cuts" in readings-briefing.test.ts: 1 line added. "a two-sentence Briefed, lead or digest over its bound keeps its first sentence w" in readings-briefing.test.ts: 39 lines added.',
          asked: 2,
          deskUnitId: "01M7E8B1EK0002KM08YD0M3N2P",
        },
      ],
    },
    {
      id: "01M7E55TCX5YF2ZB2TXXWAJ9KE",
      title: "Portable release assembly",
      range: "4673441..5eb1164",
      at: "2026-11-14T23:27:10.761Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E5AZ3B00057PBPB0NPY9CE",
          title: "Portable release assembly",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '2 units in 2 files for "Portable release assembly". build-desk.ts at line 7: 3 lines added. imports in build-desk.ts: 1 line added and 1 removed. withoutMachinePaths in build-desk.ts: 42 lines added. indexOf in build-desk.ts: 6 lines added. buildDesk in build-desk.ts: 4 lines added. buildArchive in build.ts: 11 lines added and 1 removed.',
          asked: 2,
          deskUnitId: "01M7E5AZ3B000260PK19CBATNA",
        },
        {
          id: "01M7E5AZ3B000DPZ2CEG1AY24J",
          title: "Runtime storage resolution",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '3 units in 2 files for "Runtime storage resolution". workspace-cli.ts at line 76: 1 line added and 1 removed. readProfile in workspace-cli.ts: 1 line added and 1 removed. workspace-runtime.ts at line 24: 1 line added and 1 removed. configureWorkspaceCli in workspace-runtime.ts: 1 line added and 1 removed.',
          removes: [
            "Named pi-transition selection now refuses in release builds",
            "Default workspace profile selection now refuses in release builds",
          ],
          asked: 3,
          deskUnitId: "01M7E5AZ3B0004SVEVTJZNVT9C",
        },
        {
          id: "01M7E5AZ3B000CBM15FMEM4515",
          title: "Storage setup isolation",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Storage setup isolation". pi-storage.ts at line 115: 2 lines added and 1 removed. ownerProfile in pi-storage.ts: 21 lines added. PI_TRANSITION_STORAGE_PROFILE in pi-storage.ts: 10 lines added and 18 removed. piTransitionProfile in pi-storage.ts: 9 lines added. loadProfile in pi-storage.ts: 1 line added and 1 removed.',
          removes: [
            "Storage profile loading now refuses pi-transition in release builds",
            "The exported owner profile is unavailable when the build version is a string",
          ],
          asked: 1,
          deskUnitId: "01M7E5AZ3B0006KS5AXJB2F1GG",
        },
        {
          id: "01M7E5AZ3B000BGAR604JWATY6",
          title: "Archive portability verification",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Archive portability verification". imports in archive.test.ts: 1 line added. archive.test.ts at line 63: 32 lines added and 2 removed.',
          asked: 1,
          deskUnitId: "01M7E5AZ3B000F1Q4WSR3ZRVD9",
        },
      ],
    },
    {
      id: "01M7E4KS7TF3NPTRRBHG7MGFWN",
      title: "Generate grounded briefings",
      range: "b2ab4df..ce7fc47",
      at: "2026-11-14T23:12:07.097Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E4KW2100090ABQQK7N5QP2",
          title: "Generate grounded briefings",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Generate grounded briefings". imports in briefing.ts: 1 line removed. briefing.ts at line 2: 5 lines added. BRIEFING_PROMPT_VERSION in briefing.ts: 1 line added and 1 removed. DIGEST_PROMPT_VERSION in briefing.ts: 5 lines added and 2 removed. BRIEFING_ANSWER_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_STORED_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_RECIPE in briefing.ts: 1 line added and 1 removed. TITLE_CHARS in briefing.ts: 2 lines added. HunkRange in briefing.ts: 9 lines added. hunkRangesOf in briefing.ts: 12 lines added. citeSide in briefing.ts: 7 lines added. HunkSides in briefing.ts: 3 lines added. hunkSidesOf in briefing.ts: 20 lines added. hunksLine in briefing.ts: 29 lines added. PartSection in briefing.ts: 3 lines added. PartMaterial in briefing.ts: 2 lines added. linkedOf in briefing.ts: 9 lines added and 2 removed. partMaterial in briefing.ts: 5 lines added. DigestSection in briefing.ts: 2 lines added. DigestMaterial in briefing.ts: 2 lines added. digestMaterial in briefing.ts: 5 lines added. renderBriefingTask in briefing.ts: 2 lines added and 2 removed. renderDigestTask in briefing.ts: 1 line added and 1 removed. briefing.ts at line 996: 5 lines added. briefing.ts at line 1013: 5 lines added. BRIEFING_PROBLEM_CLASSES in briefing.ts: 10 lines added. BRIEFING_REPAIRED_WITHOUT_A_TURN in briefing.ts: 2 lines added. BriefingIndex in briefing.ts: 18 lines added. partIndexOf in briefing.ts: 20 lines added. digestIndexOf in briefing.ts: 20 lines added and 7 removed. narrowedCite in briefing.ts: 28 lines added. resolveCite in briefing.ts: 49 lines added. citeOf in briefing.ts: 5 lines added and 3 removed. briefing.ts at line 1353: 3 lines added. briefing.ts at line 1356: 2 lines added. KEPT in briefing.ts: 2 lines added. briefing.ts at line 1437: 10 lines added. fileLikeTitle in briefing.ts: 4 lines added. DigestText in briefing.ts: 1 line added. briefing.ts at line 1463: 2 lines added. briefing.ts at',
          removes: [
            "Explained citation conversion returns at most one bare hunk per input",
            "Caller declaration locations no longer qualify as linked call-site evidence",
            "Section answers now require a title string",
          ],
          asked: 2,
          deskUnitId: "01M7E4KW21000C5Y1ZSW9ZHWVA",
        },
        {
          id: "01M7E4KW21000DBRQVE2D74WYY",
          title: "Settle bounded briefing text",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Settle bounded briefing text". SectionBriefing in briefing-settle.ts: 2 lines added. FileLead in briefing-settle.ts: 2 lines added. undangled in briefing-settle.ts: 21 lines added. boundedText in briefing-settle.ts: 3 lines added and 1 removed. cutText in briefing-settle.ts: 7 lines added. unitLeadOf in briefing-settle.ts: 7 lines added and 7 removed. fileLeadOf in briefing-settle.ts: 15 lines added. unitTitleOf in briefing-settle.ts: 24 lines added. unitLinked in briefing-settle.ts: 2 lines added and 1 removed.',
          asked: 1,
          deskUnitId: "01M7E4KW21000F87N2KY5C19DQ",
        },
        {
          id: "01M7E4KW2100003KRPN15PT9J1",
          title: "Carry settled batch context",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Carry settled batch context". settledBriefingsOf in collect.ts: 2 lines added. imports in collect.ts: 1 line added. settled.ts at line 60: 1 line added. SettledBatchSchema in settled.ts: 1 line added. Unstored in settled.ts: 8 lines added. StoredBatch in settled.ts: 1 line added. settled.ts at line 515: 8 lines added. settled.ts at line 523: 1 line added. PlannedSection in settled.ts: 1 line added. sameBatchReferences in settled.ts: 43 lines added and 13 removed. SettledInput in settled.ts: 2 lines added. settledBatches in settled.ts: 22 lines added and 3 removed. rowOf in readings-settled.test.ts: 31 lines added. "same-batch references: a caller-declaration row writes none; a reference row wri" in readings-settled.test.ts: 23 lines added. "same-batch references: a deletion-only callee\'s lines are sourced at the merge b" in readings-settled.test.ts: 65 lines added.',
          removes: [
            "References exclude non-use-site rows and omit old-side sources without a valid base.",
          ],
          asked: 2,
          deskUnitId: "01M7E4KW210001TKZ2Z8NQEYZ9",
        },
        {
          id: "01M7E4KW210005PEM35K61JR87",
          title: "Verify briefing contracts",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 2,
            },
          ],
          digest:
            '3 units in 3 files for "Verify briefing contracts". world in pi-briefing-task.test.ts: 13 lines added and 2 removed. "a cite of a hunk\'s lines and the sections\' behaviour titles reach Records\' read," in readings-briefing-boundary.test.ts: 41 lines added. imports in readings-briefing.test.ts: 1 line added. readings-briefing.test.ts at line 28: 5 lines added. readings-briefing.test.ts at line 51: 2 lines added. "the key holds only the briefing\'s content: run, cycle, head, group, lane, verdic" in readings-briefing.test.ts: 6 lines added and 6 removed. readings-briefing.test.ts at line 459: 5 lines added and 2 removed. "the rubric is the design\'s with the ruled lines and titles, word for word, and t" in readings-briefing.test.ts: 1 line added and 1 removed. "every section is asked for Briefed, and a missing one is sent back and left unan" in readings-briefing.test.ts: 2 lines added and 1 removed. "a sentence with no link is counted as uncited-claim, without a turn" in readings-briefing.test.ts: 8 lines added and 1 removed. "a link in Explained is stripped to its phrase, counted as ids-in-explained, with" in readings-briefing.test.ts: 8 lines added and 1 removed. "a lead is kept only for a marked path, at most once, and bounded without cutting" in readings-briefing.test.ts: 16 lines added and 3 removed. "a marked file\'s missing lead is sent back for a turn; with no turn left it is co" in readings-briefing.test.ts: 75 lines added. "a bare hunk ID, unit handle or line cite outside a link is taken out of Briefed," in readings-briefing.test.ts: 68 lines added. "an unknown cite is dropped and counted as unknown-cite, and judging words are co" in readings-briefing.test.ts: 43 lines added. "a cite of a hunk\'s lines is kept inside one of its rows, clipped to it, or falls" in readings-briefing.test.ts: 85 lines added. "a cite of lines: old side for a deletion, and a range across two rows narrowed i" in readings-briefing.test.ts: 29 lines added. "a missing section title is sent ba',
          asked: 1,
          deskUnitId: "01M7E4KW21000284YP3RPH4GYA",
        },
        {
          id: "01M7E4KW21000F71AYAGMPMT6P",
          title: "Lockfiles and generated files",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Lockfiles and generated files". MARKS in briefing.ts: 1 line added. briefingsFor in briefing.ts: 1 line added. BASE in briefing.ts: 2 lines added. settle in briefing.ts: 4 lines added and 1 removed.',
          asked: 0,
          deskUnitId: "01M7E4KW210001AJV7BT0B5HND",
        },
      ],
    },
    {
      id: "01M7E24G5FDNGMDXARN6A9XSWQ",
      title: "Precise briefing generation",
      range: "b2ab4df..39c66ed",
      at: "2026-11-14T22:29:45.014Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 4,
        },
      ],
      gate: [],
      feedback: false,
      batches: [
        {
          id: "01M7E24K7V0008NY55DKH5HXX8",
          title: "Precise briefing generation",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Precise briefing generation". imports in briefing.ts: 1 line removed. briefing.ts at line 2: 5 lines added. BRIEFING_PROMPT_VERSION in briefing.ts: 1 line added and 1 removed. DIGEST_PROMPT_VERSION in briefing.ts: 5 lines added and 2 removed. BRIEFING_ANSWER_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_STORED_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_RECIPE in briefing.ts: 1 line added and 1 removed. TITLE_CHARS in briefing.ts: 2 lines added. HunkRange in briefing.ts: 7 lines added. hunkRangesOf in briefing.ts: 9 lines added. citeSide in briefing.ts: 7 lines added. hunksLine in briefing.ts: 27 lines added. PartSection in briefing.ts: 3 lines added. linkedOf in briefing.ts: 9 lines added and 2 removed. partMaterial in briefing.ts: 1 line added. DigestSection in briefing.ts: 2 lines added. digestMaterial in briefing.ts: 1 line added. renderBriefingTask in briefing.ts: 2 lines added and 2 removed. renderDigestTask in briefing.ts: 1 line added and 1 removed. briefing.ts at line 954: 5 lines added. briefing.ts at line 971: 5 lines added. BRIEFING_PROBLEM_CLASSES in briefing.ts: 10 lines added. BRIEFING_REPAIRED_WITHOUT_A_TURN in briefing.ts: 2 lines added. BriefingIndex in briefing.ts: 10 lines added. partIndexOf in briefing.ts: 12 lines added. digestIndexOf in briefing.ts: 12 lines added and 7 removed. narrowedCite in briefing.ts: 25 lines added. resolveCite in briefing.ts: 40 lines added. citeOf in briefing.ts: 6 lines added and 3 removed. briefing.ts at line 1262: 3 lines added. briefing.ts at line 1265: 2 lines added. KEPT in briefing.ts: 2 lines added. briefing.ts at line 1335: 7 lines added. fileLikeTitle in briefing.ts: 4 lines added. DigestText in briefing.ts: 1 line added. briefing.ts at line 1358: 2 lines added. briefing.ts at line 1370: 2 lines added. briefingRepair in briefing.ts: 63 lines added and 2 removed. briefingStep in briefing.ts: 1 line added and 1 removed. briefingSystem in briefing.ts: 7 lin',
          removes: [
            "Explained citations retain only the first resolved hunk for a reading line cite",
            "Caller-declaration locations no longer qualify as linked use-site evidence",
          ],
          asked: 0,
          deskUnitId: "01M7E24K7V0008CGR8ZX3B6F87",
        },
        {
          id: "01M7E24K7V000ETKA0D892GWM1",
          title: "Link-safe briefing shortening",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Link-safe briefing shortening". SectionBriefing in briefing-settle.ts: 2 lines added. FileLead in briefing-settle.ts: 2 lines added. undangled in briefing-settle.ts: 21 lines added. boundedText in briefing-settle.ts: 3 lines added and 1 removed. cutText in briefing-settle.ts: 7 lines added. unitLeadOf in briefing-settle.ts: 7 lines added and 7 removed. fileLeadOf in briefing-settle.ts: 15 lines added. unitTitleOf in briefing-settle.ts: 12 lines added. unitLinked in briefing-settle.ts: 2 lines added and 1 removed.',
          asked: 0,
          deskUnitId: "01M7E24K7V000CY52ZKQW95YC3",
        },
        {
          id: "01M7E24K7V000CDP90MK22SZSR",
          title: "Preserve supporting references",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Preserve supporting references". settledBriefingsOf in collect.ts: 2 lines added. imports in collect.ts: 1 line added. settled.ts at line 60: 1 line added. SettledBatchSchema in settled.ts: 1 line added. Unstored in settled.ts: 8 lines added. StoredBatch in settled.ts: 1 line added. settled.ts at line 515: 8 lines added. settled.ts at line 523: 1 line added. PlannedSection in settled.ts: 1 line added. sameBatchReferences in settled.ts: 43 lines added and 13 removed. SettledInput in settled.ts: 2 lines added. settledBatches in settled.ts: 19 lines added and 3 removed. rowOf in readings-settled.test.ts: 31 lines added. "same-batch references: a caller-declaration row writes none; a reference row wri" in readings-settled.test.ts: 23 lines added. "same-batch references: a deletion-only callee\'s lines are sourced at the merge b" in readings-settled.test.ts: 65 lines added.',
          removes: [
            "References exclude declaration-only callers and old-side sources without a valid base.",
          ],
          asked: 0,
          deskUnitId: "01M7E24K7V0006A5MY4VJ4FWWM",
        },
        {
          id: "01M7E24K7V00001NQ5NECKHPB6",
          title: "Verify briefing behaviour",
          unitCount: 4,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 3,
            },
          ],
          digest:
            '4 units in 3 files for "Verify briefing behaviour". world in pi-briefing-task.test.ts: 13 lines added and 2 removed. "a cite of a hunk\'s lines and the sections\' behaviour titles reach Records\' read," in readings-briefing-boundary.test.ts: 37 lines added. readings-briefing.test.ts at line 27: 1 line added. readings-briefing.test.ts at line 46: 1 line added. "the key holds only the briefing\'s content: run, cycle, head, group, lane, verdic" in readings-briefing.test.ts: 6 lines added and 6 removed. readings-briefing.test.ts at line 453: 5 lines added and 2 removed. "the rubric is the design\'s with the ruled lines and titles, word for word, and t" in readings-briefing.test.ts: 1 line added and 1 removed. "every section is asked for Briefed, and a missing one is sent back and left unan" in readings-briefing.test.ts: 2 lines added and 1 removed. "a sentence with no link is counted as uncited-claim, without a turn" in readings-briefing.test.ts: 8 lines added and 1 removed. "a link in Explained is stripped to its phrase, counted as ids-in-explained, with" in readings-briefing.test.ts: 8 lines added and 1 removed. "a lead is kept only for a marked path, at most once, and bounded without cutting" in readings-briefing.test.ts: 16 lines added and 3 removed. "a marked file\'s missing lead is sent back for a turn; with no turn left it is co" in readings-briefing.test.ts: 75 lines added. "a bare hunk ID, unit handle or line cite outside a link is taken out of Briefed," in readings-briefing.test.ts: 68 lines added. "an unknown cite is dropped and counted as unknown-cite, and judging words are co" in readings-briefing.test.ts: 43 lines added. "a cite of lines: old side for a deletion, and a range across two rows narrowed i" in readings-briefing.test.ts: 29 lines added. "a missing section title is sent back; a file-name, path or line-count title is r" in readings-briefing.test.ts: 65 lines added. "no clip of Briefed, the digest or the lead cuts inside a link or leaves a dangli" in rea',
          asked: 0,
          deskUnitId: "01M7E24K7V0004E72SY0PAGRHB",
        },
        {
          id: "01M7E24K7V00022XP4M0RQZQQ3",
          title: "Lockfiles and generated files",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Lockfiles and generated files". MARKS in briefing.ts: 1 line added. briefingsFor in briefing.ts: 1 line added. BASE in briefing.ts: 2 lines added. settle in briefing.ts: 4 lines added and 1 removed.',
          asked: 0,
          deskUnitId: "01M7E24K7V0007FGJQ0BPYB0H2",
        },
      ],
      newer: true,
    },
  ],
  filter: "all",
  page: 1,
  pageSize: 10,
  total: 481,
  counts: {
    all: 481,
    waiting: 172,
  },
  waiting: {
    units: 3486,
    reviews: 172,
    nextUnitId: "01M7G6QADR00027J1K5Z1W78WZ",
  },
  newestHead: "8d089212a9f0ac836370c1b65069e4bfb70c00a4",
}

export const realHomeWaiting: HomeData = {
  repo: "neuve",
  reviews: [
    {
      id: "01M7G6Q4VTRBC9YFQKDKP77MCR",
      title: "Refusal and cleanup hardening",
      range: "915c55d..4b6e18c",
      at: "2026-11-15T18:18:42.349Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7G6QADR000EH9DQ1C6CW40V",
          title: "Refusal and cleanup hardening",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            "Release archive inspection now refuses nonregular members, duplicate names and bare release-folder entries, extending rejection toward the installer's refusal policy. It also reports unreadable paths and rejects owner-inaccessible folders. These checks combine with pre-extraction refusal so rejected archives need not proceed to extraction. For failures encountered during inspection, failure reporting is paired with permission-repair cleanup: folder unlocking and temporary-tree removal support cleanup after a locked folder, rather than leaving temporary work behind on that failure path.",
          toCheck: "3 checkpoints across this batch's units: 3 without proof.",
          removes: [
            "Admission now excludes nonregular members, duplicate names and bare release-folder entries",
          ],
          asked: 2,
          deskUnitId: "01M7G6QADR00027J1K5Z1W78WZ",
        },
        {
          id: "01M7G6QADR000DNQPB53YC7G67",
          title: "Release failure regression tests",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            "This batch extends release failure-path coverage toward installer-aligned refusals and cleanup after a locked-folder failure. The test setup gains more archive-header and member construction options, alongside crafted-folder fixtures, to support exercising failures rather than relying only on successful release execution. These fixtures underpin the expanded release regression scenarios; the intended observation is both rejection and subsequent cleanup.",
          toCheck: "3 checkpoints across this batch's units: 3 without proof.",
          asked: 0,
          deskUnitId: "01M7G6QADR00073NKBJQ9K5KD0",
        },
      ],
    },
    {
      id: "01M7FVY9SPVNC8QAM7PR9W8ZPZ",
      title: "Checked archive upload",
      range: "908ec3a..815f5d9",
      at: "2026-11-15T15:09:36.181Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 2,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7FVYDSR0006CZCF3CF2D7F0",
          title: "Checked archive upload",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Checked archive upload". imports in release.ts: 2 lines added. release.ts at line 40: 4 lines added and 3 removed. ArchiveMember in release.ts: 5 lines added. tarField in release.ts: 6 lines added. archiveMembersGuard in release.ts: 47 lines added. MEASURED_FILES in release.ts: 1 line added. checkMeasured in release.ts: 23 lines added and 8 removed. publish in release.ts: 8 lines added and 4 removed. tarSize in release.ts: 12 lines added. archiveMembers in release.ts: 85 lines added. runRelease in release.ts: 6 lines added and 7 removed.',
          removes: [
            "Member checks now gate metadata extraction and built-CLI execution",
          ],
          asked: 2,
          deskUnitId: "01M7FVYDSR000F8NEP46VCS2PW",
        },
        {
          id: "01M7FVYDSR000CDFQSTDK75G2S",
          title: "Upload invocation instrumentation",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Upload invocation instrumentation". ghInvocations in release-fixture.ts: 13 lines added. git in release-fixture.ts: 1 line added. releaseCheckout in release-fixture.ts: 2 lines added and 1 removed.',
          asked: 1,
          deskUnitId: "01M7FVYDSR000FBRDN4166460C",
        },
        {
          id: "01M7FVYDSR000AQVNFYB54DJPG",
          title: "Release upload regression tests",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 2,
            },
          ],
          digest:
            '2 units in 2 files for "Release upload regression tests". imports in release-command.test.ts: 1 line added and 1 removed. release-command.test.ts at line 17: 1 line added. ghCalls in release-command.test.ts: 1 line added and 3 removed. "with every guard passing, the release is one gh release create of a prerelease o" in release-command.test.ts: 10 lines added and 1 removed. "a dry run builds the files and prints the GitHub step, and creates nothing on Gi" in release-command.test.ts: 1 line added and 1 removed. imports in release-from.test.ts: 5 lines added and 4 removed. release-from.test.ts at line 11: 9 lines added. release-from.test.ts at line 30: 1 line added. measuredFolder in release-from.test.ts: 12 lines added and 2 removed. ghCalls in release-from.test.ts: 1 line added and 3 removed. createCall in release-from.test.ts: 2 lines added and 2 removed. expectUploadFrom in release-from.test.ts: 13 lines added. "a matching folder is uploaded as it is, on this commit, with nothing built" in release-from.test.ts: 3 lines added and 1 removed. "a dry run with --from runs every check and prints the upload of the three files," in release-from.test.ts: 1 line added and 1 removed. "an archive measured at an earlier commit ships from a later main with --target, " in release-from.test.ts: 2 lines added and 1 removed. "gh uploads the checked files from a folder whose path holds #, [, * and a space" in release-from.test.ts: 12 lines added. release-from.test.ts at line 372: 35 lines added. release-from.test.ts at line 407: 14 lines added. "a CLI with a quarantine mark is never run, and the release is refused" in release-from.test.ts: 1 line added.',
          asked: 0,
          deskUnitId: "01M7FVYDSR000F2ZPNF4CEB3DS",
        },
      ],
    },
    {
      id: "01M7FGWXY7JMZDD7CX3HN37412",
      title: "Clean stored briefing prose",
      range: "1fb4016..da3ff80",
      at: "2026-11-15T11:56:42.068Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7FGWYJC000DJAANZ3VYZ6P0",
          title: "Clean stored briefing prose",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Clean stored briefing prose". briefedFrom in briefing-settle.ts: 8 lines added and 4 removed. wholeSentences in briefing-settle.ts: 24 lines added. unitLeadOf in briefing-settle.ts: 3 lines added and 2 removed. digestFrom in briefing-settle.ts: 1 line added and 1 removed. briefing.ts at line 1404: 4 lines added and 3 removed. readings-briefing.test.ts at line 52: 1 line added. "a behaviour title passes; only a path-like title or code\'s own wording is refuse" in readings-briefing.test.ts: 6 lines added. "a second sentence over the bound is dropped whole, at the answer stage and at se" in readings-briefing.test.ts: 100 lines added. "the lead\'s trim counts code points, keeps astral characters whole and never cuts" in readings-briefing.test.ts: 1 line added.',
          removes: [
            "Selected briefing text can lose an ellipsis-ended partial sentence",
            "Unit leads discard eligible trailing partial sentences before bounding",
            "Digest text discards eligible trailing partial sentences before linking",
            "Metadata matching no longer accepts changed counts or arbitrary colon-count prose",
          ],
          asked: 2,
          deskUnitId: "01M7FGWYJC00050VEY67PXW281",
        },
        {
          id: "01M7FGWYJC0005WHN9515V54WF",
          title: "Preserve grouped section outcomes",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Preserve grouped section outcomes". settled.ts at line 6: 1 line added. imports in settled.ts: 1 line added and 1 removed. settled.ts at line 61: 2 lines added. settled.ts at line 78: 2 lines added. SettledGuided in settled.ts: 21 lines added and 3 removed. SettledSectionReview in settled.ts: 8 lines added. SettledSectionNote in settled.ts: 6 lines added. SECTION_MESSAGE in settled.ts: 2 lines added. settled.ts at line 420: 1 line added. settled.ts at line 479: 14 lines added. StoredGuided in settled.ts: 1 line added. settled.ts at line 504: 7 lines added and 2 removed. settled.ts at line 1712: 9 lines added. settled.ts at line 1721: 1 line added. settled.ts at line 1722: 4 lines added. settled.ts at line 1726: 1 line added. withoutCodes in settled.ts: 13 lines added. wholeExplained in settled.ts: 14 lines added. heldRowsOf in settled.ts: 1 line added. sentence in settled.ts: 2 lines added and 1 removed. unsureReason in settled.ts: 6 lines added. unsureNote in settled.ts: 3 lines added and 2 removed. sectionMessage in settled.ts: 16 lines added. guidedOf in settled.ts: 127 lines added and 40 removed. briefedOf in settled.ts: 2 lines added and 1 removed. settledBatches in settled.ts: 2 lines added and 1 removed. readings-settled.test.ts at line 37: 3 lines added. "the review message and the suggestion of a decided human-required unit; review w" in readings-settled.test.ts: 12 lines added. readings-settled.test.ts at line 1826: 2 lines added and 2 removed. readings-settled.test.ts at line 1828: 1 line added and 1 removed. mixedCollected in readings-settled.test.ts: 9 lines added and 3 removed. "a fully undecided unit keeps its notes alone and adds each section\'s reason; a s" in readings-settled.test.ts: 18 lines added. "a section\'s message is its own checked line, plain, at most 300 characters at a " in readings-settled.test.ts: 51 lines added. "through the real publisher: a mixed unit\'s section reviews and section notes rea" in readings-settle',
          removes: [
            "Assessment-derived briefing prose can lose a trailing partial sentence",
            "Stored explanations can lose trailing partial sentences on either side",
          ],
          asked: 2,
          deskUnitId: "01M7FGWYJC0002JHJH1X2XFR3F",
        },
        {
          id: "01M7FGWYJC00080K46Q1A8CEKT",
          title: "Consolidate file lane units",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Consolidate file lane units". BatchSection in units.ts: 5 lines added and 4 removed. unitVerdict in units.ts: 2 lines added and 1 removed. unitRequirements in units.ts: 1 line added and 1 removed. composeUnits in units.ts: 9 lines added and 10 removed. "a unit requests changes if any section does, approves only if all do, and an und" in readings-units.test.ts: 2 lines added and 9 removed. "a file\'s decided and undecided sections in one lane are one unit with no verdict" in readings-units.test.ts: 9 lines added and 13 removed. "an undecided section that requests changes gives its unit no verdict" in readings-units.test.ts: 29 lines added. "each lane\'s approval and request become the disposition applyLane defines" in readings-units.test.ts: 1 line added.',
          asked: 2,
          deskUnitId: "01M7FGWYJC0005W8Z60KV22JR2",
        },
        {
          id: "01M7FGWYJC000D7321CGDKKSEG",
          title: "Remove evaluation dependency symlink",
          unitCount: 1,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Remove evaluation dependency symlink". node_modules at line 1: 1 line removed.',
          removes: [
            "The existing external node_modules reference is no longer available",
          ],
          asked: 1,
          deskUnitId: "01M7FGWYJC0007T17C0994FK0Q",
        },
      ],
    },
    {
      id: "01M7E8B0TK992YTZMGH04BGCBG",
      title: "Precise readable briefings",
      range: "b5e7a20..1fb4016",
      at: "2026-11-15T00:07:50.055Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 5,
        },
        {
          lane: "agentic-review",
          count: 2,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E8B1EK0008MGMY6VJE1CJ6",
          title: "Precise readable briefings",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 3,
            },
          ],
          digest:
            '3 units in 3 files for "Precise readable briefings". undangled in briefing-settle.ts: 2 lines added and 2 removed. cutText in briefing-settle.ts: 3 lines added and 3 removed. HunkRange in briefing-settle.ts: 14 lines added. citeSide in briefing-settle.ts: 7 lines added. narrowedCite in briefing-settle.ts: 28 lines added. imports in briefing.ts: 1 line removed. briefing.ts at line 33: 7 lines added. briefing.ts at line 40: 2 lines added. hunkRangesOf in briefing.ts: 1 line removed. HunkRange in briefing.ts: 10 lines removed. HunkSides in briefing.ts: 1 line removed. citeSide in briefing.ts: 6 lines removed. PartSection in briefing.ts: 1 line added. resolveCite in briefing.ts: 1 line removed. narrowedCite in briefing.ts: 27 lines removed. briefing.ts at line 1400: 13 lines added and 7 removed. settled.ts at line 6: 1 line added. settled.ts at line 60: 3 lines added. heldRowsOf in settled.ts: 23 lines added. rowEvidence in settled.ts: 47 lines added and 5 removed. guidedOf in settled.ts: 6 lines added. settledBatches in settled.ts: 3 lines added.',
          removes: [
            "This change removes HunkRange in briefing.ts (10 lines).",
            "This change removes citeSide in briefing.ts (6 lines).",
            "This change removes narrowedCite in briefing.ts (27 lines).",
            "Evidence links clip to owned rows or omit shared-hunk fallbacks instead of always linking…",
            "Guided evidence generation receives unit ownership and review-wide row constraints",
            "Settled batch output applies review-wide ownership constraints to Guided evidence",
          ],
          asked: 3,
          deskUnitId: "01M7E8B1EK0002PFFDV8ZRQ0NN",
        },
        {
          id: "01M7E8B1EK000757QR54D4ZARH",
          title: "Citation scope regressions",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Citation scope regressions". imports in readings-settled.test.ts: 1 line removed. readings-settled.test.ts at line 8: 6 lines added. readings-settled.test.ts at line 36: 1 line added. lineAt in readings-settled.test.ts: 2 lines added. hunkAt in readings-settled.test.ts: 1 line added. "Guided rows: the linked rows on the strongest basis, the worst status of the uni" in readings-settled.test.ts: 4 lines added and 4 removed. "a repaired met keeps its reading text and cites under Missing" in readings-settled.test.ts: 1 line added and 1 removed. "a not-met row is unchanged, with its reading carried and no proof state" in readings-settled.test.ts: 1 line added and 1 removed. "through the real publisher: a Missing row\'s proof state and reading reach Record" in readings-settled.test.ts: 2 lines added and 2 removed. "two sections, one with a met-refused reading and one with no evidence or no answ" in readings-settled.test.ts: 1 line added and 1 removed. "two sections read apart, met and not-met: both readings are kept within bounds" in readings-settled.test.ts: 2 lines added and 2 removed. "Guided row evidence cites the lines it read: a span inside one row, a clip, an o" in readings-settled.test.ts: 59 lines added. "Guided row evidence narrows only into the unit\'s own rows: another unit\'s hunk o" in readings-settled.test.ts: 104 lines added.',
          asked: 1,
          deskUnitId: "01M7E8B1EK000EFRK6BC2QTJK1",
        },
        {
          id: "01M7E8B1EK0005R0N32NZC6A48",
          title: "Readable output regressions",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Readable output regressions". "a cite of a hunk\'s lines and the sections\' behaviour titles reach Records\' read," in readings-briefing-boundary.test.ts: 6 lines added and 2 removed. "a behaviour title passes; only a path-like title or code\'s own wording is refuse" in readings-briefing.test.ts: 13 lines added and 6 removed. "the lead\'s trim counts code points, keeps astral characters whole and never cuts" in readings-briefing.test.ts: 1 line added. "a two-sentence Briefed, lead or digest over its bound keeps its first sentence w" in readings-briefing.test.ts: 39 lines added.',
          asked: 2,
          deskUnitId: "01M7E8B1EK0002KM08YD0M3N2P",
        },
      ],
    },
    {
      id: "01M7E55TCX5YF2ZB2TXXWAJ9KE",
      title: "Portable release assembly",
      range: "4673441..5eb1164",
      at: "2026-11-14T23:27:10.761Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E5AZ3B00057PBPB0NPY9CE",
          title: "Portable release assembly",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '2 units in 2 files for "Portable release assembly". build-desk.ts at line 7: 3 lines added. imports in build-desk.ts: 1 line added and 1 removed. withoutMachinePaths in build-desk.ts: 42 lines added. indexOf in build-desk.ts: 6 lines added. buildDesk in build-desk.ts: 4 lines added. buildArchive in build.ts: 11 lines added and 1 removed.',
          asked: 2,
          deskUnitId: "01M7E5AZ3B000260PK19CBATNA",
        },
        {
          id: "01M7E5AZ3B000DPZ2CEG1AY24J",
          title: "Runtime storage resolution",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '3 units in 2 files for "Runtime storage resolution". workspace-cli.ts at line 76: 1 line added and 1 removed. readProfile in workspace-cli.ts: 1 line added and 1 removed. workspace-runtime.ts at line 24: 1 line added and 1 removed. configureWorkspaceCli in workspace-runtime.ts: 1 line added and 1 removed.',
          removes: [
            "Named pi-transition selection now refuses in release builds",
            "Default workspace profile selection now refuses in release builds",
          ],
          asked: 3,
          deskUnitId: "01M7E5AZ3B0004SVEVTJZNVT9C",
        },
        {
          id: "01M7E5AZ3B000CBM15FMEM4515",
          title: "Storage setup isolation",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Storage setup isolation". pi-storage.ts at line 115: 2 lines added and 1 removed. ownerProfile in pi-storage.ts: 21 lines added. PI_TRANSITION_STORAGE_PROFILE in pi-storage.ts: 10 lines added and 18 removed. piTransitionProfile in pi-storage.ts: 9 lines added. loadProfile in pi-storage.ts: 1 line added and 1 removed.',
          removes: [
            "Storage profile loading now refuses pi-transition in release builds",
            "The exported owner profile is unavailable when the build version is a string",
          ],
          asked: 1,
          deskUnitId: "01M7E5AZ3B0006KS5AXJB2F1GG",
        },
        {
          id: "01M7E5AZ3B000BGAR604JWATY6",
          title: "Archive portability verification",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Archive portability verification". imports in archive.test.ts: 1 line added. archive.test.ts at line 63: 32 lines added and 2 removed.',
          asked: 1,
          deskUnitId: "01M7E5AZ3B000F1Q4WSR3ZRVD9",
        },
      ],
    },
    {
      id: "01M7E4KS7TF3NPTRRBHG7MGFWN",
      title: "Generate grounded briefings",
      range: "b2ab4df..ce7fc47",
      at: "2026-11-14T23:12:07.097Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 6,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7E4KW2100090ABQQK7N5QP2",
          title: "Generate grounded briefings",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Generate grounded briefings". imports in briefing.ts: 1 line removed. briefing.ts at line 2: 5 lines added. BRIEFING_PROMPT_VERSION in briefing.ts: 1 line added and 1 removed. DIGEST_PROMPT_VERSION in briefing.ts: 5 lines added and 2 removed. BRIEFING_ANSWER_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_STORED_VERSION in briefing.ts: 1 line added and 1 removed. BRIEFING_RECIPE in briefing.ts: 1 line added and 1 removed. TITLE_CHARS in briefing.ts: 2 lines added. HunkRange in briefing.ts: 9 lines added. hunkRangesOf in briefing.ts: 12 lines added. citeSide in briefing.ts: 7 lines added. HunkSides in briefing.ts: 3 lines added. hunkSidesOf in briefing.ts: 20 lines added. hunksLine in briefing.ts: 29 lines added. PartSection in briefing.ts: 3 lines added. PartMaterial in briefing.ts: 2 lines added. linkedOf in briefing.ts: 9 lines added and 2 removed. partMaterial in briefing.ts: 5 lines added. DigestSection in briefing.ts: 2 lines added. DigestMaterial in briefing.ts: 2 lines added. digestMaterial in briefing.ts: 5 lines added. renderBriefingTask in briefing.ts: 2 lines added and 2 removed. renderDigestTask in briefing.ts: 1 line added and 1 removed. briefing.ts at line 996: 5 lines added. briefing.ts at line 1013: 5 lines added. BRIEFING_PROBLEM_CLASSES in briefing.ts: 10 lines added. BRIEFING_REPAIRED_WITHOUT_A_TURN in briefing.ts: 2 lines added. BriefingIndex in briefing.ts: 18 lines added. partIndexOf in briefing.ts: 20 lines added. digestIndexOf in briefing.ts: 20 lines added and 7 removed. narrowedCite in briefing.ts: 28 lines added. resolveCite in briefing.ts: 49 lines added. citeOf in briefing.ts: 5 lines added and 3 removed. briefing.ts at line 1353: 3 lines added. briefing.ts at line 1356: 2 lines added. KEPT in briefing.ts: 2 lines added. briefing.ts at line 1437: 10 lines added. fileLikeTitle in briefing.ts: 4 lines added. DigestText in briefing.ts: 1 line added. briefing.ts at line 1463: 2 lines added. briefing.ts at',
          removes: [
            "Explained citation conversion returns at most one bare hunk per input",
            "Caller declaration locations no longer qualify as linked call-site evidence",
            "Section answers now require a title string",
          ],
          asked: 2,
          deskUnitId: "01M7E4KW21000C5Y1ZSW9ZHWVA",
        },
        {
          id: "01M7E4KW21000DBRQVE2D74WYY",
          title: "Settle bounded briefing text",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Settle bounded briefing text". SectionBriefing in briefing-settle.ts: 2 lines added. FileLead in briefing-settle.ts: 2 lines added. undangled in briefing-settle.ts: 21 lines added. boundedText in briefing-settle.ts: 3 lines added and 1 removed. cutText in briefing-settle.ts: 7 lines added. unitLeadOf in briefing-settle.ts: 7 lines added and 7 removed. fileLeadOf in briefing-settle.ts: 15 lines added. unitTitleOf in briefing-settle.ts: 24 lines added. unitLinked in briefing-settle.ts: 2 lines added and 1 removed.',
          asked: 1,
          deskUnitId: "01M7E4KW21000F87N2KY5C19DQ",
        },
        {
          id: "01M7E4KW2100003KRPN15PT9J1",
          title: "Carry settled batch context",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Carry settled batch context". settledBriefingsOf in collect.ts: 2 lines added. imports in collect.ts: 1 line added. settled.ts at line 60: 1 line added. SettledBatchSchema in settled.ts: 1 line added. Unstored in settled.ts: 8 lines added. StoredBatch in settled.ts: 1 line added. settled.ts at line 515: 8 lines added. settled.ts at line 523: 1 line added. PlannedSection in settled.ts: 1 line added. sameBatchReferences in settled.ts: 43 lines added and 13 removed. SettledInput in settled.ts: 2 lines added. settledBatches in settled.ts: 22 lines added and 3 removed. rowOf in readings-settled.test.ts: 31 lines added. "same-batch references: a caller-declaration row writes none; a reference row wri" in readings-settled.test.ts: 23 lines added. "same-batch references: a deletion-only callee\'s lines are sourced at the merge b" in readings-settled.test.ts: 65 lines added.',
          removes: [
            "References exclude non-use-site rows and omit old-side sources without a valid base.",
          ],
          asked: 2,
          deskUnitId: "01M7E4KW210001TKZ2Z8NQEYZ9",
        },
        {
          id: "01M7E4KW210005PEM35K61JR87",
          title: "Verify briefing contracts",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 2,
            },
          ],
          digest:
            '3 units in 3 files for "Verify briefing contracts". world in pi-briefing-task.test.ts: 13 lines added and 2 removed. "a cite of a hunk\'s lines and the sections\' behaviour titles reach Records\' read," in readings-briefing-boundary.test.ts: 41 lines added. imports in readings-briefing.test.ts: 1 line added. readings-briefing.test.ts at line 28: 5 lines added. readings-briefing.test.ts at line 51: 2 lines added. "the key holds only the briefing\'s content: run, cycle, head, group, lane, verdic" in readings-briefing.test.ts: 6 lines added and 6 removed. readings-briefing.test.ts at line 459: 5 lines added and 2 removed. "the rubric is the design\'s with the ruled lines and titles, word for word, and t" in readings-briefing.test.ts: 1 line added and 1 removed. "every section is asked for Briefed, and a missing one is sent back and left unan" in readings-briefing.test.ts: 2 lines added and 1 removed. "a sentence with no link is counted as uncited-claim, without a turn" in readings-briefing.test.ts: 8 lines added and 1 removed. "a link in Explained is stripped to its phrase, counted as ids-in-explained, with" in readings-briefing.test.ts: 8 lines added and 1 removed. "a lead is kept only for a marked path, at most once, and bounded without cutting" in readings-briefing.test.ts: 16 lines added and 3 removed. "a marked file\'s missing lead is sent back for a turn; with no turn left it is co" in readings-briefing.test.ts: 75 lines added. "a bare hunk ID, unit handle or line cite outside a link is taken out of Briefed," in readings-briefing.test.ts: 68 lines added. "an unknown cite is dropped and counted as unknown-cite, and judging words are co" in readings-briefing.test.ts: 43 lines added. "a cite of a hunk\'s lines is kept inside one of its rows, clipped to it, or falls" in readings-briefing.test.ts: 85 lines added. "a cite of lines: old side for a deletion, and a range across two rows narrowed i" in readings-briefing.test.ts: 29 lines added. "a missing section title is sent ba',
          asked: 1,
          deskUnitId: "01M7E4KW21000284YP3RPH4GYA",
        },
        {
          id: "01M7E4KW21000F71AYAGMPMT6P",
          title: "Lockfiles and generated files",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Lockfiles and generated files". MARKS in briefing.ts: 1 line added. briefingsFor in briefing.ts: 1 line added. BASE in briefing.ts: 2 lines added. settle in briefing.ts: 4 lines added and 1 removed.',
          asked: 0,
          deskUnitId: "01M7E4KW210001AJV7BT0B5HND",
        },
      ],
    },
    {
      id: "01M7DTFA8J3TW9A9NEZV99X4TE",
      title: "Versioned release assembly",
      range: "9f18a04..4673441",
      at: "2026-11-14T20:05:55.784Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 8,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7DTFF4C0001F8AH0CHBGQD2",
          title: "Versioned release assembly",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '2 units in 2 files for "Versioned release assembly". RELEASE_BUILD in cli-version.ts: 3 lines added. imports in build.ts: 1 line added. imports in build.ts: 1 line added. build.ts at line 28: 5 lines added. build.ts at line 41: 5 lines added and 2 removed. addReviewDesk in build.ts: 15 lines added and 6 removed. SKILL_TEMPLATE in build.ts: 2 lines added and 2 removed. buildArchive in build.ts: 27 lines added and 6 removed.',
          asked: 2,
          deskUnitId: "01M7DTFF4C0001GB4RN5RP5JBM",
        },
        {
          id: "01M7DTFF4C000D29V5CVC6Z8WM",
          title: "Bundled skill integration",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
          ],
          digest:
            '3 units in 3 files for "Bundled skill integration". Set up in setup.md: 3 lines removed. imports in cli.ts: 1 line added and 1 removed. cli.ts at line 33: 6 lines added. cli.ts at line 39: 2 lines added and 3 removed. imports in skills-cli.ts: 1 line added and 1 removed. readLine in skills-cli.ts: 33 lines added and 2 removed.',
          removes: [
            "Setup guidance no longer warns that some deeper modes show only the diff",
            "Release help omits the workspace command listing",
          ],
          asked: 3,
          deskUnitId: "01M7DTFF4C0005PD4SZSFDSBWV",
        },
        {
          id: "01M7DTFF4C000DG5MSEJXE5P57",
          title: "Installation and skill checks",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 2,
            },
          ],
          digest:
            '3 units in 2 files for "Installation and skill checks". install.test.ts at line 19: 1 line added. "bun run check leaves a receipt only when it started and finished clean at one co" in install.test.ts: 3 lines added and 11 removed. "one untracked file in the checkout leaves no receipt" in install.test.ts: 71 lines added. "an install holds the lock; one stopped releases it and stops its build" in install.test.ts: 1 line added. imports in skills-cli.test.ts: 1 line added. imports in skills-cli.test.ts: 7 lines added and 2 removed. skills-cli.test.ts at line 996: 70 lines added.',
          removes: [
            "Root runs omit the unreadable-directory case and use an ENOTDIR fixture instead",
          ],
          asked: 1,
          deskUnitId: "01M7DTFF4C00080N1WPEZSRFMV",
        },
        {
          id: "01M7DTFF4C0007AMZEWT58790T",
          title: "Final distribution verification",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Final distribution verification". imports in archive.test.ts: 2 lines added and 2 removed. imports in archive.test.ts: 3 lines added. archive.test.ts at line 18: 4 lines removed. archive.test.ts at line 83: 23 lines added and 6 removed. buildWorkspaces in detached-build.test.ts: 3 lines added.',
          asked: 2,
          deskUnitId: "01M7DTFF4C000BW3Q6KST2FA0S",
        },
        {
          id: "01M7DTFF4C000CA6B0S0J7ECTG",
          title: "Repository housekeeping",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Repository housekeeping"..gitignore at line 29: 3 lines added.',
          removes: [
            "Finder metadata no longer contributes untracked files to the clean-tree guard",
          ],
          asked: 1,
          deskUnitId: "01M7DTFF4C0004REKZR9NRQEF9",
        },
      ],
    },
    {
      id: "01M7DT4BSNZGGJ167Y970BA548",
      title: "Behaviour and evidence",
      range: "afab008..57a9f3a",
      at: "2026-11-14T20:00:01.680Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 3,
        },
        {
          lane: "human-suggested",
          count: 9,
        },
        {
          lane: "agentic-review",
          count: 4,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7DT4CDH000AHAHVTFWMKT4E",
          title: "Behaviour and evidence",
          unitCount: 4,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '4 units in 2 files for "Behaviour and evidence". imports in briefing.ts: 1 line added and 1 removed. briefing.ts at line 18: 2 lines removed. imports in briefing.ts: 1 line added and 1 removed. BRIEFING_PART_BOUND in briefing.ts: 9 lines added and 6 removed. BRIEFING_PROMPT_VERSION in briefing.ts: 5 lines added and 2 removed. DIGEST_PROMPT_VERSION in briefing.ts: 2 lines added and 2 removed. BRIEFING_ANSWER_VERSION in briefing.ts: 3 lines added and 2 removed. BRIEFING_STORED_VERSION in briefing.ts: 2 lines added and 2 removed. BRIEFING_RECIPE in briefing.ts: 1 line added and 1 removed. LEAD_CHARS in briefing.ts: 2 lines added. TESTED_LINE_CHARS in briefing.ts: 2 lines added. RequirementText in briefing.ts: 8 lines added. AssessText in briefing.ts: 3 lines added and 2 removed. briefing.ts at line 305: 2 lines added. headLineText in briefing.ts: 23 lines added. anchorHunks in briefing.ts: 23 lines added and 6 removed. assessTextOf in briefing.ts: 52 lines added and 13 removed. askedOf in briefing.ts: 20 lines removed. PartSection in briefing.ts: 6 lines added and 1 removed. LeadFile in briefing.ts: 8 lines added. PartMaterial in briefing.ts: 3 lines added. linkedOf in briefing.ts: 49 lines added. partMaterial in briefing.ts: 46 lines added and 22 removed. assessLines in briefing.ts: 4 lines added and 3 removed. renderBriefingTask in briefing.ts: 19 lines added and 9 removed. briefing.ts at line 861: 5 lines added and 3 removed. briefing.ts at line 882: 3 lines added and 2 removed. briefing.ts at line 888: 8 lines added. DigestAnswer in briefing.ts: 1 line added. BriefingAnswer in briefing.ts: 7 lines added and 2 removed. BRIEFING_PROBLEM_CLASSES in briefing.ts: 6 lines added and 1 removed. claimsOf in briefing.ts: 9 lines added. uncitedClaimsOf in briefing.ts: 6 lines added. BriefingIndex in briefing.ts: 4 lines added and 2 removed. partIndexOf in briefing.ts: 2 lines added and 1 removed. digestIndexOf in briefing.ts: 2 lines added and 1 removed. cleanText in briefing',
          removes: [
            "This change removes askedOf in briefing.ts (20 lines).",
            "Section answers no longer accept null Briefed values.",
            "Submissions must now include a leads array, empty when none are requested.",
            "The replacement fixture drops unknown-cite and judging-word examples.",
            "The helper no longer supplies group-level assessment input.",
            "The exclusion test no longer supplies group-level assessment input.",
          ],
          asked: 3,
          deskUnitId: "01M7DT4CDH0005PX0K8WNVAD9H",
        },
        {
          id: "01M7DT4CDH000CAWFJXYPZKGYR",
          title: "Briefing agent contract",
          unitCount: 4,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '4 units in 2 files for "Briefing agent contract". imports in briefing-task.ts: 1 line added and 1 removed. briefingTask in briefing-task.ts: 15 lines added and 9 removed. briefingAgent in briefing-task.ts: 11 lines added and 2 removed. pi-briefing-task.test.ts at line 49: 1 line added. world in pi-briefing-task.test.ts: 33 lines added and 10 removed. "a briefing task stored by an older build is never resumed: held as migration_fai" in pi-briefing-task.test.ts: 39 lines added.',
          removes: [
            "Version-1 resumption is disabled; parts now receive group evidence",
          ],
          asked: 3,
          deskUnitId: "01M7DT4CDH00015QQ1PHPEJR22",
        },
        {
          id: "01M7DT4CDH000FY30J79A3TDCX",
          title: "Settle and publish orientation",
          unitCount: 5,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 3,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '5 units in 3 files for "Settle and publish orientation". SectionBriefing in briefing-settle.ts: 2 lines removed. FileLead in briefing-settle.ts: 6 lines added. DigestBriefing in briefing-settle.ts: 1 line added. SettledBriefings in briefing-settle.ts: 2 lines added. briefedFrom in briefing-settle.ts: 7 lines added and 6 removed. LEAD_POINTS in briefing-settle.ts: 2 lines added. pointsOf in briefing-settle.ts: 2 lines added. boundedText in briefing-settle.ts: 35 lines added. DIGEST_FAILED in briefing-settle.ts: 1 line added. unitLeadOf in briefing-settle.ts: 27 lines added. collect.ts at line 57: 1 line added. settledBriefingsOf in collect.ts: 8 lines added and 4 removed. imports in collect.ts: 6 lines added. imports in readings-briefing-boundary.test.ts: 2 lines added. readings-briefing-boundary.test.ts at line 14: 3 lines added and 1 removed. publishedRead in readings-briefing-boundary.test.ts: 1 line removed. readings-briefing-boundary.test.ts at line 21: 1 line removed. "written: no unit outside the generated batch publishes Facts only, and the diges" in readings-briefing-boundary.test.ts: 3 lines added and 2 removed. "failed: every affected unit carries the briefing-failed gap, and the digest says" in readings-briefing-boundary.test.ts: 1 line added and 1 removed. "a same-batch reference by code, each range\'s hunk, the unit lead and the Briefed" in readings-briefing-boundary.test.ts: 108 lines added.',
          removes: [
            "This change removes readings-briefing-boundary.test.ts at line 21 (1 line).",
          ],
          asked: 4,
          deskUnitId: "01M7DT4CDH000A6PEJWJAXX5BA",
        },
        {
          id: "01M7DT4CDH0000GV3ZNGKP4GXV",
          title: "Connect related changes",
          unitCount: 2,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '2 units in 2 files for "Connect related changes". imports in settled.ts: 1 line removed. settled.ts at line 2: 6 lines added. imports in settled.ts: 1 line added and 1 removed. settled.ts at line 39: 5 lines added. settled.ts at line 59: 1 line added. SettledBatch in settled.ts: 2 lines added and 2 removed. Reference in settled.ts: 2 lines removed. SettledSection in settled.ts: 6 lines added. SettledUnit in settled.ts: 5 lines added. SettledBatchSchema in settled.ts: 3 lines added. rangeHunksOf in settled.ts: 11 lines added. settled.ts at line 614: 3 lines added. rangeHunksFor in settled.ts: 21 lines added. SettledReference in settled.ts: 7 lines added. ReferenceSection in settled.ts: 10 lines added. settled.ts at line 655: 2 lines added. sameBatchReferences in settled.ts: 197 lines added. clipTo in settled.ts: 1 line added. SettledInput in settled.ts: 4 lines added. settledBatches in settled.ts: 65 lines added. readings-settled.test.ts at line 27: 4 lines added. imports in readings-settled.test.ts: 3 lines added. "a settled batch of a mixed range passes every check the publisher makes and ever" in readings-settled.test.ts: 2 lines added. callerOnHelper in readings-settled.test.ts: 30 lines added. "same-batch references: a confirmed caller row into another unit\'s owned lines wr" in readings-settled.test.ts: 102 lines added. "range hunks: one per owned range when each is a hunk ID in one file, else none" in readings-settled.test.ts: 28 lines added. "same-batch references: an unconfirmed row writes none, and no head writes none" in readings-settled.test.ts: 22 lines added. "same-batch references: a row whose call site is in the same unit writes none" in readings-settled.test.ts: 52 lines added.',
          removes: [
            "This change removes Reference in settled.ts (2 lines).",
            "Reference values must satisfy the assembled-reference contract instead of arbitrary…",
          ],
          asked: 1,
          deskUnitId: "01M7DT4CDH000DHEGCYZKCJAGW",
        },
        {
          id: "01M7DT4CDH000EM1ZTEKT3512V",
          title: "Lockfiles and generated files",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Lockfiles and generated files". briefing.ts at line 11: 1 line added. briefingsFor in briefing.ts: 16 lines added and 8 removed. HEAD in briefing.ts: 2 lines added. settle in briefing.ts: 7 lines added and 1 removed.',
          asked: 0,
          deskUnitId: "01M7DT4CDH000B3R7ABK8ZMF4C",
        },
      ],
    },
    {
      id: "01M7DMQYA1SSCW916WCHNMM9M9",
      title: "Per-batch digest scheduling",
      range: "50fe2b7..cdd93ab",
      at: "2026-11-14T18:25:14.988Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 1,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7DMQYRV0002JE1D4XMYP3M9",
          title: "Per-batch digest scheduling",
          unitCount: 2,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
          ],
          digest:
            '2 units in 1 file for "Per-batch digest scheduling". BriefingTaskInput in briefing-task.ts: 6 lines added and 1 removed. ownedOf in briefing-task.ts: 10 lines added. PlannedCall in briefing-task.ts: 1 line added. briefingTask in briefing-task.ts: 77 lines added and 17 removed.',
          asked: 2,
          deskUnitId: "01M7DMQYRV000AE03BNBXD474J",
        },
        {
          id: "01M7DMQYRV000731FJRZ0PT0FX",
          title: "Batch scheduling regression tests",
          unitCount: 1,
          needYou: 0,
          lanes: [
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '1 unit in 1 file for "Batch scheduling regression tests". imports in pi-briefing-task.test.ts: 2 lines added and 1 removed. pi-briefing-task.test.ts at line 82: 2 lines added and 1 removed. world in pi-briefing-task.test.ts: 17 lines added. "a batch of one group waits only on its own group\'s parts: X is done while the sh" in pi-briefing-task.test.ts: 9 lines added and 2 removed. "a shared batch\'s digest waits only on the groups\' Assess and starts while the ow" in pi-briefing-task.test.ts: 3 lines added and 1 removed. "a digest task owning two shared batches starts each digest once its own batch\'s " in pi-briefing-task.test.ts: 116 lines added.',
          asked: 0,
          deskUnitId: "01M7DMQYRV00002PT9TR7P89NY",
        },
      ],
    },
    {
      id: "01M7DKKE8C75PWGDFJMEAMNG8K",
      title: "Concurrent batch execution",
      range: "d57d3cd..50fe2b7",
      at: "2026-11-14T18:05:40.453Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 2,
        },
        {
          lane: "human-suggested",
          count: 8,
        },
        {
          lane: "agentic-review",
          count: 4,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M7DKKEM6000EW7W7DA629BMQ",
          title: "Concurrent batch execution",
          unitCount: 4,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '4 units in 2 files for "Concurrent batch execution". BRIEFING_TASK in briefing-task.ts: 8 lines added and 5 removed. BriefingTaskInput in briefing-task.ts: 6 lines added. ownedDigests in briefing-task.ts: 16 lines added. PlannedCall in briefing-task.ts: 1 line added. briefingTask in briefing-task.ts: 87 lines added and 68 removed. pi-briefing-task.test.ts at line 69: 1 line added. imports in pi-briefing-task.test.ts: 1 line added. pi-briefing-task.test.ts at line 81: 1 line added and 1 removed. pi-briefing-task.test.ts at line 115: 2 lines added and 2 removed. pi-briefing-task.test.ts at line 118: 1 line added. pi-briefing-task.test.ts at line 119: 1 line added. "one run per key: two briefings of the same part make one model call; a later one" in pi-briefing-task.test.ts: 10 lines added and 3 removed. "inside 60 s of the cut-off with nothing stored it sends nothing: the batch is he" in pi-briefing-task.test.ts: 10 lines added and 2 removed. pi-briefing-task.test.ts at line 841: 6 lines added. pi-briefing-task.test.ts at line 847: 12 lines added. pi-briefing-task.test.ts at line 859: 22 lines added. callOf in pi-briefing-task.test.ts: 2 lines added. world in pi-briefing-task.test.ts: 119 lines added and 34 removed. "a batch of one group waits only on its own group\'s parts: X is done while the sh" in pi-briefing-task.test.ts: 96 lines added. "a shared batch\'s digest waits only on the groups\' Assess and starts while the ow" in pi-briefing-task.test.ts: 52 lines added.',
          asked: 3,
          deskUnitId: "01M7DKKEM6000CZ48GJNYZ6ADA",
        },
        {
          id: "01M7DKKEM60001ZWJ8391BBKKY",
          title: "Settlement and briefing reuse",
          unitCount: 3,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 2,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 3 files for "Settlement and briefing reuse". digestGap in briefing-settle.ts: 29 lines added. BatchBriefing in briefing-settle.ts: 1 line added. collect.ts at line 639: 1 line added. briefingTaskInputs in collect.ts: 20 lines added and 14 removed. settledBriefingsOf in collect.ts: 21 lines added and 8 removed. "code\'s checks: an unknown cite dropped, text clipped, unasked Briefed dropped, j" in readings-briefing.test.ts: 1 line added. "settle, failed: code\'s Briefed with factor findings, no Explained, code\'s digest" in readings-briefing.test.ts: 5 lines added and 3 removed. "settle, cut: not settled while a follow-on is left; final, published with the br" in readings-briefing.test.ts: 2 lines added and 1 removed. "a submodule pointer\'s undecided note: the pointer\'s own line at unsure, the caus" in readings-briefing.test.ts: 58 lines added. "a standalone digest that failed or was cut, every part written, gives the batch " in readings-briefing.test.ts: 31 lines added.',
          asked: 2,
          deskUnitId: "01M7DKKEM600093FVVHGYPD1RP",
        },
        {
          id: "01M7DKKEM6000A15CPEGXNWR4W",
          title: "Briefing boundaries and prompts",
          unitCount: 3,
          needYou: 1,
          lanes: [
            {
              lane: "human-required",
              count: 1,
            },
            {
              lane: "human-suggested",
              count: 1,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '3 units in 2 files for "Briefing boundaries and prompts". BRIEFING_ANSWER_VERSION in briefing.ts: 4 lines added and 1 removed. DIGEST_SUBMIT in briefing.ts: 1 line removed. digestSystem in briefing.ts: 1 line added and 1 removed. BriefingAnswer in briefing.ts: 9 lines added. BRIEFING_PROBLEM_CLASSES in briefing.ts: 1 line removed. AnyBriefingAnswer in briefing.ts: 2 lines removed. BriefingDigestAnswer in briefing.ts: 6 lines removed. briefingRepair in briefing.ts: 2 lines added and 2 removed. briefingStep in briefing.ts: 12 lines added and 34 removed. "failed: every affected unit carries the briefing-failed gap, and the digest says" in readings-briefing-boundary.test.ts: 2 lines added and 1 removed.',
          removes: [
            "This change removes DIGEST_SUBMIT in briefing.ts (1 line).",
            "This change removes BriefingDigestAnswer in briefing.ts (6 lines).",
            "This change removes AnyBriefingAnswer in briefing.ts (2 lines).",
          ],
          asked: 2,
          deskUnitId: "01M7DKKEM6000DNNW5D5XS5FJ0",
        },
        {
          id: "01M7DKKEM600049PHCB60WFMXR",
          title: "Batch context and evidence",
          unitCount: 4,
          needYou: 0,
          lanes: [
            {
              lane: "human-suggested",
              count: 3,
            },
            {
              lane: "agentic-review",
              count: 1,
            },
          ],
          digest:
            '4 units in 4 files for "Batch context and evidence". readingName in reading-task.ts: 8 lines added and 3 removed. imports in batches.ts: 1 line added. reviewBatches in batches.ts: 5 lines added. settled.ts at line 45: 1 line added. settled.ts at line 1360: 2 lines added and 2 removed. settled.ts at line 1376: 2 lines added and 1 removed. undecidedNote in settled.ts: 1 line added and 3 removed. settledBatches in settled.ts: 6 lines added. "the review\'s real readings plan, given graph\'s head gate as the review gives it," in readings-evidence.test.ts: 6 lines added and 3 removed.',
          removes: [
            "The pointer-specific override applies only to the unsure cause.",
          ],
          asked: 3,
          deskUnitId: "01M7DKKEM60007TJCJZFWVN2CF",
        },
      ],
    },
  ],
  filter: "waiting",
  page: 1,
  pageSize: 10,
  total: 172,
  counts: {
    all: 481,
    waiting: 172,
  },
  waiting: {
    units: 3486,
    reviews: 172,
    nextUnitId: "01M7G6QADR00027J1K5Z1W78WZ",
  },
  newestHead: "8d089212a9f0ac836370c1b65069e4bfb70c00a4",
}
