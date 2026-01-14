import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const samplePayload = {
	headers: {
		return_path: 'from@example.com',
		received: [
			'by 10.52.90.229 with SMTP id bz5cs75582vdb; Mon, 16 Jan 2012 09:00:07 -0800',
			'by 10.216.131.153 with SMTP id m25mr5479776wei.9.1326733205283; Mon, 16 Jan 2012 09:00:05 -0800',
			'from mail-wi0-f170.google.com (mail-wi0-f170.google.com [209.85.212.170]) by mx.google.com with ESMTPS id u74si9614172weq.62.2012.01.16.09.00.04 (version=TLSv1/SSLv3 cipher=OTHER); Mon, 16 Jan 2012 09:00:04 -0800',
		],
		date: 'Mon, 16 Jan 2012 17:00:01 +0000',
		from: 'Message Sender <sender@example.com>',
		to: 'Message Recipient<to@example.co.uk>',
		message_id: '<4F145791.8040802@example.com>',
		subject: 'Test Subject',
		mime_version: '1.0',
		content_type: 'multipart/alternative; boundary=------------090409040602000601080801',
		delivered_to: 'to@example.com',
		received_spf:
			'neutral (google.com: 10.0.10.1 is neither permitted nor denied by best guess record for domain of from@example.com) client-ip=10.0.10.1;',
		authentication_results:
			'mx.google.com; spf=neutral (google.com: 10.0.10.1 is neither permitted nor denied by best guess record for domain of from@example.com) smtp.mail=from@example.com',
		user_agent: 'Postbox 3.0.2 (Macintosh/20111203)',
	},
	envelope: {
		to: 'to@example.com',
		from: 'from@example.com',
		helo_domain: 'localhost',
		remote_ip: '127.0.0.1',
		recipients: ['to@example.com', 'another@example.com'],
		spf: {
			result: 'pass',
			domain: 'example.com',
		},
		tls: true,
	},
	plain: 'Test with HTML.',
	html: `<html><head>
<meta http-equiv="content-type" content="text/html; charset=ISO-8859-1"></head><body
 bgcolor="#FFFFFF" text="#000000">
Test with <span style="font-weight: bold;">HTML</span>.<br>
</body>
</html>`,
	reply_plain: 'Message reply if found.',
	attachments: [
		{
			content: 'dGVzdGZpbGU=',
			file_name: 'file.txt',
			content_type: 'text/plain',
			size: 8,
			disposition: 'attachment',
		},
		{
			content: 'dGVzdGZpbGU=',
			file_name: 'file.txt',
			content_type: 'text/plain',
			size: 8,
			disposition: 'attachment',
		},
	],
} as const;

const expectedDiscordContent = [
	'**CloudMailin inbound email**',
	'From: `Message Sender <sender@example.com>`',
	'To: `Message Recipient<to@example.co.uk>`',
	'Subject: `Test Subject`',
	'Message ID: `<4F145791.8040802@example.com>`',
	'Date: `Mon, 16 Jan 2012 17:00:01 +0000`',
	'Attachments: `2` (file.txt, file.txt)',
	'',
	'Test with HTML.',
].join('\n');

const BASIC_AUTH = 'user:mypass';
const DISCORD_URL = 'https://discord.example/webhook';
const workerUrl = 'https://worker.example';

const makeEnv = (): Env => ({
	CLOUDMAILIN_BASIC_AUTH: BASIC_AUTH,
	DISCORD_WEBHOOK_URL: DISCORD_URL,
});

const base64Encode = (value: string): string => {
	if (typeof btoa === 'function') return btoa(value);
	return Buffer.from(value, 'utf-8').toString('base64');
};

function buildAuthedRequest(payload: object, auth: string): Request {
	const body = JSON.stringify(payload);
	const encoded = base64Encode(auth);
	return new Request(`${workerUrl}/webhooks/cloudmailin`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Basic ${encoded}`,
		},
		body,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('CloudMailin inbound webhook bridge', () => {
	it('responds with ok on GET /health', async () => {
		const request = new Request(`${workerUrl}/health`);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('returns 404 for other routes', async () => {
		const request = new Request(`${workerUrl}/nope`, { method: 'POST' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('rejects the request when the authorization is invalid', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const request = new Request(`${workerUrl}/webhooks/cloudmailin`, {
			method: 'POST',
			headers: { Authorization: 'Basic deadbeef' },
			body: JSON.stringify(samplePayload),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('forwards a valid CloudMailin payload to Discord', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
		const request = buildAuthedRequest(samplePayload, BASIC_AUTH);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(
			DISCORD_URL,
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(sentBody).toEqual({
			content: expectedDiscordContent,
			allowed_mentions: { parse: [] },
		});
	});

	it('propagates Discord failures as 502 so CloudMailin retries', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fail', { status: 500 }));
		const request = buildAuthedRequest(samplePayload, BASIC_AUTH);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchSpy).toHaveBeenCalled();
		expect(response.status).toBe(502);
		expect(await response.text()).toBe('Discord error: 500');
	});

	it('truncates long plain bodies to the Discord limit', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
		const longPayload = {
			...samplePayload,
			plain: 'a'.repeat(3000),
		};
		const request = buildAuthedRequest(longPayload, BASIC_AUTH);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(sentBody.content.length).toBeLessThanOrEqual(2000);
		expect(sentBody.content).toContain('[truncated]');
	});
});
