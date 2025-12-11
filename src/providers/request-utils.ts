import { Readable } from "node:stream";

export interface ReadBodyOptions {
  maxBodyBytes?: number;
}

export class BodySizeLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly size: number,
  ) {
    super(`Request body exceeded limit of ${limit} bytes (received ${size})`);
    this.name = "BodySizeLimitError";
  }
}

export async function readIncomingMessage(
  stream: NodeJS.ReadableStream,
  options: ReadBodyOptions = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream as Readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (options.maxBodyBytes !== undefined && total > options.maxBodyBytes) {
      throw new BodySizeLimitError(options.maxBodyBytes, total);
    }
    chunks.push(buffer);
  }

  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}
