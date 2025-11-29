import { ChatEntry, ChatHistory, ChatSettings, HTTPStatus } from "./common";
import { createParser, EventSourceParser } from "eventsource-parser";
import { EventEmitter } from "node:events";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { request as request_http } from "node:http";
import { ImageAsset, imageAssetToDataUrl } from "./images";

function sanitize(text: string) {
	// escape 2+ byte unicode characters
	// prettier-ignore
	return [...text].map((c) =>	/^[\x00-\x7F]$/.test(c)	? c : c.split("")
					.map((a) =>	"\\u" +	a.charCodeAt(0).toString(16).padStart(4, "0"))
					.join("")).join("");
}

const ERROR_SUFFIX = "Press to dismiss.";

const ANTHROPIC_ENDPOINT: string = "https://api.anthropic.com";
const ANTHROPIC_PATH: string = "/v1/messages";

const OPENAI_ENDPOINT: string = "https://api.openai.com";
const OPENAI_PATH: string = "/v1/chat/completions";

const OPENROUTER_ENDPOINT: string = "https://openrouter.ai/api";
const TOGETHER_ENDPOINT: string = "https://api.together.xyz";

const COHERE_ENDPOINT: string = "https://api.cohere.ai";
const COHERE_PATH: string = "/v1/chat";

const DEEPSEEK_ENDPOINT: string = "https://api.deepseek.com";
const DEEPSEEK_PATH: string = "/chat/completions";

const ANTHROPIC_MODELS: Record<string, string> = {
	"claude-3-opus": "claude-3-opus-20240229",
	"claude-3-sonnet": "claude-3-sonnet-20240229",
	"claude-3-haiku": "claude-3-haiku-20240307",
};

const ANTHROPIC_SETTINGS: Record<string, string> = {
	temperature: "temperature",
	topK: "top_k",
	topP: "top_p",
};

const OPENAI_MODELS: Record<string, string> = {
	"gpt-4": "gpt-4",
	"gpt-4-turbo": "gpt-4-turbo-preview",
	"gpt-4-32k": "gpt-4-32k",
	"gpt-3.5-turbo": "gpt-3.5-turbo",
	"gpt-3.5-turbo-16k": "gpt-3.5-turbo-16k",
};

const OPENAI_SETTINGS: Record<string, string> = {
	temperature: "temperature",
	topK: "top_k",
	topP: "top_p",
	maxTokens: "max_tokens",
	frequencyPenalty: "frequency_penalty",
	reasoning: "reasoning",
};

const COHERE_MODELS: Record<string, string> = {
	"command-r": "command-r",
	"command-r-plus": "command-r-plus",
};

const COHERE_SETTINGS: Record<string, string> = {
	temperature: "temperature",
	topK: "k",
	topP: "p",
	maxTokens: "max_tokens",
	frequencyPenalty: "frequency_penalty",
};

const DEEPSEEK_MODELS: Record<string, string> = {
	"deepseek-r1": "deepseek-reasoner",
	"deepseek-v3": "deepseek-chat",
};

const DEEPSEEK_SETTINGS: Record<string, string> = {
	temperature: "temperature",
	topP: "top_p",
	maxTokens: "max_tokens",
	frequencyPenalty: "frequency_penalty",
};

function formatSentance(text: string) {
	text = text.charAt(0).toUpperCase() + text.slice(1);
	if (text.charAt(text.length - 1) != ".") {
		text += ".";
	}
	return text;
}

function joinEndpoint(base: string, path: string) {
	if (base.charAt(base.length - 1) == path.charAt(0)) {
		base = base.slice(0, -1);
	}
	return base + path;
}

type OpenAIContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image_url"; image_url: { url: string } }
	  >;

async function getMessages(
	history: ChatHistory,
	target: ChatEntry,
	options: { includeImages?: boolean } = {}
) {
	let messages: Array<{ role: string; content: OpenAIContent }> = [];

	let contents = [];

	const resolveSelectedSwipe = (entry: ChatEntry) => {
		const { index, swipes } = entry;
		if (Number.isInteger(index) && index >= 0 && index < swipes.length) {
			return swipes[index];
		}
		if (Number.isInteger(index) && index === swipes.length && entry.new) {
			return entry.new;
		}
		if (swipes.length > 0) {
			entry.index = swipes.length - 1;
			return swipes[entry.index];
		}
		return entry.new;
	};

	for (const [index, document] of history.documents.entries()) {
		if (document.mute) {
			continue;
		}
		const content = await history.app?.vault.read(document.file);
		contents.push(
			`BEGIN DOCUMENT (${document.file.path})\n${content}\nEND DOCUMENT`
		);
	}

	for (const [, entry] of history.entries.entries()) {
		if (target == entry) {
			break;
		}
		const swipe = resolveSelectedSwipe(entry);
		if (!swipe) {
			continue;
		}
		const text = swipe.content;
		const images = swipe.images ?? [];

		let content: OpenAIContent = text;
		if (options.includeImages) {
			const imageUrls = await Promise.all(
				images.map((img: ImageAsset) => imageAssetToDataUrl(img))
			);
			content = [
				{
					type: "text",
					text: text,
				},
				...imageUrls.map((url) => ({
					type: "image_url" as const,
					image_url: { url },
				})),
			];
		}

		messages.push({
			role: entry.user ? "user" : "assistant",
			content: content,
		});
	}

	if (messages.length == 0) {
		messages.push({
			role: "user",
			content: "",
		});
	}

	const text =
		typeof messages[0]!.content === "string"
			? messages[0]!.content
			: messages[0]!.content[0]?.type === "text"
			? messages[0]!.content[0].text
			: "";
	if (contents.length > 0) {
		const prefix = `${contents.join("\n")}\nBEGIN CHAT\n`;
		if (typeof messages[0].content === "string") {
			messages[0].content = `${prefix}${text}`;
		} else if (Array.isArray(messages[0].content)) {
			if (messages[0].content.length == 0) {
				messages[0].content.push({ type: "text", text: "" });
			}
			const first = messages[0].content[0];
			if (first.type === "text") {
				first.text = `${prefix}${text}`;
			}
		}
	} else {
		const prefix =
			"BEGIN DOCUMENTS\nNO SHARED DOCUMENTS\nEND DOCUMENTS\nBEGIN CHAT\n";
		if (typeof messages[0].content === "string") {
			messages[0].content = `${prefix}${text}`;
		} else if (Array.isArray(messages[0].content)) {
			if (messages[0].content.length == 0) {
				messages[0].content.push({ type: "text", text: "" });
			}
			const first = messages[0].content[0];
			if (first.type === "text") {
				first.text = `${prefix}${text}`;
			}
		}
	}

	return messages;
}

function getModel(settings: ChatSettings, mapping: Record<string, string>) {
	let model = settings.apiModel;
	if (model == "custom") {
		model = settings.apiModelCustom;
	}
	if (model in mapping) {
		model = mapping[model];
	}
	return model;
}

function getContent(
	content: Record<string, any>,
	settings: ChatSettings,
	mapping: Record<string, string>
) {
	for (const [key, value] of Object.entries(mapping)) {
		if (key in settings && settings[key] != null) {
			content[value] = settings[key];
		}
	}

	if ("reasoning" in content) {
		var reasoning = settings["reasoning"];
		content["reasoning"] = {
			effort: reasoning,
		};
	}

	return content;
}

export function getAPI(settings: ChatSettings) {
	switch (settings.apiProvider) {
		case "openai":
			return new OpenAIAPI(
				OPENAI_ENDPOINT,
				OPENAI_SETTINGS,
				OPENAI_MODELS
			) as API;
		case "openrouter":
			return new OpenAIAPI(
				OPENROUTER_ENDPOINT,
				OPENAI_SETTINGS,
				{}
			) as API;
		case "togetherai":
			return new OpenAIAPI(TOGETHER_ENDPOINT, OPENAI_SETTINGS, {}) as API;
		case "openai-custom":
			return new OpenAIAPI(
				settings.apiEndpoint,
				OPENAI_SETTINGS,
				{}
			) as API;
		case "anthropic":
			return new AnthropicAPI(
				ANTHROPIC_ENDPOINT,
				ANTHROPIC_SETTINGS,
				ANTHROPIC_MODELS
			) as API;
		case "anthropic-custom":
			return new AnthropicAPI(
				settings.apiEndpoint,
				ANTHROPIC_SETTINGS,
				{}
			) as API;
		case "cohere":
			return new CohereAPI(
				COHERE_ENDPOINT,
				COHERE_SETTINGS,
				COHERE_MODELS
			) as API;
		case "deepseek":
			return new DeepSeekAPI(
				DEEPSEEK_ENDPOINT,
				DEEPSEEK_SETTINGS,
				DEEPSEEK_MODELS
			) as API;
	}
	return null;
}

export class API {
	events: EventEmitter;
	request: ClientRequest;
	endpoint: string;
	settings: Record<string, string>;
	models: Record<string, string>;
	closed: boolean = false;
	constructor(
		endpoint: string,
		settings: Record<string, string>,
		models: Record<string, string>
	) {
		this.endpoint = endpoint;
		this.events = new EventEmitter();
		this.settings = settings;
		this.models = models;
	}
	async getEndpoint() {
		return this.endpoint;
	}
	async getBody(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		return "";
	}
	async getHeaders(settings: ChatSettings) {
		return {} as Record<string, any>;
	}

	async handleChunk(chunk: string, parser: EventSourceParser) {
		try {
			parser.feed(chunk);
		} catch {}
	}

	async send(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		const url = await this.getEndpoint();
		const body = await this.getBody(history, target, settings);
		let headers = await this.getHeaders(settings);

		//headers["charset"] = "UTF-8";
		//headers["content-type"] = "application/json; charset=UTF-8";
		headers["content-type"] = "application/json";
		headers["content-length"] = body.length;

		const parser = createParser((event) => {
			if (event.type != "event") return;

			const response = JSON.parse(event.data);
			const type =
				response.object ?? response.type ?? response.event_type;

			switch (type) {
				case "chat.completion.chunk": // OpenAI
				case "completion.chunk": // TogetherAI
					let chunk = response.choices[0].delta.content;
					if (chunk != undefined) {
						this.events.emit("text", chunk);
					}
					let reasoning = response.choices[0].delta.reasoning;
					if (reasoning != undefined) {
						this.events.emit("reasoning", reasoning);
					}
					const images = response.choices[0].delta.images;
					if (Array.isArray(images)) {
						for (const image of images) {
							const url = image?.image_url?.url;
							if (typeof url === "string" && url.length > 0) {
								this.events.emit("image", url);
							}
						}
					}
					break;
				case "content_block_start": // Anthropic
					if (response.content_block.type === "text") {
						this.events.emit("text", response.content_block.text);
					}
					break;
				case "content_block_delta": // Anthropic
					if (response.delta.type === "text_delta") {
						this.events.emit("text", response.delta.text);
					}
					break;
				case "text-generation": // Cohere
					this.events.emit("text", response.text);
					break;
				default:
					break;
			}
		});

		var request_fn = request;
		if (url.startsWith("http://")) {
			request_fn = request_http;
		}

		this.request = request_fn(
			url,
			{
				method: "POST",
				headers: headers,
			},
			async (response: IncomingMessage) => {
				const status = response.statusCode ?? 0;
				this.events.emit("status", status);
				if (status == 200) {
					response.socket.setTimeout(0);
					response.setEncoding("utf8");
					response.on("data", async (chunk: string) => {
						console.log("DATA", chunk);
						await this.handleChunk(chunk, parser);
					});
					response.on("end", () => {
						this.events.emit("done");
					});
				} else {
					let data = "";
					response.on("data", (chunk: string) => {
						data += chunk;
					});
					response.on("close", () => {
						let title = `HTTP ${status} ${HTTPStatus[status]}`;
						let details = ERROR_SUFFIX;
						try {
							let err = formatSentance(
								JSON.parse(data).error.message
							);
							details = `${err}\n${details}`;
						} catch {}
						this.events.emit("error", `${title}\n${details}`);
					});
				}
			}
		);
		this.request.on("error", (e: Error) => {
			if (this.closed) return;
			this.events.emit(
				"error",
				`Request Failed\n${e.name}: ${formatSentance(
					e.message
				)}\n${ERROR_SUFFIX}`
			);
			this.request.destroy();
			this.closed = true;
		});
		this.request.on("timeout", (e: Error) => {
			if (this.closed) return;
			this.events.emit(
				"error",
				`Request Failed\nTimeout\n${ERROR_SUFFIX}`
			);
			this.request.destroy();
			this.closed = true;
		});
		this.request.on("close", () => {
			this.closed = true;
			this.events.emit("close");
		});

		this.request.setTimeout(20 * 1000);

		this.request.write(Buffer.from(body, "utf8"));
		this.request.end();
	}

	async abort() {
		if (this.request && !this.closed) {
			this.events.emit("abort");
			this.request.destroy();
		}
	}
}

export class AnthropicAPI extends API {
	async getEndpoint() {
		return joinEndpoint(this.endpoint, ANTHROPIC_PATH);
	}
	async getBody(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		const messages = await getMessages(history, target);
		const content = getContent(
			{
				model: getModel(settings, this.models),
				messages: messages,
				stream: true,
				system: settings.systemPrompt,
				max_tokens: settings.maxTokens ?? 1024,
			},
			settings,
			this.settings
		);
		const body = sanitize(JSON.stringify(content));

		return body;
	}

	async getHeaders(settings: ChatSettings) {
		const headers = {
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "messages-2023-12-15",
			"x-api-key": settings.apiKey,
		};

		return headers;
	}
}

export class OpenAIAPI extends API {
	async getEndpoint() {
		return joinEndpoint(this.endpoint, OPENAI_PATH);
	}
	async getBody(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		const messages = await getMessages(history, target, {
			includeImages: true,
		});
		if (settings.systemPrompt.trim().length != 0) {
			messages.unshift({
				role: "system",
				content: settings.systemPrompt,
			});
		}
		const content = getContent(
			{
				model: getModel(settings, this.models),
				messages: messages,
				stream: true,
			},
			settings,
			this.settings
		);
		const body = sanitize(JSON.stringify(content));

		return body;
	}

	async getHeaders(settings: ChatSettings): Promise<Record<string, any>> {
		const headers = {
			accept: "application/json",
			authorization: `Bearer ${settings.apiKey}`,
		};
		return headers;
	}
}

export class CohereAPI extends API {
	currentChunk: string;
	async getEndpoint() {
		return joinEndpoint(this.endpoint, COHERE_PATH);
	}
	async getBody(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		let messages: any[] = await getMessages(history, target);
		let lastMessage = messages.last();
		messages.splice(messages.length - 1, 1);

		const roleMap: Record<string, string> = {
			user: "USER",
			assistant: "CHATBOT",
		};

		messages = messages.map((value) => {
			return { role: roleMap[value.role], message: value.content };
		});

		let request: Record<string, any> = {
			model: getModel(settings, this.models),
			message: lastMessage!.content,
			chat_history: messages,
			stream: true,
		};

		if (settings.systemPrompt.trim().length != 0) {
			request.preamble = settings.systemPrompt;
		}

		const content = getContent(request, settings, this.settings);
		const body = sanitize(JSON.stringify(content));

		return body;
	}

	async getHeaders(settings: ChatSettings): Promise<Record<string, any>> {
		const headers = {
			accept: "application/json",
			authorization: `Bearer ${settings.apiKey}`,
		};

		return headers;
	}

	async handleChunk(chunk: string, parser: EventSourceParser) {
		chunk = (this.currentChunk ?? "") + chunk;
		this.currentChunk = "";

		let chunks: string[] = chunk.split("\n");
		let lastChunk = chunks.pop()!;

		if (lastChunk.length != 0) {
			this.currentChunk = lastChunk;
		}

		for (let chunk of chunks) {
			parser.feed(`event: cohere\ndata:${chunk}\n\n`);
		}
	}
}

export class DeepSeekAPI extends API {
	async getEndpoint() {
		return joinEndpoint(this.endpoint, DEEPSEEK_PATH);
	}
	async getBody(
		history: ChatHistory,
		target: ChatEntry,
		settings: ChatSettings
	) {
		const messages = await getMessages(history, target);
		const content = getContent(
			{
				model: getModel(settings, this.models),
				messages: messages,
				stream: true,
			},
			settings,
			this.settings
		);
		const body = sanitize(JSON.stringify(content));

		return body;
	}

	async getHeaders(settings: ChatSettings): Promise<Record<string, any>> {
		const headers = {
			accept: "application/json",
			authorization: `Bearer ${settings.apiKey}`,
		};
		return headers;
	}
}
