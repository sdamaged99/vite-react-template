/**
 * Node implementation of the small `cloudflare:sockets` surface the SMTP
 * client uses: connect() with implicit TLS ("on") or STARTTLS, Web-stream
 * readable/writable, close() and startTls(). Certificates are verified
 * (system trust store, plus SMTP_CA_FILE if the mail server uses a private CA).
 */
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import type { CfSocket, ConnectFn } from "../worker/lib/smtp";

function caOption(): { ca?: (string | Buffer)[] } {
  const file = process.env.SMTP_CA_FILE;
  if (!file) return {};
  return { ca: [...tls.rootCertificates, readFileSync(file)] };
}

function wrap(sock: net.Socket, hostname: string): CfSocket {
  let onData: (b: Buffer) => void = () => {};
  let onEnd: () => void = () => {};
  let onError: (e: Error) => void = () => {};
  // Remember the first real failure (e.g. a certificate rejected during the
  // TLS handshake) so a write that loses the race reports that, not EBADF.
  let failure: Error | null = null;
  sock.once("error", (e) => (failure ??= e));
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      onData = (b) => controller.enqueue(new Uint8Array(b));
      onEnd = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      onError = (e) => {
        failure ??= e;
        try {
          controller.error(e);
        } catch {
          /* already errored */
        }
      };
      sock.on("data", onData);
      sock.on("end", onEnd);
      sock.on("close", onEnd);
      sock.on("error", onError);
    },
    cancel() {
      sock.destroy();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (failure) return Promise.reject(failure);
      return new Promise<void>((resolve, reject) =>
        sock.write(chunk, (e) => (e ? setImmediate(() => reject(failure ?? e)) : resolve())),
      );
    },
  });
  const detach = () => {
    sock.off("data", onData);
    sock.off("end", onEnd);
    sock.off("close", onEnd);
    sock.off("error", onError);
  };
  return {
    readable,
    writable,
    close: async () => {
      sock.end();
      sock.destroySoon?.();
    },
    startTls: () => {
      // Hand the raw socket to TLS; our old listeners must not see ciphertext.
      detach();
      const secure = tls.connect({ socket: sock, servername: hostname, ...caOption() });
      return wrap(secure, hostname);
    },
  };
}

export const nodeConnect: ConnectFn = (address, options) => {
  const { hostname, port } = address;
  const sock =
    options.secureTransport === "on"
      ? tls.connect({ host: hostname, port, servername: hostname, ...caOption() })
      : net.connect({ host: hostname, port });
  sock.setTimeout(30_000, () => sock.destroy(new Error("SMTP socket timeout")));
  return wrap(sock, hostname);
};
