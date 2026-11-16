// Modified by Neuve AI in 2026: handle disposal during highlighter loading. See NOTICE.md.

import type { ThemeLoader } from '@pierre/theming';
import { pierreThemes } from '@pierre/theming/themes';
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  createOnigurumaEngine,
} from 'shiki';

import type {
  DiffsHighlighter,
  DiffsThemeNames,
  HighlighterTypes,
  SupportedLanguages,
  ThemeRegistrationResolved,
  ThemesType,
} from '../types';
import type { ResolvedLanguage } from '../worker/types';
import { areLanguagesAttached } from './languages/areLanguagesAttached';
import { attachResolvedLanguages } from './languages/attachResolvedLanguages';
import { cleanUpResolvedLanguages } from './languages/cleanUpResolvedLanguages';
import { getResolvedOrResolveLanguage } from './languages/getResolvedOrResolveLanguage';
import { areThemesAttached } from './themes/areThemesAttached';
import { attachResolvedThemes } from './themes/attachResolvedThemes';
import { cleanUpResolvedThemes } from './themes/cleanUpResolvedThemes';
import { getResolvedOrResolveTheme } from './themes/getResolvedOrResolveTheme';
import { themeResolver } from './themes/themeResolver';

type CachedOrLoadingHighlighterType =
  | Promise<DiffsHighlighter>
  | DiffsHighlighter
  | undefined;

let highlighter: CachedOrLoadingHighlighterType;

interface HighlighterOptions {
  themes: DiffsThemeNames[];
  langs: SupportedLanguages[];
  preferredHighlighter?: HighlighterTypes;
}

// disposeHighlighter() can run while a caller awaits the instance or its
// language and theme loaders. An instance that is no longer the shared one has
// been disposed, so nothing is loaded into it or returned; the caller starts
// again on the current shared instance, creating one if none is left.
export async function getSharedHighlighter(
  options: HighlighterOptions
): Promise<DiffsHighlighter> {
  const { themes, langs, preferredHighlighter = 'shiki-js' } = options;
  highlighter ??= createHighlighter({
    themes: [],
    langs: ['text'],
    engine:
      preferredHighlighter === 'shiki-wasm'
        ? createOnigurumaEngine(import('shiki/wasm'))
        : createJavaScriptRegexEngine(),
  }) as Promise<DiffsHighlighter>;

  const current = highlighter;
  const instance = isHighlighterLoading(current) ? await current : current;
  if (highlighter !== current && highlighter !== instance) {
    return getSharedHighlighter(options);
  }
  highlighter = instance;

  const languageLoaders: Promise<ResolvedLanguage>[] = [];
  for (const language of Array.from(new Set(langs))) {
    if (language === 'text' || language === 'ansi') continue;
    const maybeResolvedLanguage = getResolvedOrResolveLanguage(language);
    if ('then' in maybeResolvedLanguage) {
      languageLoaders.push(maybeResolvedLanguage);
    } else {
      attachResolvedLanguages(maybeResolvedLanguage, instance);
    }
  }

  const themeLoaders: Promise<ThemeRegistrationResolved>[] = [];
  for (const themeName of themes) {
    const maybeResolvedTheme = getResolvedOrResolveTheme(themeName);
    if ('then' in maybeResolvedTheme) {
      themeLoaders.push(maybeResolvedTheme);
    } else {
      attachResolvedThemes(maybeResolvedTheme, highlighter);
    }
  }

  // If we need to load any languages or themes, lets do that now
  if (languageLoaders.length > 0 || themeLoaders.length > 0) {
    await Promise.all([
      Promise.all(languageLoaders).then((languages) => {
        if (highlighter === instance) {
          attachResolvedLanguages(languages, instance);
        }
      }),
      Promise.all(themeLoaders).then((themes) => {
        if (highlighter === instance) {
          attachResolvedThemes(themes, instance);
        }
      }),
    ]);
    if (highlighter !== instance) {
      return getSharedHighlighter(options);
    }
  }

  return instance;
}

export function isHighlighterLoaded(
  h: CachedOrLoadingHighlighterType = highlighter
): h is DiffsHighlighter {
  return h != null && !('then' in h);
}

interface GetHighlighterIfLoadedProps {
  theme: DiffsThemeNames | ThemesType;
  lang: SupportedLanguages;
}

export function getHighlighterIfLoaded(
  withSettings?: GetHighlighterIfLoadedProps
): DiffsHighlighter | undefined {
  if (highlighter == null || 'then' in highlighter) {
    return undefined;
  }
  if (
    withSettings != null &&
    (!areThemesAttached(withSettings.theme) ||
      !areLanguagesAttached(withSettings.lang))
  ) {
    return undefined;
  }
  return highlighter;
}

export function isHighlighterLoading(
  h: CachedOrLoadingHighlighterType = highlighter
): h is Promise<DiffsHighlighter> {
  return h != null && 'then' in h;
}

export function isHighlighterNull(
  h: CachedOrLoadingHighlighterType = highlighter
): h is undefined {
  return h == null;
}

export async function preloadHighlighter(
  options: HighlighterOptions
): Promise<void> {
  return void (await getSharedHighlighter(options));
}

export async function disposeHighlighter(): Promise<void> {
  const current = highlighter;
  if (current == null) return;
  // Detach first, so no caller is handed or loads into the instance while it
  // is being disposed.
  highlighter = undefined;
  cleanUpResolvedLanguages();
  cleanUpResolvedThemes();
  (await current).dispose();
}

for (const descriptor of pierreThemes.getThemes()) {
  themeResolver.registerThemeIfAbsent(
    descriptor.name,
    descriptor.load as ThemeLoader<ThemeRegistrationResolved>
  );
}
