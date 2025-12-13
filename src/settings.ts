import {
	App,
	Notice,
	TextComponent,
	DropdownComponent,
	PluginSettingTab,
	Setting,
	prepareFuzzySearch,
} from "obsidian";
import { API as OpenAICompatibleAPI } from "./api";
import { ChatSettingProfiles, ChatSettings, ModelInfo } from "./common";
import ChatPlugin from "./main";

export const DEFAULT_SETTINGS: ChatSettingProfiles = {
	current: 0,
	names: ["Default"],
	settings: [
		{
			apiEndpoint: "https://api.openai.com",
			apiKey: "",
			apiModel: null,
			imageSaveFolder: "",
			parameters: {
				systemPrompt:
					"You are an assistant in Obsidian, a note-taking program. Shared notes/documents are provided. Dont show the document formatting (BEGIN DOCUMENT etc).",
			},
		},
	],
};

export function cloneDefaultSettings(): ChatSettings {
	const base = DEFAULT_SETTINGS.settings[0];
	return {
		...base,
		apiModel: base.apiModel
			? {
					...base.apiModel,
					capabilities: { ...base.apiModel.capabilities },
			  }
			: null,
		parameters: { ...(base.parameters ?? {}) },
	};
}

export function normalizeProfiles(profiles: ChatSettingProfiles) {
	if (!Array.isArray(profiles.settings) || profiles.settings.length === 0) {
		profiles.settings = [cloneDefaultSettings()];
	}
	if (!Array.isArray(profiles.names) || profiles.names.length === 0) {
		profiles.names = [...DEFAULT_SETTINGS.names];
	}

	const defaults = cloneDefaultSettings();
	const defaultCapabilities = { reasoning: false, images: false };
	const defaultParameters = defaults.parameters ?? {};
	for (let i = 0; i < profiles.settings.length; i++) {
		const incoming = profiles.settings[i] as any;
		if (!incoming || typeof incoming !== "object") {
			profiles.settings[i] = cloneDefaultSettings();
			continue;
		}

		const normalized: ChatSettings = {
			...cloneDefaultSettings(),
			parameters: { ...defaultParameters },
		};

		if (typeof incoming.apiEndpoint === "string") {
			normalized.apiEndpoint = incoming.apiEndpoint;
		}
		if (typeof incoming.apiKey === "string") {
			normalized.apiKey = incoming.apiKey;
		}

		if (typeof incoming.systemPrompt === "string") {
			incoming.parameters = { systemPrompt: incoming.systemPrompt };
		}
		if (
			incoming.parameters != null &&
			typeof incoming.parameters === "object"
		) {
			normalized.parameters = {
				...defaultParameters,
				...incoming.parameters,
			};
		}

		const rawModel = incoming.apiModel;
		if (rawModel == null) {
			normalized.apiModel = null;
		} else {
			let modelId =
				typeof rawModel === "string" ? rawModel : rawModel?.id;
			if (modelId === "custom") {
				const customId =
					typeof incoming.apiModelCustom === "string"
						? incoming.apiModelCustom
						: "";
				modelId = customId;
			}
			if (typeof modelId !== "string") {
				modelId = "";
			}
			const caps = rawModel?.capabilities ?? {};
			normalized.apiModel = {
				id: modelId,
				capabilities: {
					reasoning:
						caps.reasoning === true
							? true
							: caps.reasoning === false
							? false
							: defaultCapabilities.reasoning,
					images:
						caps.images === true
							? true
							: caps.images === false
							? false
							: defaultCapabilities.images,
				},
			};
		}

		if (typeof incoming.imageSaveFolder === "string") {
			normalized.imageSaveFolder = incoming.imageSaveFolder;
		}

		profiles.settings[i] = normalized;
	}

	if (profiles.names.length < profiles.settings.length) {
		const start = profiles.names.length;
		for (let i = start; i < profiles.settings.length; i++) {
			profiles.names.push(`Profile ${i + 1}`);
		}
	}

	if (
		typeof profiles.current !== "number" ||
		profiles.current < 0 ||
		profiles.current >= profiles.settings.length
	) {
		profiles.current = 0;
	}
}
export class ChatSettingTab extends PluginSettingTab {
	plugin: ChatPlugin;
	models: ModelInfo[] = [];
	modelSearch: string = "";

	private filterModels(query: string): ModelInfo[] {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return [...this.models];
		}
		const matcher = prepareFuzzySearch(trimmed);
		return this.models.filter((model) => matcher(model.id));
	}

	private clearModelSearch() {
		this.models = [];
		this.modelSearch = "";
	}

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
		const settings: ChatSettings = cloneDefaultSettings();
		this.plugin.profiles.names.push(name);
		this.plugin.profiles.settings.push(settings);
		this.plugin.profiles.current = this.plugin.profiles.names.length - 1;
		this.clearModelSearch();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		normalizeProfiles(this.plugin.profiles);
		const defaultCapabilities = { reasoning: false, images: false };
		const defaultParameters = {
			...DEFAULT_SETTINGS.settings[0].parameters,
		};
		const endpointPresets: Record<string, string> = {
			openai: "https://api.openai.com",
			openrouter: "https://openrouter.ai/api",
		};

		const currentIndex = this.plugin.profiles.current;
		const currentName = this.plugin.profiles.names[currentIndex];
		const currentSettings = this.plugin.profiles.settings[currentIndex];
		const currentModel = currentSettings.apiModel ?? {
			id: "",
			capabilities: { ...defaultCapabilities },
		};
		const filteredModels = this.filterModels(this.modelSearch);
		const params =
			currentSettings.parameters ??
			(currentSettings.parameters = { ...defaultParameters });
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
					this.clearModelSearch();
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
					this.clearModelSearch();
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
			.setName("Plugin")
			.setClass("asys__setting-heading");

		new Setting(containerEl)
			.setName("Image autosave folder")
			.addText((text) => {
				text.inputEl.addClass("asys__setting-medium");
				text.setPlaceholder("Disabled")
					.setValue(currentSettings.imageSaveFolder ?? "")
					.onChange(async (value) => {
						currentSettings.imageSaveFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setHeading()
			.setName("API")
			.setClass("asys__setting-heading");

		let endpointInput: TextComponent | null = null;
		let modelDropdown: DropdownComponent | null = null;
		const presetKey =
			Object.entries(endpointPresets).find(
				([, url]) => url === currentSettings.apiEndpoint?.trim()
			)?.[0] ?? "custom";
		new Setting(containerEl)
			.setName("API Endpoint")
			.addDropdown((component) => {
				component.addOptions({
					custom: "Custom",
					openai: "OpenAI",
					openrouter: "OpenRouter",
				});
				component.setValue(presetKey);
				component.onChange(async (value) => {
					if (value === "custom") return;
					const preset = endpointPresets[value];
					if (preset && endpointInput) {
						endpointInput.setValue(preset);
						currentSettings.apiEndpoint = preset;
						this.clearModelSearch();
						await this.plugin.saveSettings();
						await this.display();
					}
				});
			})
			.addText((component) => {
				endpointInput = component;
				component.inputEl.addClass("asys__setting-medium");
				component
					.setPlaceholder(DEFAULT_SETTINGS.settings[0].apiEndpoint)
					.setValue(currentSettings.apiEndpoint ?? "")
					.onChange(async (value) => {
						currentSettings.apiEndpoint = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("API Key").addText((text) => {
			text.inputEl.addClass("asys__setting-medium");
			text.setPlaceholder("Enter your key")
				.setValue(currentSettings.apiKey)
				.onChange(async (value) => {
					currentSettings.apiKey = value;
					await this.plugin.saveSettings();
				});
		});

		const modelSelectRow = new Setting(containerEl).setName("API Models");
		modelSelectRow.addButton((button) => {
			button.setButtonText("Fetch");
			button.onClick(async () => {
				const endpoint = currentSettings.apiEndpoint?.trim();
				const apiKey = currentSettings.apiKey?.trim();
				if (!endpoint || !apiKey) {
					new Notice("Enter API endpoint and key to fetch models.");
					return;
				}
				button.setDisabled(true);
				button.setButtonText("Fetching...");
				try {
					const api = new OpenAICompatibleAPI(
						endpoint,
						currentModel,
						{
							apiKey,
						}
					);
					const models = await api.listModels();
					if (models instanceof Error) {
						new Notice(`Failed to fetch models: ${models.message}`);
					} else if (Array.isArray(models)) {
						if (models.length === 0) {
							new Notice("No models returned.");
						} else {
							this.models = models;
							new Notice(`Found ${models.length} models.`);
						}
					}
				} catch (err) {
					console.error("Fetch button", err);
					new Notice(`Failed to fetch models: ${err}`);
				} finally {
					button.setDisabled(false);
					button.setButtonText("Fetch");
					this.display();
				}
			});
		});
		modelSelectRow.addText((component) => {
			component.inputEl.addClass("asys__setting-search");
			component.setPlaceholder("Search models");
			component.setValue(this.modelSearch);
			component.onChange(async (value) => {
				this.modelSearch = value;
				if (modelDropdown) {
					const filtered = this.filterModels(this.modelSearch);
					const options: Record<string, string> = {};
					if (this.modelSearch.length > 0) {
						options["search"] = `Found ${filtered.length} models`;
					}
					for (const model of filtered) {
						options[model.id] = model.id;
					}
					if (this.modelSearch.length === 0) {
						options["custom"] = "Custom";
					}
					modelDropdown.selectEl.empty();
					if (options["search"]) {
						modelDropdown.addOption("search", options["search"]);
					}
					for (const model of filtered) {
						modelDropdown.addOption(model.id, model.id);
					}
					if (options["custom"]) {
						modelDropdown.addOption("custom", "Custom");
					}
					const nextValue =
						currentSettings.apiModel?.id &&
						currentSettings.apiModel.id in options
							? currentSettings.apiModel.id
							: "";
					modelDropdown.setValue(
						this.modelSearch.length > 0
							? "search"
							: nextValue
							? nextValue
							: filtered.length > 0
							? filtered[0].id
							: "custom"
					);
				}
			});
		});
		modelSelectRow.addDropdown((component) => {
			modelDropdown = component;
			component.selectEl.addClass("asys__setting-medium");
			const hasCustom = this.modelSearch.length === 0;
			if (this.modelSearch.length > 0) {
				component.addOption(
					"search",
					`Found ${filteredModels.length} models`
				);
			}
			for (const model of filteredModels) {
				component.addOption(model.id, model.id);
			}
			if (hasCustom) {
				component.addOption("custom", "Custom");
			}
			const currentOption = filteredModels.some(
				(model) => model.id === currentModel.id
			)
				? currentModel.id
				: this.modelSearch.length > 0
				? "search"
				: hasCustom
				? "custom"
				: filteredModels[0]?.id ?? "search";
			component.setValue(currentOption);
			let lastApplied = "";
			const applySelection = async (
				value: string,
				force: boolean = false
			) => {
				if (!force && value === lastApplied) {
					return;
				}
				lastApplied = value;
				if (value === "custom" || value === "search") {
					return;
				}
				await setModelFromSelection(value);
			};
			component.onChange(async (value) => {
				await applySelection(value);
			});
		});

		new Setting(containerEl)
			.setHeading()
			.setName("Model")
			.setClass("asys__setting-heading");

		let modelInput: TextComponent | null = null;
		const setModelFromSelection = async (modelId: string) => {
			const selected = this.models.find((m) => m.id === modelId);
			if (!selected) {
				if (modelInput) {
					modelInput.setValue(modelId ?? "");
				}
				currentSettings.apiModel = modelId
					? {
							id: modelId,
							capabilities: { ...defaultCapabilities },
					  }
					: null;
				await this.plugin.saveSettings();
				this.display();
				return;
			}
			currentSettings.apiModel = {
				id: selected.id,
				capabilities: { ...selected.capabilities },
			};
			if (modelInput) {
				modelInput.setValue(selected.id);
			}
			await this.plugin.saveSettings();
			this.display();
		};

		new Setting(containerEl).setName("Model ID").addText((component) => {
			modelInput = component;
			component.inputEl.addClass("asys__setting-medium");
			component
				.setPlaceholder("gpt-4, claude-2, etc.")
				.setValue(currentModel.id)
				.onChange(async (value) => {
					const trimmed = value.trim();
					this.modelSearch = "";
					if (trimmed.length === 0) {
						currentSettings.apiModel = null;
					} else {
						if (!currentSettings.apiModel) {
							currentSettings.apiModel = {
								id: trimmed,
								capabilities: { ...defaultCapabilities },
							};
						} else {
							currentSettings.apiModel.id = trimmed;
						}
					}
					await this.plugin.saveSettings();
					if (modelDropdown) {
						const allModels = this.modelSearch
							? filteredModels
							: this.models;
						const matched = allModels.some(
							(model) => model.id === trimmed
						);
						const options: Record<string, string> = {};
						for (const model of allModels) {
							options[model.id] = model.id;
						}
						options["custom"] = "Custom";
						modelDropdown.selectEl.empty();
						modelDropdown.addOptions(options);
						modelDropdown.setValue(matched ? trimmed : "custom");
					}
				});
		});

		new Setting(containerEl)
			.setName("Supports Images")
			.addToggle((component) => {
				component
					.setValue(currentModel.capabilities.images)
					.onChange(async (value) => {
						if (!currentSettings.apiModel) return;
						currentSettings.apiModel.capabilities.images = value;
						await this.plugin.saveSettings();
						await this.display();
					});
			});

		new Setting(containerEl)
			.setName("Supports Reasoning")
			.addToggle((component) => {
				component
					.setValue(currentModel.capabilities.reasoning)
					.onChange(async (value) => {
						if (!currentSettings.apiModel) return;
						currentSettings.apiModel.capabilities.reasoning = value;
						if (!value) {
							if (params.reasoning) {
								delete params.reasoning;
							}
						}
						await this.plugin.saveSettings();
						await this.display();
					});
			});

		new Setting(containerEl)
			.setHeading()
			.setName("Parameters")
			.setClass("asys__setting-heading");

		new Setting(containerEl)
			.setName("System prompt")
			.addTextArea((text) => {
				text.setValue(params.systemPrompt ?? "");
				text.onChange(async (value) => {
					params.systemPrompt = value;
					await this.plugin.saveSettings();
				});
				text.inputEl.addClass("asys__setting-prompt");
				text.setPlaceholder("Default");
			});

		if (currentModel.capabilities.reasoning) {
			const reasoningOptions: Record<string, string> = {
				default: "Default",
				minimal: "Minimal",
				low: "Low",
				medium: "Medium",
				high: "High",
			};
			const reasoningValue =
				(params.reasoning?.effort as string) ?? "default";
			new Setting(containerEl)
				.setName("Reasoning effort")
				.addDropdown((component) => {
					component.selectEl.addClass("asys__setting-medium");
					component.addOptions(reasoningOptions);
					component.setValue(
						reasoningOptions[reasoningValue]
							? reasoningValue
							: "default"
					);
					component.onChange(async (value) => {
						if (value === "default") {
							delete params.reasoning;
						} else {
							params.reasoning = { effort: value };
						}
						await this.plugin.saveSettings();
					});
				});
		}
	}
}
