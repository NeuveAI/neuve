// Modified by Neuve AI in 2026: share language loading through SharedWork. See NOTICE.md.

import { SharedWork } from '@neuve/records-core/shared-work';
import { bundledLanguages } from 'shiki';

import type { BundledLanguage, SupportedLanguages } from '../../types';
import { isWorkerContext } from '../../utils/isWorkerContext';
import type { ResolvedLanguage } from '../../worker';
import { RegisteredCustomLanguages, ResolvedLanguages } from './constants';

const languageWork = new SharedWork<ResolvedLanguage>();

export async function resolveLanguage(
  lang: Exclude<SupportedLanguages, 'text' | 'ansi'>
): Promise<ResolvedLanguage> {
  // Prevent dynamic imports in worker contexts
  if (isWorkerContext()) {
    throw new Error(
      `resolveLanguage("${lang}") cannot be called from a worker context. ` +
        'Languages must be pre-resolved on the main thread and passed to the worker via the resolvedLanguages parameter.'
    );
  }

  const known = ResolvedLanguages.get(lang);
  if (known != null) return known;
  const result = await languageWork.run({
    scope: 'language',
    key: lang,
    run: async () => {
      let loader = RegisteredCustomLanguages.get(lang);
      if (
        loader == null &&
        Object.prototype.hasOwnProperty.call(bundledLanguages, lang)
      ) {
        loader = bundledLanguages[lang as BundledLanguage];
      }
      if (loader == null) {
        throw new Error(
          `resolveLanguage: "${lang}" not found in bundled or custom languages`
        );
      }
      const { default: data } = await loader();
      const value = { name: lang, data };
      if (!ResolvedLanguages.has(lang)) ResolvedLanguages.set(lang, value);
      return { kind: 'succeeded', value };
    },
  });
  if (result.outcome.kind === 'failed') throw result.outcome.error;
  return result.outcome.value;
}
