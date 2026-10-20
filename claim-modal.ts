/** "Make it a claim" — turn a selected passage into its own vault note. The
 *  reader's own words go first (the claim), then the passage it rests on and a
 *  link back to where it came from. Shared by the EPUB and PDF hosts, which
 *  differ only in how they describe the source.
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

export interface ClaimSource {
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

export class ClaimModal extends Modal {
	constructor(app: App, private src: ClaimSource) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("tmr-claim-modal");
		this.setTitle("Make it a claim");

		const passage = this.src.passage.replace(/\s+/g, " ").trim();

		const field = (label: string) => {
			const wrap = contentEl.createDiv({ cls: "tmr-claim-field" });
			wrap.createDiv({ cls: "tmr-claim-label", text: label });
			return wrap;
		};

		const claimEl = field("The claim").createEl("textarea", { cls: "tmr-claim-text" });
		claimEl.value = passage;
		claimEl.rows = 3;

		const titleEl = field("Title").createEl("input", { cls: "tmr-claim-title", attr: { type: "text" } });
		titleEl.value = passage.length > TITLE_MAX ? passage.slice(0, TITLE_MAX).trimEnd() + "…" : passage;

		field("Passage").createDiv({ cls: "tmr-claim-passage", text: passage });
		field("Source").createDiv({ cls: "tmr-claim-source", text: this.src.source });

		const folderEl = field("Folder").createEl("input", {
			cls: "tmr-claim-folder",
			attr: { type: "text", placeholder: "The vault's root" },
		});
		folderEl.value = this.src.folder;
		new FolderSuggest(this.app, folderEl);

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const createBtn = buttons.createEl("button", { cls: "mod-cta", text: "Create" });
		createBtn.addEventListener("click", () => {
			void this.create(claimEl.value.trim(), titleEl.value, folderEl.value.trim());
		});

		claimEl.focus();
		claimEl.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async create(claim: string, rawTitle: string, rawFolder: string): Promise<void> {
		if (!claim) {
			new Notice("Write the claim first");
			return;
		}
		const title = sanitizeFileName(rawTitle.replace(/…$/, "")).replace(/^\.+/, "") || "Claim";
		const folder = rawFolder.replace(/^\/+|\/+$/g, "");
		if (folder && !(this.app.vault.getAbstractFileByPath(normalizePath(folder)) instanceof TFolder)) {
			new Notice(`No folder named "${folder}"`);
			return;
		}
		const path = this.freePath(folder, title);
		const quote = this.src.passage.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
		const body = `${claim}\n\n${quote}\n\nSource: ${this.src.source}\n`;
		try {
			await this.app.vault.create(path, body);
		} catch (err) {
			console.error("Claim note creation failed", err);
			new Notice("Fourth Mind Reader: failed to create the claim note");
			return;
		}
		this.src.onCreated(folder);
		new Notice(`Claim created: ${path}`);
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
