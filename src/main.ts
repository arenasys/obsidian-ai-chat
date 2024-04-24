import { Plugin, WorkspaceLeaf } from "obsidian";
import { ChatView, VIEW_TYPE_CHAT } from "./view";
import { ChatSettingProfiles } from "./common";
import { ChatSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class ChatPlugin extends Plugin {
	profiles: ChatSettingProfiles;

	async onload() {
		this.registerView(
			VIEW_TYPE_CHAT,
			(leaf) => new ChatView(leaf, this.profiles)
		);
		await this.activateView();
		await this.loadSettings();
		this.addSettingTab(new ChatSettingTab(this.app, this));
	}

	onunload() {}

	async activateView() {
		const { workspace } = this.app;

		workspace.onLayoutReady(async () => {
			let leaf: WorkspaceLeaf | null = null;
			const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
			if (leaves.length == 0) {
				leaf = workspace.getRightLeaf(false);
				await leaf?.setViewState({
					type: VIEW_TYPE_CHAT,
					active: false,
				});
			}
		});
	}

	async loadSettings() {
		this.profiles = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.profiles);
	}
}
