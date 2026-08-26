import { request } from "node:http";
import { connect } from "node:net";
import type { ConnectionDescriptor } from "../src/index.js";

export interface HttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  readonly json: unknown;
}

export async function httpGet(
  descriptor: ConnectionDescriptor,
  path: string,
  options: Readonly<{
    method?: string;
    token?: string | null;
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }> = {},
): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token !== null) headers["authorization"] = `Bearer ${options.token ?? descriptor.bearerToken}`;
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = request({
      host: "127.0.0.1",
      port: descriptor.port,
      path,
      method: options.method ?? "GET",
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try { json = JSON.parse(text) as unknown; } catch { /* caller may inspect non-JSON parser refusal */ }
        resolve(Object.freeze({ statusCode: response.statusCode ?? 0, headers: response.headers, text, json }));
      });
    });
    req.once("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export async function rawHttp(port: number, document: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(document));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}
