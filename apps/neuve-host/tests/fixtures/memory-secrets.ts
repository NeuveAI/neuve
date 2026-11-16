/** Disposable tests replace the external keychain boundary. This proves no OS keychain behavior. */
const values = new Map<string, string>();
export const calls = {get: 0, set: 0, delete: 0, externalFetch: 0};
const key = (options: {service: string; name: string}) => JSON.stringify([options.service, options.name]);
Object.defineProperty(Bun, "secrets", {value: {
	async get(options: {service: string; name: string}) {calls.get++; return values.get(key(options)) ?? null;},
	async set(options: {service: string; name: string; value: string}) {calls.set++; values.set(key(options), options.value);},
	async delete(options: {service: string; name: string}) {calls.delete++; return values.delete(key(options));},
}});
process.env.NEUVE_TEST_PRELOAD = import.meta.path;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : input);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		calls.externalFetch++;
		throw new Error(`Host fixtures refuse external network calls to ${url.hostname}`);
	}
	return originalFetch(input, init);
}, originalFetch);

if (!process.env.ACE_HOME) process.env.ACE_HOME = `${process.env.TMPDIR}/host-fixture-bootstrap-${process.pid}`;
if (!process.env.ACE_CONFIG_HOME) process.env.ACE_CONFIG_HOME = `${process.env.ACE_HOME}/settings`;
if (!process.env.ACE_KEYCHAIN_SERVICE) process.env.ACE_KEYCHAIN_SERVICE = `host-fixture-${process.pid}`;
