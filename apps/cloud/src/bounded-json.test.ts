import { expect, it } from 'vitest';
import { boundedJson } from './bounded-json';

it('returns the configured application error when streamed JSON exceeds its byte cap', async () => {
  const request = new Request('https://cloud.test/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ignored: 'x'.repeat(80) }),
  });
  const result = await boundedJson(request, 32, 'AUTH_BODY_TOO_LARGE');
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(413);
  await expect(response.json()).resolves.toEqual({ code: 'AUTH_BODY_TOO_LARGE' });
});
