import { describe, expect, it } from 'vitest';
import { parseAndVerifyMembershipWebhook, WebhookError } from './webhooks';

const secret = 'local-test-webhook-secret';
const event = {
  id: 'evt_membership_1',
  type: 'membership.revoked',
  tenantId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '55555555-5555-4555-8555-555555555555',
  principalId: '33333333-3333-4333-8333-333333333333',
};

async function signedRequest(
  body = JSON.stringify(event),
  timestamp = '1760000000',
  signatureOverride?: string,
): Promise<Request> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new TextEncoder().encode(`${timestamp}.${body}`);
  const signature = signatureOverride ?? [...new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return new Request('https://cloud.test/v1/webhooks/membership', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(body).byteLength),
      'x-xyra-timestamp': timestamp,
      'x-xyra-signature': signature,
    },
    body,
  });
}

describe('verified membership webhook ingress', () => {
  it('accepts a fresh signed event and returns its canonical payload hash', async () => {
    const request = await signedRequest();
    const parsed = await parseAndVerifyMembershipWebhook(request, secret, 1_760_000_000_000);
    expect(parsed.event).toEqual(event);
    expect(parsed.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects bad signatures, stale timestamps and unsupported event types', async () => {
    await expect(
      parseAndVerifyMembershipWebhook(await signedRequest(undefined, undefined, '00'.repeat(32)), secret, 1_760_000_000_000),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    await expect(
      parseAndVerifyMembershipWebhook(await signedRequest(), secret, 1_761_000_000_000),
    ).rejects.toMatchObject({ code: 'WEBHOOK_TIMESTAMP_INVALID' });
    const unsupported = JSON.stringify({ ...event, type: 'tenant.deleted' });
    await expect(
      parseAndVerifyMembershipWebhook(await signedRequest(unsupported), secret, 1_760_000_000_000),
    ).rejects.toMatchObject({ code: 'WEBHOOK_EVENT_UNSUPPORTED' });
  });

  it('rejects missing length and oversized streamed bodies before persistence', async () => {
    const missing = await signedRequest();
    missing.headers.delete('content-length');
    await expect(parseAndVerifyMembershipWebhook(missing, secret, 1_760_000_000_000)).rejects.toBeInstanceOf(WebhookError);
    const body = 'x'.repeat(256 * 1024 + 1);
    const oversized = new Request('https://cloud.test/v1/webhooks/membership', {
      method: 'POST',
      headers: { 'content-length': String(body.length), 'x-xyra-timestamp': '1760000000', 'x-xyra-signature': '00'.repeat(32) },
      body,
    });
    await expect(parseAndVerifyMembershipWebhook(oversized, secret, 1_760_000_000_000)).rejects.toMatchObject({ code: 'WEBHOOK_BODY_TOO_LARGE' });
  });

});
