import { Modal, Setting, App, TextComponent } from "obsidian";
import type { LibraryBook } from "./library-scan";

/**
 * Small modal to override a book's displayed title/author. Stores a display-only
 * override (see `applyOverride`); the epub file is never touched. "Reset to
 * original" restores the raw OPF values, which prunes the override on save.
 */
export class EditBookDetailsModal extends Modal {
	private titleValue: string;
	private authorValue: string;
	private readValue: boolean;

	constructor(
		app: App,
		private book: LibraryBook,
		private onSave: (title: string, author: string, read: boolean) => void | Promise<void>
	) {
		super(app);
		this.titleValue = book.title;
		this.authorValue = book.author;
		this.readValue = book.markedRead;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Edit book details");
		contentEl.createEl("p", {
			cls: "tmr-lib-edit-note",
			text: "Display only — your book file is never modified.",
		});

		let titleInput: TextComponent;
		let authorInput: TextComponent;

		new Setting(contentEl).setName("Title").addText((t) => {
			titleInput = t;
			t.setValue(this.titleValue).onChange((v) => (this.titleValue = v));
		});

		new Setting(contentEl)
			.setName("Author")
			.setDesc(
				this.book.rawAuthor
					? `Original: ${this.book.rawAuthor}`
					: this.book.kind === "pdf"
						? "A PDF carries no author metadata — set one here."
						: "No author in the epub metadata."
			)
			.addText((t) => {
				authorInput = t;
				t.setValue(this.authorValue).onChange((v) => (this.authorValue = v));
			});

		new Setting(contentEl)
			.setName("Read")
			.setDesc("Counts the book as finished on the shelf, whatever page you stopped on.")
			.addToggle((t) => t.setValue(this.readValue).onChange((v) => (this.readValue = v)));

		new Setting(contentEl)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Reset to original")
					.onClick(() => {
						this.titleValue = this.book.rawTitle;
						this.authorValue = this.book.rawAuthor;
						titleInput.setValue(this.titleValue);
						authorInput.setValue(this.authorValue);
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						await this.onSave(this.titleValue, this.authorValue, this.readValue);
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Single-field prompt for a new collection (subfolder) name. */
export class FolderNameModal extends Modal {
	private value = "";

	constructor(app: App, private onSubmit: (name: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("New collection");

		const submit = async () => {
			if (!this.value.trim()) return;
			this.close();
			await this.onSubmit(this.value);
		};

		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("e.g. Essays").onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					void submit();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Create").setCta().onClick(() => void submit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
