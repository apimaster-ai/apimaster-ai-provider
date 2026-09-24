/**
 * Tests run against dist/ with an injected fetch — no key, no network, no tokens.
 *
 *   npm run build && npm test
 */
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

import { createAPIMaster, DEFAULT_BASE_URL } from '../dist/index.js';

/** Builds a fetch stub that walks a scripted sequence of responses. */
function stubFetch(script) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
		const step = script.shift();
		if (!step) throw new Error(`unexpected extra request to ${url}`);
		return {
			ok: step.status === undefined || step.status < 400,
			status: step.status ?? 200,
			json: async () => step.json,
			text: async () => step.text ?? JSON.stringify(step.json ?? {}),
			arrayBuffer: async () => step.bytes ?? new ArrayBuffer(0),
		};
	};
	return { fetchImpl, calls };
}

// The provider sleeps 15s before the first poll and 4s between polls. Tests replace the
// clock rather than waiting.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
	globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
});

describe('provider surface', () => {
	test('exposes the AI SDK model factories', () => {
		const provider = createAPIMaster({ apiKey: 'sk-test' });
		for (const factory of ['chatModel', 'completionModel', 'textEmbeddingModel', 'imageModel']) {
			assert.equal(typeof provider[factory], 'function', `missing ${factory}`);
		}
		assert.equal(typeof provider.generateVideo, 'function');
	});

	test('is callable as a function for the default model type', () => {
		const provider = createAPIMaster({ apiKey: 'sk-test' });
		const model = provider('gpt-5.5');
		assert.equal(model.modelId, 'gpt-5.5');
		assert.equal(model.provider, 'apimaster.chat');
	});

	test('the default base URL keeps the /v1 suffix', () => {
		assert.match(DEFAULT_BASE_URL, /\/v1$/);
	});

	test('a custom base URL is honoured and trailing slashes are dropped', async () => {
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't1' }] } },
			{ json: { status: 'completed', url: 'https://gw.test/v1/videos/t1/content' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', baseURL: 'https://gw.test/v1/', fetch: fetchImpl });
		await provider.generateVideo({ prompt: 'a cat' });
		assert.equal(calls[0].url, 'https://gw.test/v1/videos/generations');
	});
});

describe('generateVideo', () => {
	test('submits, polls until completed, and returns the content URL', async () => {
		const { fetchImpl, calls } = stubFetch([
			{ json: { code: 200, data: [{ status: 'submitted', task_id: 'task_abc' }] } },
			{ json: { status: 'queued' } },
			{ json: { status: 'in_progress' } },
			{ json: { status: 'completed', url: 'https://apimaster.ai/v1/videos/task_abc/content' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });

		const video = await provider.generateVideo({ prompt: 'a waterfall', durationSeconds: 8 });

		assert.equal(video.taskId, 'task_abc');
		assert.equal(video.model, 'sora-2');
		assert.match(video.url, /\/videos\/task_abc\/content$/);
		assert.ok(video.elapsedMs >= 0);
		assert.equal(calls.length, 4, 'one submit plus three polls');
		assert.equal(calls[0].body.duration, 8);
	});

	test('defaults the aspect ratio explicitly, because the gateway assumes 16:9', async () => {
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'completed', url: 'u' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await provider.generateVideo({ prompt: 'x', referenceImageUrl: 'https://e/p.jpg' });
		assert.equal(calls[0].body.aspect_ratio, '16:9');
		assert.deepEqual(calls[0].body.image_urls, ['https://e/p.jpg']);
	});

	test('a portrait aspect ratio is passed through', async () => {
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'completed', url: 'u' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await provider.generateVideo({ prompt: 'x', aspectRatio: '9:16' });
		assert.equal(calls[0].body.aspect_ratio, '9:16');
	});

	test('accepts the OpenAI-shaped submit response too', async () => {
		const { fetchImpl } = stubFetch([
			{ json: { id: 'task_openai', object: 'video', status: 'queued' } },
			{ json: { status: 'completed' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		const video = await provider.generateVideo({ prompt: 'x' });
		assert.equal(video.taskId, 'task_openai');
		assert.match(video.url, /\/videos\/task_openai\/content$/);
	});

	test('a failed job throws with the payload', async () => {
		const { fetchImpl } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'failed', error: 'moderation' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await assert.rejects(provider.generateVideo({ prompt: 'x' }), /failed/);
	});

	test('a 401 is explained, not surfaced as a bare status code', async () => {
		const { fetchImpl } = stubFetch([{ status: 401, text: '{"error":{"message":"bad key"}}' }]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await assert.rejects(provider.generateVideo({ prompt: 'x' }), /copied with whitespace/);
	});

	test('a 404 points at the base URL, the usual cause', async () => {
		const { fetchImpl } = stubFetch([{ status: 404, text: 'not found' }]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await assert.rejects(provider.generateVideo({ prompt: 'x' }), /should end with \/v1/);
	});

	test('downloads bytes only when asked', async () => {
		const payload = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'completed', url: 'https://apimaster.ai/v1/videos/t/content' } },
			{ bytes: payload },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		const video = await provider.generateVideo({ prompt: 'x', download: true });
		assert.equal(video.bytes?.length, 8);
		assert.equal(calls.length, 3);
	});

	test('a missing task id fails loudly instead of polling forever', async () => {
		const { fetchImpl } = stubFetch([{ json: { code: 200, data: [] } }]);
		const provider = createAPIMaster({ apiKey: 'sk-test', fetch: fetchImpl });
		await assert.rejects(provider.generateVideo({ prompt: 'x' }), /No task id/);
	});

	test('the bearer token is sent on every call', async () => {
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'completed', url: 'u' } },
		]);
		const provider = createAPIMaster({ apiKey: 'sk-secret', fetch: fetchImpl });
		await provider.generateVideo({ prompt: 'x' });
		for (const call of calls) {
			assert.equal(call.headers.Authorization, 'Bearer sk-secret');
		}
	});
});

describe('credentials', () => {
	test('a missing key is reported before any request goes out', async () => {
		const previous = process.env.APIMASTER_API_KEY;
		delete process.env.APIMASTER_API_KEY;
		try {
			const provider = createAPIMaster({ fetch: async () => assert.fail('must not call fetch') });
			await assert.rejects(provider.generateVideo({ prompt: 'x' }), /APIMaster/);
		} finally {
			if (previous !== undefined) process.env.APIMASTER_API_KEY = previous;
		}
	});

	test('the environment variable is used when no key is passed', async () => {
		process.env.APIMASTER_API_KEY = 'sk-from-env';
		const { fetchImpl, calls } = stubFetch([
			{ json: { data: [{ task_id: 't' }] } },
			{ json: { status: 'completed', url: 'u' } },
		]);
		const provider = createAPIMaster({ fetch: fetchImpl });
		await provider.generateVideo({ prompt: 'x' });
		assert.equal(calls[0].headers.Authorization, 'Bearer sk-from-env');
		delete process.env.APIMASTER_API_KEY;
	});
});
