import { ChatEntry, ChatHistory, ChatSettings, HTTPStatus } from "./common";
import { createParser, EventSourceParser } from "eventsource-parser";
import { EventEmitter } from "node:events";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";

function sanitize(text: string) {
	// escape 2+ byte unicode characters
	// prettier-ignore
	return [...text].map((c) =>	/^[\x00-\x7F]$/.test(c)	? c : c.split("")
					.map((a) =>	"\\u" +	a.charCodeAt(0).toString(16).padStart(4, "0"))
					.join("")).join("");
}

const ERROR_SUFFIX = "Press to dismiss.";
const CHARS_PER_TOKEN = 3.35;

const ANTHROPIC_ENDPOINT: string = "https://api.anthropic.com";
const ANTHROPIC_PATH: string = "/v1/messages";

const OPENAI_ENDPOINT: string = "https://api.openai.com";
const OPENAI_PATH: string = "/v1/chat/completions";

const OPENROUTER_ENDPOINT: string = "https://openrouter.ai/api";
const TOGETHER_ENDPOINT: string = "https://api.together.xyz";

const COHERE_ENDPOINT: string = "https://api.cohere.ai";
const COHERE_PATH: string = "/v1/chat";

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

async function getMessages(history: ChatHistory, target: ChatEntry) {
	let messages: Array<{ role: string; content: string }> = [];

	let contents = [];
	for (const [index, document] of history.documents.entries()) {
		if (document.mute) {
			continue;
		}
		const content = await history.app?.vault.read(document.file);
		contents.push(
			`BEGIN DOCUMENT (${document.file.path})\n${content}\nEND DOCUMENT`
		);
	}

	for (const [index, entry] of history.entries.entries()) {
		if (target == entry) {
			break;
		}
		console.log(entry.content[entry.index]);
		messages.push({
			role: entry.user ? "user" : "assistant",
			content: entry.content[entry.index],
		});
	}

	if (messages.length == 0) {
		messages.push({
			role: "user",
			content: "",
		});
	}

	const text = messages[0]!.content;
	if (contents.length > 0) {
		messages[0].content = `${contents.join("\n")}\nBEGIN CHAT\n${text}`;
	} else {
		messages[0].content = `BEGIN DOCUMENTS\nNO SHARED DOCUMENTS\nEND DOCUMENTS\nBEGIN CHAT\n${text}`;
	}

	return messages;
}

export async function getApproxTokens(
	history: ChatHistory,
	settings: ChatSettings
) {
	const messages = await getMessages(
		history,
		history.entries[history.entries.length - 1]
	);
	let count = settings.systemPrompt.length;
	for (const message of messages) {
		count += message.content.length;
	}
	return Math.floor(count / CHARS_PER_TOKEN);
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
	return content;
}

export function getAPI(settings: ChatSettings) {
	switch (settings.apiProvider) {
		case "openai":
			return new OpenAIAPI(OPENAI_ENDPOINT) as API;
		case "openrouter":
			return new OpenAIAPI(OPENROUTER_ENDPOINT) as API;
		case "togetherai":
			return new OpenAIAPI(TOGETHER_ENDPOINT) as API;
		case "openai-custom":
			return new OpenAIAPI(settings.apiEndpoint) as API;
		case "anthropic":
			return new AnthropicAPI(ANTHROPIC_ENDPOINT) as API;
		case "anthropic-custom":
			return new AnthropicAPI(settings.apiEndpoint) as API;
		case "cohere":
			return new CohereAPI(COHERE_ENDPOINT) as API;
	}
	return null;
}

export class API {
	events: EventEmitter;
	request: ClientRequest;
	endpoint: string;
	constructor(endpoint: string) {
		this.endpoint = endpoint;
		this.events = new EventEmitter();
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

		headers["charset"] = "UTF-8";
		headers["content-type"] = "application/json; charset=UTF-8";
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

		this.request = request(
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
			this.events.emit(
				"error",
				`Request Failed\n${e.name}: ${formatSentance(
					e.message
				)}\n${ERROR_SUFFIX}`
			);
		});
		this.request.on("timeout", (e: Error) => {
			this.events.emit(
				"error",
				`Request Failed\nTimeout\n${ERROR_SUFFIX}`
			);
			this.events.emit("close");
		});
		this.request.on("close", () => {
			this.events.emit("close");
		});

		this.request.setTimeout(10 * 1000);

		this.request.write(Buffer.from(body, "utf8"));
		this.request.end();
	}

	async abort() {
		if (this.request) {
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
				model: getModel(settings, ANTHROPIC_MODELS),
				messages: messages,
				stream: true,
				system: settings.systemPrompt,
				max_tokens: settings.maxTokens ?? 1024,
			},
			settings,
			ANTHROPIC_SETTINGS
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
		const messages = await getMessages(history, target);
		if (settings.systemPrompt.trim().length != 0) {
			messages.unshift({
				role: "system",
				content: settings.systemPrompt,
			});
		}
		const content = getContent(
			{
				model: getModel(settings, OPENAI_MODELS),
				messages: messages,
				stream: true,
			},
			settings,
			OPENAI_SETTINGS
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
			model: getModel(settings, COHERE_MODELS),
			message: lastMessage!.content,
			chat_history: messages,
			stream: true,
		};

		if (settings.systemPrompt.trim().length != 0) {
			request.preamble = settings.systemPrompt;
		}

		const content = getContent(request, settings, COHERE_SETTINGS);
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
