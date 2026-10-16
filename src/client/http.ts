/**
 * The card's only `fetch` surface.
 *
 * Every host-route read the card performs — the two containers'
 * (`QoderUsagePanel`, `QoderAccountPanel`) fetches and the model-roster read
 * the assembly layer keeps in `card.tsx` — goes through here, so the request
 * contract lives in exactly one place. The host routes serve the plugin's own
 * `lib/`, so they are same-origin and answer JSON; this wraps that contract
 * once.
 *
 * Every call sends `accept: application/json` and `credentials:
 * "same-origin"` — the routes are behind the loopback origin check in
 * `src/host/routes.ts`, so the credential must travel. POSTs that carry a
 * body stringify to JSON and advertise `content-type: application/json`.
 *
 * The shape of a failed response is decided here and nowhere else: a non-OK
 * status throws with the host's own `error` field when present, so the card's
 * catch blocks can show the real reason instead of a fabricated one (the
 * "undefined" failure message that issue 06 was about is what this prevents).
 * A `POST` body that will not parse degrades to an empty answer (`undefined`),
 * never a throw — a write that the host did not echo back is "no data". A
 * `GET` that will not parse THROWS instead: the reads that use it (roster,
 * accounts, quotas) have no "no data" state to fall back to, and a caller
 * that asked for a fact must be told the fact did not arrive.
 */

/**
 * The reason to report for a refused response.
 *
 * The host answers refusals in two shapes and both must reach the reader:
 * route-level gates write `{ error: "origin-not-trusted" }` (a bare string),
 * while `writeError` writes `{ error: { message, type, code } }`. Reading only
 * the first would turn every `writeError` refusal — including "the credential
 * file could not be removed, so it is still in use" — into a bare `HTTP 500`,
 * which says a request failed but not what to do about it. That is the
 * silent-failure shape issue 06 was about, one layer down.
 *
 * A shape neither branch recognises still yields the status code; naming the
 * failure is the floor, never a fabricated reason.
 */
function failureMessage(value: unknown, status: number): string {
	const error = (value as { error?: unknown } | undefined)?.error;
	if (typeof error === "string" && error !== "") return error;
	const message = (error as { message?: unknown } | undefined | null)?.message;
	if (typeof message === "string" && message !== "") return message;
	return `HTTP ${status}`;
}

/** Read the host route at `path` and decode its JSON answer. */
export async function getJson<T = unknown>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: "application/json" },
		credentials: "same-origin",
		signal: options?.signal,
	});
	const value = (await response.json().catch((): undefined => undefined)) as T | undefined;
	if (!response.ok) {
		// A refused GET can carry the host's own `error` — e.g. the loopback
		// origin check answers `{ error: "origin-not-trusted" }`. Surfacing it
		// is what the module doc above promises; throwing a bare "HTTP 403"
		// would hand the user a status code and drop the diagnosis.
		throw new Error(failureMessage(value, response.status));
	}
	if (value === undefined) throw new Error(`unparseable JSON body (HTTP ${response.status})`);
	return value as T;
}

/** POST to the host route at `path` and decode its JSON answer. */
export async function postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		credentials: "same-origin",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const value = (await response.json().catch((): undefined => undefined)) as T | undefined;
	if (!response.ok) {
		throw new Error(failureMessage(value, response.status));
	}
	return value as T;
}
