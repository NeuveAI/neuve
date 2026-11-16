import { atom } from "jotai"

import type {
  DeliveryLanguage,
  DeliverySettings,
  DeliverySettingsAtom,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"

/**
 * Settings page state. The workspace setting itself lives in the settings
 * atom the contract provides (`useDeliverySettingsAtom`): the real setting in
 * browser storage, or the `/mock` layout's sample atom. These atoms say which
 * row the preview shows and write that setting the way the board does; each
 * write names the settings atom it writes.
 */

/** What the preview shows: the workspace default or one language row. */
export type PreviewTarget =
  { kind: "workspace" } | { kind: "language"; id: DeliveryLanguage }

export const previewTargetAtom = atom<PreviewTarget>({ kind: "workspace" })

/** The stop the preview shows, resolved from the setting. */
export function previewStop(
  settings: DeliverySettings,
  target: PreviewTarget
): DeliveryStop {
  if (target.kind === "language")
    return settings.byLanguage[target.id] ?? settings.workspaceDefault
  return settings.workspaceDefault
}

/** Moving the main dial previews the workspace default. */
export const setWorkspaceDefaultAtom = atom(
  null,
  (
    get,
    set,
    { source, stop }: { source: DeliverySettingsAtom; stop: DeliveryStop }
  ) => {
    set(source, { ...get(source), workspaceDefault: stop })
    set(previewTargetAtom, { kind: "workspace" })
  }
)

function withoutLanguage(
  byLanguage: DeliverySettings["byLanguage"],
  id: DeliveryLanguage
): DeliverySettings["byLanguage"] {
  return Object.fromEntries(
    Object.entries(byLanguage).filter(([language]) => language !== id)
  )
}

/**
 * A language row's dial. Choosing the workspace default's stop returns the
 * language to following the default (board behaviour); any other stop
 * refines it. Either way the preview switches to that language.
 */
export const setLanguageStopAtom = atom(
  null,
  (
    get,
    set,
    {
      source,
      id,
      stop,
    }: {
      source: DeliverySettingsAtom
      id: DeliveryLanguage
      stop: DeliveryStop
    }
  ) => {
    const settings = get(source)
    const rest = withoutLanguage(settings.byLanguage, id)
    set(source, {
      ...settings,
      byLanguage:
        stop === settings.workspaceDefault ? rest : { ...rest, [id]: stop },
    })
    set(previewTargetAtom, { kind: "language", id })
  }
)

/** "Reset": the language follows the workspace default again. */
export const resetLanguageAtom = atom(
  null,
  (
    get,
    set,
    { source, id }: { source: DeliverySettingsAtom; id: DeliveryLanguage }
  ) => {
    const settings = get(source)
    set(source, {
      ...settings,
      byLanguage: withoutLanguage(settings.byLanguage, id),
    })
    set(previewTargetAtom, { kind: "language", id })
  }
)
