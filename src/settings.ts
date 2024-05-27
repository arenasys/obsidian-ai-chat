import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import { ChatSettingProfiles, ChatSettings } from "./common";
import ChatPlugin from "./main";

export const DEFAULT_SETTINGS: ChatSettingProfiles = {
	current: 0,
	names: ["Default"],
	settings: [
		{
			apiProvider: "openai",
			apiModel: "gpt-4",
			apiModelCustom: "",
			apiKey: "",
			apiEndpoint: "",
			systemPrompt:
				"You are an assistant in Obsidian, a note-taking program. Shared notes/documents are provided. Dont show the document formatting (BEGIN DOCUMENT etc).",
			maxTokens: null,
			temperature: null,
			topK: null,
			topP: null,
			frequencyPenalty: null,
		},
	],
};
const PROVIDERS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	cohere: "Cohere",
	openrouter: "OpenRouter",
	togetherai: "TogetherAI",
	"openai-custom": "OpenAI compatible",
	"anthropic-custom": "Anthropic compatible",
};
const PROVIDER_MODELS: Record<string, Record<string, string>> = {
	anthropic: {
		"claude-3-opus": "Claude 3 Opus",
		"claude-3-sonnet": "Claude 3 Sonnet",
		"claude-3-haiku": "Claude 3 Haiku",
	},
	openai: {
		"gpt-4": "GPT-4",
		"gpt-4-turbo": "GPT-4 Turbo",
		"gpt-3.5-turbo": "GPT-3.5 Turbo",
	},
	cohere: {
		"command-r": "Command R",
		"command-r-plus": "Command R+",
	},
	openrouter: {},
	togetherai: {},
	"openai-custom": {},
	"anthropic-custom": {},
};

export class ChatSettingTab extends PluginSettingTab {
	plugin: ChatPlugin;

	constructor(app: App, plugin: ChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	isNameAvailable(name: string) {
		return name.length > 0 && !this.plugin.profiles.names.includes(name);
	}

	addSetting(name: string = "") {
		if (name.length == 0) {
			name = DEFAULT_SETTINGS.names[0];
		}
		const settings: ChatSettings = {
			...DEFAULT_SETTINGS.settings[0],
		};
		this.plugin.profiles.names.push(name);
		this.plugin.profiles.settings.push(settings);
		this.plugin.profiles.current = this.plugin.profiles.names.length - 1;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const currentIndex = this.plugin.profiles.current;
		const currentName = this.plugin.profiles.names[currentIndex];
		const currentSettings = this.plugin.profiles.settings[currentIndex];
		const profileNames = this.plugin.profiles.names.reduce(
			(a, v) => ({ ...a, [v]: v }),
			{}
		);

		new Setting(containerEl)
			.setHeading()
			.setName("Profile")
			.setClass("asys__setting-heading");

		new Setting(containerEl)
			.setName("Current profile")
			.addDropdown(async (component) => {
				component.selectEl.addClass("asys__setting-medium");
				component.addOptions(profileNames);
				component.setValue(currentName);
				component.onChange(async (value) => {
					const idx = this.plugin.profiles.names.indexOf(value);
					this.plugin.profiles.current = idx;
					await this.plugin.saveSettings();
					await this.display();
				});
			});

		let renameName = "";
		new Setting(containerEl)
			.setName("Edit profile")
			.addButton((component) => {
				component.buttonEl.addClass("asys__setting-small");
				component.setButtonText("Delete");
				component.onClick(async () => {
					this.plugin.profiles.names.splice(currentIndex, 1);
					this.plugin.profiles.settings.splice(currentIndex, 1);
					this.plugin.profiles.current = Math.max(
						currentIndex - 1,
						0
					);
					if (this.plugin.profiles.names.length == 0) {
						this.addSetting();
					}
					await this.plugin.saveSettings();
					await this.display();
				});
			})
			.addText((component) => {
				component.inputEl.addClass("asys__setting-name");
				component.setPlaceholder("Name");
				component.onChange((value) => {
					renameName = value;
				});
			})
			.addButton((component) => {
				component.buttonEl.addClass("asys__setting-small");
				component.setButtonText("Rename");
				component.onClick(async () => {
					if (this.isNameAvailable(renameName)) {
						this.plugin.profiles.names[currentIndex] = renameName;
						await this.plugin.saveSettings();
						await this.display();
					}
				});
			});

		let newName = "";
		new Setting(containerEl)
			.setName("New profile")
			.addText((component) => {
				component.inputEl.addClass("asys__setting-name");
				component.setPlaceholder("Name");
				component.onChange((value) => {
					newName = value;
				});
			})
			.addButton((component) => {
				component.buttonEl.addClass("asys__setting-small");
				component.setButtonText("New");
				component.onClick(async () => {
					if (this.isNameAvailable(newName)) {
						this.addSetting(newName);
						await this.plugin.saveSettings();
						await this.display();
					}
				});
			});

		new Setting(containerEl)
			.setHeading()
			.setName("Configure")
			.setClass("asys__setting-heading");

		new Setting(containerEl)
			.setName("API provider")
			.addDropdown((component) => {
				component.selectEl.addClass("asys__setting-medium");
				component
					.addOptions(PROVIDERS)
					.setValue(currentSettings.apiProvider)
					.onChange(async (value) => {
						currentSettings.apiProvider = value;
						currentSettings.apiModel = "custom";
						for (var value in PROVIDER_MODELS[value]) {
							currentSettings.apiModel = value;
							break;
						}
						await this.plugin.saveSettings();
						await this.display();
					});
			});

		let provider = currentSettings.apiProvider;
		if (provider.endsWith("custom")) {
			new Setting(containerEl)
				.setName("API endpoint")
				.setDesc(
					provider == "openai-custom"
						? "Any OpenAI compatible endpoint."
						: "Any Anthropic compatible endpoint."
				)
				.addText((component) => {
					component.inputEl.addClass("asys__setting-medium");
					component
						.setPlaceholder("Enter a url")
						.setValue(currentSettings.apiEndpoint)
						.onChange(async (value) => {
							currentSettings.apiEndpoint = value;
							await this.plugin.saveSettings();
						});
				});
		}

		let current: string = currentSettings.apiModel;
		let available: Record<string, string> = {
			...PROVIDER_MODELS[currentSettings.apiProvider],
			custom: "Custom",
		};
		if (!(current in available)) {
			for (var value in available) {
				current = value;
				break;
			}
			currentSettings.apiModel = current;
			this.plugin.saveSettings();
		}

		const modelSetting = new Setting(containerEl)
			.setName("API model")
			.addDropdown((component) => {
				if (current != "custom") {
					component.selectEl.addClass("asys__setting-medium");
				}
				component
					.addOptions(available)
					.setValue(current)
					.onChange(async (value) => {
						currentSettings.apiModel = value;
						await this.plugin.saveSettings();
						await this.display();
					});
			});

		if (currentSettings.apiModel.endsWith("custom")) {
			modelSetting.addText((text) => {
				text.inputEl.addClass("asys__setting-medium");
				text.setPlaceholder("Enter a model name")
					.setValue(currentSettings.apiModelCustom)
					.onChange(async (value) => {
						currentSettings.apiModelCustom = value;
						await this.plugin.saveSettings();
					});
			});
		}

		new Setting(containerEl).setName("API key").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Enter your key")
				.setValue(currentSettings.apiKey)
				.onChange(async (value) => {
					currentSettings.apiKey = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
			.setName("System prompt")
			.addTextArea((text) => {
				text.setValue(currentSettings.systemPrompt);
				text.onChange(async (value) => {
					currentSettings.systemPrompt = value;
					await this.plugin.saveSettings();
				});
				text.inputEl.addClass("asys__setting-prompt");
				text.setPlaceholder("Default");
			});

		new Setting(containerEl).setName("Max tokens").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Default")
				.setValue(currentSettings.maxTokens?.toFixed(0) ?? "")
				.onChange(async (value) => {
					currentSettings.maxTokens = Number.parseInt(value);
					if (!Number.isFinite(currentSettings.maxTokens)) {
						currentSettings.maxTokens = null;
					}
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl).setName("Temperature").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Default")
				.setValue(currentSettings.temperature?.toFixed(2) ?? "")
				.onChange(async (value) => {
					currentSettings.temperature = Number.parseFloat(value);
					if (!Number.isFinite(currentSettings.temperature)) {
						currentSettings.temperature = null;
					}
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl).setName("Top K").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Default")
				.setValue(currentSettings.topK?.toFixed(2) ?? "")
				.onChange(async (value) => {
					currentSettings.topK = Number.parseFloat(value);
					if (!Number.isFinite(currentSettings.topK)) {
						currentSettings.topK = null;
					}
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl).setName("Top P").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Default")
				.setValue(currentSettings.topP?.toFixed(2) ?? "")
				.onChange(async (value) => {
					currentSettings.topP = Number.parseFloat(value);
					if (!Number.isFinite(currentSettings.topP)) {
						currentSettings.topP = null;
					}
					await this.plugin.saveSettings();
				});
		});

		if (currentSettings.apiProvider != "anthropic") {
			new Setting(containerEl)
				.setName("Frequency penalty")
				.addText((text) => {
					text.inputEl.addClass("asys__setting-medium");
					text.setPlaceholder("Default")
						.setValue(
							currentSettings.frequencyPenalty?.toFixed(2) ?? ""
						)
						.onChange(async (value) => {
							currentSettings.frequencyPenalty =
								Number.parseFloat(value);
							if (
								!Number.isFinite(
									currentSettings.frequencyPenalty
								)
							) {
								currentSettings.frequencyPenalty = null;
							}
							await this.plugin.saveSettings();
						});
				});
		}
	}
}
