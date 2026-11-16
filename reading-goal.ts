import { getLanguage, moment, setIcon } from "obsidian";
import type { ReadingTimeFields } from "./reading-time";

/** Daily goal bounds and default, in minutes. */
export const READING_GOAL_DEFAULT = 20;
export const READING_GOAL_MIN = 5;
export const READING_GOAL_MAX = 120;

const DAY_KEY = "YYYY-MM-DD";

/** Moment locale matching Obsidian's app language. Moment's global locale
 *  follows the system region instead, which can differ (e.g. Spanish month
 *  names under an English UI). Obsidian codes like "pt-BR" map to Moment's
 *  "pt-br"; an unknown code falls back to the base language, then English. */
function appLocale(): string {
	const lang = getLanguage().toLowerCase();
	const known = moment.locales();
	return [lang, lang.split("-")[0]].find((l) => known.includes(l)) ?? "en";
}

/** Reading time per local day across every book, ms. Built from the per-book
 *  `readingDays` the tracker keeps, so it covers every day since tracking began. */
export function readingByDay(positions: Record<string, ReadingTimeFields | undefined>): Map<string, number> {
	const days = new Map<string, number>();
	for (const fields of Object.values(positions)) {
		for (const [day, ms] of Object.entries(fields?.readingDays ?? {})) {
			days.set(day, (days.get(day) ?? 0) + ms);
		}
	}
	return days;
}

export interface GoalStats {
	goalMs: number;
	todayMs: number;
	metToday: boolean;
	/** Consecutive goal days up to today. A streak whose last day was yesterday
	 *  is still alive: today isn't over. */
	streak: number;
	longestStreak: number;
	/** Goal days since January 1. */
	daysMetThisYear: number;
	msThisYear: number;
}

export function goalStats(days: Map<string, number>, goalMinutes: number, now = moment()): GoalStats {
	const goalMs = goalMinutes * 60_000;
	const met = (day: moment.Moment) => (days.get(day.format(DAY_KEY)) ?? 0) >= goalMs;
	const today = now.clone().startOf("day");
	const todayMs = days.get(today.format(DAY_KEY)) ?? 0;
	const metToday = todayMs >= goalMs;

	let streak = 0;
	const cursor = today.clone();
	if (!metToday) cursor.subtract(1, "day");
	while (met(cursor)) {
		streak++;
		cursor.subtract(1, "day");
	}

	// Longest run, over everything the tracker has recorded.
	let longestStreak = 0;
	const recorded = [...days.keys()].sort();
	if (recorded.length) {
		let run = 0;
		for (const day = moment(recorded[0], DAY_KEY); !day.isAfter(today); day.add(1, "day")) {
			run = met(day) ? run + 1 : 0;
			longestStreak = Math.max(longestStreak, run);
		}
	}

	const year = today.format("YYYY");
	let daysMetThisYear = 0;
	let msThisYear = 0;
	for (const [day, ms] of days) {
		if (!day.startsWith(year)) continue;
		msThisYear += ms;
		if (ms >= goalMs) daysMetThisYear++;
	}

	return { goalMs, todayMs, metToday, streak, longestStreak, daysMetThisYear, msThisYear };
}

/** Heat level for one day, 0–4: nothing, under half the goal, under the goal,
 *  the goal met, twice the goal. */
function level(ms: number, goalMs: number): number {
	if (ms <= 0) return 0;
	const r = ms / goalMs;
	if (r < 0.5) return 1;
	if (r < 1) return 2;
	if (r < 2) return 3;
	return 4;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ReadingGoalCardOptions {
	positions: Record<string, ReadingTimeFields | undefined>;
	goalMinutes: number;
	calendarOpen: boolean;
	onToggleCalendar: (open: boolean) => void;
}

/** The streak card: today's progress against the goal, the current streak, and
 *  a calendar of this year's reading. */
export function renderReadingGoalCard(parent: HTMLElement, opts: ReadingGoalCardOptions): void {
	// Every date below is cloned from `now`, so all of them carry this locale
	// (month labels, tooltips, and which weekday a calendar column starts on).
	const locale = appLocale();
	const now = moment().locale(locale);
	const days = readingByDay(opts.positions);
	const s = goalStats(days, opts.goalMinutes, now);
	const todayMin = minutes(s.todayMs);
	const goal = opts.goalMinutes;

	const card = parent.createDiv({ cls: "fmr-goal" });
	const head = card.createDiv({ cls: "fmr-goal-head" });

	// Ring: fills with today's progress; a check once the goal is met.
	const ring = head.createDiv({ cls: "fmr-goal-ring" });
	ring.toggleClass("is-met", s.metToday);
	const r = 15.9155; // circumference 100, so the dash length is the percent
	const svg = ring.createSvg("svg", { attr: { viewBox: "0 0 36 36", "aria-hidden": "true" } });
	svg.createSvg("circle", { cls: "fmr-goal-ring-track", attr: { cx: 18, cy: 18, r } });
	svg.createSvg("circle", {
		cls: "fmr-goal-ring-fill",
		attr: {
			cx: 18, cy: 18, r,
			transform: "rotate(-90 18 18)",
			"stroke-dasharray": `${Math.min(1, s.todayMs / s.goalMs) * 100} 100`,
		},
	});
	const inner = ring.createDiv({ cls: "fmr-goal-ring-inner" });
	if (s.metToday) setIcon(inner, "check");
	else {
		inner.createDiv({ cls: "fmr-goal-ring-value", text: String(todayMin) });
		inner.createDiv({ cls: "fmr-goal-ring-unit", text: `of ${goal}` });
	}

	const text = head.createDiv({ cls: "fmr-goal-text" });
	const title = text.createDiv({ cls: "fmr-goal-title" });
	const sub = text.createDiv({ cls: "fmr-goal-sub" });
	if (s.metToday) {
		title.setText(s.streak > 1 ? `${s.streak} days in a row` : "Goal met today");
		const over = s.todayMs >= s.goalMs * 1.5 ? "well past" : "past";
		sub.setText(`You've read ${todayMin} min today, ${over} your ${goal}-minute goal.`);
	} else if (s.streak > 0) {
		title.setText(`${plural(s.streak, "day")} streak`);
		sub.setText(`${todayMin} of ${goal} min read today. ${goal - todayMin} more keeps the streak going.`);
	} else {
		title.setText("Daily reading goal");
		sub.setText(todayMin > 0
			? `${todayMin} of ${goal} min read today. ${goal - todayMin} more to start a streak.`
			: `Read ${goal} min today to start a streak.`);
	}

	const badge = head.createDiv({ cls: "fmr-goal-badge" });
	badge.toggleClass("is-lit", s.metToday && s.streak > 0);
	badge.setAttr("aria-label", s.metToday ? "Current streak" : "Streak — today's goal not met yet");
	setIcon(badge.createDiv({ cls: "fmr-goal-badge-icon" }), "flame");
	badge.createDiv({ cls: "fmr-goal-badge-value", text: String(s.streak) });
	badge.createDiv({ cls: "fmr-goal-badge-label", text: s.streak === 1 ? "day" : "days" });

	const toggle = card.createEl("button", {
		cls: "fmr-goal-toggle",
		attr: { "aria-expanded": String(opts.calendarOpen) },
	});
	toggle.createSpan({ cls: "fmr-goal-toggle-count", text: String(s.daysMetThisYear) });
	toggle.createSpan({
		cls: "fmr-goal-toggle-label",
		text: `${s.daysMetThisYear === 1 ? "day" : "days"} with the goal met this year`,
	});
	setIcon(toggle.createSpan({ cls: "fmr-goal-toggle-chevron" }), "chevron-down");

	const body = card.createDiv({ cls: "fmr-goal-body" });
	body.toggleClass("is-collapsed", !opts.calendarOpen);
	toggle.addEventListener("click", () => {
		const open = body.hasClass("is-collapsed");
		body.toggleClass("is-collapsed", !open);
		toggle.setAttr("aria-expanded", String(open));
		opts.onToggleCalendar(open);
		if (open) scroller.scrollLeft = scroller.scrollWidth;
	});

	const scroller = body.createDiv({ cls: "fmr-goal-cal" });
	renderCalendar(scroller, days, s.goalMs, now);

	const legend = body.createDiv({ cls: "fmr-goal-legend" });
	legend.createSpan({ text: "Less" });
	for (let i = 0; i <= 4; i++) legend.createSpan({ cls: `fmr-goal-cell fmr-goal-l${i}` });
	legend.createSpan({ text: "More" });

	card.createDiv({
		cls: "fmr-goal-foot",
		text: `Longest streak: ${plural(s.longestStreak, "day")} · ${minutes(s.msThisYear).toLocaleString(locale)} min read this year`,
	});

	// Keep today in view when the year is wider than the panel.
	window.requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
}

/** This year as a grid of weeks (columns) by weekday (rows), January 1 to today. */
function renderCalendar(parent: HTMLElement, days: Map<string, number>, goalMs: number, now: moment.Moment): void {
	const today = now.clone().startOf("day");
	const first = today.clone().startOf("year");
	const start = first.clone().startOf("week");
	const end = today.clone().endOf("week").startOf("day");
	const weeks = end.diff(start, "weeks") + 1;

	const months = parent.createDiv({ cls: "fmr-goal-months" });
	months.style.setProperty("--fmr-goal-weeks", String(weeks));
	const grid = parent.createDiv({ cls: "fmr-goal-grid" });
	grid.style.setProperty("--fmr-goal-weeks", String(weeks));

	let labelled = -1;
	for (const day = start.clone(); !day.isAfter(end); day.add(1, "day")) {
		const week = day.diff(start, "weeks");
		const inYear = !day.isBefore(first) && !day.isAfter(today);
		if (inYear && day.date() <= 7 && day.month() !== labelled) {
			labelled = day.month();
			const label = months.createDiv({ cls: "fmr-goal-month", text: day.format("MMM") });
			label.style.gridColumn = String(week + 1);
		}
		const cell = grid.createDiv({ cls: "fmr-goal-cell" });
		if (!inYear) {
			cell.addClass("is-blank");
			continue;
		}
		const ms = days.get(day.format(DAY_KEY)) ?? 0;
		cell.addClass(`fmr-goal-l${level(ms, goalMs)}`);
		if (day.isSame(today, "day")) cell.addClass("is-today");
		cell.setAttr("aria-label", `${day.format("ddd, MMM D")} · ${ms <= 0 ? "no reading" : ms < 60_000 ? "<1 min" : `${minutes(ms)} min`}`);
	}
}
