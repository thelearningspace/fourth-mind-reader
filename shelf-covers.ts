import { type App, TFile, loadPdfJs } from "obsidian";
import JSZip from "jszip";

/** Cover art for the Shelf. EPUBs use the image the package file names as its
 *  cover; PDFs are drawn from their first page. Results (including "no cover")
 *  are cached per path and validated against the file's mtime, so scrolling
 *  back over a card never re-reads the book. */

interface CoverEntry {
	mtime: number;
	url: string | null;
}

const cache = new Map<string, CoverEntry>();
const inflight = new Map<string, Promise<string | null>>();

/** Books are read one or two at a time: a shelf of large PDFs opened at once
 *  would otherwise read every file into memory together. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
	try {
		return await task();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/** The cached cover for `path` if one has already been resolved, without
 *  starting a read — lets a repaint draw known covers synchronously. */
export function cachedCover(app: App, path: string): string | null | undefined {
	const file = app.vault.getFileByPath(path);
	const entry = cache.get(path);
	if (!file || !entry || entry.mtime !== file.stat.mtime) return undefined;
	return entry.url;
}

export function loadCover(app: App, path: string): Promise<string | null> {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) return Promise.resolve(null);
	const entry = cache.get(path);
	if (entry && entry.mtime === file.stat.mtime) return Promise.resolve(entry.url);
	const pending = inflight.get(path);
	if (pending) return pending;

	const job = withSlot(async () => {
		let url: string | null = null;
		try {
			const data = await app.vault.readBinary(file);
			const blob = file.extension === "pdf" ? await pdfCover(data) : await epubCover(data);
			if (blob) url = URL.createObjectURL(blob);
		} catch {
			// An unreadable book just keeps its drawn cover.
		}
		if (entry?.url) URL.revokeObjectURL(entry.url);
		cache.set(path, { mtime: file.stat.mtime, url });
		return url;
	}).finally(() => inflight.delete(path));
	inflight.set(path, job);
	return job;
}

/** Release every cover's object URL; called when the plugin unloads. */
export function clearCovers(): void {
	for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
	cache.clear();
}

const IMAGE_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

/** Find the cover image an EPUB declares: EPUB 3 `properties="cover-image"`,
 *  then the EPUB 2 `<meta name="cover">` pointer, then any image whose id or
 *  file name says "cover". */
async function epubCover(data: ArrayBuffer): Promise<Blob | null> {
	const zip = await JSZip.loadAsync(data);
	const container = await zip.file("META-INF/container.xml")?.async("string");
	if (!container) return null;
	const parser = new DOMParser();
	const opfPath = parser
		.parseFromString(container, "application/xml")
		.querySelector("rootfile")
		?.getAttribute("full-path");
	if (!opfPath) return null;
	const opfXml = await zip.file(opfPath)?.async("string");
	if (!opfXml) return null;
	const opf = parser.parseFromString(opfXml, "application/xml");

	const items = Array.from(opf.getElementsByTagNameNS("*", "item"));
	const isImage = (el: Element) => (el.getAttribute("media-type") ?? "").startsWith("image/");
	const metaCoverId = Array.from(opf.getElementsByTagNameNS("*", "meta"))
		.find((m) => m.getAttribute("name") === "cover")
		?.getAttribute("content");
	const item =
		items.find((el) => (el.getAttribute("properties") ?? "").split(/\s+/).includes("cover-image"))
		?? items.find((el) => metaCoverId && el.getAttribute("id") === metaCoverId && isImage(el))
		?? items.find((el) => isImage(el) && /cover/i.test(`${el.getAttribute("id")} ${el.getAttribute("href")}`));
	const href = item?.getAttribute("href");
	if (!href) return null;

	const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
	const imagePath = resolvePath(opfDir, decodeURIComponent(href));
	const bytes = await zip.file(imagePath)?.async("arraybuffer");
	if (!bytes) return null;
	const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
	const type = item?.getAttribute("media-type") || IMAGE_TYPES[ext] || "image/jpeg";
	return new Blob([bytes], { type });
}

/** Join an OPF-relative href onto the OPF's folder, folding `..` segments. */
function resolvePath(dir: string, href: string): string {
	const out: string[] = [];
	for (const part of (dir + href).split("/")) {
		if (part === "..") out.pop();
		else if (part && part !== ".") out.push(part);
	}
	return out.join("/");
}

/** Width, in CSS pixels, the first page is drawn at. Covers show at most
 *  ~11rem wide, so this leaves room for a 2× display. */
const PDF_COVER_WIDTH = 360;

/** The slice of pdf.js used here. Obsidian ships pdf.js but types it as `any`. */
interface PdfViewport { width: number; height: number }
interface PdfPage {
	getViewport(opts: { scale: number }): PdfViewport;
	render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument {
	getPage(n: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}
interface PdfJs {
	getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

async function pdfCover(data: ArrayBuffer): Promise<Blob | null> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
	try {
		const page = await doc.getPage(1);
		const scale = PDF_COVER_WIDTH / page.getViewport({ scale: 1 }).width;
		const viewport = page.getViewport({ scale });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		await page.render({ canvasContext: ctx, viewport }).promise;
		return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
	} finally {
		void doc.destroy();
	}
}
