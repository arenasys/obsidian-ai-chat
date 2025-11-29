import {
	App,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Menu,
	Modal,
	TFile,
	getIcon,
} from "obsidian";
import {
	ChatEntry,
	ChatDocument,
	ChatHistory,
	PLUGIN_ID,
	ChatSettingProfiles,
	ChatSwipe,
	setIcon,
	setLoader,
} from "./common";
import { API, getAPI } from "./api";
import {
	ImageList,
	ImageListOptions,
	ImageModal,
	ImageAsset,
	autoSaveImageAsset,
	imageAssetFromDataUrl,
	imageAssetFromFile,
	addImageDropTarget,
} from "./images";

export const VIEW_TYPE_CHAT = "arenasys-ai-chat-view";
export class ChatView extends ItemView {
	profiles: ChatSettingProfiles;
	entryContainer: HTMLElement;
	documentContainer: HTMLElement;
	inputContainer: HTMLElement;
	inputImagesContainer: HTMLElement;
	popupContainer: HTMLElement;
	inputImages: ImageAsset[];
	imageLists: WeakMap<HTMLElement, ImageList> = new WeakMap();
	history: ChatHistory;
	working: boolean;

	api: API;

	editOriginal: ChatSwipe | null;

	menuSkip: boolean;
	menuOpen: boolean;

	entryMenu: Menu;
	entryMenuIndex: number;

	constructor(leaf: WorkspaceLeaf, profiles: ChatSettingProfiles) {
		super(leaf);
		this.profiles = profiles;
	}

	private openImageModal(image: ImageAsset, galleryImages?: ImageAsset[]) {
		const images = galleryImages ?? this.getVisibleImages();
		let selectedIndex = images.findIndex((img) => img.url === image.url);
		if (selectedIndex === -1) {
			images.push(image);
			selectedIndex = images.length - 1;
		}
		new ImageModal(this.app, images, selectedIndex).open();
	}

	private getVisibleImages(): ImageAsset[] {
		const images: ImageAsset[] = [];
		for (const entry of this.history?.entries ?? []) {
			const swipe =
				entry.new ??
				(entry.index >= 0 && entry.index < entry.swipes.length
					? entry.swipes[entry.index]
					: null);
			if (!swipe?.images) continue;
			images.push(...swipe.images.filter(Boolean));
		}
		return images;
	}

	getSettings() {
		return this.profiles.settings[this.profiles.current];
	}

	getViewType() {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText() {
		return "Chat";
	}

	getIcon() {
		return "message-square";
	}

	setWorking(working: boolean) {
		this.working = working;
		this.syncGenerateButtonToDom();
	}

	async setText(el: Element, text: string) {
		el.empty();
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			el.appendText(line);
			if (index != lines.length - 1) {
				el.createEl("br");
			}
		}
	}

	async setMarkdown(el: HTMLElement, text: string) {
		const tmp = document.createElement("div");

		// prettier-ignore
		await MarkdownRenderer.render(this.app, text, tmp, "", this);

		// insert <br> between <p>'s
		el.empty();
		const length = tmp.children.length;
		for (var i = 0; i < length; i++) {
			const thisNode = tmp.children[0] as HTMLElement;
			const nextNode = tmp.children[1] as HTMLElement;
			el.appendChild(thisNode);
			if (thisNode?.tagName == "P" && nextNode?.tagName == "P") {
				el.appendChild(document.createElement("br"));
			}
		}
	}

	private ensureImageList(
		container: HTMLElement,
		options: ImageListOptions
	): ImageList {
		let list = this.imageLists.get(container);
		if (!list) {
			list = new ImageList(container, options);
			this.imageLists.set(container, list);
		} else {
			list.updateOptions(options);
		}
		return list;
	}

	syncInputImages() {
		if (!this.inputImagesContainer) {
			return;
		}
		const list = this.ensureImageList(this.inputImagesContainer, {
			onClick: (image) => this.openImageModal(image, this.inputImages),
			onRemove: (index) => {
				this.inputImages.splice(index, 1);
				this.syncInputImages();
			},
			onReorder: (images: ImageAsset[]) => {
				this.inputImages = images;
			},
		});
		list.setImages(this.inputImages ?? []);
	}

	addPlainPaste(element: HTMLElement, onImage?: (image: ImageAsset) => void) {
		element.addEventListener("paste", (event: ClipboardEvent) => {
			const clipboard = event.clipboardData;
			if (!clipboard) {
				return;
			}
			const files = Array.from(clipboard.files ?? []).filter((file) =>
				file.type.startsWith("image/")
			);

			const text = clipboard.getData("text/plain");
			if (text || files.length > 0) {
				event.preventDefault();
			}
			if (text) {
				document.execCommand("insertText", false, text);
			}

			for (const file of files) {
				imageAssetFromFile(file)
					.then((asset) => {
						onImage?.(asset);
					})
					.catch((err) => {
						console.error("Failed to parse pasted image", err);
					});
			}
		});
	}

	addEntry(entry: ChatEntry) {
		const container = this.entryContainer;

		entry.swipes = entry.swipes.map((swipe) => ({
			...swipe,
			images: swipe.images ?? [],
		}));

		entry.element = container.createEl("div", { cls: "asys__entry" });
		entry.element.addClass(entry.user ? "asys__right" : "asys__left");

		// inner container to hold controls and content
		const inner = entry.element.createEl("div", {
			cls: "asys__entry_inner",
		});

		const controls = inner.createEl("div", {
			cls: "asys__controls",
		});
		const contentWrapper = inner.createEl("div", {
			cls: "asys__content",
		});
		const content = contentWrapper.createDiv({
			cls: "asys__content-text",
		});
		const images = contentWrapper.createDiv({
			cls: "asys__images asys__hidden",
		});

		const removeOutsidePointerListener = () => {
			const handler = (entry as any)._outsidePointerHandler as
				| ((event: PointerEvent) => void)
				| undefined;
			if (handler) {
				document.removeEventListener("pointerdown", handler, true);
				delete (entry as any)._outsidePointerHandler;
			}
		};

		const finishEditing = () => {
			if (!entry.edit) {
				return;
			}
			entry.edit = false;
			this.editOriginal = null;
			removeOutsidePointerListener();
			this.syncEntryToDom(entry);
		};

		const revertEditing = () => {
			if (!entry.edit) {
				return;
			}
			const current = entry.swipes[entry.index];
			if (current && this.editOriginal) {
				current.content = this.editOriginal.content;
				current.images = [...(this.editOriginal.images ?? [])];
				current.thoughts = this.editOriginal.thoughts;
			}
			entry.edit = false;
			this.editOriginal = null;
			removeOutsidePointerListener();
			this.syncEntryToDom(entry);
		};

		const addOutsidePointerListener = () => {
			removeOutsidePointerListener();
			const handler = (event: PointerEvent) => {
				const target = event.target as HTMLElement | null;
				const targetButton = target?.closest("button");
				const insideContent =
					target?.closest(".asys__content") === contentWrapper;
				const isEditButton = targetButton === editButton;
				const isTrashButton = targetButton === trashButton;
				if (!insideContent && !isEditButton && !isTrashButton) {
					finishEditing();
				}
			};
			(entry as any)._outsidePointerHandler = handler;
			document.addEventListener("pointerdown", handler, true);
		};

		const startEditing = () => {
			if (entry.edit) {
				return;
			}

			entry.reasoning = false;

			const swipe = entry.swipes[entry.index];
			this.editOriginal = swipe
				? { ...swipe, images: [...(swipe.images ?? [])] }
				: null;
			entry.edit = true;
			this.syncEntryToDom(entry);
			addOutsidePointerListener();
			content.focus();
		};

		content.addEventListener("input", (event) => {
			this.syncEntryFromDom(entry);
		});

		// Optional reasoning toggle button (for assistant entries), placed before edit
		let reasoningButton: HTMLButtonElement | null = null;
		if (!entry.user) {
			reasoningButton = controls.createEl("button", {
				cls: "asys__icon clickable-icon",
			});
			setIcon(reasoningButton, "brain");
			reasoningButton.addEventListener("click", (event) => {
				const currentSwipe = entry.swipes[entry.index];
				if (!entry.new && currentSwipe?.thoughts && !entry.edit) {
					entry.reasoning = !entry.reasoning;
					this.syncEntryToDom(entry);
				}
			});
		}

		const editButton = controls.createEl("button", {
			cls: "asys__icon clickable-icon",
		});
		setIcon(editButton, "more-horizontal");
		editButton.addEventListener("click", (event) => {
			if (entry.edit) {
				finishEditing();
			} else {
				startEditing();
			}
		});

		if (!entry.user) {
			const label = controls.createEl("span", { cls: "asys__label" });
			const leftButton = controls.createEl("button", {
				cls: "asys__icon clickable-icon",
			});
			setIcon(leftButton, "chevron-left");
			leftButton.addEventListener("click", (event) => {
				if (entry.index - 1 >= 0) {
					entry.index -= 1;
					this.syncEntryToDom(entry);
				}
			});

			const rightButton = controls.createEl("button", {
				cls: "asys__icon clickable-icon",
			});
			setIcon(rightButton, "chevron-right");
			rightButton.addEventListener("click", (event) => {
				if (entry.index + 1 < entry.swipes.length) {
					entry.index += 1;
					this.syncEntryToDom(entry);
				} else {
					this.redoResponse(entry);
				}
			});
		}

		const trashButton = controls.createEl("button", {
			cls: "asys__icon clickable-icon asys__red",
		});

		let clicked = false;
		setIcon(trashButton, "x");
		trashButton.addEventListener("click", (event) => {
			if (entry.edit) {
				revertEditing();
				return;
			}
			if (clicked) {
				this.removeEntry(entry);
			} else {
				clicked = true;
				setIcon(trashButton, "check");
				setTimeout(() => {
					clicked = false;
					setIcon(trashButton, "x");
				}, 500);
			}
		});
		trashButton.addEventListener("contextmenu", (event) => {
			if (trashButton.ariaDisabled === "true") {
				return;
			}
			this.entryMenuIndex = this.history.entries.indexOf(entry);
			const rect = trashButton.getBoundingClientRect();
			this.entryMenu.showAtPosition({ x: rect.right, y: rect.bottom });
		});

		this.addPlainPaste(content, (image) => {
			if (!entry.edit) {
				return;
			}
			const swipe = entry.swipes[entry.index];
			swipe.images = swipe.images ?? [];
			swipe.images.push(image);
			this.syncEntryToDom(entry);
		});
		addImageDropTarget(entry.element, {
			canAccept: () => entry.edit,
			onImages: (images) => {
				const swipe = entry.swipes[entry.index];
				if (!swipe) return;
				swipe.images = swipe.images ?? [];
				swipe.images.push(...images);
				this.syncEntryToDom(entry);
			},
		});

		this.syncEntryToDom(entry);
		this.history.entries.push(entry);
		return entry;
	}

	removeEntry(entry: ChatEntry) {
		try {
			this.entryContainer.removeChild(entry.element!);
			this.history.entries.remove(entry);
		} catch {}
	}

	cleanEntry(entry: ChatEntry) {
		entry.new = null;
		if (entry.swipes.length == 0) {
			this.removeEntry(entry);
		} else {
			entry.index = entry.swipes.length - 1;
			this.syncEntryToDom(entry);
		}
	}

	finishEntry(entry: ChatEntry) {
		if (entry.new != null) {
			entry.swipes.push(entry.new);
			entry.index = entry.swipes.length - 1;
			entry.new = null;
			this.syncEntryToDom(entry);
		}
	}

	async syncEntryToDom(entry: ChatEntry) {
		const inner = entry.element!.children[0] as HTMLElement;
		const controls = inner.children[0] as HTMLElement;
		// When assistant entry, controls order: [reasoning?, edit, label, left, right, trash]
		// When user entry, controls order: [edit, trash]
		const editButton = controls.children[entry.user ? 0 : 1] as HTMLElement;
		const trashButton = controls.lastElementChild!;
		const reasoningButton = entry.user
			? null
			: (controls.children[0] as HTMLElement);

		const contentWrapper = inner.children[1] as HTMLElement;
		const content = contentWrapper.children[0] as HTMLElement;
		const images = contentWrapper.children[1] as HTMLElement;

		const editing = content.getAttribute("contenteditable") == "true";
		if (editing && !entry.edit) {
			entry.element?.removeClass("asys__edit");
			setIcon(editButton, "more-horizontal");
			editButton.removeClass("asys__green");
			editButton.ariaLabel = "Edit";
			trashButton.ariaLabel = "Delete";
		}
		if (!editing && entry.edit) {
			entry.element?.addClass("asys__edit");
			setIcon(editButton, "check");
			editButton.addClass("asys__green");
		}
		content.setAttribute("contenteditable", entry.edit ? "true" : "false");

		const invalid =
			entry.swipes.length == 0 || entry.index >= entry.swipes.length;

		var working = entry.new != null;
		var reasoning = entry.reasoning && !entry.edit;

		const currentSwipe = working ? entry.new : entry.swipes[entry.index];

		controls.setAttribute(
			"data-asys-show",
			entry.edit || reasoning ? "true" : "false"
		);

		if (invalid && !working) {
			if (entry.started) {
				setLoader(content);
			} else {
				content.setText("");
			}
		} else {
			const text =
				(reasoning ? currentSwipe?.thoughts : currentSwipe?.content) ??
				"";

			if (entry.edit) {
				await this.setText(content, text);
			} else {
				inner.setAttribute(
					"data-asys-reasoning",
					working && reasoning ? "true" : "false"
				);

				content.setAttribute(
					"data-asys-reasoning",
					reasoning ? "true" : "false"
				);

				await this.setMarkdown(content, text);

				if (reasoning) {
					(inner as HTMLElement).scrollTop = (
						inner as HTMLElement
					).scrollHeight;
				}
			}
		}

		editButton.ariaLabel = entry.edit ? "Accept" : "Edit";
		editButton.ariaDisabled = invalid || working ? "true" : "false";

		trashButton.ariaLabel = entry.edit ? "Revert" : "Delete";
		trashButton.ariaDisabled = invalid || working ? "true" : "false";

		if (!entry.user) {
			const label = controls.children[2];
			label.setText(
				entry.swipes.length == 0
					? ""
					: `${entry.index + 1} of ${entry.swipes.length}`
			);

			const leftButton = controls.children[3];
			leftButton.ariaDisabled =
				entry.index == 0 || invalid || entry.edit ? "true" : "false";
			leftButton.ariaLabel = "Previous";

			const rightButton = controls.children[4];
			rightButton.ariaDisabled = invalid || entry.edit ? "true" : "false";
			rightButton.ariaLabel = "Next";

			// Show/hide the reasoning button based on conditions
			if (reasoningButton) {
				const currentSwipe = entry.swipes[entry.index];
				const reasoning = entry.reasoning;
				const showReasoningButton = !!currentSwipe?.thoughts;
				reasoningButton.classList.toggle(
					"asys__hidden",
					!showReasoningButton
				);
				reasoningButton.classList.toggle(
					"asys__green-active",
					!!reasoning
				);
				reasoningButton.classList.toggle(
					"asys__gray-active",
					!reasoning
				);
				reasoningButton.ariaLabel = reasoning
					? "Reasoning"
					: "Hide Reasoning";
				reasoningButton.ariaDisabled =
					invalid || entry.edit ? "true" : "false";
			}
		}

		const imagesToRender = (currentSwipe?.images ?? []).filter(
			(img) => !!img
		);
		const list = this.ensureImageList(images, {
			onClick: (image) => this.openImageModal(image),
			onRemove: entry.edit
				? (index) => {
						const swipe = entry.swipes[entry.index];
						if (!swipe?.images) return;
						swipe.images.splice(index, 1);
						this.syncEntryToDom(entry);
				  }
				: undefined,
			onReorder: entry.edit
				? (images: ImageAsset[]) => {
						entry.swipes[entry.index].images = images;
				  }
				: undefined,
		});
		list.setImages(imagesToRender);
	}

	syncEntryFromDom(entry: ChatEntry) {
		const inner = entry.element!.children[0] as HTMLElement;
		const contentWrapper = inner.children[1] as HTMLDivElement;
		const content = contentWrapper.children[0] as HTMLDivElement;
		entry.swipes[entry.index].content = content.innerText;
	}

	addDocument(file: TFile, append: boolean = true) {
		const row = document.createElement("div");
		row.addClass("asys__document-row");
		const element = row.createDiv({ cls: "asys__document" });

		const doc: ChatDocument = {
			file: file,
			element: row,
			pin: false,
			mute: false,
		};

		if (append || this.documentContainer.children.length == 0) {
			this.documentContainer.appendChild(row);
			this.history.documents.push(doc);
		} else {
			this.documentContainer.insertBefore(
				row,
				this.documentContainer.firstChild
			);
			this.history.documents.unshift(doc);
		}

		const mute = element.createEl("button", {
			cls: "asys__mute asys__toggle asys__icon clickable-icon",
		});
		mute.ariaLabel = "Hide/Unhide document";

		setIcon(mute, "eye");
		mute.addEventListener("click", (event) => {
			if (doc.mute) {
				mute.removeClass("asys__toggled");
				setIcon(mute, "eye");
				doc.mute = false;
			} else {
				mute.addClass("asys__toggled");
				setIcon(mute, "eye-off");
				doc.mute = true;
			}
		});

		const pin = element.createEl("button", {
			cls: "asys__pin asys__toggle asys__icon clickable-icon",
		});
		pin.ariaLabel = "Pin/Unpin document";

		setIcon(pin, "pin-off");
		pin.addEventListener("click", (event) => {
			if (doc.pin) {
				pin.removeClass("asys__toggled");
				doc.pin = false;
				setIcon(pin, "pin-off");
				const isFirst = doc == this.history.documents[0];
				if (!isFirst) {
					this.removeDocument(doc);
				}
				const current = this.app.workspace.getActiveFile();
				if (current) {
					this.setCurrentDocument(current);
				}
			} else {
				pin.addClass("asys__toggled");
				setIcon(pin, "pin");
				doc.pin = true;
			}
		});
		const content = element.createDiv();
		this.syncDocumentToDom(doc);
	}

	removeDocument(doc: ChatDocument) {
		this.history.documents.remove(doc);
		this.documentContainer.removeChild(doc.element!);
	}

	setCurrentDocument(file: TFile) {
		if (this.history.documents.length == 0) {
			this.addDocument(file);
		}

		const exists = this.history.documents.some((document, index) => {
			return document.file == file && document.pin;
		});

		if (!exists) {
			if (!this.history.documents[0].pin) {
				this.history.documents[0].file = file;
				this.syncDocumentToDom(this.history.documents[0]);
			} else {
				this.addDocument(file, false);
			}
		} else if (!this.history.documents[0].pin) {
			const doc = this.history.documents[0];
			this.history.documents.remove(doc);
			this.documentContainer.removeChild(doc.element!);
		}
	}

	syncDocumentToDom(document: ChatDocument) {
		const row = document.element! as HTMLDivElement;
		const element = row.children[0] as HTMLDivElement;
		const pin = element.children[0];
		const mute = element.children[1];
		const content = element.children[2] as HTMLDivElement;

		content.setText(document.file.path);
	}

	checkCurrentDocument() {
		if (this.history.documents.length > 0) {
			const document = this.history.documents[0];
			const element = document.element! as HTMLDivElement;
			const current = element.innerText;
			const target = document.file.path;
			if (current != target) {
				this.syncDocumentToDom(document);
			}
		}
	}

	syncGenerateButtonToDom() {
		const button = this.inputContainer.children[0];
		if (this.working) {
			button.addClass("asys__working");
			setIcon(button, "square");
		} else {
			button.removeClass("asys__working");
			setIcon(button, "play");
		}
	}

	snapToBottom() {
		const background = this.containerEl.children[1];
		background.scrollTop = background.scrollHeight;
	}

	async hidePopup() {
		this.popupContainer.removeClass("asys__fadeIn");
		this.popupContainer.addClass("asys__fadeOut");
	}

	async showPopup(message: string) {
		await this.setText(this.popupContainer, message);

		this.popupContainer.removeClass("asys__fadeOut");
		this.popupContainer.addClass("asys__fadeIn");

		this.popupContainer.addEventListener("click", (event) => {
			this.hidePopup();
		});
	}

	async redoResponse(entry: ChatEntry) {
		entry.index = entry.swipes.length;
		entry.reasoning = false;
		entry.started = false;
		entry.new = null;
		this.syncEntryToDom(entry);
		this.makeRequest(entry);
	}

	async getResponse() {
		const response = this.addEntry({
			user: false,
			edit: false,
			reasoning: false,
			new: null,
			started: false,
			index: 0,
			swipes: [],
		});
		this.makeRequest(response);
	}

	async handleInput(input: string) {
		const images = [...(this.inputImages ?? [])];
		this.inputImages = [];
		this.syncInputImages();

		const hasText = input.trim().length > 0;
		const hasImages = images.length > 0;
		const isEmpty = !hasText && !hasImages;
		const lastEntry = this.history.entries[this.history.entries.length - 1];

		if (isEmpty) {
			if (lastEntry && lastEntry.user) {
				this.getResponse();
			}
			return;
		}

		if (lastEntry && lastEntry.user) {
			const swipe = lastEntry.swipes[lastEntry.index];
			if (hasText) {
				const separator =
					swipe.content.length > 0 && input.length > 0 ? "\n" : "";
				swipe.content += `${separator}${input}`;
			}
			swipe.images = swipe.images ?? [];
			swipe.images.push(...images);
			this.syncEntryToDom(lastEntry);
			this.getResponse();
		} else {
			this.addEntry({
				user: true,
				edit: false,
				reasoning: false,
				new: null,
				started: false,
				index: 0,
				swipes: [{ content: input, images: images, thoughts: null }],
			});
			this.getResponse();
		}
	}

	async makeRequest(entry: ChatEntry) {
		this.setWorking(true);

		const settings = this.getSettings();

		const isLast =
			entry == this.history.entries[this.history.entries.length - 1];
		this.api = getAPI(settings)!;

		this.api.events.on("text", (text: string) => {
			if (text.length == 0) {
				return;
			}
			if (entry.new == null) {
				entry.new = { content: "", images: [], thoughts: null };
			}
			entry.reasoning = false;
			entry.new.content += text;
			this.syncEntryToDom(entry);
			if (isLast) {
				this.snapToBottom();
			}
		});
		this.api.events.on("image", async (image: string) => {
			if (typeof image !== "string" || image.length == 0) {
				return;
			}
			try {
				const asset = await imageAssetFromDataUrl(image);
				const autoSaveFolder =
					this.getSettings().imageSaveFolder?.trim();
				if (autoSaveFolder && autoSaveFolder.length > 0) {
					autoSaveImageAsset(asset, autoSaveFolder);
				}
				if (entry.new == null) {
					entry.new = { content: "", images: [], thoughts: null };
				}
				entry.new.images = entry.new.images ?? [];
				entry.new.images.push(asset);
				this.syncEntryToDom(entry);
				if (isLast) {
					this.snapToBottom();
				}
			} catch (err) {
				console.error("Failed to handle streamed image", err);
			}
		});
		this.api.events.on("reasoning", (text: string) => {
			if (text.length == 0) {
				return;
			}
			if (entry.reasoning == false) {
				entry.reasoning = true;
			}
			if (entry.new == null) {
				entry.new = { content: "", images: [], thoughts: "" };
			}
			if (entry.new.thoughts == null) {
				entry.new.thoughts = "";
			}
			entry.new.thoughts += text;
			this.syncEntryToDom(entry);
			if (isLast) {
				this.snapToBottom();
			}
		});
		this.api.events.on("status", (status: number) => {
			console.log(Date.now(), "Status:", status);
			if (status != 200) {
				if (isLast) {
					this.snapToBottom();
				}
			} else {
				entry.started = true;
				this.syncEntryToDom(entry);
			}
		});
		this.api.events.on("done", () => {
			console.log(Date.now(), "Done");
			entry.reasoning = false;
			this.finishEntry(entry);
		});
		this.api.events.on("error", (error: string) => {
			console.log(Date.now(), "Error:", error);
			/*entry.new = null;
			this.cleanEntry(entry);
			this.syncEntryToDom(entry);*/
			this.showPopup(error);
		});
		this.api.events.on("abort", () => {
			console.log(Date.now(), "Aborted");
			this.finishEntry(entry);
		});
		this.api.events.on("close", () => {
			console.log(Date.now(), "Closed");
			this.cleanEntry(entry);
			this.setWorking(false);
		});

		await this.api.send(this.history, entry, settings);

		return;
	}

	async abortRequest() {
		if (this.working && this.api) {
			await this.api.abort();
		}
	}

	async addChat() {
		this.history = {
			entries: [],
			documents: [],
			app: this.app,
		};
		this.inputImages = [];

		const background = this.containerEl.children[1];
		background.addClass("asys__background");
		background.empty();

		this.entryContainer = background.createEl("div", {
			cls: "asys__entries",
		});

		const tmp = this.entryContainer.createEl("div");
		const settings = tmp.createEl("button", {
			cls: "asys__settings clickable-icon view-action",
		});
		settings.ariaLabel = "More options";
		this.documentContainer = tmp.createEl("div");

		setIcon(settings, "more-vertical");
		const settingsMenu = new Menu();
		settingsMenu.addItem((item) => {
			item.setIcon("settings");
			item.setTitle("Open settings");
			item.onClick((e) => {
				this.app.setting.open();
				if (this.app.setting.lastTabId !== PLUGIN_ID)
					this.app.setting.openTabById(PLUGIN_ID);
			});
		});
		settingsMenu.addSeparator();
		settingsMenu.addItem((item) => {
			item.setIcon("trash");
			item.setTitle("Clear chat");
			item.setWarning(true);
			item.onClick((e) => {
				this.addChat();
			});
		});
		settings.addEventListener("mousedown", (event: MouseEvent) => {
			if (this.menuOpen) {
				this.menuSkip = true;
			}
		});
		settings.addEventListener("click", (event: MouseEvent) => {
			if (this.menuSkip) {
				this.menuSkip = false;
				return;
			}
			const rect = settings.getBoundingClientRect();
			settingsMenu.showAtPosition({ x: rect.right, y: rect.bottom });
			this.menuOpen = true;
		});
		settingsMenu.onHide(() => {
			this.menuOpen = false;
		});

		this.entryMenu = new Menu();
		this.entryMenu.addItem((item) => {
			item.setIcon("trash");
			item.setTitle("Delete below");
			item.setWarning(true);
			item.onClick((e) => {
				let idx = this.entryMenuIndex + 1;
				while (idx < this.history.entries.length) {
					const before = this.history.entries.length;
					this.removeEntry(this.history.entries[idx]);
					if (before == this.history.entries.length) {
						// failed to remove
						break;
					}
				}
			});
		});

		const current = this.app.workspace.getActiveFile();
		if (current) {
			this.setCurrentDocument(current);
		}

		this.inputContainer = background.createDiv({
			cls: "asys__input-container",
		});

		const inputButton = this.inputContainer.createEl("button", {
			cls: "asys__icon asys__input-button clickable-icon",
		});
		inputButton.ariaLabel = "Stop";
		setIcon(inputButton, "play");
		inputButton.addEventListener("click", async (event) => {
			if (this.working) {
				this.abortRequest();
			}
		});

		const input = this.inputContainer.createDiv({ cls: "asys__input" });
		input.setAttribute("contenteditable", "true");
		input.setAttribute("placeholder", "Ask something...");
		input.addEventListener("keydown", async (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				await this.hidePopup();
				if (!this.working) {
					await this.handleInput(input.innerText);
					input.empty();
				}
				event.preventDefault();
			}
		});
		input.addEventListener("input", (event) => {
			this.snapToBottom();
			if (input.innerText == "\n") {
				input.empty();
			}
		});
		this.addPlainPaste(input, (image) => {
			this.inputImages.push(image);
			this.syncInputImages();
		});
		addImageDropTarget(this.inputContainer, {
			onImages: (images) => {
				this.inputImages.push(...images);
				this.syncInputImages();
			},
		});

		this.inputImagesContainer = this.inputContainer.createDiv({
			cls: "asys__images asys__input-images asys__hidden",
		});
		this.syncInputImages();

		this.popupContainer = background.createEl("div", {
			cls: "asys__popup asys__fadeOut",
		});
	}

	async onOpen() {
		await this.addChat();
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.setCurrentDocument(file!);
			})
		);
		this.registerInterval(
			window.setInterval(() => this.checkCurrentDocument(), 1000)
		);
	}

	async onClose() {}
}
