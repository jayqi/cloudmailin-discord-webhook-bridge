export interface Env {
  CLOUDMAILIN_BASIC_AUTH: string;
  DISCORD_WEBHOOK_URL: string;
}

// Note: Cloudflare Workers observability captures request payloads if enabled.
// Disable it in wrangler.jsonc if logging webhook data to Cloudflare is not desired.

/** Constant-time compare for same-length strings */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function parseBasicAuth(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function verifyBasicAuth(header: string | null, expectedUserPass: string): boolean {
  const provided = parseBasicAuth(header);
  if (!provided) return false;
  const expected = btoa(expectedUserPass);
  return timingSafeEqual(provided, expected);
}

function normalizeRecipients(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function splitOnWordBoundary(text: string, maxLength: number): [string, string] {
  if (text.length <= maxLength) return [text, ""];

  let splitAt = maxLength;
  for (let i = maxLength; i >= 0; i--) {
    const ch = text[i];
    if (ch === " " || ch === "\n" || ch === "\t") {
      splitAt = i;
      break;
    }
  }

  const head = text.slice(0, splitAt).trimEnd();
  const tail = text.slice(splitAt).trimStart();
  if (head.length === 0) {
    return [text.slice(0, maxLength), text.slice(maxLength)];
  }

  return [head, tail];
}

function splitPlainIntoChunks(plain: string, firstLimit: number, nextLimit: number): string[] {
  const chunks: string[] = [];
  let remaining = plain;
  let limit = firstLimit;

  while (remaining.length > 0) {
    const [chunk, tail] = splitOnWordBoundary(remaining, limit);
    chunks.push(chunk);
    remaining = tail;
    limit = nextLimit;
  }

  return chunks;
}

function summarizeToDiscordContents(payload: any): string[] {
  const headers = payload?.headers ?? {};
  const envelope = payload?.envelope ?? {};

  const from = headers?.from ?? envelope?.from ?? "";
  const to = headers?.to ?? normalizeRecipients(envelope?.recipients ?? envelope?.to);
  const subject = headers?.subject ?? "";
  const messageId = headers?.message_id ?? headers?.messageId ?? "";
  const date = headers?.date ?? "";

  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const attachmentNames = attachments
    .map((attachment: any) => attachment?.file_name)
    .filter((name: string | undefined) => name && name.trim().length > 0);

  const lines = [];

  if (from) lines.push(`From: \`${from}\``);
  if (subject) lines.push(`Subject: **${subject}**`);
  if (date) lines.push(`Date: \`${date}\``);

  if (attachments.length > 0) {
    const attachmentLine = attachmentNames.length > 0
      ? `Attachments: \`${attachments.length}\` (${attachmentNames.join(", ")})`
      : `Attachments: \`${attachments.length}\``;
    lines.push(attachmentLine);
  }

  const plain = typeof payload?.plain === "string"
    ? payload.plain
    : typeof payload?.reply_plain === "string"
      ? payload.reply_plain
      : "";

  const header = lines.join("\n");
  const maxLength = 2000;
  const markerReserve = 15; // "[part 999/999]" + "\n"

  if (!plain) return [header.length > maxLength ? header.slice(0, maxLength) : header];

  const separator = "\n\n";
  const firstLimit = Math.max(0, maxLength - header.length - separator.length - markerReserve);
  if (firstLimit <= 0) return [header.slice(0, maxLength)];

  const chunks = splitPlainIntoChunks(plain, firstLimit, maxLength - markerReserve);
  const total = chunks.length;
  return chunks.map((chunk, index) => {
    if (total === 1) return header + separator + chunk;
    const marker = `[part ${index + 1}/${total}]`;
    if (index === 0) {
      return header + separator + marker + "\n" + chunk;
    }
    return marker + "\n" + chunk;
  });
}

function backoffDelayMs(attempt: number): number {
  const base = 500;
  return Math.min(10000, base * 2 ** attempt);
}

async function parseRetryAfterMs(resp: Response): Promise<number | null> {
  const header = resp.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  try {
    const body = await resp.clone().json();
    const retryAfter = typeof body?.retry_after === "number" ? body.retry_after : null;
    return retryAfter !== null ? Math.max(0, retryAfter * 1000) : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToDiscordWithRetry(
  url: string,
  payload: { content: string; allowed_mentions: { parse: string[] } },
  maxAttempts = 3
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok) return resp;
    lastResponse = resp;

    const shouldRetry = resp.status === 429 || resp.status >= 500;
    if (!shouldRetry || attempt === maxAttempts - 1) return resp;

    const retryAfterMs = await parseRetryAfterMs(resp);
    const waitMs = retryAfterMs ?? backoffDelayMs(attempt);
    if (waitMs > 0) await delay(waitMs);
  }

  return lastResponse ?? new Response("Discord error: unknown", { status: 502 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/cloudmailin") {
      return new Response("Not found", { status: 404 });
    }

    const ok = verifyBasicAuth(
      request.headers.get("Authorization"),
      env.CLOUDMAILIN_BASIC_AUTH
    );

    if (!ok) return new Response("Invalid authorization", { status: 401 });

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const contents = summarizeToDiscordContents(payload);
    const discordUrl = new URL(env.DISCORD_WEBHOOK_URL);
    discordUrl.searchParams.set("wait", "true");
    const discordEndpoint = discordUrl.toString();
    for (const content of contents) {
      const discordPayload = {
        content,
        // Prevent @everyone surprises if inbound data contains "@" somewhere
        allowed_mentions: { parse: [] as string[] },
      };

      const resp = await postToDiscordWithRetry(discordEndpoint, discordPayload);

      if (!resp.ok) {
        // Return non-2xx so CloudMailin retries webhook delivery
        return new Response(`Discord error: ${resp.status}`, { status: 502 });
      }
    }

    return new Response("ok", { status: 200 });
  },
};
