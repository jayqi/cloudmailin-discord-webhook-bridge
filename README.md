# cloudmailin-discord-webhook-bridge

A bridge to send inbound email from [CloudMailin](https://www.cloudmailin.com/) to a [Discord channel webhook](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), deployed as a [Cloudflare Worker](https://developers.cloudflare.com/workers/).

Created with assistance from OpenAI's ChatGPT and Codex.

## Environment variables

Requires the following two environment variables

- `CLOUDMAILIN_BASIC_AUTH` — the `user:password` pair used for basic auth in the CloudMailin webhook URL.
- `DISCORD_WEBHOOK_URL` — provided by Discord. Can be found by going to "Edit Channel" > "Integrations" > "Webhooks" > specific webhook > "Copy Webhook URL".

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in your values so `wrangler dev` can read them. For deployed environments, add the secrets to your Worker with:

```bash
npx wrangler secret put CLOUDMAILIN_BASIC_AUTH
npx wrangler secret put DISCORD_WEBHOOK_URL
```

Wrangler will prompt you for each value and store them securely on Cloudflare.

## Deploy

Run

```bash
npm run deploy
```

The exposed webhook endpoint for the bridge is `https://<your-worker-domain>/webhooks/cloudmailin`.

Set the CloudMailin target URL to include basic auth:

```
https://user:password@<your-worker-domain>/webhooks/cloudmailin
```

This worker expects the CloudMailin JSON POST format. It sends the `plain` field to Discord, truncating to 2,000 characters to satisfy Discord's message limit.

## Discord message format

The Discord message includes key email headers plus as much of the `plain` body as fits. Example:

```
From: `Message Sender <sender@example.com>`
Subject: **Test Subject**
Date: `Mon, 16 Jan 2012 17:00:01 +0000`
Attachments: `2` (file.txt, file.txt)

Test with HTML.
```

If the `plain` body exceeds Discord's 2,000 character limit, the message is truncated and ends with:

```
[truncated]
```

## Endpoints

- `/health` — health check for the service
- `/webhooks/cloudmailin` — endpoint that accepts inbound email payloads from CloudMailin
