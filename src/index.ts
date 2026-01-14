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

function summarizeToDiscordContent(payload: any): string {
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

  if (!plain) return header.length > maxLength ? header.slice(0, maxLength) : header;

  const separator = "\n\n";
  const available = maxLength - header.length - separator.length;
  if (available <= 0) return header.slice(0, maxLength);

  const truncationMarker = "\n[truncated]";
  let body = plain;
  if (body.length > available) {
    const sliceLength = Math.max(0, available - truncationMarker.length);
    body = body.slice(0, sliceLength) + truncationMarker;
  }

  return header + separator + body;
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

    const discordPayload = {
      content: summarizeToDiscordContent(payload),
      // Prevent @everyone surprises if inbound data contains "@" somewhere
      allowed_mentions: { parse: [] as string[] },
    };

    const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload),
    });

    if (!resp.ok) {
      // Return non-2xx so CloudMailin retries webhook delivery
      return new Response(`Discord error: ${resp.status}`, { status: 502 });
    }

    return new Response("ok", { status: 200 });
  },
};
