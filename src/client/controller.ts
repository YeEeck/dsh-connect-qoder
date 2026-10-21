/**
 * The card's editable-state domain layer (no React, no DOM).
 *
 * WHY THIS FILE EXISTS
 *
 * The card's `dirty` / `save` / `discard` behaviour is a state machine, and it
 * used to live inside the React component — a component no Node test can import
 * without a browser. That made the very rules a user depends on (does this edit
 * count as unsaved? does a refused write show a failure?) testable only through
 * the shipped bundle's text or a DOM harness. Both are real, but neither is the
 * layer the bug is in.
 *
 * This is the same shape `dsh-sensenova-provider`'s `SenseNovaSettingsController`
 * uses: a class holding staged-vs-saved state, exposing one `state()` snapshot,
 * and doing the writes itself. The JSX then reads a plain object and calls
 * methods — no `useState` in the rules, only around the rendering concerns the
 * controller cannot own (the mount effect, the ticking clock, the row flash).
 *
 * WHAT IS PURE
 *
 * - No `react`, no `document`, no `fetch`. Every dependency is injected.
 * - `state()` answers a plain object, so a test can assert the whole surface.
 * - The persist function is injected, so a test can make it lie (the Windows
 *   silent-failure shape) without a network or a DOM.
 *
 * WHAT STAYS IN REACT
 *
 * The mount/refresh fetch, the status/refreshing/refreshedAt flags, the off-peak
 * clock, the row flash (`pulse`) and the open/collapsed flag are rendering
 * concerns driven by effects and timers. They are not the persisted document,
 * and dragging them in would defeat the point of extracting this layer.
 */
import { writeSettingsField } from "./settings-write.ts";
import type { SettingsScope, UnconfirmedSave } from "./settings-write.ts";
import { describeThrown } from "./card-model.ts";

/** The three per-model image choices this card writes. */
export const IMAGE_MODES = ["auto", "on", "off"] as const;
/**
 * Sentinel stored in a region's allow-list to mean "hide every model".
 *
 * The host convention is `[] = no filter = show all`, so "hide all" has no
 * value of its own in that scheme. A non-empty list that matches no real model
 * id collapses to "show nothing" in `filterByEnabled`, so a marker that no model
 * id can equal expresses "hide all" without touching that convention.
 */
export const HIDE_ALL_MODELS = "__hide-all__";

/**
 * The queue-patience tiers this card offers — the client half of the vocabulary.
 *
 * The host owns the authoritative list (`PATIENCE_TIERS` in
 * `src/host/patience.ts`) and resolves a stored value with it; the card needs
 * the same three strings to render its three options and to normalise whatever
 * the host shipped. Two lists, one meaning — so `test/contract.test.js`
 * extracts the strings from the card source and asserts they equal the host's,
 * and this module's copy is the one that test reads.
 */
export const PATIENCE_TIERS = ["2m", "4m", "6m"] as const;

/**
 * The tier in force when nothing usable is stored.
 *
 * The same value as the host's `DEFAULT_PATIENCE_TIER` and the schema's
 * `.default(...)`: a card that defaulted elsewhere would show a selection the
 * document does not hold, and the first save would then write it.
 */
export const DEFAULT_PATIENCE_TIER = "4m";

/** One model row as the models route serves it — the fields this layer reads. */
export interface ControllerModelRow {
	id: string
	region?: string
	name?: string
	[key: string]: unknown
}

/** The fields the card persists, staged and saved. */
export interface EditableState {
	imageOverrides: Record<string, string>
	maxWindow: boolean
	enabledIds: Record<string, string[]>
	/**
	 * The queue-patience tier, one global value (`'2m' | '4m' | '6m'`).
	 *
	 * Typed `string` rather than the tier union because it is staged from
	 * whatever the host reported and from a `<select>`'s `value`, both of which
	 * are plain strings at the boundary; `patienceTierOf` below is the
	 * normaliser that narrows it.
	 */
	patienceTier: string
}

/**
 * Normalise one stored patience tier to one of {@link PATIENCE_TIERS}.
 *
 * An unrecognised value degrades to the default rather than to the first tier.
 * The host already resolves the tier before shipping it, so this is the second
 * half of the same rule: a browser cannot represent an unknown `<select>`
 * value, and it does not throw either — it silently selects the FIRST option,
 * which would show the user a deliberate "2m" for a document that says
 * something else.
 */
export function patienceTierOf(stored: unknown): string {
	// `find` rather than `includes` with a widened receiver: the list is a
	// readonly tuple of literals, and comparing element-wise needs no cast to
	// widen it to `readonly string[]` — the predicate itself is the narrowing.
	return typeof stored === "string" && PATIENCE_TIERS.some((tier) => tier === stored)
		? stored
		: DEFAULT_PATIENCE_TIER;
}

/** Normalise whatever the saved map holds into one of {@link IMAGE_MODES}. */
export function imageModeOf(overrides: unknown, modelId: string): string {
	const saved = overrides === null || typeof overrides !== "object" ? undefined : (overrides as Record<string, unknown>)[modelId];
	return typeof saved === "string" && IMAGE_MODES.includes(saved as (typeof IMAGE_MODES)[number]) ? saved : "auto";
}

/**
 * The set of model ids currently ticked, given what the host reported.
 *
 * The host stores an empty list as "no filter" (every model shows), so the card
 * presents that same state as "everything ticked" — otherwise a fresh install
 * would render every box empty while every model was visible.
 */
export function enabledIdsFor<M extends ControllerModelRow>(models: M[], saved: unknown): Set<string> {
	const list = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
	if (list.length === 0) return new Set(models.map((model) => model.id));
	return new Set(list);
}

/**
 * What the last `save()` did, kept as data so the JSX can choose the copy.
 *
 * Deliberately not a translated string: the controller must not know the copy,
 * and the card's "已保存" / "保存失败" wording is a rendering decision.
 *
 * `confirmed` (only present as `false`) marks the one save that must not be
 * shown as a clean "已保存": the endpoint was absent (404) and the value
 * delivered only through the settings scope's own snapshot, which cannot prove
 * the document changed. Absent (i.e. confirmed) is the normal case.
 */
export type SaveOutcome = { ok: true; confirmed?: false } | { ok: false; reason: string };

/** The snapshot the JSX reads each render. */
export interface CardSnapshot<M extends ControllerModelRow = ControllerModelRow> extends EditableState {
	dirty: boolean
	saving: boolean
	lastSave: SaveOutcome | undefined
	query: string
	activeRegion: string
	regionModels: M[]
	regionAllTicked: boolean
	visibleModels: M[]
	visibleTicked: number
}

/** Persist one field. Throwing means the write did not land. */
export type PersistField = (field: string, value: unknown) => Promise<unknown>;

/** The persist implementation the host provides: `writeSettingsField` bound to a scope. */
export function persistViaScope(scope: SettingsScope): PersistField {
	return (field, value) => writeSettingsField(scope, field, value);
}

/** Stable initial state for a controller built from a route answer. */
export function initialEditableState(value: unknown): EditableState {
	const record = value === null || typeof value !== "object" ? {} : (value as Record<string, unknown>);
	return {
		imageOverrides:
			record.imageOverrides !== null && typeof record.imageOverrides === "object"
				? (record.imageOverrides as Record<string, string>)
				: {},
		maxWindow: record.useMaximumContextWindow === true,
		enabledIds:
			record.enabledModelIds !== null && typeof record.enabledModelIds === "object"
				? (record.enabledModelIds as Record<string, string[]>)
				: {},
		patienceTier: patienceTierOf(record.patienceTier),
	};
}

/**
 * The card's editable-state machine.
 *
 * Construction is cheap and side-effect free: nothing is fetched, nothing is
 * subscribed. The caller feeds the roster with `setModels` after its own fetch
 * lands, and seeds the saved values with `seedSaved` on the first load — a
 * refresh must not clobber edits the user has staged but not yet saved, which is
 * why `seedSaved` is separate from `setModels`.
 */
export class QoderCardController<M extends ControllerModelRow = ControllerModelRow> {
	private staged: EditableState;
	private saved: EditableState;
	private models: M[] = [];
	private saving = false;
	private lastSave: SaveOutcome | undefined = undefined;
	private query = "";
	private activeRegion = "qoder-cn";

	private snapshot: CardSnapshot<M>;
	private readonly listeners = new Set<() => void>();

	constructor(initial: EditableState) {
		this.staged = {
			imageOverrides: { ...initial.imageOverrides },
			maxWindow: initial.maxWindow,
			enabledIds: { ...initial.enabledIds },
			patienceTier: patienceTierOf(initial.patienceTier),
		};
		this.saved = {
			imageOverrides: { ...initial.imageOverrides },
			maxWindow: initial.maxWindow,
			enabledIds: { ...initial.enabledIds },
			patienceTier: patienceTierOf(initial.patienceTier),
		};
		this.snapshot = this.build();
	}

	/**
	 * Subscribe to snapshot changes.
	 *
	 * An arrow property on purpose: `useSyncExternalStore` receives the bare
	 * reference, so a prototype method would lose `this` and throw.
	 */
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/**
	 * The current view, referentially stable until a mutation happens.
	 *
	 * `useSyncExternalStore` compares this by identity, so it must be the SAME
	 * object across renders that changed nothing. Rebuilding it here on every
	 * read would loop the card forever. An arrow property for the same reason
	 * as {@link subscribe}.
	 */
	getSnapshot = (): CardSnapshot<M> => {
		return this.snapshot;
	};

	/** Replace the roster. Never touches the saved or staged settings. */
	setModels(models: M[]): void {
		this.models = Array.isArray(models) ? models : [];
		this.publish();
	}

	/** Seed the saved document, and mirror it as the staged state. */
	seedSaved(next: EditableState): void {
		const patienceTier = patienceTierOf(next.patienceTier);
		this.saved = {
			imageOverrides: { ...next.imageOverrides },
			maxWindow: next.maxWindow,
			enabledIds: { ...next.enabledIds },
			patienceTier,
		};
		this.staged = {
			imageOverrides: { ...next.imageOverrides },
			maxWindow: next.maxWindow,
			enabledIds: { ...next.enabledIds },
			patienceTier,
		};
		this.lastSave = undefined;
		this.publish();
	}

	/** One model's image mode. "auto" deletes the override, so it writes no key. */
	setMode(modelId: string, mode: string): void {
		const next = { ...this.staged.imageOverrides };
		if (mode === "auto") delete next[modelId];
		else next[modelId] = mode;
		this.staged.imageOverrides = next;
		this.lastSave = undefined;
		this.publish();
	}

	/**
	 * Tick or untick one model for the picker.
	 *
	 * Ticking is recorded against the region's **full** roster, not against
	 * whatever happens to be ticked now, so the saved list is a complete
	 * allow-list rather than a diff. That is what lets a partially curated
	 * region stay curated when the catalog later grows.
	 */
	toggleModel(regionId: string, modelId: string): void {
		const roster = this.models.filter((m) => m.region === regionId).map((m) => m.id);
		const active = enabledIdsFor(this.models, this.staged.enabledIds[regionId]);
		const next = new Set(active);
		if (!next.delete(modelId)) next.add(modelId);
		// A full selection is stored as the empty list, the "no filter" state.
		const list = roster.filter((id) => next.has(id));
		this.staged.enabledIds = { ...this.staged.enabledIds, [regionId]: list.length === roster.length ? [] : list };
		this.lastSave = undefined;
		this.publish();
	}

	/**
	 * Bulk-set one region's roster to an extreme.
	 *
	 * `[]` is "show all" (the host's no-filter state); `[HIDE_ALL_MODELS]` matches
	 * no real id, so the host returns `[]` — a true "hide all" without changing
	 * the empty-means-all convention. Only the named region is touched.
	 */
	setRegionAll(regionId: string, allOn: boolean): void {
		this.staged.enabledIds = { ...this.staged.enabledIds, [regionId]: allOn ? [HIDE_ALL_MODELS] : [] };
		this.lastSave = undefined;
		this.publish();
	}

	setMaxWindow(on: boolean): void {
		this.staged.maxWindow = on;
		this.lastSave = undefined;
		this.publish();
	}

	/**
	 * Choose the queue-patience tier.
	 *
	 * Normalised on the way in, from the same list the options are rendered
	 * from, so a stale option value (or a value that arrived from a host this
	 * card does not fully understand) can never enter the staged document as an
	 * unknown string.
	 */
	setPatienceTier(tier: string): void {
		this.staged.patienceTier = patienceTierOf(tier);
		this.lastSave = undefined;
		this.publish();
	}

	setQuery(query: string): void {
		this.query = query;
		// View-only: never part of `dirty`, never persisted.
		this.publish();
	}

	setActiveRegion(regionId: string): void {
		this.activeRegion = regionId;
		this.publish();
	}

	/**
	 * Persist every editable field through the injected writer.
	 *
	 * Each write is verified upstream of this class (the host endpoint's
	 * read-back in `writeSettingsField`), so a rejection raises here rather than
	 * silently passing. On success the staged state becomes the saved state and
	 * `lastSave` says so; on failure `lastSave` carries the reason and the
	 * staged edits stay, so nothing the user typed is lost to a locked file.
	 */
	async save(persist: PersistField): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.lastSave = undefined;
		this.publish();
		const results: unknown[] = [];
		try {
			results.push(await persist("enabledModelIds", this.staged.enabledIds));
			results.push(await persist("imageOverrides", this.staged.imageOverrides));
			results.push(await persist("useMaximumContextWindow", this.staged.maxWindow));
			results.push(await persist("patienceTier", this.staged.patienceTier));
			this.saved = {
				imageOverrides: { ...this.staged.imageOverrides },
				maxWindow: this.staged.maxWindow,
				enabledIds: { ...this.staged.enabledIds },
				patienceTier: this.staged.patienceTier,
			};
			// A clean "已保存" is owed only for a value the endpoint read back out
			// of the document. The 404-legacy scope fallback instead resolves with
			// an UnconfirmedSave marker (only the scope's own snapshot saw it), and
			// that is the one save the card must label "已保存（未确认）".
			const unconfirmed = results.some(
				(result) => result !== null && typeof result === "object" && (result as UnconfirmedSave).unconfirmed === true,
			);
			this.lastSave = unconfirmed ? { ok: true, confirmed: false } : { ok: true };
		} catch (error) {
			this.lastSave = { ok: false, reason: describeThrown(error) };
		} finally {
			this.saving = false;
			this.publish();
		}
	}

	/** Drop every staged edit back to the last saved document. */
	discard(): void {
		this.staged = {
			imageOverrides: { ...this.saved.imageOverrides },
			maxWindow: this.saved.maxWindow,
			enabledIds: { ...this.saved.enabledIds },
			patienceTier: this.saved.patienceTier,
		};
		this.lastSave = undefined;
		this.publish();
	}

	private publish(): void {
		this.snapshot = this.build();
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch (error) {
				console.error("[dsh-connect-qoder] controller subscriber failed:", error);
			}
		}
	}

	/** Compute the current snapshot from the live fields. */
	private build(): CardSnapshot<M> {
		const dirty =
			JSON.stringify(this.staged.imageOverrides) !== JSON.stringify(this.saved.imageOverrides) ||
			JSON.stringify(this.staged.enabledIds) !== JSON.stringify(this.saved.enabledIds) ||
			this.staged.maxWindow !== this.saved.maxWindow ||
			this.staged.patienceTier !== this.saved.patienceTier;
		const regionModels = this.models.filter((model) => model.region === this.activeRegion);
		const regionAllTicked =
			regionModels.length > 0 &&
			regionModels.every((model) => enabledIdsFor(this.models, this.staged.enabledIds[this.activeRegion]).has(model.id));
		const needle = this.query.trim().toLowerCase();
		const visibleModels = regionModels.filter((model) => {
			if (needle === "") return true;
			return String(model.name ?? model.id).toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
		});
		const visibleTicked = visibleModels.filter(
			(model) => model.region !== undefined && enabledIdsFor(this.models, this.staged.enabledIds[model.region]).has(model.id),
		).length;

		return {
			imageOverrides: this.staged.imageOverrides,
			maxWindow: this.staged.maxWindow,
			enabledIds: this.staged.enabledIds,
			patienceTier: this.staged.patienceTier,
			dirty,
			saving: this.saving,
			lastSave: this.lastSave,
			query: this.query,
			activeRegion: this.activeRegion,
			regionModels,
			regionAllTicked,
			visibleModels,
			visibleTicked,
		};
	}
}
