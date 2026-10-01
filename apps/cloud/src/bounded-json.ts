/** Counts actual streamed transport bytes, including properties later discarded by parsing. */
export async function boundedJson(
  request: Request,
  cap: number,
  tooLargeCode = 'PUSH_TOO_LARGE',
): Promise<{ value: unknown; bytes: number } | Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > cap))
    return Response.json({ code: tooLargeCode }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ code: 'INVALID_JSON' }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        await reader.cancel();
        return Response.json({ code: tooLargeCode }, { status: 413 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown, bytes };
  } catch {
    return Response.json({ code: 'INVALID_JSON' }, { status: 400 });
  }
}
