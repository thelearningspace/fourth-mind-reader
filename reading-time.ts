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

/** "3h 12m", "45m", "<1m" — for the Library details panel. */
export function formatReadingTime(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return ms > 0 ? "<1m" : "—";
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
