/** Dialogs that turn a selected passage into its own vault note — a quick
 *  Note (a fleeting thought, filed in Fleeting Notes by default) or a Claim
 *  ("Make it a claim"). The reader's own words go first, then the passage they
 *  rest on and a link back to where it came from. Shared by the EPUB and PDF
 *  hosts, which differ only in how they describe the source.
 */

import { AbstractInputSuggest, App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
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

export interface PassageSource {
	/** The selected text, verbatim. */
	passage: string;
	/** Markdown citation line: a wikilink back to the book plus whatever
	 *  location the host knows (chapter, page). Shown in the dialog and written
	 *  into the note as-is. */
	source: string;
	/** Folder the dialog opens on — the last one used. Empty is the vault root. */
	folder: string;
	/** The note was created in `folder`; hosts remember it for next time. */
	onCreated: (folder: string) => void;
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

	/** Write `folder/title.md` holding `text`, the passage as a quote, and the
	 *  source line. */
	protected async save(text: string, rawTitle: string, kind: string): Promise<void> {
		const title = sanitizeFileName(rawTitle.replace(/…$/, "")).replace(/^\.+/, "") || kind;
		const folder = (this.folderEl?.value ?? "").trim().replace(/^\/+|\/+$/g, "");
		if (folder && !(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
			new Notice(`No folder named "${folder}"`);
			return;
		}
		const path = this.freePath(folder, title);
		const quote = this.src.passage.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
		const body = `${text}\n\n${quote}\n\nSource: ${this.src.source}\n`;
		try {
			await this.app.vault.create(path, body);
		} catch (err) {
			console.error(`${kind} note creation failed`, err);
			new Notice(`Fourth Mind Reader: failed to create the ${kind.toLowerCase()} note`);
			return;
		}
		this.src.onCreated(folder);
		new Notice(`${kind} created: ${path}`);
		this.close();
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
		this.renderTail("Save", () => {
			const text = noteEl.value.trim();
			if (!text) {
				new Notice("Write the note first");
				return;
			}
			const title = titleEl.value.trim() || clip(text.split(/\r?\n/, 1)[0], TITLE_MAX);
			void this.save(text, title, "Note");
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
		this.renderTail("Create", () => {
			const claim = claimEl.value.trim();
			if (!claim) {
				new Notice("Write the claim first");
				return;
			}
			void this.save(claim, titleEl.value, "Claim");
		});
		claimEl.focus();
		claimEl.select();
	}
}
