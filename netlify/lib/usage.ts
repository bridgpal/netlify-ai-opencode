export type Usage = { input: number; output: number };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Best-effort token usage from any provider payload:
 * Anthropic `usage.input_tokens/output_tokens` (message_start / message_delta in streams),
 * OpenAI chat `usage.prompt_tokens/completion_tokens`, OpenAI Responses `usage.input_tokens/output_tokens`
 * (nested under `response` in stream events), Gemini `usageMetadata.promptTokenCount/candidatesTokenCount`.
 */
export function usageFrom(obj: unknown): Usage | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const candidates = [o.usage, (o.message as Record<string, unknown> | undefined)?.usage, (o.response as Record<string, unknown> | undefined)?.usage, o.usageMetadata];
  for (const u of candidates) {
    if (!u || typeof u !== "object") continue;
    const r = u as Record<string, unknown>;
    const input = num(r.input_tokens) || num(r.prompt_tokens) || num(r.promptTokenCount);
    const output = num(r.output_tokens) || num(r.completion_tokens) || num(r.candidatesTokenCount);
    if (input || output) return { input, output };
  }
  return undefined;
}

export const merge = (a: Usage, b: Usage | undefined): Usage =>
  b ? { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output) } : a;

/**
 * Wraps a response body so it streams through untouched while we watch for usage
 * fields. `onDone` fires after the last byte has been forwarded. Only lines that
 * mention usage are parsed, which keeps CPU time negligible on long streams.
 */
export function tapUsage(body: ReadableStream<Uint8Array>, isEventStream: boolean, onDone: (usage: Usage | undefined) => Promise<void>) {
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Usage = { input: 0, output: 0 };
  let sawUsage = false;
  const MAX_JSON = 4 * 1024 * 1024;

  const consider = (text: string) => {
    if (!text.includes("usage")) return;
    const json = text.startsWith("data:") ? text.slice(5).trim() : text.trim();
    if (!json.startsWith("{")) return;
    try {
      const found = usageFrom(JSON.parse(json));
      if (found) {
        usage = merge(usage, found);
        sawUsage = true;
      }
    } catch {
      /* partial or non-JSON line */
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (isEventStream) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) consider(line);
        } else if (pending.length < MAX_JSON) {
          pending += decoder.decode(chunk, { stream: true });
        }
      },
      async flush() {
        pending += decoder.decode();
        if (isEventStream) {
          if (pending) consider(pending);
        } else {
          consider(pending);
        }
        await onDone(sawUsage ? usage : undefined);
      },
    }),
  );
}
