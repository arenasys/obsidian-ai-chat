import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Menu,
	TFile,
	getIcon,
} from "obsidian";
import {
	ChatEntry,
	ChatDocument,
	ChatHistory,
	PLUGIN_ID,
	ChatSettingProfiles,
} from "./common";
import { API, getAPI, getApproxTokens } from "./api";

export const VIEW_TYPE_CHAT = "arena-chat-view";

function setIcon(el: Element, name: string) {
	el.empty();
	el.appendChild(getIcon(name) ?? getIcon("bug")!);
}

export class ChatView extends ItemView {
	profiles: ChatSettingProfiles;
	entryContainer: Element;
	documentContainer: Element;
	inputContainer: Element;
	tokenContainer: Element;
	popupContainer: Element;
	history: ChatHistory;
	working: boolean;

	api: API;

	editOriginal: string;
	editRevert: boolean;
	editSkip: boolean;

	menuSkip: boolean;
	menuOpen: boolean;

	constructor(leaf: WorkspaceLeaf, profiles: ChatSettingProfiles) {
		super(leaf);
		this.profiles = profiles;
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

	addPlainPaste(element: HTMLElement) {
		element.addEventListener("paste", (event: ClipboardEvent) => {
			event.preventDefault();
			const text = event.clipboardData
				?.getData("text/plain")
				?.replace(/\n/g, "<br>");
			document.execCommand("insertHTML", false, text);
		});
	}

	addEntry(entry: ChatEntry) {
		const container = this.entryContainer;

		entry.element = container.createEl("div", { cls: "asys__entry" });
		entry.element.addClass(entry.user ? "asys__right" : "asys__left");

		const controls = entry.element.createEl("div", {
			cls: "asys__controls",
		});
		const content = entry.element.createEl("div", {
			cls: "asys__content",
		});

		content.addEventListener("input", (event) => {
			this.syncEntryFromDom(entry);
		});

		const editButton = controls.createEl("button", {
			cls: "asys__icon clickable-icon",
		});
		setIcon(editButton, "more-horizontal");
		editButton.addEventListener("click", (event) => {
			if (this.editSkip) {
				this.editSkip = false;
				return;
			}

			entry.edit = true;
			this.editOriginal = entry.content[entry.index];
			this.editRevert = false;
			this.syncEntryToDom(entry);
			content.focus();
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
				if (entry.index + 1 < entry.content.length) {
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
			if (clicked) {
				this.removeEntry(entry);
			} else if (!this.editRevert) {
				clicked = true;
				setIcon(trashButton, "check");
				setTimeout(() => {
					clicked = false;
					setIcon(trashButton, "x");
				}, 500);
			} else {
				this.editRevert = false;
			}
		});

		content.addEventListener("focusout", (event) => {
			this.editSkip = event.relatedTarget == editButton;
			this.editRevert = event.relatedTarget == trashButton;
			if (!this.editSkip && !this.editRevert) {
				return;
			}
			entry.edit = false;
			this.syncEntryToDom(entry);
		});
		this.addPlainPaste(content);

		entry.element.addEventListener("mouseover", (event) => {
			if (
				entry == this.history.entries[this.history.entries.length - 1]
			) {
				this.tokenContainer.removeClass("asys__hidden");
			}
		});
		entry.element.addEventListener("mouseout", (event) => {
			if (
				entry == this.history.entries[this.history.entries.length - 1]
			) {
				this.tokenContainer.addClass("asys__hidden");
			}
		});

		this.syncEntryToDom(entry);
		this.history.entries.push(entry);
		return entry;
	}

	removeEntry(entry: ChatEntry) {
		try {
			if (
				entry == this.history.entries[this.history.entries.length - 1]
			) {
				this.tokenContainer.addClass("asys__hidden");
			}

			this.entryContainer.removeChild(entry.element!);
			this.history.entries.remove(entry);
		} catch {}
	}

	cleanEntry(entry: ChatEntry) {
		entry.new = null;
		if (entry.content.length == 0) {
			this.removeEntry(entry);
		} else {
			entry.index = entry.content.length - 1;
			this.syncEntryToDom(entry);
		}
	}

	finishEntry(entry: ChatEntry) {
		if (entry.new != null) {
			entry.content.push(entry.new);
			entry.index = entry.content.length - 1;
			entry.new = null;
			this.syncEntryToDom(entry);
		}
	}

	async syncEntryToDom(entry: ChatEntry) {
		const controls = entry.element!.children[0] as HTMLElement;
		const editButton = controls.children[0];
		const trashButton = controls.lastElementChild!;

		const content = entry.element!.children[1] as HTMLElement;

		const editing = content.getAttribute("contenteditable") == "true";
		if (editing && !entry.edit) {
			if (this.editRevert) {
				entry.content[entry.index] = this.editOriginal;
			}
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
			entry.content.length == 0 || entry.index >= entry.content.length;
		const working = entry.new != null;
		const waiting = entry.new != null && entry.new.length != 0;

		if (invalid && !waiting) {
			content.setText("...");
		} else {
			const text = waiting ? entry.new! : entry.content[entry.index];
			if (entry.edit) {
				await this.setText(content, text);
			} else {
				await this.setMarkdown(content, text);
			}
		}

		editButton.ariaLabel = entry.edit ? "Accept" : "Edit";
		editButton.ariaDisabled = invalid || working ? "true" : "false";

		trashButton.ariaLabel = entry.edit ? "Revert" : "Delete";
		trashButton.ariaDisabled = invalid || working ? "true" : "false";

		if (!entry.user) {
			const label = controls.children[1];
			label.setText(
				entry.content.length == 0
					? ""
					: `${entry.index + 1} of ${entry.content.length}`
			);

			const leftButton = controls.children[2];
			leftButton.ariaDisabled =
				entry.index == 0 || invalid || entry.edit ? "true" : "false";
			leftButton.ariaLabel = "Previous";

			const rightButton = controls.children[3];
			rightButton.ariaDisabled = invalid || entry.edit ? "true" : "false";
			rightButton.ariaLabel = "Next";
		}
	}

	syncEntryFromDom(entry: ChatEntry) {
		const content = entry.element!.children[1] as HTMLDivElement;
		entry.content[entry.index] = content.innerText;
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

	async checkCurrentTokens() {
		const tokens = await getApproxTokens(this.history, this.getSettings());
		this.tokenContainer.setText(`${tokens} Tokens`);
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
		entry.index = entry.content.length;
		this.syncEntryToDom(entry);
		this.makeRequest(entry);
	}

	async getResponse() {
		const response = this.addEntry({
			user: false,
			edit: false,
			new: null,
			index: 0,
			content: [],
		});
		this.makeRequest(response);
	}

	async handleInput(input: string) {
		const isEmpty = input.trim().length == 0;
		const lastEntry = this.history.entries[this.history.entries.length - 1];

		if (lastEntry && lastEntry.user) {
			if (!isEmpty) {
				lastEntry.content[lastEntry.index] += `\n${input}`;
				this.syncEntryToDom(lastEntry);
			}
			this.getResponse();
		} else {
			if (!isEmpty) {
				this.addEntry({
					user: true,
					edit: false,
					new: null,
					index: 0,
					content: [input],
				});
				this.getResponse();
			}
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
				entry.new = "";
			}
			entry.new += text;
			this.syncEntryToDom(entry);
			if (isLast) {
				this.snapToBottom();
			}
		});
		this.api.events.on("status", (status: number) => {
			if (status != 200) {
				if (isLast) {
					this.snapToBottom();
				}
			}
		});
		this.api.events.on("done", () => {
			this.finishEntry(entry);
		});
		this.api.events.on("error", (error: string) => {
			entry.new = null;
			this.cleanEntry(entry);
			this.syncEntryToDom(entry);
			this.showPopup(error);
		});
		this.api.events.on("abort", () => {
			this.finishEntry(entry);
		});
		this.api.events.on("close", () => {
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

		const current = this.app.workspace.getActiveFile();
		if (current) {
			this.setCurrentDocument(current);
		}

		this.tokenContainer = background.createDiv({
			cls: "asys__tokens asys__hidden",
		});

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
		this.addPlainPaste(input);

		this.popupContainer = background.createEl("div", {
			cls: "asys__popup asys__fadeOut",
		});
	}

	async onOpen() {
		await this.addChat();
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.setCurrentDocument(file!);
				this.checkCurrentTokens();
			})
		);
		this.registerInterval(
			window.setInterval(() => this.checkCurrentDocument(), 1000)
		);
		this.registerInterval(
			window.setInterval(() => this.checkCurrentTokens(), 5000)
		);
	}

	async onClose() {}
}
