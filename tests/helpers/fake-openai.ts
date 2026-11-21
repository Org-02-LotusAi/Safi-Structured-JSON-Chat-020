// TEST-ONLY fake of the OpenAI Responses endpoint. Never imported by production code.
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type FakeBehavior =
  | { kind: 'json'; body: unknown; delayMs?: number; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'refusal' }
  | { kind: 'incomplete' }
  | { kind: 'http'; status: number }
  | { kind: 'hang' }
  | { kind: 'destroy' };

export interface FakeOpenAI {
  baseURL: string;
  /** Request bodies received on POST /v1/responses, in order. */
  requests: Record<string, any>[];
  /** Queue a behavior; each request consumes one (FIFO). */
  script(...b: FakeBehavior[]): void;
  close(): Promise<void>;
}

function responseBody(output: unknown[], opts: { status?: string; incomplete?: boolean; model?: string } = {}) {
  return {
    id: 'resp_fake_1',
    object: 'response',
    created_at: 1,
    status: opts.status ?? 'completed',
    error: null,
    incomplete_details: opts.incomplete ? { reason: 'max_output_tokens' } : null,
    model: opts.model ?? 'fake-model-1',
    output,
    parallel_tool_calls: false,
    tools: [],
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 18,
    },
  };
}

const message = (content: unknown[]) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content });
const outputText = (text: string) => ({ type: 'output_text', text, annotations: [] });

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const queue: FakeBehavior[] = [];
  const requests: Record<string, any>[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404).end('{}');
        return;
      }
      requests.push(JSON.parse(raw));
      const b = queue.shift();
      if (!b) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"fake: no behavior scripted"}}');
        return;
      }
      const send = (status: number, body: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_fake_123' }).end(JSON.stringify(body));
      switch (b.kind) {
        case 'json': {
          const go = () => send(200, responseBody([message([outputText(JSON.stringify(b.body))])], { model: b.model }));
          if (b.delayMs) setTimeout(go, b.delayMs);
          else go();
          break;
        }
        case 'text':
          send(200, responseBody([message([outputText(b.text)])]));
          break;
        case 'refusal':
          send(200, responseBody([message([{ type: 'refusal', refusal: 'I cannot help with that.' }])]));
          break;
        case 'incomplete':
          send(200, responseBody([message([outputText('{"reply":"cut')])], { status: 'incomplete', incomplete: true }));
          break;
        case 'http':
          send(b.status, { error: { message: `fake error ${b.status}`, type: 'fake_error', code: null } });
          break;
        case 'hang':
          break; // never respond
        case 'destroy':
          req.socket.destroy();
          break;
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (...b) => void queue.push(...b),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
