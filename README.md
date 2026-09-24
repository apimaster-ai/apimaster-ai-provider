# @apimaster/ai-sdk-provider

[Vercel AI SDK](https://sdk.vercel.ai/) provider for [APIMaster](https://apimaster.ai/docs)
and any other OpenAI-compatible gateway — plus `generateVideo`, which the AI SDK has no
model type for.

```bash
npm i @apimaster/ai-sdk-provider ai
```

```ts
import { apimaster } from '@apimaster/ai-sdk-provider';
import { generateText } from 'ai';

const { text } = await generateText({
  model: apimaster('gpt-5.5'),
  prompt: 'Why does time to first token matter?',
});
```

Set `APIMASTER_API_KEY` in the environment, or pass a key explicitly:

```ts
import { createAPIMaster } from '@apimaster/ai-sdk-provider';

const apimaster = createAPIMaster({
  apiKey: process.env.MY_KEY,
  baseURL: 'https://apimaster.ai/v1',   // any OpenAI-compatible gateway
});
```

## What you get

| Call | Backed by |
| --- | --- |
| `apimaster(id)` / `apimaster.chatModel(id)` | `@ai-sdk/openai-compatible` chat model |
| `apimaster.completionModel(id)` | completion model |
| `apimaster.textEmbeddingModel(id)` | embedding model |
| `apimaster.imageModel(id)` | image model (`generateImage` from `ai`) |
| `apimaster.generateVideo({...})` | submit + poll + MP4 URL |

Chat, completion, embedding and image models come straight from
`@ai-sdk/openai-compatible`. This package deliberately does not reimplement them — it adds
the preset base URL, the key lookup, model-id autocomplete, and video.

## Streaming, tools, structured output

Everything the AI SDK does works unchanged:

```ts
import { streamText, generateObject } from 'ai';
import { z } from 'zod';

const stream = streamText({ model: apimaster('claude-sonnet-4-6'), prompt: 'Count to ten' });
for await (const chunk of stream.textStream) process.stdout.write(chunk);

const { object } = await generateObject({
  model: apimaster('gpt-5.5'),
  schema: z.object({ name: z.string(), age: z.number() }),
  prompt: 'Invent a character',
});
```

### One setting worth getting right

Most models on this gateway are reasoning models: they spend part of the token budget on
hidden reasoning before emitting visible text. A tight `maxOutputTokens` returns an empty
string, not a short answer. Measured on one model, a 64-token budget was consumed 59
tokens by reasoning; at 256 it answered correctly. If output is empty, raise the budget
before assuming the model is broken.

## Images

```ts
import { experimental_generateImage as generateImage } from 'ai';

const { image } = await generateImage({
  model: apimaster.imageModel('gpt-image-2'),
  prompt: 'a corgi astronaut on the moon',
  size: '1792x1024',
});
```

Image generation is slow — a 1K render measured 160 s, and 4K can take ten minutes. Give
the request a generous timeout.

## Video

```ts
const video = await apimaster.generateVideo({
  model: 'sora-2',
  prompt: 'a waterfall forming a rainbow, cinematic',
  durationSeconds: 4,
  aspectRatio: '16:9',
});

console.log(video.url, video.elapsedMs);
```

Image-to-video:

```ts
const video = await apimaster.generateVideo({
  prompt: 'slow push-in, hair moving in the breeze',
  referenceImageUrl: 'https://example.com/face.jpg',
  aspectRatio: '9:16',      // always explicit: a portrait reference with no aspect
  download: true,           // ratio is treated as 16:9 and comes back letterboxed
});

await fs.writeFile('clip.mp4', video.bytes!);
```

The returned URL needs the API key as a bearer token and expires, so `download: true` is
the safer option when you intend to keep the file.

If the job outlives `maxWaitMs`, the error includes the task id — the job is not lost and
you can keep polling `GET /v1/videos/{id}` yourself.

## Model ids

The ids in the types are the ones verified on the default gateway; any other string is
accepted, so a model added after this release still works. List what an endpoint serves:

```bash
curl -s https://apimaster.ai/v1/models \
  -H "Authorization: Bearer $APIMASTER_API_KEY" | jq -r '.data[].id'
```

## Development

```bash
npm install
npm run typecheck
npm run build && npm test
```

Tests inject a stub `fetch`, so they need no key, no network and spend nothing.

## License

MIT
