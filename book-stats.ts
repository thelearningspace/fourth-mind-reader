import { type App, Modal } from "obsidian";
import { loadCover } from "./shelf-covers";
import {
	averageSessionMs,
	formatTimeLeft,
	readingRate,
	type ReadingTimeFields,
} from "./reading-time";

/** What the reader knows about the open book at the moment the panel opens. */
export interface BookStatsSnapshot {
	path: string;
	title: string;
	author: string;
	/** 0..1 through the whole book. */
	bookPct: number;
	/** Label of the section the reader is in, if the book names it. */
	chapterLabel: string;
	/** 0..1 through the current section. */
	chapterPct: number;
	/** Share of the whole book still left in the current section, 0..1 — what
	 *  the reading speed (a fraction of the book per ms) is applied to. */
	chapterLeft: number;
	fields: ReadingTimeFields | undefined;
}

/** Per-book reading stats: progress through the book and the current chapter
 *  with time-to-go estimates, then the reading-time numbers behind them. */
export class BookStatsModal extends Modal {
	constructor(app: App, private snap: BookStatsSnapshot) {
		super(app);
	}

	onOpen(): void {
		const { modalEl, contentEl } = this;
		const s = this.snap;
		modalEl.addClass("fmr-stats-modal");
		contentEl.empty();

		const top = contentEl.createDiv({ cls: "fmr-stats-top" });
		const cover = top.createDiv({ cls: "fmr-stats-cover" });
		void loadCover(this.app, s.path).then((url) => {
			if (url) cover.createEl("img", { attr: { src: url, alt: "" } });
			else cover.addClass("fmr-stats-cover--none");
		});

		const what = top.createDiv({ cls: "fmr-stats-what" });
		what.createEl("h2", { cls: "fmr-stats-title", text: s.title });
		if (s.author) what.createDiv({ cls: "fmr-stats-author", text: s.author });

		const rate = readingRate(s.fields);
		const left = (fraction: number) => (rate ? formatTimeLeft(fraction / rate) : null);
		this.progressRow(what, "Book progress", s.bookPct, left(1 - s.bookPct));
		this.progressRow(what, s.chapterLabel ? `Chapter: ${s.chapterLabel}` : "Current chapter", s.chapterPct, left(s.chapterLeft));

		const figures = contentEl.createDiv({ cls: "fmr-stats-figures" });
		const readingMs = s.fields?.readingMs ?? 0;
		figure(figures, hours(readingMs), "Hours of reading");
		const avg = averageSessionMs(s.fields);
		figure(figures, avg === null ? "—" : String(Math.round(avg / 60_000)), "Avg. minutes per session");
		figure(figures, rate === null ? "—" : `${(rate * 3_600_000 * 100).toFixed(1)}%`, "Of the book per hour");

		if (rate === null) {
			contentEl.createDiv({
				cls: "fmr-stats-note",
				text: "Time-to-go estimates and reading speed appear after about 10 minutes of reading this book.",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private progressRow(parent: HTMLElement, label: string, pct: number, timeLeft: string | null): void {
		const row = parent.createDiv({ cls: "fmr-stats-progress" });
		const bar = row.createDiv({ cls: "fmr-stats-progress-main" });
		const head = bar.createDiv({ cls: "fmr-stats-progress-label" });
		head.createSpan({ cls: "fmr-stats-progress-name", text: label });
		head.createSpan({ text: `: ${Math.round(pct * 100)}%` });
		const track = bar.createDiv({ cls: "fmr-stats-bar" });
		track.createDiv({ cls: "fmr-stats-bar-fill" }).style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
		if (timeLeft) {
			const left = row.createDiv({ cls: "fmr-stats-left" });
			left.createDiv({ cls: "fmr-stats-left-time", text: timeLeft });
			left.createDiv({ cls: "fmr-stats-left-label", text: "to go" });
		}
	}
}

/** One big number over its caption — shared with the Library's summary strip. */
export function figure(parent: HTMLElement, value: string, label: string): HTMLElement {
	const el = parent.createDiv({ cls: "fmr-stats-figure" });
	el.createDiv({ cls: "fmr-stats-figure-value", text: value });
	el.createDiv({ cls: "fmr-stats-figure-label", text: label });
	return el;
}

/** Hours to one decimal: "1.7", "0.2", "0". */
export function hours(ms: number): string {
	const h = ms / 3_600_000;
	return h === 0 ? "0" : h.toFixed(1);
}
