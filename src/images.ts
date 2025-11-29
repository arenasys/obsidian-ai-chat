import * as fs from "node:fs";
import * as path from "node:path";
import { App, Modal } from "obsidian";
import { setIcon } from "./common";

const IMAGE_DRAG_TYPE = "application/x-asys-image-drag";

export function deriveImageExtension(
	image: ImageAsset,
	fallback: string = "png"
) {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/bmp": "bmp",
		"image/avif": "avif",
		"image/svg+xml": "svg",
	};
	return map[image.mime] ?? fallback;
}

export function downloadImageAsset(image: ImageAsset) {
	const link = document.createElement("a");
	const timestamp = (window as any).moment().format("YYYYMMDD_HHmmss");
	const ext = deriveImageExtension(image);
	const filename = `obsidian_${timestamp}.${ext}`;
	link.href = image.url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
}

export async function saveImageToFolder(
	image: ImageAsset,
	folder: string,
	filename: string
) {
	try {
		const targetDir = path.isAbsolute(folder)
			? folder
			: path.resolve(folder);
		await fs.promises.mkdir(targetDir, { recursive: true });

		const targetPath = path.join(targetDir, filename);
		await imageAssetToFS(image, targetPath);
		return true;
	} catch (err) {
		console.error("Failed to save image", err);
		return false;
	}
}

export async function autoSaveImageAsset(image: ImageAsset, folder: string) {
	const timestamp = (window as any).moment().format("YYYYMMDD_HHmmss");
	const ext = deriveImageExtension(image);
	const suffix = Math.random().toString(36).slice(2, 6);
	const filename = `obsidian_${timestamp}_${suffix}.${ext}`;
	await saveImageToFolder(image, folder, filename);
}

export type ImageListOptions = {
	onClick?: (image: ImageAsset, index: number) => void;
	onRemove?: (index: number) => void;
	onReorder?: (images: ImageAsset[]) => void;
	showSelection?: boolean;
	selectedIndex?: number;
	showDownload?: boolean;
};

export class ImageList {
	private images: ImageAsset[] = [];
	private dragIndex: number | null = null;
	private dragPreviewEl: HTMLElement | null = null;

	constructor(
		private container: HTMLElement,
		private options: ImageListOptions = {}
	) {
		this.container.addEventListener("dragover", (event: DragEvent) => {
			if (!this.isOurDrag(event)) return;
			if (this.dragIndex === null) return;
			const index = this.getDropTargetFromPosition(event.clientX);
			if (index === null) return;
			event.preventDefault();
			this.updateDropIndicator(index);
		});

		this.container.addEventListener("dragexit", (event: DragEvent) => {
			if (!this.isOurDrag(event)) return;
			if (this.dragIndex === null) return;
			this.clearDropIndicators();
		});

		this.container.addEventListener("drop", (event: DragEvent) => {
			if (!this.isOurDrag(event)) return;
			if (this.dragIndex === null) return;
			event.preventDefault();
			const index = this.getDropTargetFromPosition(event.clientX);
			if (index !== null) {
				this.moveImage(this.dragIndex, index);
			}
			this.resetDragState();
		});
	}

	updateOptions(options: ImageListOptions) {
		this.options = { ...this.options, ...options };
	}

	setImages(images: ImageAsset[], selectedIndex?: number) {
		this.images = images;
		if (selectedIndex !== undefined) {
			this.options.selectedIndex = selectedIndex;
		}
		if (this.options.showSelection) {
			if (this.images.length === 0) {
				this.options.selectedIndex = undefined;
			} else if (this.options.selectedIndex === undefined) {
				this.options.selectedIndex = 0;
			} else {
				this.options.selectedIndex = Math.min(
					Math.max(this.options.selectedIndex, 0),
					this.images.length - 1
				);
			}
		}
		this.render();
	}

	setSelectedIndex(index: number, instant: boolean = false) {
		if (!this.options.showSelection) return;
		if (index < 0 || index >= this.images.length) return;
		this.options.selectedIndex = index;
		Array.from(this.container.children).forEach((child, childIndex) => {
			(child as HTMLElement).toggleClass(
				"asys__image-selected",
				childIndex === index
			);
		});
		this.centerSelected(instant);
	}

	centerSelected(instant: boolean = false) {
		if (!this.options.showSelection) return;
		const selected = this.container.children[
			this.options.selectedIndex ?? -1
		] as HTMLElement | null;
		if (!selected) return;

		const container = this.container;
		const scrollTo = () => {
			const offset =
				selected.offsetLeft +
				selected.offsetWidth / 2 -
				container.clientWidth / 2;
			const maxScroll = Math.max(
				0,
				container.scrollWidth - container.clientWidth
			);
			const target = Math.max(0, Math.min(maxScroll, offset));
			container.scrollTo({
				left: target,
				behavior: instant ? "auto" : "smooth",
			});
		};

		if (instant) {
			scrollTo();
		} else {
			requestAnimationFrame(scrollTo);
		}
	}

	private clearDropIndicators() {
		Array.from(this.container.children).forEach((child) => {
			child.removeClass("asys__image-drop-before");
			child.removeClass("asys__image-drop-after");
		});
	}

	private resetDragState() {
		this.dragIndex = null;
		this.dragPreviewEl?.remove();
		this.dragPreviewEl = null;
		Array.from(this.container.children).forEach((child) => {
			child.removeClass("asys__image-placeholder");
			child.removeClass("asys__image-drop-before");
			child.removeClass("asys__image-drop-after");
		});
	}

	private updateDropIndicator(index: number) {
		this.clearDropIndicators();
		let dropAfter = false;
		if (index == this.container.children.length) {
			dropAfter = true;
			index = index - 1;
		}
		let wrapper = this.container.children[index] as HTMLElement;
		wrapper.addClass(
			dropAfter ? "asys__image-drop-after" : "asys__image-drop-before"
		);
	}

	private getDropTargetFromPosition(clientX: number) {
		const wrappers = Array.from(this.container.children) as HTMLElement[];
		if (wrappers.length === 0) return null;

		let index = null;
		for (let i = 0; i < wrappers.length; i++) {
			const rect = wrappers[i].getBoundingClientRect();
			const midpoint = rect.left + rect.width / 2;
			if (clientX < midpoint) {
				index = i;
				break;
			}
			if (i === wrappers.length - 1) {
				index = i + 1;
			}
		}

		return index;
	}

	private moveImage(from: number, to: number) {
		if (
			from < 0 ||
			from >= this.images.length ||
			to < 0 ||
			to > this.images.length
		) {
			return;
		}

		const [image] = this.images.splice(from, 1);
		let target = to;
		if (from < to) {
			target -= 1;
		}
		this.images.splice(target, 0, image);

		this.options.onReorder?.(this.images);
		this.render();
	}

	private render() {
		this.container.empty();
		if (this.images.length === 0) {
			this.container.addClass("asys__hidden");
			this.container.style.display = "none";
			return;
		}
		this.container.removeClass("asys__hidden");
		this.container.style.display = "";

		const showDownload =
			this.options.showDownload === undefined
				? true
				: this.options.showDownload;

		this.images.forEach((image, index) => {
			const wrapper = this.container.createDiv({
				cls: "asys__image-wrapper",
			});
			if (
				this.options.showSelection &&
				this.options.selectedIndex === index
			) {
				wrapper.addClass("asys__image-selected");
			}
			const img = wrapper.createEl("img", {
				attr: {
					src: image.url,
				},
			});
			wrapper.addEventListener("click", () => {
				this.options.onClick?.(image, index);
				if (this.options.showSelection) {
					this.setSelectedIndex(index);
				}
			});

			if (showDownload) {
				const download = wrapper.createEl("button", {
					cls: "asys__image-download asys__image-action asys__icon clickable-icon",
				});
				setIcon(download, "download");
				download.ariaLabel = "Download image";
				download.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					downloadImageAsset(image);
				});
			}

			if (this.options.onRemove) {
				const remove = wrapper.createEl("button", {
					cls: "asys__image-remove asys__image-action asys__icon clickable-icon",
				});
				setIcon(remove, "x");
				remove.ariaLabel = "Remove image";
				remove.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.options.onRemove?.(index);
				});
			}

			if (this.options.onReorder) {
				wrapper.setAttribute("draggable", "true");
				wrapper.addEventListener("dragstart", (event) => {
					this.dragIndex = index;
					event.dataTransfer?.setData(IMAGE_DRAG_TYPE, "true");
					if (event.dataTransfer) {
						event.dataTransfer.effectAllowed = "move";
					}
					const rect = img.getBoundingClientRect();
					const width = rect.width;
					const height = rect.height;
					const preview = img.cloneNode(true) as HTMLElement;
					preview.addClass("asys__image-drag-preview");
					preview.style.width = `${width}px`;
					preview.style.height = `${height}px`;
					document.body.appendChild(preview);
					this.dragPreviewEl = preview;
					event.dataTransfer?.setDragImage(
						preview,
						width / 2,
						height / 2
					);
					wrapper.addClass("asys__image-placeholder");
				});

				wrapper.addEventListener("dragend", (_event) => {
					this.resetDragState();
				});
			}
		});
	}

	private isOurDrag(event: DragEvent) {
		const types = event.dataTransfer?.types;
		return !!types && Array.from(types).includes(IMAGE_DRAG_TYPE);
	}
}

export class ImageModal extends Modal {
	private mainImageEl: HTMLImageElement | null = null;
	private thumbs: ImageList | null = null;
	private currentIndex: number;
	private keydownHandler = (event: KeyboardEvent) => {
		if (this.images.length <= 1) return;
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			this.setCurrentImage(
				(this.currentIndex + this.images.length - 1) %
					this.images.length
			);
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			this.setCurrentImage((this.currentIndex + 1) % this.images.length);
		}
	};

	constructor(app: App, private images: ImageAsset[], selectedIndex: number) {
		super(app);
		this.currentIndex =
			this.images.length == 0
				? 0
				: Math.min(Math.max(selectedIndex, 0), this.images.length - 1);
	}

	private centerSelectedThumb(instant: boolean = false) {
		this.thumbs?.centerSelected(instant);
	}

	private setCurrentImage(index: number) {
		if (index < 0 || index >= this.images.length) return;
		this.currentIndex = index;
		const asset = this.images[this.currentIndex];
		if (this.mainImageEl) {
			this.mainImageEl.src = asset.url;
		}
		if (this.thumbs) {
			this.thumbs.setSelectedIndex(index);
		}
	}

	onOpen() {
		const { contentEl } = this;
		this.containerEl.addClass("asys__image-modal-container");
		contentEl.empty();

		if (this.images.length == 0) {
			this.close();
			return;
		}

		const containerEl = contentEl.createDiv({ cls: "asys__image-modal" });
		if (this.images.length === 1) {
			containerEl.addClass("asys__image-single");
		}
		const mainEl = containerEl.createDiv({ cls: "asys__image-modal-main" });
		const asset = this.images[this.currentIndex];
		this.mainImageEl = mainEl.createEl("img", {
			attr: { src: asset.url },
		});

		if (this.images.length > 1) {
			const thumbsContainer = containerEl.createDiv({
				cls: "asys__images asys__image-modal-images",
			});
			this.thumbs = new ImageList(thumbsContainer, {
				showSelection: true,
				selectedIndex: this.currentIndex,
				onClick: (_, index) => this.setCurrentImage(index),
			});
			this.thumbs.setImages(this.images, this.currentIndex);
			this.centerSelectedThumb(true);
		} else {
			this.thumbs = null;
		}

		window.addEventListener("keydown", this.keydownHandler);
	}

	onClose() {
		window.removeEventListener("keydown", this.keydownHandler);
		this.contentEl.empty();
		this.contentEl.removeClass("asys__image-modal");
		this.containerEl.removeClass("asys__image-modal-container");
		this.thumbs = null;
	}
}

export interface ImageAsset {
	blob: Blob;
	mime: string;
	url: string;
}

const DATA_URL_REGEX = /^data:([^;]+);base64,(.+)$/i;

export async function imageAssetFromDataUrl(
	dataUrl: string
): Promise<ImageAsset> {
	const match = DATA_URL_REGEX.exec(dataUrl.trim());
	if (!match) {
		throw new Error("Invalid data URL");
	}
	const mime = match[1];
	const base64 = match[2];
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const blob = new Blob([bytes], { type: mime });
	const url = URL.createObjectURL(blob);
	return { blob, mime, url };
}

export async function imageAssetToDataUrl(image: ImageAsset) {
	const buffer = await image.blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	return `data:${image.mime};base64,${base64}`;
}

function guessMimeFromPath(
	filePath: string,
	fallback: string = "application/octet-stream"
) {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
		gif: "image/gif",
		bmp: "image/bmp",
		avif: "image/avif",
		svg: "image/svg+xml",
	};
	return (ext && map[ext]) || fallback;
}

export async function imageAssetFromFS(
	filePath: string,
	mime: string | null = null
): Promise<ImageAsset> {
	const data = await fs.promises.readFile(filePath);
	const type = mime ?? guessMimeFromPath(filePath);
	const blob = new Blob([data], { type });
	const url = URL.createObjectURL(blob);
	return { blob, mime: type, url };
}

export async function imageAssetToFS(image: ImageAsset, filePath: string) {
	const buffer = Buffer.from(await image.blob.arrayBuffer());
	await fs.promises.writeFile(filePath, buffer);
}

export async function imageAssetFromFile(file: File): Promise<ImageAsset> {
	const arrayBuffer = await file.arrayBuffer();
	const blob = new Blob([arrayBuffer], { type: file.type });
	const url = URL.createObjectURL(blob);
	return { blob, mime: file.type, url };
}
