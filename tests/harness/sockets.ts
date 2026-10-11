// Fake `cloudflare:sockets`: an in-memory SMTP server speaking the real
// protocol to the Worker's SMTP client. TLS is simulated (startTls continues
// the same session); a real certificate check needs the real NethServer.
export interface SmtpLog { host: string; port: number; secure: string; lines: string[]; messages: { from: string; to: string[]; data: string }[]; authToken?: string }
export const smtpState: { mode: "ok" | "auth_fail" | "refuse" | "rcpt_fail_second"; sessions: SmtpLog[]; rcptCount: number } =
  (globalThis as any).__smtpState ??= { mode: "ok", sessions: [], rcptCount: 0 };

export function connect(address: { hostname: string; port: number }, options: { secureTransport: string }) {
  const st = smtpState;
  const log: SmtpLog = { host: address.hostname, port: address.port, secure: options.secureTransport, lines: [], messages: [] };
  st.sessions.push(log);
  let push!: (s: string) => void;
  let closeOut!: () => void;
  let tlsStarted = options.secureTransport === "on";
  const mk = () => {
    const readable = new ReadableStream<Uint8Array>({
      start(ctrl) {
        push = (s) => ctrl.enqueue(new TextEncoder().encode(s));
        closeOut = () => { try { ctrl.close(); } catch {} };
      },
    });
    let buf = "";
    let inData = false;
    let data = "";
    let mailFrom = "";
    let rcpts: string[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (inData) {
            if (line === ".") { inData = false; log.messages.push({ from: mailFrom, to: rcpts, data }); push("250 2.0.0 queued\r\n"); }
            else data += line + "\r\n";
            continue;
          }
          log.lines.push(line);
          const cmd = line.split(" ")[0]!.toUpperCase();
          if (cmd === "EHLO") push("250-fake.nethserver\r\n250-PIPELINING\r\n250-8BITMIME\r\n" + (tlsStarted ? "" : "250-STARTTLS\r\n") + "250 AUTH PLAIN LOGIN\r\n");
          else if (cmd === "STARTTLS") push("220 2.0.0 Ready to start TLS\r\n");
          else if (cmd === "AUTH") { log.authToken = line.split(" ")[2]; push(st.mode === "auth_fail" ? "535 5.7.8 Authentication failed\r\n" : "235 2.7.0 Authentication successful\r\n"); }
          else if (cmd === "MAIL") { mailFrom = line; rcpts = []; data = ""; push("250 2.1.0 Ok\r\n"); }
          else if (cmd === "RCPT") { st.rcptCount++; rcpts.push(line); push(st.mode === "rcpt_fail_second" && st.rcptCount >= 2 ? "550 5.1.1 Recipient rejected\r\n" : "250 2.1.5 Ok\r\n"); }
          else if (cmd === "DATA") { inData = true; push("354 End data with <CR><LF>.<CR><LF>\r\n"); }
          else if (cmd === "QUIT") { push("221 2.0.0 Bye\r\n"); closeOut(); }
          else push("502 5.5.2 Unknown\r\n");
        }
      },
    });
    return { readable, writable };
  };
  if (st.mode === "refuse") {
    const readable = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("connection refused")); } });
    const writable = new WritableStream<Uint8Array>();
    return { readable, writable, close: async () => {}, startTls: () => { throw new Error("no"); } };
  }
  const first = mk();
  queueMicrotask(() => push("220 fake.nethserver ESMTP\r\n"));
  const sock: any = {
    ...first,
    close: async () => closeOut(),
    startTls: () => {
      tlsStarted = true;
      const next = mk(); // fresh streams, same server session state
      return { ...next, close: async () => closeOut(), startTls: () => { throw new Error("already TLS"); } };
    },
  };
  return sock;
}
