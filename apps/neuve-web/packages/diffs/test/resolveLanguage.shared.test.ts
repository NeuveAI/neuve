// Cold language loads must execute once, publish before release, and retry failures.
import { afterEach, expect, test } from 'bun:test';
import {
  RegisteredCustomLanguages,
  ResolvedLanguages,
} from '../src/highlighter/languages/constants';
import { resolveLanguage } from '../src/highlighter/languages/resolveLanguage';

afterEach(() => {
  for (const name of ['shared-a', 'shared-b', 'shared-failure']) {
    RegisteredCustomLanguages.delete(name);
    ResolvedLanguages.delete(name);
  }
});

test('equal cold languages share the loader; different languages stay separate', async () => {
  let loads = 0;
  const gate = Promise.withResolvers<void>();
  for (const name of ['shared-a', 'shared-b']) {
    RegisteredCustomLanguages.set(name, async () => {
      loads++;
      await gate.promise;
      return {
        default: [
          { name, scopeName: `source.${name}`, patterns: [], repository: {} },
        ],
      };
    });
  }
  const first = resolveLanguage('shared-a');
  const second = resolveLanguage('shared-a');
  const other = resolveLanguage('shared-b');
  gate.resolve();
  const [a, b, c] = await Promise.all([first, second, other]);
  expect(a).toBe(b);
  expect(c.name).toBe('shared-b');
  expect(loads).toBe(2);
  expect(await resolveLanguage('shared-a')).toBe(a);
  expect(loads).toBe(2);
});

test('every waiter receives a loader failure and the next request retries', async () => {
  let loads = 0;
  const failure = new Error('language download failed');
  RegisteredCustomLanguages.set('shared-failure', async () => {
    loads++;
    throw failure;
  });
  const results = await Promise.allSettled([
    resolveLanguage('shared-failure'),
    resolveLanguage('shared-failure'),
  ]);
  expect(results).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  expect(loads).toBe(1);
  await expect(resolveLanguage('shared-failure')).rejects.toBe(failure);
  expect(loads).toBe(2);
});
