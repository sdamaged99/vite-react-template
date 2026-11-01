// Node implementation of the `cloudflare:sockets` connect() used by
// worker/lib/smtp.ts. Certificates are verified against the mail hostname.
import net from "node:net";
import tls from "node:tls";

interface Address { hostname: string; port: number }
interface Options { secureTransport: "on" | "starttls"; allowHalfOpen?: boolean }

function wrap(raw: net.Socket, hostname: string) {
  let onData: ((b: Buffer) => void) | undefined;
  let onEnd: (() => void) | undefined;
  let onError: ((e: Error) => void) | undefined;
  const detach = () => {
    if (onData) raw.off("data", onData);
    if (onEnd) raw.off("end", onEnd);
    if (onError) raw.off("error", onError);
  };
  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      onData = (b) => ctrl.enqueue(new Uint8Array(b));
      onEnd = () => { detach(); try { ctrl.close(); } catch { /* cancelled */ } };
      onError = (e) => { detach(); try { ctrl.error(e); } catch { /* cancelled */ } };
      raw.on("data", onData);
      raw.on("end", onEnd);
      raw.on("error", onError);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => raw.write(chunk, (err) => (err ? reject(err) : resolve()))),
  });
  return {
    readable,
    writable,
    close: async () => { raw.destroy(); },
    startTls: () => {
      detach();
      const upgraded = tls.connect({ socket: raw, servername: hostname });
      return wrap(upgraded, hostname);
    },
  };
}

export function connect(address: Address, options: Options) {
  const { hostname, port } = address;
  const raw =
    options.secureTransport === "on"
      ? tls.connect({ host: hostname, port, servername: hostname })
      : net.connect({ host: hostname, port });
  return wrap(raw, hostname);
}
