import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { errors } from '../errors/AppError.js';
import { ErrorCode } from '../errors/codes.js';

// A large request body from the phone (docs/data/sync.md section 7): the JSON, gzipped, written as base64 TEXT, with the header `X-Body-Encoding: gzip-base64`. It is text on purpose: React Native's HTTP stack did not
// deliver the binary body (`Content-Encoding: gzip`) intact on Android (the server read it as undecoded bytes: "Body is not valid JSON"), while a text body arrives as it was sent. Binary gzip (`Content-Encoding:
// gzip`) is still unpacked by `@fastify/compress`, for any client that can send it.

/** The most a body may grow to when unpacked, and the most base64 text read for it: a larger one is refused (a gzip bomb costs memory, not a request). */
export const MAX_UNPACKED = 8 * 1024 * 1024;
const MAX_PACKED = 4 * 1024 * 1024;

export default fp(async (app: FastifyInstance) => {
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.headers['x-body-encoding'] !== 'gzip-base64') {
      return payload;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buf = Buffer.from(chunk as Buffer);
      size += buf.length;
      if (size > MAX_PACKED) {
        throw errors.BadRequest('Body too large', ErrorCode.BAD_REQUEST);
      }
      chunks.push(buf);
    }
    let json: Buffer;
    try {
      json = gunzipSync(Buffer.from(Buffer.concat(chunks).toString('latin1'), 'base64'), { maxOutputLength: MAX_UNPACKED });
    } catch {
      throw errors.BadRequest('Body is not valid gzip-base64', ErrorCode.BAD_REQUEST);
    }
    // The length the client sent is of the packed text: it no longer matches what the parser will read.
    delete req.headers['content-length'];
    const unpacked = Readable.from([json]);
    return Object.assign(unpacked, { receivedEncodedLength: json.length });
  });
});
