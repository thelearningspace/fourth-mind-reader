import {
	ItemView,
	Menu,
	Notice,
	Scope,
	WorkspaceLeaf,
	moment,
	sanitizeHTMLToDom,
	setIcon,
	setTooltip,
	type ViewStateResult,
} from "obsidian";
import type FourthMindReader from "./main";
import { LOGO_3C_SVG } from "./main";
import {
	companionDocPath,
	computeCollections,
	detectExplodedEpubs,
	libraryRootPath,
	scanLibrary,
	type LibraryBook,
	type LibraryOverride,
} from "./library-scan";
import { parseSavedHighlights } from "./gloss";
import { EditBookDetailsModal, FolderNameModal } from "./library-modals";
import { cachedCover, loadCover } from "./shelf-covers";
import { formatReadingTime } from "./reading-time";

/**
 * The Library, laid out as a shelf: what you are reading up top, then the
 * books you added last, then everything, as cover cards. A book's details,
 * stats and highlights open in a side panel.
 *
 * The layout follows the Library ("Shelf") view of the ZettelFlow plugin by
 * RafaelGB (MIT licence, github.com/RafaelGB/Obsidian-ZettelFlow).
 */
export const LIBRARY_VIEW_TYPE = "fmr-library";

type KindFilter = "all" | "epub" | "pdf";
type SortKey = "recent" | "highlighted" | "title" | "added";
type StatusFilter = "all" | "unread" | "reading" | "finished";

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "epub", label: "Books" },
	{ id: "pdf", label: "PDFs" },
];
const SORTS: { id: SortKey; label: string }[] = [
	{ id: "recent", label: "Recently read" },
	{ id: "highlighted", label: "Most highlighted" },
	{ id: "title", label: "Title" },
	{ id: "added", label: "Recently added" },
];
const STATUSES: { id: StatusFilter; label: string }[] = [
	{ id: "all", label: "Any status" },
	{ id: "unread", label: "Not started" },
	{ id: "reading", label: "Reading" },
	{ id: "finished", label: "Finished" },
];
const MODE_LABELS: Record<string, string> = {
	emphasise: "Emphasise",
	explain: "Explain",
	exclaim: "Exclaim",
	examine: "Examine",
	enquiry: "Enquiry",
};

/** Progress at or past this counts as finished: the last page or two of a book
 *  is often notes and index, which nobody pages through. */
const FINISHED_AT = 0.98;
const HERO_COUNT = 2;
const RECENT_COUNT = 12;
const HIGHLIGHTS_SHOWN = 30;
const TINTS = 8;

function statusOf(book: LibraryBook): Exclude<StatusFilter, "all"> {
	if (book.markedRead || book.progress >= FINISHED_AT) return "finished";
	return book.progress > 0 || book.lastRead > 0 ? "reading" : "unread";
}

/** A stable colour for a drawn cover, so a book keeps its colour between visits. */
function tintOf(title: string): number {
	let h = 0;
	for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
	return Math.abs(h) % TINTS;
}

function percent(book: LibraryBook): string {
	return `${Math.round(book.progress * 100)}%`;
}

export class LibraryView extends ItemView {
	private books: LibraryBook[] = [];
	private explodedFolders: string[] = [];
	private kind: KindFilter = "all";
	private sort: SortKey = "recent";
	private status: StatusFilter = "all";
	/** null = every collection; "" = books at the Library root. */
	private collection: string | null = null;
	private search = "";
	/** Path of the book whose details panel is open. */
	private detail: string | null = null;

	private headEl: HTMLElement | null = null;
	private barsEl: HTMLElement | null = null;
	private nudgeEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private scrimEl: HTMLElement | null = null;
	private asideEl: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	private progressTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: FourthMindReader) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register([], "Escape", () => {
			if (!this.detail) return true;
			this.closeDetail();
			return false;
		});
	}

	getViewType(): string {
		return LIBRARY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Library";
	}

	getIcon(): string {
		return "library";
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			kind: this.kind,
			sort: this.sort,
			status: this.status,
			collection: this.collection,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = (state ?? {}) as Record<string, unknown>;
		if (KIND_FILTERS.some((k) => k.id === s.kind)) this.kind = s.kind as KindFilter;
		if (SORTS.some((k) => k.id === s.sort)) this.sort = s.sort as SortKey;
		if (STATUSES.some((k) => k.id === s.status)) this.status = s.status as StatusFilter;
		if (typeof s.collection === "string" || s.collection === null) this.collection = s.collection;
		if (this.bodyEl) {
			this.paintBars();
			this.paintBody();
		}
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("fmr-shelf-host");
		const root = this.contentEl.createDiv({ cls: "fmr-shelf" });
		this.headEl = root.createDiv({ cls: "fmr-shelf-head" });
		this.barsEl = root.createDiv({ cls: "fmr-shelf-bars" });
		this.nudgeEl = root.createDiv();
		this.bodyEl = root.createDiv({ cls: "fmr-shelf-body" });

		this.scrimEl = this.containerEl.createDiv({ cls: "fmr-shelf-scrim" });
		this.registerDomEvent(this.scrimEl, "click", () => this.closeDetail());
		this.asideEl = this.containerEl.createEl("aside", {
			cls: "fmr-shelf-detail",
			attr: { "aria-label": "Book details", role: "dialog" },
		});

		this.observer = new IntersectionObserver((entries) => this.onCoversVisible(entries), {
			root: this.contentEl,
			rootMargin: "300px 0px",
		});

		this.paintHead();
		await this.render();
	}

	async onClose(): Promise<void> {
		this.observer?.disconnect();
		this.observer = null;
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		this.scrimEl?.remove();
		this.asideEl?.remove();
		this.contentEl.empty();
	}

	/** Re-scan and repaint, keeping the scroll position and any open details. */
	async refresh(): Promise<void> {
		await this.render();
	}

	/** Called by the reader on every position save. The new numbers are kept at
	 *  once; the repaint waits until page turns pause. */
	updateBookProgress(path: string, pct: number): void {
		const book = this.books.find((b) => b.path === path);
		if (!book) return;
		book.progress = pct;
		book.lastRead = Date.now();
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		this.progressTimer = window.setTimeout(() => {
			this.progressTimer = null;
			this.paintBody();
		}, 1000);
	}

	/** The Library follows Obsidian's theme; this only keeps the 3C button in step
	 *  with the reader's mode. */
	applyThemeClasses(): void {
		this.headEl
			?.querySelector(".fmr-shelf-3c")
			?.toggleClass("is-active", this.plugin.settings.tmrMode === "3c");
	}

	private async render(): Promise<void> {
		this.books = await scanLibrary(
			this.app.vault,
			this.plugin.settings.libraryOverrides,
			this.plugin.settings.bookPositions,
		);
		this.explodedFolders = await detectExplodedEpubs(this.app.vault);
		if (!this.bodyEl?.isConnected) return;

		const collections = this.collections();
		const order = this.plugin.settings.libraryCollectionOrder;
		const pruned = order.filter((c) => collections.includes(c));
		if (pruned.length !== order.length) {
			this.plugin.settings.libraryCollectionOrder = pruned;
			void this.plugin.persistSettings();
		}
		if (this.collection && !collections.includes(this.collection)) this.collection = null;

		this.paintBars();
		this.paintNudge();
		this.paintBody();
		if (this.detail) {
			const book = this.books.find((b) => b.path === this.detail);
			if (book) this.openDetail(book);
			else this.closeDetail();
		}
	}

	private collections(): string[] {
		return computeCollections(this.app.vault, this.plugin.settings.libraryCollectionOrder);
	}

	// ── Header ──────────────────────────────────────────────────────────────

	private paintHead(): void {
		const head = this.headEl;
		if (!head) return;
		head.empty();

		const titles = head.createDiv({ cls: "fmr-shelf-titles" });
		titles.createEl("h1", { cls: "fmr-shelf-heading", text: "Library" });
		titles.createDiv({ cls: "fmr-shelf-subtitle", text: "What you are reading, and what came of it." });

		const search = head.createDiv({ cls: "fmr-shelf-search" });
		setIcon(search.createSpan({ cls: "fmr-shelf-search-icon" }), "search");
		const input = search.createEl("input", {
			cls: "fmr-shelf-search-input",
			attr: { type: "search", placeholder: "Search the shelf", "aria-label": "Search the shelf" },
		});
		input.value = this.search;
		this.registerDomEvent(input, "input", () => {
			this.search = input.value;
			this.paintBody();
		});
		this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape" && input.value) {
				e.stopPropagation();
				input.value = "";
				this.search = "";
				this.paintBody();
			}
		});

		const actions = head.createDiv({ cls: "fmr-shelf-actions" });
		const addFolder = this.iconButton(actions, "folder-plus", "New collection");
		this.registerDomEvent(addFolder, "click", () => this.promptAddFolder());

		const threeC = actions.createEl("button", { cls: "clickable-icon fmr-shelf-3c", attr: { "aria-label": "3C reading mode" } });
		threeC.appendChild(sanitizeHTMLToDom(LOGO_3C_SVG));
		this.registerDomEvent(threeC, "click", async () => {
			this.plugin.settings.tmrMode = this.plugin.settings.tmrMode === "3c" ? "obsidian" : "3c";
			await this.plugin.saveSettings();
		});

		const settings = this.iconButton(actions, "settings", "Settings and import");
		this.registerDomEvent(settings, "click", () => this.openSettings());
		this.applyThemeClasses();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(btn, icon);
		setTooltip(btn, label);
		return btn;
	}

	// ── Filters ─────────────────────────────────────────────────────────────

	private paintBars(): void {
		const bars = this.barsEl;
		if (!bars) return;
		bars.empty();

		const top = bars.createDiv({ cls: "fmr-shelf-bar" });
		for (const { id, label } of KIND_FILTERS) {
			const count = id === "all" ? this.books.length : this.books.filter((b) => b.kind === id).length;
			this.chip(top, label, count, this.kind === id, () => {
				this.kind = id;
				this.onFiltersChanged();
			});
		}

		const sort = top.createEl("select", { cls: "dropdown fmr-shelf-sort", attr: { "aria-label": "Sort the shelf" } });
		for (const { id, label } of SORTS) sort.createEl("option", { value: id, text: label });
		sort.value = this.sort;
		this.registerDomEvent(sort, "change", () => {
			this.sort = sort.value as SortKey;
			this.onFiltersChanged();
		});

		const second = bars.createDiv({ cls: "fmr-shelf-bar fmr-shelf-bar--sub" });
		const statusGroup = second.createDiv({ cls: "fmr-shelf-chip-group", attr: { role: "group", "aria-label": "Filter by status" } });
		for (const { id, label } of STATUSES) {
			const count = id === "all" ? null : this.books.filter((b) => statusOf(b) === id).length;
			this.chip(statusGroup, label, count, this.status === id, () => {
				this.status = id;
				this.onFiltersChanged();
			});
		}

		const collections = this.collections();
		if (collections.length === 0) return;
		const collectionGroup = second.createDiv({ cls: "fmr-shelf-chip-group", attr: { role: "group", "aria-label": "Filter by collection" } });
		this.chip(collectionGroup, "Every collection", null, this.collection === null, () => {
			this.collection = null;
			this.onFiltersChanged();
		});
		for (const c of collections) {
			const count = this.books.filter((b) => b.collection === c).length;
			this.chip(collectionGroup, c, count, this.collection === c, () => {
				this.collection = c;
				this.onFiltersChanged();
			});
		}
	}

	private chip(parent: HTMLElement, label: string, count: number | null, active: boolean, onClick: () => void): void {
		const chip = parent.createEl("button", { cls: "fmr-shelf-filter" });
		chip.toggleClass("is-active", active);
		chip.setAttribute("aria-pressed", String(active));
		chip.createSpan({ text: label });
		if (count !== null) chip.createSpan({ cls: "fmr-shelf-filter-count", text: String(count) });
		this.registerDomEvent(chip, "click", onClick);
	}

	private onFiltersChanged(): void {
		this.paintBars();
		this.paintBody();
		this.app.workspace.requestSaveLayout();
	}

	// ── Import nudge ────────────────────────────────────────────────────────

	private paintNudge(): void {
		const slot = this.nudgeEl;
		if (!slot) return;
		slot.empty();
		const n = this.explodedFolders.length;
		if (n === 0) return;
		const banner = slot.createDiv({ cls: "fmr-shelf-nudge" });
		banner.createSpan({
			text: `Found ${n} book${n === 1 ? "" : "s"} that ${n === 1 ? "needs" : "need"} to be imported.`,
		});
		const cta = banner.createEl("button", { cls: "mod-cta", text: "Import" });
		this.registerDomEvent(cta, "click", () => this.openSettings());
		const dismiss = this.iconButton(banner, "x", "Dismiss");
		this.registerDomEvent(dismiss, "click", () => slot.empty());
	}

	// ── Shelf ───────────────────────────────────────────────────────────────

	private visibleBooks(): LibraryBook[] {
		const q = this.search.trim().toLowerCase();
		return this.books.filter((b) =>
			(this.kind === "all" || b.kind === this.kind)
			&& (this.status === "all" || statusOf(b) === this.status)
			&& (this.collection === null || b.collection === this.collection)
			&& (!q || `${b.title}\n${b.author}\n${b.collection}`.toLowerCase().includes(q)));
	}

	private sorted(books: LibraryBook[], key: SortKey): LibraryBook[] {
		const copy = [...books];
		switch (key) {
			case "recent":
				return copy.sort((a, b) => b.lastRead - a.lastRead);
			case "highlighted":
				return copy.sort((a, b) => b.marks - a.marks);
			case "title":
				return copy.sort((a, b) => a.title.localeCompare(b.title));
			case "added":
				return copy.sort((a, b) => this.addedAt(b) - this.addedAt(a));
		}
	}

	private addedAt(book: LibraryBook): number {
		return this.app.vault.getFileByPath(book.path)?.stat.ctime ?? 0;
	}

	private paintBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		const scroll = this.contentEl.scrollTop;
		this.observer?.disconnect();
		body.empty();

		if (this.books.length === 0) {
			this.renderEmpty(body);
			return;
		}

		const browsing = !this.search.trim() && this.kind === "all" && this.status === "all" && this.collection === null;
		if (browsing) {
			const current = this.sorted(this.books.filter((b) => statusOf(b) === "reading"), "recent").slice(0, HERO_COUNT);
			if (current.length) {
				body.createDiv({ cls: "fmr-shelf-section", text: "Continue reading" });
				const hero = body.createDiv({ cls: "fmr-shelf-hero" });
				for (const book of current) this.renderHero(hero, book);
			}
			if (this.books.length > RECENT_COUNT / 2) {
				body.createDiv({ cls: "fmr-shelf-section", text: "Recently added" });
				const row = body.createDiv({ cls: "fmr-shelf-grid fmr-shelf-grid--recent" });
				for (const book of this.sorted(this.books, "added").slice(0, RECENT_COUNT)) this.renderCard(row, book);
			}
		}

		const visible = this.sorted(this.visibleBooks(), this.sort);
		const query = this.search.trim();
		body.createDiv({
			cls: "fmr-shelf-section",
			text: query ? `${visible.length} found` : browsing ? "Your shelf" : `${visible.length} on the shelf`,
		});
		if (visible.length === 0) {
			body.createDiv({
				cls: "fmr-shelf-no-match",
				text: query ? `Nothing matches “${query}”.` : "No books match these filters.",
			});
		} else {
			const grid = body.createDiv({ cls: "fmr-shelf-grid" });
			for (const book of visible) this.renderCard(grid, book);
		}
		this.contentEl.scrollTop = scroll;
	}

	private renderCover(parent: HTMLElement, book: LibraryBook): HTMLElement {
		const cover = parent.createDiv({ cls: `fmr-shelf-cover fmr-shelf-cover--tint-${tintOf(book.title)}` });
		if (book.kind === "pdf") cover.addClass("fmr-shelf-cover--pdf");
		cover.dataset.path = book.path;
		const drawn = cover.createDiv({ cls: "fmr-shelf-cover-drawn" });
		drawn.createDiv({ cls: "fmr-shelf-cover-title", text: book.title });
		if (book.author) drawn.createDiv({ cls: "fmr-shelf-cover-author", text: book.author });

		const known = cachedCover(this.app, book.path);
		if (typeof known === "string") this.showCoverImage(cover, known);
		else if (known === undefined) this.observer?.observe(cover);
		return cover;
	}

	private showCoverImage(cover: HTMLElement, url: string): void {
		if (cover.querySelector(".fmr-shelf-cover-image")) return;
		cover.addClass("fmr-shelf-cover--image");
		cover.createEl("img", { cls: "fmr-shelf-cover-image", attr: { src: url, alt: "", loading: "lazy" } });
	}

	private onCoversVisible(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const cover = entry.target as HTMLElement;
			this.observer?.unobserve(cover);
			const path = cover.dataset.path;
			if (!path) continue;
			void loadCover(this.app, path).then((url) => {
				if (!url) return;
				// The same book can be on screen twice (Recently added and the shelf).
				this.contentEl
					.querySelectorAll<HTMLElement>(".fmr-shelf-cover")
					.forEach((el) => {
						if (el.dataset.path === path) this.showCoverImage(el, url);
					});
			});
		}
	}

	private renderRing(parent: HTMLElement, book: LibraryBook): void {
		const r = 8;
		const circumference = 2 * Math.PI * r;
		const svg = parent.createSvg("svg", {
			cls: "fmr-shelf-ring",
			attr: { viewBox: "0 0 20 20", "aria-hidden": "true" },
		});
		if (statusOf(book) === "finished") svg.addClass("fmr-shelf-ring--done");
		svg.createSvg("circle", { cls: "fmr-shelf-ring-track", attr: { cx: 10, cy: 10, r } });
		svg.createSvg("circle", {
			cls: "fmr-shelf-ring-fill",
			attr: {
				cx: 10,
				cy: 10,
				r,
				transform: "rotate(-90 10 10)",
				"stroke-dasharray": `${circumference * (book.markedRead ? 1 : book.progress)} ${circumference}`,
			},
		});
	}

	private renderCard(grid: HTMLElement, book: LibraryBook): void {
		const card = grid.createDiv({ cls: "fmr-shelf-card" });
		card.dataset.path = book.path;

		const open = card.createEl("button", { cls: "fmr-shelf-card-open", attr: { "aria-label": `Open ${book.title}` } });
		const cover = this.renderCover(open, book);
		cover.createSpan({ cls: "fmr-shelf-kind", text: book.kind === "pdf" ? "PDF" : "EPUB" });
		this.registerDomEvent(open, "click", () => void this.plugin.openBookInNewTab(book.path));

		const more = this.iconButton(card, "ellipsis", "More");
		more.addClass("fmr-shelf-more");
		this.registerDomEvent(more, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.showMenu(e, book);
		});
		this.registerDomEvent(card, "contextmenu", (e: MouseEvent) => {
			e.preventDefault();
			this.showMenu(e, book);
		});

		const title = card.createEl("button", { cls: "fmr-shelf-card-title", text: book.title });
		setTooltip(title, "Details");
		this.registerDomEvent(title, "click", () => this.openDetail(book));
		if (book.author) card.createDiv({ cls: "fmr-shelf-card-author", text: book.author });

		const meta = card.createDiv({ cls: "fmr-shelf-meta" });
		const status = statusOf(book);
		if (status !== "unread") this.renderRing(meta, book);
		meta.createSpan({
			cls: status === "unread" ? "" : "fmr-shelf-meta-strong",
			text: status === "unread" ? "Never opened" : status === "finished" ? "Finished" : percent(book),
		});
		if (book.marks > 0) {
			const marks = meta.createSpan({ cls: "fmr-shelf-meta-marks" });
			setIcon(marks.createSpan({ cls: "fmr-shelf-meta-icon" }), "highlighter");
			marks.createSpan({ text: String(book.marks) });
			setTooltip(marks, `${book.marks} highlight${book.marks === 1 ? "" : "s"}`);
		}
	}

	private renderHero(parent: HTMLElement, book: LibraryBook): void {
		const card = parent.createDiv({ cls: "fmr-shelf-hero-card" });
		const cover = this.renderCover(card, book);
		cover.setAttribute("role", "button");
		cover.setAttribute("aria-label", `Open ${book.title}`);
		this.registerDomEvent(cover, "click", () => void this.plugin.openBookInNewTab(book.path));

		const info = card.createDiv({ cls: "fmr-shelf-hero-info" });
		info.createDiv({ cls: "fmr-shelf-kind-inline", text: book.kind === "pdf" ? "PDF" : "EPUB" });
		const title = info.createEl("button", { cls: "fmr-shelf-hero-title", text: book.title });
		this.registerDomEvent(title, "click", () => this.openDetail(book));
		if (book.author) info.createDiv({ cls: "fmr-shelf-card-author", text: book.author });
		info.createDiv({
			cls: "fmr-shelf-hero-where",
			text: `${percent(book)} read · ${moment(book.lastRead).fromNow()}`,
		});
		const bar = info.createDiv({ cls: "fmr-shelf-progress" });
		bar.createDiv({ cls: "fmr-shelf-progress-fill" }).style.setProperty("--fmr-progress", String(book.progress));
		const resume = info.createEl("button", { cls: "mod-cta fmr-shelf-resume" });
		setIcon(resume.createSpan({ cls: "fmr-shelf-resume-icon" }), "book-open");
		resume.createSpan({ text: "Resume" });
		this.registerDomEvent(resume, "click", () => void this.plugin.openBookInNewTab(book.path));
	}

	private renderEmpty(parent: HTMLElement): void {
		const empty = parent.createDiv({ cls: "fmr-shelf-empty" });
		setIcon(empty.createDiv({ cls: "fmr-shelf-empty-icon" }), "library");
		empty.createEl("h3", { cls: "fmr-shelf-empty-title", text: "Your shelf is empty, for now" });
		empty.createDiv({
			cls: "fmr-shelf-empty-body",
			text: `Import a book, or drop .epub and .pdf files into your ${libraryRootPath()} folder.`,
		});
		const btn = empty.createEl("button", { cls: "mod-cta", text: "Import a book" });
		this.registerDomEvent(btn, "click", () => this.openSettings());
	}

	// ── Menu and actions ────────────────────────────────────────────────────

	private showMenu(e: MouseEvent, book: LibraryBook): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open").setIcon("book-open")
			.onClick(() => void this.plugin.openBookInNewTab(book.path)));
		menu.addItem((i) => i.setTitle("Details").setIcon("info")
			.onClick(() => this.openDetail(book)));
		if (book.hasCompanion) {
			menu.addItem((i) => i.setTitle("Open annotations note").setIcon("file-text")
				.onClick(() => void this.openCompanion(book)));
		}
		menu.addItem((i) => i.setTitle(book.markedRead ? "Mark as unread" : "Mark as read")
			.setIcon(book.markedRead ? "book-x" : "book-check")
			.onClick(() => void this.setMarkedRead(book, !book.markedRead)));
		menu.addItem((i) => i.setTitle("Edit details…").setIcon("pencil")
			.onClick(() => this.editDetails(book)));
		menu.showAtMouseEvent(e);
	}

	private async openCompanion(book: LibraryBook): Promise<void> {
		const path = companionDocPath(book.rawTitle);
		if (!this.app.vault.getFileByPath(path)) {
			new Notice("This book has no annotations note yet.");
			return;
		}
		await this.app.workspace.openLinkText(path, "", "tab");
	}

	private editDetails(book: LibraryBook): void {
		new EditBookDetailsModal(this.app, book, async (title, author, read) => {
			this.applyOverride(book, title, author, read);
			await this.plugin.saveSettings();
			await this.refresh();
		}).open();
	}

	private async setMarkedRead(book: LibraryBook, read: boolean): Promise<void> {
		this.applyOverride(book, book.title, book.author, read);
		await this.plugin.saveSettings();
		await this.refresh();
	}

	/** Store a field only when it differs from the book's own metadata, so
	 *  resetting a value removes the override instead of pinning it. */
	private applyOverride(book: LibraryBook, title: string, author: string, read: boolean): void {
		const overrides = this.plugin.settings.libraryOverrides;
		const next: LibraryOverride = { ...overrides[book.path] };
		const t = title.trim();
		if (t && t !== book.rawTitle) next.title = t;
		else delete next.title;
		const a = author.trim();
		if (a !== book.rawAuthor) next.author = a;
		else delete next.author;
		if (read) next.read = true;
		else delete next.read;
		if (next.title === undefined && next.author === undefined && !next.read) delete overrides[book.path];
		else overrides[book.path] = next;
	}

	private openSettings(): void {
		// Undocumented app.setting API — the only route to a specific settings tab.
		const setting = (this.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		}).setting;
		setting?.open?.();
		setting?.openTabById?.(this.plugin.manifest.id);
	}

	private promptAddFolder(): void {
		new FolderNameModal(this.app, async (name) => {
			const clean = name.trim().replace(/[\\/:*?"<>|]+/g, "").trim();
			if (!clean || clean === "Annotations") return;
			const path = `${libraryRootPath()}/${clean}`;
			if (!this.app.vault.getAbstractFileByPath(path)) {
				try {
					await this.app.vault.createFolder(path);
				} catch (e) {
					new Notice(`Couldn't create folder: ${(e as Error).message}`);
					return;
				}
			}
			this.collection = clean;
			this.onFiltersChanged();
		}).open();
	}

	// ── Details panel ───────────────────────────────────────────────────────

	private openDetail(book: LibraryBook): void {
		const aside = this.asideEl;
		if (!aside) return;
		this.detail = book.path;
		aside.empty();

		const close = this.iconButton(aside, "x", "Close");
		close.addClass("fmr-shelf-detail-close");
		this.registerDomEvent(close, "click", () => this.closeDetail());

		const top = aside.createDiv({ cls: "fmr-shelf-detail-top" });
		const cover = this.renderCover(top, book);
		// The panel sits outside the scrolling shelf the cover observer watches.
		this.observer?.unobserve(cover);
		void loadCover(this.app, book.path).then((url) => {
			if (url) this.showCoverImage(cover, url);
		});
		const what = top.createDiv({ cls: "fmr-shelf-detail-what" });
		what.createDiv({ cls: "fmr-shelf-kind-inline", text: book.kind === "pdf" ? "PDF" : "EPUB" });
		what.createEl("h3", { cls: "fmr-shelf-detail-title", text: book.title });
		if (book.author) what.createDiv({ cls: "fmr-shelf-card-author", text: book.author });
		what.createDiv({ cls: "fmr-shelf-detail-file", text: book.path });

		const actions = aside.createDiv({ cls: "fmr-shelf-detail-actions" });
		const read = actions.createEl("button", {
			cls: "mod-cta",
			text: statusOf(book) === "reading" ? "Resume" : "Open",
		});
		this.registerDomEvent(read, "click", () => void this.plugin.openBookInNewTab(book.path));
		if (book.hasCompanion) {
			const notes = actions.createEl("button", { text: "Annotations note" });
			this.registerDomEvent(notes, "click", () => void this.openCompanion(book));
		}
		const edit = actions.createEl("button", { text: "Edit details" });
		this.registerDomEvent(edit, "click", () => this.editDetails(book));

		const stats = aside.createDiv({ cls: "fmr-shelf-detail-stats" });
		const stat = (value: string, label: string) => {
			const el = stats.createDiv({ cls: "fmr-shelf-detail-stat" });
			el.createDiv({ cls: "fmr-shelf-detail-stat-value", text: value });
			el.createDiv({ cls: "fmr-shelf-detail-stat-label", text: label });
		};
		stat(statusOf(book) === "finished" ? "Done" : percent(book), "read");
		stat(String(book.marks), book.marks === 1 ? "highlight" : "highlights");
		stat(formatReadingTime(book.readingMs), "reading time");
		stat(book.lastRead ? moment(book.lastRead).fromNow(true) : "—", book.lastRead ? "since last read" : "never opened");
		const added = this.addedAt(book);
		if (added) stat(moment(added).format("D MMM YYYY"), "added");

		aside.createDiv({
			cls: "fmr-shelf-detail-where",
			text: book.collection ? `In the ${book.collection} collection` : "At the top of your Library",
		});

		aside.createEl("h4", { cls: "fmr-shelf-detail-group", text: "Highlights" });
		const list = aside.createDiv();
		void this.renderHighlights(list, book);

		this.scrimEl?.addClass("fmr-shelf-scrim--on");
		aside.addClass("fmr-shelf-detail--open");
	}

	private async renderHighlights(list: HTMLElement, book: LibraryBook): Promise<void> {
		const file = book.hasCompanion ? this.app.vault.getFileByPath(companionDocPath(book.rawTitle)) : null;
		if (!file) {
			list.createDiv({ cls: "fmr-shelf-detail-empty", text: "No highlights yet. Open it and select a passage." });
			return;
		}
		const loading = list.createDiv({ cls: "fmr-shelf-detail-empty", text: "Reading your highlights…" });
		const entries = parseSavedHighlights(await this.app.vault.cachedRead(file))
			.filter((h) => h.mode !== "bookmark" && (h.quote.trim() || h.userText.trim()));
		loading.remove();
		if (!list.isConnected) return;
		if (entries.length === 0) {
			list.createDiv({ cls: "fmr-shelf-detail-empty", text: "No highlights yet. Open it and select a passage." });
			return;
		}

		const draw = (limit: number) => {
			list.empty();
			for (const h of entries.slice(0, limit)) {
				const item = list.createEl("button", { cls: "fmr-shelf-highlight" });
				item.addClass(`fmr-shelf-highlight--${h.mode}`);
				if (h.quote.trim()) item.createDiv({ cls: "fmr-shelf-highlight-quote", text: h.quote.trim() });
				const note = h.userText.trim() || h.turns.find((t) => t.role === "assistant")?.content.trim() || "";
				if (note) {
					item.createDiv({
						cls: "fmr-shelf-highlight-note",
						text: note.length > 220 ? `${note.slice(0, 220)}…` : note,
					});
				}
				const where = [MODE_LABELS[h.mode] ?? h.mode];
				if (h.pdfPage) where.push(`page ${h.pdfPage}`);
				item.createDiv({ cls: "fmr-shelf-highlight-where", text: where.join(" · ") });
				this.registerDomEvent(item, "click", () => void this.openCompanion(book));
			}
			if (entries.length > limit) {
				const more = list.createEl("button", { cls: "fmr-shelf-show-all", text: `Show all ${entries.length}` });
				this.registerDomEvent(more, "click", () => draw(entries.length));
			}
		};
		draw(HIGHLIGHTS_SHOWN);
	}

	private closeDetail(): void {
		this.detail = null;
		this.scrimEl?.removeClass("fmr-shelf-scrim--on");
		this.asideEl?.removeClass("fmr-shelf-detail--open");
	}
}
