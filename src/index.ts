/**
 * Vercel AI SDK provider for APIMaster and other OpenAI-compatible gateways.
 *
 * Chat, completion, embedding and image models come straight from
 * `@ai-sdk/openai-compatible` — re-implementing them would mean re-fixing the same bugs.
 * What this package adds is the preset base URL, the key lookup, model-id autocomplete,
 * and `generateVideo`, which the AI SDK has no model type for.
 */
import {
	createOpenAICompatible,
	type OpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible';
import { loadApiKey, withoutTrailingSlash } from '@ai-sdk/provider-utils';

export const DEFAULT_BASE_URL = 'https://apimaster.ai/v1';

/** Ids verified against GET /v1/models on 2026-09-22. Any other id is still accepted. */
export type APIMasterChatModelId =
	| 'gpt-5.5'
	| 'gpt-6-astra'
	| 'claude-sonnet-4-6'
	| 'claude-opus-4-8'
	| 'deepseek-v4-pro'
	| 'deepseek-v3.2'
	| 'glm-5.3-flash'
	| 'kimi-k3'
	| 'qwen3.8-max'
	| 'grok-4.7'
	| (string & {});

export type APIMasterImageModelId =
	| 'gpt-image-2'
	| 'doubao-seedream-5-0-pro-260628'
	| 'gemini-3.1-flash-image'
	| 'midjourney-v8.2'
	| 'midjourney-niji-7'
	| (string & {});

export type APIMasterVideoModelId =
	| 'sora-2'
	| 'sora-2-pro'
	| 'seedance-2.5'
	| 'seedance-2.0'
	| 'kling-v3-motion-control'
	| 'kling-v3-omni'
	| 'MiniMax-H3'
	| 'grok-imagine-video-1.5'
	| (string & {});

export interface APIMasterProviderSettings {
	/** Defaults to https://apimaster.ai/v1 — point it at any OpenAI-compatible gateway. */
	baseURL?: string;
	/** Defaults to process.env.APIMASTER_API_KEY. */
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: typeof globalThis.fetch;
}

export interface APIMasterProvider
	extends OpenAICompatibleProvider<APIMasterChatModelId, APIMasterChatModelId, string, APIMasterImageModelId> {
	/**
	 * Generate a video. The AI SDK has no video model type, so this is a plain async
	 * function: it submits the job, polls it, and returns the MP4 URL (and optionally the
	 * bytes).
	 */
	generateVideo(options: GenerateVideoOptions): Promise<GeneratedVideo>;
}

export interface GenerateVideoOptions {
	model?: APIMasterVideoModelId;
	prompt: string;
	/** 4, 8, 12, 16 or 20. Billed per second of output. */
	durationSeconds?: number;
	/** `720p` everywhere; `1024p` and `1080p` need a pro model. */
	resolution?: '720p' | '1024p' | '1080p';
	/**
	 * Always set this when passing a reference image: a portrait reference with no aspect
	 * ratio is treated as 16:9 by the gateway and comes back letterboxed.
	 */
	aspectRatio?: '16:9' | '9:16';
	/** Public URL of an image to animate. */
	referenceImageUrl?: string;
	/** Download the MP4 and return it as bytes. Off by default — files are large. */
	download?: boolean;
	/** Give up after this long. Typical jobs finish in one to three minutes. */
	maxWaitMs?: number;
	abortSignal?: AbortSignal;
}

export interface GeneratedVideo {
	taskId: string;
	model: string;
	/** Needs the API key as a bearer token, and expires. Save what you want to keep. */
	url: string;
	elapsedMs: number;
	bytes?: Uint8Array;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

function explain(status: number, body: string): string {
	const hints: Record<number, string> = {
		400: 'Bad request — check the model id and parameters.',
		401: 'Unauthorized — the key is wrong, expired, or was copied with whitespace.',
		402: 'Insufficient balance.',
		404: 'Not found — the base URL should end with /v1.',
		429: 'Rate limited.',
	};
	return `HTTP ${status}: ${hints[status] ?? 'Request failed.'} ${body.slice(0, 200)}`.trim();
}

export function createAPIMaster(options: APIMasterProviderSettings = {}): APIMasterProvider {
	const baseURL = withoutTrailingSlash(options.baseURL ?? DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;
	const getKey = () =>
		loadApiKey({
			apiKey: options.apiKey,
			environmentVariableName: 'APIMASTER_API_KEY',
			description: 'APIMaster',
		});

	const base = createOpenAICompatible<
		APIMasterChatModelId,
		APIMasterChatModelId,
		string,
		APIMasterImageModelId
	>({
		name: 'apimaster',
		baseURL,
		apiKey: options.apiKey,
		headers: options.headers,
		fetch: options.fetch,
	});

	const doFetch = options.fetch ?? globalThis.fetch;

	const generateVideo = async (opts: GenerateVideoOptions): Promise<GeneratedVideo> => {
		const model = opts.model ?? 'sora-2';
		const started = Date.now();
		const headers = {
			Authorization: `Bearer ${getKey()}`,
			'Content-Type': 'application/json',
			...options.headers,
		};

		const submitResponse = await doFetch(`${baseURL}/videos/generations`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model,
				prompt: opts.prompt,
				duration: opts.durationSeconds ?? 4,
				resolution: opts.resolution ?? '720p',
				aspect_ratio: opts.aspectRatio ?? '16:9',
				...(opts.referenceImageUrl ? { image_urls: [opts.referenceImageUrl] } : {}),
			}),
			signal: opts.abortSignal,
		});
		if (!submitResponse.ok) {
			throw new Error(explain(submitResponse.status, await submitResponse.text()));
		}
		const submitted = (await submitResponse.json()) as {
			data?: Array<{ task_id?: string }>;
			id?: string;
		};
		const taskId = submitted.data?.[0]?.task_id ?? submitted.id;
		if (!taskId) throw new Error(`No task id in response: ${JSON.stringify(submitted)}`);

		const deadline = Date.now() + (opts.maxWaitMs ?? 900_000);
		// The first poll is delayed: the job is never ready sooner.
		await sleep(15_000, opts.abortSignal);

		while (Date.now() < deadline) {
			const statusResponse = await doFetch(`${baseURL}/videos/${encodeURIComponent(taskId)}`, {
				headers,
				signal: opts.abortSignal,
			});
			if (!statusResponse.ok) {
				throw new Error(explain(statusResponse.status, await statusResponse.text()));
			}
			const payload = (await statusResponse.json()) as { status?: string; url?: string };
			if (payload.status === 'completed') {
				const url = payload.url ?? `${baseURL}/videos/${encodeURIComponent(taskId)}/content`;
				const result: GeneratedVideo = {
					taskId,
					model,
					url,
					elapsedMs: Date.now() - started,
				};
				if (opts.download) {
					const media = await doFetch(url, { headers, redirect: 'follow', signal: opts.abortSignal });
					if (!media.ok) throw new Error(explain(media.status, 'download failed'));
					result.bytes = new Uint8Array(await media.arrayBuffer());
				}
				return result;
			}
			if (payload.status && ['failed', 'error', 'cancelled'].includes(payload.status)) {
				throw new Error(`Video job ${payload.status}: ${JSON.stringify(payload)}`);
			}
			await sleep(4_000, opts.abortSignal);
		}
		throw new Error(
			`Video job ${taskId} did not finish in time. It is not lost — poll ${baseURL}/videos/${taskId} yourself.`,
		);
	};

	return Object.assign(base, { generateVideo }) as APIMasterProvider;
}

/** Ready-to-use provider reading APIMASTER_API_KEY from the environment. */
export const apimaster = createAPIMaster();
