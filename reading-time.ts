import { type App, Component, Platform, TFile } from "obsidian";

/** Which book is in front of the reader right now, and where its companion doc
 *  lives. Null when the active leaf isn't a book. */
export interface ActiveBook {
	path: string;
	companionPath: string | null;
}

/** The per-book fields this tracker owns inside `settings.bookPositions[path]`. */
export interface ReadingTimeFields {
	/** Total active reading time, ms. */
	readingMs?: number;
	/** Active reading time per local day (`YYYY-MM-DD` → ms). */
	readingDays?: Record<string, number>;
	/** Sittings with this book: runs of credited time with no gap longer than
	 *  `SESSION_GAP_MS`. Counted from when session tracking began. */
	sessionCount?: number;
	/** Reading time credited since session tracking began, ms. Unlike
	 *  `readingMs` it never includes older totals, so it pairs with
	 *  `sessionCount` and `pagedPct`. */
	sessionMs?: number;
	/** Epoch ms of the last credited tick — the end of the latest session. */
	lastSessionEnd?: number;
	/** Fraction of the book covered by forward page turns (not jumps), summed
	 *  since session tracking began. Over `sessionMs` it is the reading speed. */
	pagedPct?: number;
}

/** Frontmatter key carrying a book's total reading time in whole minutes, so
 *  Dataview can sum it. Written to the companion doc only if one exists. */
export const READING_MINUTES_KEY = "reading-minutes";

/** How often the clock samples. Also the most time one sample can credit, so a
 *  machine waking from sleep doesn't count the nap as reading. */
const TICK_MS = 15_000;
/** No input for this long and the reader is assumed to have walked away. Long
 *  enough for a slow page, short enough that a book left open overnight doesn't
 *  rack up hours. */
const IDLE_MS = 5 * 60_000;
/** Credited time is persisted to data.json at most this often while reading;
 *  switching books or unloading flushes whatever is left. */
const PERSIST_MS = 60_000;
/** A break shorter than this continues the same session, so glancing at another
 *  tab or app doesn't split one sitting into many. */
const SESSION_GAP_MS = 10 * 60_000;
/** Time-to-go estimates need this much timed reading, and `MIN_PAGED_PCT` of the
 *  book turned through, before the speed they divide by is worth trusting. */
const MIN_RATE_MS = 10 * 60_000;
const MIN_PAGED_PCT = 0.005;

/** Counts active reading time per book.
 *
 *  "Active" = a book is the focused leaf, the window is visible and focused,
 *  and there has been input (page turn, scroll, key, tap) within `IDLE_MS`.
 *  Time lands in `bookPositions[path]` beside `pct`/`lastRead`; when the reader
 *  leaves a book, its total is mirrored into the companion doc's frontmatter. */
export class ReadingTimeTracker extends Component {
	private lastTick = Date.now();
	private lastActivity = Date.now();
	private unpersistedMs = 0;
	/** The book credited on the previous tick, so leaving it can be detected. */
	private current: ActiveBook | null = null;
	/** Minutes last written to each companion doc — skips no-op writes. */
	private writtenMinutes = new Map<string, number>();

	constructor(
		private app: App,
		private activeBook: () => ActiveBook | null,
		private positions: () => Record<string, ReadingTimeFields>,
		private persist: () => Promise<void>,
	) {
		super();
	}

	onload(): void {
		this.watchActivity(document);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.watchActivity(win.doc)));
		// Re-entering a book counts as activity: opening it is the reader's intent.
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			this.markActive();
			this.tick();
		}));
		this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
	}

	onunload(): void {
		this.tick();
		this.leave();
		if (this.unpersistedMs > 0) void this.persist();
	}

	/** Total reading time for `path`, ms (0 if never tracked). */
	static totalMs(fields: ReadingTimeFields | undefined): number {
		return fields?.readingMs ?? 0;
	}

	private watchActivity(doc: Document): void {
		for (const type of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
			this.registerDomEvent(doc, type, () => this.markActive(), { passive: true, capture: true });
		}
		// Native PDF viewer pages by scrolling; scroll doesn't bubble, so capture.
		this.registerDomEvent(doc, "scroll", () => this.markActive(), { passive: true, capture: true });
	}

	private markActive(): void {
		this.lastActivity = Date.now();
	}

	private isAttending(): boolean {
		const doc = activeDocument;
		if (doc.visibilityState !== "visible") return false;
		// Mobile webviews report focus unreliably; visibility is the signal there.
		if (!Platform.isMobile && !doc.hasFocus()) return false;
		return Date.now() - this.lastActivity <= IDLE_MS;
	}

	private tick(): void {
		const now = Date.now();
		const elapsed = Math.min(now - this.lastTick, TICK_MS);
		this.lastTick = now;

		// The interval belongs to the book that was in front during it, not to
		// whatever a leaf change just brought forward.
		if (this.current && elapsed > 0) this.credit(this.current.path, elapsed, now);

		const book = this.isAttending() ? this.activeBook() : null;
		if (this.current && this.current.path !== book?.path) this.leave();
		this.current = book;
	}

	private credit(path: string, elapsed: number, now: number): void {
		const positions = this.positions();
		const entry = (positions[path] ??= {});
		entry.readingMs = (entry.readingMs ?? 0) + elapsed;
		const day = window.moment(now).format("YYYY-MM-DD");
		const days = (entry.readingDays ??= {});
		days[day] = (days[day] ?? 0) + elapsed;
		if (entry.lastSessionEnd === undefined || now - entry.lastSessionEnd > SESSION_GAP_MS + TICK_MS) {
			entry.sessionCount = (entry.sessionCount ?? 0) + 1;
		}
		entry.sessionMs = (entry.sessionMs ?? 0) + elapsed;
		entry.lastSessionEnd = now;

		this.unpersistedMs += elapsed;
		if (this.unpersistedMs >= PERSIST_MS) {
			this.unpersistedMs = 0;
			void this.persist();
		}
	}

	/** The reader just stopped reading `current` (switched away, went idle,
	 *  closed it): flush the clock and mirror the total into the companion doc. */
	private leave(): void {
		const book = this.current;
		this.current = null;
		if (!book) return;
		if (this.unpersistedMs > 0) {
			this.unpersistedMs = 0;
			void this.persist();
		}
		if (book.companionPath) void this.writeFrontmatter(book.companionPath, book.path);
	}

	private async writeFrontmatter(companionPath: string, bookPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(companionPath);
		// Never create a companion doc just to hold a number.
		if (!(file instanceof TFile)) return;
		const minutes = Math.round(ReadingTimeTracker.totalMs(this.positions()[bookPath]) / 60_000);
		if (minutes === 0 || this.writtenMinutes.get(companionPath) === minutes) return;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[READING_MINUTES_KEY] = minutes;
			});
			this.writtenMinutes.set(companionPath, minutes);
		} catch (err) {
			// The data.json total is the record; the frontmatter is a mirror.
			console.error("[ThirdMindReader] reading-minutes write failed", err);
		}
	}
}

/** Reading speed as a fraction of the book per ms, or null until there is
 *  enough timed reading to estimate it (see `MIN_RATE_MS`). */
export function readingRate(fields: ReadingTimeFields | undefined): number | null {
	const ms = fields?.sessionMs ?? 0;
	const paged = fields?.pagedPct ?? 0;
	if (ms < MIN_RATE_MS || paged < MIN_PAGED_PCT) return null;
	return paged / ms;
}

/** Mean sitting length, ms, or null before the first session. */
export function averageSessionMs(fields: ReadingTimeFields | undefined): number | null {
	const n = fields?.sessionCount ?? 0;
	return n > 0 ? (fields?.sessionMs ?? 0) / n : null;
}

/** "about 2 hours", "about 25 mins", "under a minute" — a time-to-go phrase.
 *  Rounded coarsely because the speed behind it is an estimate. */
export function formatTimeLeft(ms: number): string {
	const minutes = ms / 60_000;
	if (minutes < 1) return "under a minute";
	if (minutes < 60) {
		const m = Math.max(1, Math.round(minutes));
		return `about ${m} min${m === 1 ? "" : "s"}`;
	}
	const h = Math.round(minutes / 30) / 2;
	return `about ${h} hour${h === 1 ? "" : "s"}`;
}

/** "3h 12m", "45m", "<1m" — for the Library details panel. */
export function formatReadingTime(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return ms > 0 ? "<1m" : "—";
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
