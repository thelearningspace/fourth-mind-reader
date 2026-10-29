/** Dialogs that turn a selected passage into its own vault note — a quick
 *  Note (a fleeting thought, filed in Fleeting Notes by default), a Claim
 *  ("Make it a claim"), or a Link to an idea already in the vault. The reader's own words go first, then the passage they
 *  rest on and a link back to where it came from. Shared by the EPUB and PDF
 *  hosts, which differ only in how they describe the source.
 */

import { AbstractInputSuggest, App, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import { annotationsFolderPath, sanitizeFileName } from "./library-scan";

/** Vault-folder autocomplete. Hides the annotations folder, which belongs to
 *  the plugin's companion docs rather than to anything the reader files. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		const annotations = annotationsFolderPath();
		const folders = this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/"
				&& f.path !== annotations && !f.path.startsWith(`${annotations}/`));
		return folders.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.input.value = folder.path;
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

/** Tag autocomplete for the Tags box: completes the word being typed from
 *  the tags already used across the vault, most-used first. */
class TagSuggest extends AbstractInputSuggest<string> {
	private tags: string[];

	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
		const counts = new Map<string, number>();
		for (const file of app.vault.getMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			for (const tag of (cache && getAllTags(cache)) ?? []) {
				const name = tag.replace(/^#/, "");
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
		}
		this.tags = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
	}

	private currentWord(): string {
		return /[^\s,]*$/.exec(this.input.value)?.[0].replace(/^#+/, "") ?? "";
	}

	protected getSuggestions(): string[] {
		const q = this.currentWord().toLowerCase();
		if (!q) return [];
		const typed = new Set(this.input.value.split(/[\s,]+/).map((t) => t.replace(/^#+/, "")));
		return this.tags.filter((t) => t.toLowerCase().includes(q) && !typed.has(t)).slice(0, 50);
	}

	renderSuggestion(tag: string, el: HTMLElement): void {
		el.setText(tag);
	}

	selectSuggestion(tag: string): void {
		this.input.value = this.input.value.replace(/[^\s,]*$/, `${tag} `);
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

export interface PassageSource {
	/** The selected text, verbatim. */
	passage: string;
	/** Markdown citation line: a wikilink back to the book plus whatever
	 *  location the host knows (chapter, page). Shown in the dialog and written
	 *  into the note as-is. */
	source: string;
	/** Folder the dialog opens on — the last one used. Empty is the vault root. */
	folder: string;
	/** `file` was created in `folder`; hosts remember the folder for next
	 *  time and keep the passage highlighted in the book. */
	onCreated: (folder: string, file: TFile) => void;
	/** Extra line written under the Source line — the book citation, when
	 *  Source is the linked idea rather than the book. */
	extra?: string;
	/** Where the passage comes from, written as the note's properties. */
	cite: PassageCitation;
}

export interface PassageCitation {
	/** Wikilink to the book, e.g. `[[Library/Range.epub|Range]]`. */
	source: string;
	/** Printed page or range ("12", "12–13"); empty when the book has none. */
	page: string;
}

/** Longest default title. A whole paragraph makes a useless file name. */
const TITLE_MAX = 80;

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

/** Shared layout and save path. Subclasses add their own text fields above
 *  the passage, then hand `save` the finished note. */
abstract class PassageNoteModal extends Modal {
	protected passage: string;
	private folderEl: HTMLInputElement | null = null;
	private tagsEl: HTMLInputElement | null = null;

	constructor(app: App, protected src: PassageSource) {
		super(app);
		this.passage = src.passage.replace(/\s+/g, " ").trim();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	protected field(label: string): HTMLElement {
		const wrap = this.contentEl.createDiv({ cls: "tmr-claim-field" });
		wrap.createDiv({ cls: "tmr-claim-label", text: label });
		return wrap;
	}

	/** Tags box, written into the note's `tags` property. */
	protected renderTags(initial = ""): void {
		this.tagsEl = this.field("Tags").createEl("input", {
			cls: "tmr-claim-tags",
			attr: { type: "text", placeholder: "Separate with spaces or commas" },
		});
		this.tagsEl.value = initial;
		new TagSuggest(this.app, this.tagsEl);
	}

	/** `source`, `page` and `tags` properties for the top of the note. */
	private frontmatter(): string {
		const tags = (this.tagsEl?.value ?? "")
			.split(/[\s,]+/)
			.map((t) => t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_/-]/gu, ""))
			.filter((t, i, all) => t && all.indexOf(t) === i);
		const lines = ["---", `source: ${JSON.stringify(this.src.cite.source)}`];
		if (this.src.cite.page) lines.push(`page: ${JSON.stringify(this.src.cite.page)}`);
		lines.push(tags.length ? `tags:\n${tags.map((t) => `  - ${t}`).join("\n")}` : "tags: []", "---", "");
		return lines.join("\n");
	}

	/** Passage, Source, Folder and the Cancel / confirm buttons. */
	protected renderTail(confirmLabel: string, onConfirm: () => void): void {
		this.field("Passage").createDiv({ cls: "tmr-claim-passage", text: this.passage });
		this.field("Source").createDiv({ cls: "tmr-claim-source", text: this.src.source });
		const folderEl = this.field("Folder").createEl("input", {
			cls: "tmr-claim-folder",
			attr: { type: "text", placeholder: "The vault's root" },
		});
		folderEl.value = this.src.folder;
		new FolderSuggest(this.app, folderEl);
		this.folderEl = folderEl;

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { cls: "mod-cta", text: confirmLabel })
			.addEventListener("click", onConfirm);
	}

	/** Write `folder/title.md` holding `text`, the passage as a quote, the
	 *  source line and any `lines` after it, under the citation properties when
	 *  `withProperties`. Null if nothing was written. */
	protected async save(
		text: string,
		rawTitle: string,
		kind: string,
		lines: string[] = [],
		withProperties = false,
	): Promise<TFile | null> {
		const title = sanitizeFileName(rawTitle.replace(/…$/, "")).replace(/^\.+/, "") || kind;
		const folder = (this.folderEl?.value ?? "").trim().replace(/^\/+|\/+$/g, "");
		if (folder && !(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
			new Notice(`No folder named "${folder}"`);
			return null;
		}
		const path = this.freePath(folder, title);
		const quote = this.src.passage.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
		const tail = [`Source: ${this.src.source}`, ...lines, this.src.extra ?? ""].filter(Boolean);
		const body = `${withProperties ? this.frontmatter() : ""}${text}\n\n${quote}\n\n${tail.join("\n")}\n`;
		let file: TFile;
		try {
			file = await this.app.vault.create(path, body);
		} catch (err) {
			console.error(`${kind} note creation failed`, err);
			new Notice(`Fourth Mind Reader: failed to create the ${kind.toLowerCase()} note`);
			return null;
		}
		this.src.onCreated(folder, file);
		new Notice(`${kind} created: ${path}`);
		this.close();
		await this.app.workspace.getLeaf("tab").openFile(file);
		return file;
	}

	/** `folder/title.md`, or `title 2.md`, `title 3.md`… if that's taken. */
	private freePath(folder: string, title: string): string {
		const base = folder ? `${folder}/${title}` : title;
		let path = normalizePath(`${base}.md`);
		for (let n = 2; this.app.vault.getAbstractFileByPath(path) instanceof TFile; n++) {
			path = normalizePath(`${base} ${n}.md`);
		}
		return path;
	}
}

/** Note button: a blank box for the reader's own thought about the passage. */
export class NoteModal extends PassageNoteModal {
	onOpen(): void {
		this.modalEl.addClass("tmr-claim-modal");
		this.setTitle("Note");

		const noteEl = this.field("Your note").createEl("textarea", { cls: "tmr-claim-text tmr-note-text" });
		const titleEl = this.field("Title").createEl("input", {
			cls: "tmr-claim-title",
			attr: { type: "text", placeholder: "First line of the note" },
		});
		this.renderTags();
		this.renderTail("Save", () => {
			const text = noteEl.value.trim();
			if (!text) {
				new Notice("Write the note first");
				return;
			}
			const title = titleEl.value.trim() || clip(text.split(/\r?\n/, 1)[0], TITLE_MAX);
			void this.save(text, title, "Note", [], true);
		});
		noteEl.focus();
	}
}

/** Claim button: "Make it a claim", pre-filled with the passage itself. */
export class ClaimModal extends PassageNoteModal {
	onOpen(): void {
		this.modalEl.addClass("tmr-claim-modal");
		this.setTitle("Make it a claim");

		const claimEl = this.field("The claim").createEl("textarea", { cls: "tmr-claim-text" });
		claimEl.value = this.passage;
		claimEl.rows = 3;
		const titleEl = this.field("Title").createEl("input", { cls: "tmr-claim-title", attr: { type: "text" } });
		titleEl.value = clip(this.passage, TITLE_MAX);
		this.renderTags("claim ");
		this.renderTail("Create", () => {
			const claim = claimEl.value.trim();
			if (!claim) {
				new Notice("Write the claim first");
				return;
			}
			void this.save(claim, titleEl.value, "Claim", [], true);
		});
		claimEl.focus();
		claimEl.select();
	}
}

/** How the new note relates to the idea it links to. `reverse` is whether
 *  the idea note gets a line pointing back: "on" and "off" are defaults the
 *  reader can flip in the dialog, "ask" puts the question at Create. `line`
 *  builds that line from the new note's link and a summary of it; relations
 *  without one rely on Obsidian's backlinks alone. */
const RELATIONSHIPS: {
	id: string;
	label: string;
	reverse: "on" | "off" | "ask";
	line?: (link: string, summary: string) => string;
}[] = [
	{ id: "contradicts", label: "Contradicts",          reverse: "on",  line: (l, s) => `Contradicted by ${l}: ${s}` },
	{ id: "qualifies",   label: "Qualifies or limits",  reverse: "on",  line: (l, s) => `Limited by ${l}: ${s}` },
	{ id: "example",     label: "Example of",           reverse: "ask", line: (l, s) => `Example: ${l} — ${s}` },
	{ id: "extends",     label: "Extends or builds on", reverse: "off" },
	{ id: "supports",    label: "Supports",             reverse: "off" },
];

/** Longest summary carried into the idea note's reverse line. */
const SUMMARY_MAX = 140;

/** Link button, second step: "Make it a link", pre-filled with the passage.
 *  Source is the idea the reader picked; the book goes in `extra`. */
export class LinkModal extends PassageNoteModal {
	constructor(app: App, src: PassageSource, private target: TFile) {
		super(app, src);
	}

	onOpen(): void {
		this.modalEl.addClass("tmr-claim-modal");
		this.setTitle("Make it a link");

		const ideaEl = this.field("Idea").createEl("textarea", { cls: "tmr-claim-text" });
		ideaEl.value = this.passage;
		ideaEl.rows = 3;
		const titleEl = this.field("Title").createEl("input", { cls: "tmr-claim-title", attr: { type: "text" } });
		titleEl.value = clip(this.passage, TITLE_MAX);

		let rel = RELATIONSHIPS[0];
		let reverse = rel.reverse === "on";
		const relField = this.field("Relationship");
		const select = relField.createEl("select", { cls: "dropdown tmr-link-relationship" });
		for (const r of RELATIONSHIPS) select.createEl("option", { value: r.id, text: r.label });
		const reverseRow = new Setting(relField).setName(`Add a line to “${this.target.basename}”`);
		reverseRow.settingEl.addClass("tmr-link-reverse");
		let toggleSet: (on: boolean) => void = () => {};
		reverseRow.addToggle((t) => {
			toggleSet = (on) => { t.setValue(on); };
			t.onChange((on) => { reverse = on; });
		});
		const sync = () => {
			rel = RELATIONSHIPS.find((r) => r.id === select.value) ?? RELATIONSHIPS[0];
			const example = rel.line?.(`[[${titleEl.value.trim() || "this note"}]]`, "…");
			if (!example) {
				reverse = false;
				reverseRow.settingEl.addClass("tmr-hidden");
			} else {
				reverseRow.settingEl.removeClass("tmr-hidden");
				reverse = rel.reverse === "on";
				toggleSet(reverse);
				reverseRow.setDesc(rel.reverse === "ask" ? `You'll be asked on Create. Adds: ${example}` : `Adds: ${example}`);
				reverseRow.controlEl.toggleClass("tmr-hidden", rel.reverse === "ask");
			}
		};
		select.addEventListener("change", sync);
		titleEl.addEventListener("input", sync);
		sync();

		this.renderTail("Create", () => {
			const idea = ideaEl.value.trim();
			if (!idea) {
				new Notice("Write the idea first");
				return;
			}
			void this.create(idea, titleEl.value, rel, reverse);
		});
		ideaEl.focus();
		ideaEl.select();
	}

	private async create(
		idea: string,
		title: string,
		rel: (typeof RELATIONSHIPS)[number],
		reverse: boolean,
	): Promise<void> {
		const file = await this.save(idea, title, "Link", [`Relationship: ${rel.label} ${this.src.source}`]);
		const line = rel.line;
		if (!file || !line) return;
		const summary = clip(idea.split(/\r?\n/, 1)[0], SUMMARY_MAX);
		const text = line(`[[${this.app.metadataCache.fileToLinktext(file, this.target.path)}]]`, summary);
		if (rel.reverse === "ask") {
			new ConfirmModal(this.app, `Also add this line to “${this.target.basename}”?`, text, "Add it", () => {
				void this.appendToTarget(text);
			}).open();
		} else if (reverse) {
			await this.appendToTarget(text);
		}
	}

	/** Append `text` as its own paragraph at the end of the idea note. */
	private async appendToTarget(text: string): Promise<void> {
		try {
			await this.app.vault.process(this.target, (data) => `${data.replace(/\s*$/, "")}\n\n${text}\n`);
			new Notice(`Added to ${this.target.basename}`);
		} catch (err) {
			console.error("Reverse link failed", err);
			new Notice(`Fourth Mind Reader: couldn't add the line to ${this.target.basename}`);
		}
	}
}

/** Yes/no prompt for an "ask" relationship, showing the exact line it adds. */
class ConfirmModal extends Modal {
	constructor(app: App, private question: string, private preview: string, private yes: string, private onYes: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tmr-claim-modal");
		this.setTitle(this.question);
		this.contentEl.createDiv({ cls: "tmr-claim-passage", text: this.preview });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Skip" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { cls: "mod-cta", text: this.yes }).addEventListener("click", () => {
			this.onYes();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Link button, first step: pick the idea — any note in the vault outside the
 *  plugin's annotations folder. */
class IdeaPicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Find an idea");
	}

	getItems(): TFile[] {
		const annotations = `${annotationsFolderPath()}/`;
		return this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(annotations));
	}

	getItemText(file: TFile): string {
		return file.basename;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

export type PassageKind = "note" | "claim" | "link";

/** The slice of plugin settings that remembers each dialog's last folder. */
export interface PassageFolders {
	noteFolder: string;
	claimFolder: string;
	linkFolder: string;
}

const FOLDER_KEY: Record<PassageKind, keyof PassageFolders> = {
	note: "noteFolder",
	claim: "claimFolder",
	link: "linkFolder",
};

/** Entry point for the Note, Claim and Link buttons. `source` is the host's
 *  citation of the book; `save` persists `folders` once a dialog has updated it. */
export function openPassageDialog(
	app: App,
	kind: PassageKind,
	passage: string,
	source: string,
	cite: PassageCitation,
	folders: PassageFolders,
	save: () => Promise<void>,
	onNote: (file: TFile) => void,
): void {
	const key = FOLDER_KEY[kind];
	const base: PassageSource = {
		passage,
		source,
		cite,
		folder: folders[key],
		onCreated: (folder, file) => {
			folders[key] = folder;
			void save();
			onNote(file);
		},
	};
	if (kind === "note") new NoteModal(app, base).open();
	else if (kind === "claim") new ClaimModal(app, base).open();
	else new IdeaPicker(app, (idea) => {
		new LinkModal(app, {
			...base,
			source: `[[${app.metadataCache.fileToLinktext(idea, "")}]]`,
			extra: `Passage from: ${source}`,
		}, idea).open();
	}).open();
}
