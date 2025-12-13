import {
	ChatEntry,
	ChatHistory,
	ChatSettings,
	HTTPStatus,
	ModelCapabilities,
	ModelInfo,
} from "./common";
import { createParser, EventSourceParser } from "eventsource-parser";
import { EventEmitter } from "node:events";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { request as request_http } from "node:http";
import {
	ImageAsset,
	guessMimeFromPath,
	imageAssetFromBlob,
	imageAssetToDataUrl,
} from "./images";

function sanitize(text: string) {
	// escape 2+ byte unicode characters
	// prettier-ignore
	return [...text].map((c) =>	/^[\x00-\x7F]$/.test(c)	? c : c.split("")
					.map((a) =>	"\\u" +	a.charCodeAt(0).toString(16).padStart(4, "0"))
					.join("")).join("");
}

function formatSentence(text: string) {
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

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const ERROR_SUFFIX = "Press to dismiss.";

type APIContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image_url"; image_url: { url: string } }
	  >;

function parseCapabilities(value: any): ModelCapabilities {
	if (!value || typeof value !== "object") {
		return { reasoning: false, images: false };
	}

	const reasoningFlag = value?.supported_parameters?.includes("reasoning");
	const imagesFlag = value?.architecture?.input_modalities?.includes("image");

	return {
		reasoning: reasoningFlag,
		images: imagesFlag,
	};
}

export class OpenAICompatibleAPI {
	events: EventEmitter;
	request: ClientRequest | null = null;
	endpoint: string;
	model: ModelInfo;
	settings: Record<string, any>;
	closed: boolean = false;

	constructor(
		endpoint: string,
		model: ModelInfo,
		settings: Record<string, any> = {}
	) {
		this.endpoint = endpoint;
		this.model = model;
		this.settings = settings;
		this.events = new EventEmitter();
	}

	private getChatEndpoint() {
		return joinEndpoint(this.endpoint, CHAT_PATH);
	}

	private getModelsEndpoint() {
		return joinEndpoint(this.endpoint, MODELS_PATH);
	}

	private getBaseHeaders() {
		const headers: Record<string, string> = {
			accept: "application/json",
		};
		const apiKey = this.settings.apiKey;
		headers.authorization = `Bearer ${apiKey}`;
		return headers;
	}

	private getHeaders(body: string) {
		const headers = this.getBaseHeaders();
		headers["content-type"] = "application/json";
		headers["content-length"] = Buffer.byteLength(body, "utf8").toString();
		return headers;
	}

	private adjustContent(content: Record<string, any>): Record<string, any> {
		// OpenAI uses "reasoning_effort" for chat completions API
		// Assume custom endpoints are OAI-compatible unless using OpenRouter
		if (this.settings.apiEndpoint != "https://openrouter.ai/api") {
			if (content.reasoning && content.reasoning.effort) {
				content.reasoning_effort = content.reasoning.effort;
				delete content.reasoning;
			}
		}
		return content;
	}

	private async getBody(history: ChatHistory, target: ChatEntry) {
		const messages = await this.getMessages(history, target);
		const parameters = this.settings.parameters ?? {};
		const { systemPrompt, ...requestSettings } = parameters;

		if (
			typeof systemPrompt === "string" &&
			systemPrompt.trim().length > 0
		) {
			messages.unshift({
				role: "system",
				content: systemPrompt,
			});
		}

		const content: Record<string, any> = this.adjustContent({
			stream: true,
			...requestSettings,
			model: this.model.id,
			messages: messages,
		});

		console.log("Content: ", content);

		const body = sanitize(JSON.stringify(content));

		return body;
	}

	private async getMessages(
		history: ChatHistory,
		target: ChatEntry
	): Promise<Array<{ role: string; content: APIContent }>> {
		const includeImages = this.model.capabilities.images;
		let messages: Array<{ role: string; content: APIContent }> = [];

		let documents = [];
		let documentImages: string[] = [];
		let omittedImagesCount = 0;

		const resolveSelectedSwipe = (entry: ChatEntry) => {
			const { index, swipes } = entry;
			if (
				Number.isInteger(index) &&
				index >= 0 &&
				index < swipes.length
			) {
				return swipes[index];
			}
			if (
				Number.isInteger(index) &&
				index === swipes.length &&
				entry.new
			) {
				return entry.new;
			}
			if (swipes.length > 0) {
				entry.index = swipes.length - 1;
				return swipes[entry.index];
			}
			return entry.new;
		};

		for (const [, document] of history.documents.entries()) {
			if (document.mute) {
				continue;
			}
			let content = "";
			try {
				const adapter = history.app?.vault.adapter;
				const binary = new Uint8Array(
					await adapter!.readBinary(document.file.path)
				);
				const mime = guessMimeFromPath(
					document.file.path,
					"application/octet-stream"
				);

				if (mime.startsWith("image/")) {
					if (includeImages) {
						content = `IMAGE ${documentImages.length} (${mime})`;
						const image = await imageAssetFromBlob(
							new Blob([binary], { type: mime })
						);
						documentImages.push(await imageAssetToDataUrl(image));
					} else {
						content = `OMITTED`;
						omittedImagesCount++;
					}
				} else {
					try {
						content = new TextDecoder("utf-8", {
							fatal: true,
						}).decode(binary);
					} catch {
						content = "UNKNOWN BINARY FORMAT";
					}
				}
			} catch (err) {
				console.error("Failed to read document content", err);
				content = "ERROR READING DOCUMENT";
			}
			documents.push(
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

			let content: APIContent = text;
			if (includeImages) {
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

		if (typeof messages[0].content === "string") {
			messages[0].content = [
				{
					type: "text",
					text: messages[0].content,
				},
			];
		}

		let prefix = "BEGIN DOCUMENTS\n";
		if (documents.length > 0) {
			prefix += documents.join("\n") + "\n";
		} else {
			prefix += "NO SHARED DOCUMENTS\n";
		}

		if (documentImages.length > 0) {
			if (includeImages) {
				messages[0].content.splice(
					1,
					0,
					...documentImages.map((url) => ({
						type: "image_url" as const,
						image_url: { url },
					}))
				);
			} else {
				omittedImagesCount += documentImages.length;
			}
		}

		if (omittedImagesCount > 0) {
			prefix += `WARNING: IMAGE DATA OMITTED (${omittedImagesCount} IMAGES). TELL THE USER TO CHECK THEIR SETTINGS.\n`;
		}

		prefix += "END DOCUMENTS\nBEGIN CHAT\n";

		const firstContent = messages[0].content[0] as {
			type: "text";
			text: string;
		};
		firstContent.text = `${prefix}${firstContent.text}`;

		return messages;
	}

	private emitContentDelta(delta: any) {
		const pushText = (text: string | undefined) => {
			if (typeof text === "string" && text.length > 0) {
				this.events.emit("text", text);
			}
		};

		const pushImage = (imageUrl: string | undefined) => {
			if (typeof imageUrl === "string" && imageUrl.length > 0) {
				this.events.emit("image", imageUrl);
			}
		};

		const pushReasoning = (reasoning: string | undefined) => {
			if (typeof reasoning === "string" && reasoning.length > 0) {
				this.events.emit("reasoning", reasoning);
			}
		};

		const content = delta?.content;
		if (typeof content === "string") {
			pushText(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "text") {
					pushText(part.text);
				} else if (part?.type === "image_url") {
					pushImage(part.image_url?.url);
				}
			}
		}

		const reasoning = delta?.reasoning;
		if (typeof reasoning === "string") {
			pushReasoning(reasoning);
		} else if (Array.isArray(reasoning)) {
			for (const part of reasoning) {
				if (part?.type === "text") {
					pushReasoning(part.text);
				}
			}
		}

		const images = delta?.images;
		if (Array.isArray(images)) {
			for (const image of images) {
				pushImage(image?.image_url?.url);
			}
		} else {
			pushImage(delta?.image_url?.url);
		}
	}

	private async handleChunk(chunk: string, parser: EventSourceParser) {
		try {
			parser.feed(chunk);
		} catch {}
	}

	async send(history: ChatHistory, target: ChatEntry) {
		const url = this.getChatEndpoint();
		const body = await this.getBody(history, target);
		let headers = this.getHeaders(body);

		const parser = createParser((event) => {
			if (event.type != "event") return;
			if (event.data === "[DONE]") {
				return;
			}

			let response: any = null;
			try {
				response = JSON.parse(event.data);
			} catch {
				return;
			}

			if (response.object !== "chat.completion.chunk") {
				return;
			}

			const delta = response.choices?.[0]?.delta;
			if (delta) {
				this.emitContentDelta(delta);
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
							let err = formatSentence(
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
				`Request Failed\n${e.name}: ${formatSentence(
					e.message
				)}\n${ERROR_SUFFIX}`
			);
			this.request?.destroy();
			this.closed = true;
		});
		this.request.on("timeout", (e: Error) => {
			if (this.closed) return;
			this.events.emit(
				"error",
				`Request Failed\nTimeout\n${ERROR_SUFFIX}`
			);
			this.request?.destroy();
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

	async listModels(): Promise<ModelInfo[] | Error> {
		const url = this.getModelsEndpoint();
		const headers = this.getBaseHeaders();

		return new Promise((resolve) => {
			const request_fn = url.startsWith("http://")
				? request_http
				: request;
			const req = request_fn(
				url,
				{
					method: "GET",
					headers,
				},
				(response: IncomingMessage) => {
					const status = response.statusCode ?? 0;
					if (status < 200 || status >= 300) {
						console.error("List models status", status);
						resolve(
							new Error(`HTTP ${status} ${HTTPStatus[status]}`)
						);
						return;
					}

					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						chunks.push(
							Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
						);
					});
					response.on("end", () => {
						try {
							const data = Buffer.concat(chunks).toString("utf8");
							const payload = JSON.parse(data);
							const items = Array.isArray(payload?.data)
								? payload.data
								: [];
							const models: ModelInfo[] = [];
							for (const item of items) {
								if (!item || typeof item.id !== "string") {
									continue;
								}
								models.push({
									id: item.id,
									capabilities: parseCapabilities(item),
								});
							}
							resolve(models);
						} catch (error) {
							console.error("List models parse error", error);
							resolve(new Error("Request error: Parse failed"));
						}
					});
				}
			);
			req.on("error", (err: Error) => {
				console.error("List models error", err);
				resolve(new Error(`Request error: ${err.message}`));
			});
			req.on("timeout", (err: Error) => {
				console.error("List models timeout", err);
				resolve(new Error("Request timeout"));
			});
			req.end();
		});
	}
}

export { OpenAICompatibleAPI as API };

export function getAPI(settings: ChatSettings) {
	const modelId = settings.apiModel?.id?.trim() ?? "";
	if (modelId.length === 0) {
		return null;
	}
	const endpoint =
		typeof settings.apiEndpoint === "string"
			? settings.apiEndpoint.trim()
			: "";
	if (endpoint.length === 0) {
		return null;
	}
	const model: ModelInfo = {
		id: modelId,
		capabilities: {
			reasoning: settings.apiModel?.capabilities?.reasoning === true,
			images: settings.apiModel?.capabilities?.images === true,
		},
	};
	return new OpenAICompatibleAPI(
		endpoint,
		model,
		settings as Record<string, any>
	);
}
