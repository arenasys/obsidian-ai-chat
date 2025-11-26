import { App, TFile } from "obsidian";
import * as fs from "node:fs";

export const PLUGIN_ID: string = "arenasys-ai-chat";

export interface ChatSwipe {
	content: string;
	images: ImageAsset[];
	thoughts: string | null;
}

// Holds an image blob plus metadata for rendering or serialization.
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

function guessMimeFromPath(filePath: string, fallback: string = "application/octet-stream") {
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

export async function imageAssetFromFile(
	filePath: string,
	mime: string | null = null
): Promise<ImageAsset> {
	const data = await fs.promises.readFile(filePath);
	const type = mime ?? guessMimeFromPath(filePath);
	const blob = new Blob([data], { type });
	const url = URL.createObjectURL(blob);
	return { blob, mime: type, url };
}

export async function writeImageAssetToFile(
	image: ImageAsset,
	filePath: string
) {
	const buffer = Buffer.from(await image.blob.arrayBuffer());
	await fs.promises.writeFile(filePath, buffer);
}
export interface ChatEntry {
	user: boolean;
	index: number;
	swipes: ChatSwipe[];
	new: ChatSwipe | null;

	edit: boolean;
	reasoning: boolean;
	started: boolean;

	element?: Element;
}
export interface ChatDocument {
	file: TFile;
	element?: Element;
	pin: boolean;
	mute: boolean;
}
export interface ChatHistory {
	entries: ChatEntry[];
	documents: ChatDocument[];
	element?: Element;
	app?: App;
}

export interface ChatSettingProfiles {
	current: number;
	names: string[];
	settings: ChatSettings[];
}
export interface ChatSettings {
	apiProvider: string;
	apiModel: string;
	apiModelCustom: string;
	apiKey: string;
	apiEndpoint: string;

	systemPrompt: string;
	reasoning: "low" | "medium" | "high" | null;
	maxTokens: number | null;
	temperature: number | null;
	topK: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	imageSaveFolder: string;
	[index: string]: number | string | null;
}

export const HTTPStatus: Record<string, string> = {
	"0": "Unknown",
	"200": "OK",
	"201": "Created",
	"202": "Accepted",
	"203": "Non-Authoritative Information",
	"204": "No Content",
	"205": "Reset Content",
	"206": "Partial Content",
	"300": "Multiple Choices",
	"301": "Moved Permanently",
	"302": "Found",
	"303": "See Other",
	"304": "Not Modified",
	"305": "Use Proxy",
	"306": "Unused",
	"307": "Temporary Redirect",
	"400": "Bad Request",
	"401": "Unauthorized",
	"402": "Payment Required",
	"403": "Forbidden",
	"404": "Not Found",
	"405": "Method Not Allowed",
	"406": "Not Acceptable",
	"407": "Proxy Authentication Required",
	"408": "Request Timeout",
	"409": "Conflict",
	"410": "Gone",
	"411": "Length Required",
	"412": "Precondition Required",
	"413": "Request Entry Too Large",
	"414": "Request-URI Too Long",
	"415": "Unsupported Media Type",
	"416": "Requested Range Not Satisfiable",
	"417": "Expectation Failed",
	"418": "I'm a teapot",
	"429": "Too Many Requests",
	"500": "Internal Server Error",
	"501": "Not Implemented",
	"502": "Bad Gateway",
	"503": "Service Unavailable",
	"504": "Gateway Timeout",
	"505": "HTTP Version Not Supported",
};
