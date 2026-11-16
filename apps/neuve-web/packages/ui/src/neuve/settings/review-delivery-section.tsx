import * as React from "react"
import { useAtomValueRawSync, useSetAtom } from "jotai"
import { PlusIcon } from "lucide-react"

import { CSS_TRANSITION } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  useDeliverySettings,
  useDeliverySettingsAtom,
} from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryLanguageInfo } from "@workspace/ui/neuve/shared/delivery"
import { DeliveryDial } from "@workspace/ui/neuve/shared/delivery-dial"
import { DeliveryPreview } from "@workspace/ui/neuve/settings/delivery-preview"
import {
  previewStop,
  previewTargetAtom,
  resetLanguageAtom,
  setLanguageStopAtom,
  setWorkspaceDefaultAtom,
} from "@workspace/ui/neuve/settings/atoms"

const HELP = "m-0 max-w-[540px] text-[13px] leading-[19px] text-ink-muted"

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"

function refinedLabel(refined: number, total: number) {
  return refined === 0
    ? "All follow the default"
    : `${refined} of ${total} refined`
}

/** One language: preview button, follows/reset, and its mini dial. */
function LanguageRow({ language }: { language: DeliveryLanguageInfo }) {
  const source = useDeliverySettingsAtom()
  const settings = useDeliverySettings()
  const followsId = React.useId()
  const target = useAtomValueRawSync(previewTargetAtom)
  const setTarget = useSetAtom(previewTargetAtom)
  const setStop = useSetAtom(setLanguageStopAtom)
  const reset = useSetAtom(resetLanguageAtom)
  const own = settings.byLanguage[language.id]
  const follows = own === undefined
  const selected = target.kind === "language" && target.id === language.id
  return (
    <li
      data-selected={selected || undefined}
      className={cn(
        "grid grid-cols-1 items-center gap-x-4 gap-y-2 border-t border-line-2 px-3.5 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]",
        CSS_TRANSITION.tone,
        selected ? "bg-paper" : "hover:bg-paper"
      )}
    >
      <button
        type="button"
        aria-label={`Preview ${language.name}`}
        aria-pressed={selected}
        onClick={() => setTarget({ kind: "language", id: language.id })}
        className={cn(
          "flex min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2.5 justify-self-start rounded-[4px] border-0 bg-transparent p-0 text-left font-sans text-ink pointer-coarse:min-h-11 pointer-coarse:items-center",
          FOCUS
        )}
      >
        <span className="text-sm font-medium">{language.name}</span>
        {language.fileTypes && language.fileTypes.length > 0 && (
          <span className="font-mono text-xs text-ink-muted">
            {language.fileTypes.join(" ")}
          </span>
        )}
      </button>
      <div className="flex flex-wrap items-center gap-2.5">
        {follows ? (
          <span id={followsId} className="text-xs text-ink-muted">
            Follows default
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Reset ${language.name} to the workspace default`}
            onClick={() => reset({ source, id: language.id })}
            className={cn(
              "cursor-pointer rounded-[4px] border-0 bg-transparent px-1 py-0.5 font-sans text-xs text-ink-muted underline decoration-line-strong underline-offset-[3px] hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-2.5",
              CSS_TRANSITION.tone,
              FOCUS
            )}
          >
            Reset
          </button>
        )}
        <DeliveryDial
          size="mini"
          label={`${language.name} delivery`}
          value={own ?? settings.workspaceDefault}
          follows={follows}
          describedBy={follows ? followsId : undefined}
          onChange={(stop) => setStop({ source, id: language.id, stop })}
        />
      </div>
    </li>
  )
}

/**
 * Settings section "Review delivery": the workspace default (large dial),
 * refined by language, with a live preview aside. The languages are data
 * (never a closed list); the setting is the one the contract provides.
 */
export function ReviewDeliverySection({
  languages,
  sampleLanguages,
}: {
  /** The workspace's languages (provider data; a fixture today). */
  languages: ReadonlyArray<DeliveryLanguageInfo>
  /** The list is sample data, not languages the workspace reported. */
  sampleLanguages: boolean
}) {
  const source = useDeliverySettingsAtom()
  const settings = useDeliverySettings()
  const setDefault = useSetAtom(setWorkspaceDefaultAtom)
  const target = useAtomValueRawSync(previewTargetAtom)
  const refined = languages.filter(
    (language) => settings.byLanguage[language.id] !== undefined
  ).length
  const previewed =
    target.kind === "language"
      ? languages.find((language) => language.id === target.id)
      : undefined
  return (
    <div className="flex flex-wrap items-start gap-10">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-12">
        <section
          aria-labelledby="review-delivery-title"
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <h2
              id="review-delivery-title"
              className="m-0 text-[32px] leading-[38px] font-semibold tracking-[-0.025em]"
            >
              Review delivery
            </h2>
            <p className={cn(HELP, "text-sm leading-[21px]")}>
              How much each review explains before anyone reads the code. Every
              stop keeps the same cited facts.
            </p>
          </div>
          <DeliveryDial
            size="large"
            label="Review delivery for this workspace"
            value={settings.workspaceDefault}
            onChange={(stop) => setDefault({ source, stop })}
          />
          <p className="m-0 text-xs leading-[17px] text-ink-muted">
            This is a sample setting. It’s saved in this browser only and isn’t
            shared with your workspace.
          </p>
        </section>

        <section
          aria-labelledby="refine-by-language-title"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h3
                id="refine-by-language-title"
                className="m-0 text-[15px] font-semibold"
              >
                Refine by language
              </h3>
              <p className={HELP}>
                {sampleLanguages
                  ? "These are sample languages until this workspace reports its own. Each follows the workspace default until you set it."
                  : "Each language follows the workspace default until you set it."}
              </p>
            </div>
            <span className="font-mono text-[11.5px] text-ink-muted">
              {refinedLabel(refined, languages.length)}
            </span>
          </div>
          <ul className="m-0 list-none overflow-hidden rounded-xl bg-surface p-0 shadow-[0_0_0_1px_var(--nv-line)]">
            {languages.map((language) => (
              <LanguageRow key={language.id} language={language} />
            ))}
          </ul>
          <div>
            <button
              type="button"
              aria-disabled="true"
              title="Not available in this sample"
              className={cn(
                "inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 font-sans text-[13px] text-ink-muted",
                FOCUS
              )}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Add a language
            </button>
          </div>
        </section>
      </div>

      <aside
        aria-label="Preview"
        className="sticky top-6 flex max-w-[460px] min-w-0 flex-[1_1_380px] flex-col"
      >
        <DeliveryPreview
          stop={previewStop(settings, target)}
          rowName={previewed?.name ?? "Workspace default"}
          termsLabel={previewed ? `${previewed.name} terms` : "Language terms"}
        />
      </aside>
    </div>
  )
}
