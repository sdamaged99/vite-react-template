import { connect } from "cloudflare:sockets";

/**
 * Minimal SMTP submission client for Workers TCP sockets, written for sending
 * a handful of plain-text emails a month through the business's own NethServer.
 *
 * Supports implicit TLS (port 465) and STARTTLS (port 587) with AUTH PLAIN.
 * No dependencies; strict timeouts; dot-stuffed DATA.
 */

export interface SmtpConfig {
  host: string;
  port: number; // 465 (implicit TLS) or 587 (STARTTLS)
  user: string;
  pass: string;
}

export interface Mail {
  from: string; // e.g. "Sparkle Carpets <website@sparklecarpets.im>"
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
}

const CRLF = "\r\n";
const TIMEOUT_MS = 15000;

function addrOnly(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return m?.[1] ?? s.trim();
}

class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private socket: ReturnType<typeof connect>) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  rebind(socket: ReturnType<typeof connect>) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = "";
  }

  get current() {
    return this.socket;
  }

  async send(line: string) {
    await this.writer.write(this.encoder.encode(line + CRLF));
  }

  async write(data: string) {
    await this.writer.write(this.encoder.encode(data));
  }

  /** Read one full SMTP reply (handles multi-line 250-... 250 <space>). */
  async reply(expect: number[]): Promise<string> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (/^\d{3}-/.test(line)) continue; // intermediate line of a multi-line reply
        const code = Number(line.slice(0, 3));
        if (!expect.includes(code)) throw new Error(`SMTP ${line.slice(0, 120)}`);
        return line;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SMTP timeout");
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SMTP timeout")), remaining)),
      ]);
      if (chunk.done) throw new Error("SMTP connection closed");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

function buildMessage(mail: Mail): string {
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(", ")}`,
    ...(mail.replyTo ? [`Reply-To: ${mail.replyTo}`] : []),
    `Subject: ${mail.subject.replace(/[\r\n]/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = mail.text.replace(/\r?\n/g, CRLF).replace(/(^|\r\n)\./g, "$1.."); // dot-stuffing
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF;
}

export async function sendMail(cfg: SmtpConfig, mail: Mail): Promise<void> {
  const implicitTls = cfg.port === 465;
  let socket = connect(
    { hostname: cfg.host, port: cfg.port },
    { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false },
  );
  const s = new Session(socket);
  try {
    await s.reply([220]);
    await s.send(`EHLO sparklecarpets.im`);
    await s.reply([250]);

    if (!implicitTls) {
      await s.send("STARTTLS");
      await s.reply([220]);
      socket = socket.startTls();
      s.rebind(socket);
      await s.send(`EHLO sparklecarpets.im`);
      await s.reply([250]);
    }

    const token = btoa(`\u0000${cfg.user}\u0000${cfg.pass}`);
    await s.send(`AUTH PLAIN ${token}`);
    await s.reply([235]);

    await s.send(`MAIL FROM:<${addrOnly(mail.from)}>`);
    await s.reply([250]);
    for (const rcpt of mail.to) {
      await s.send(`RCPT TO:<${addrOnly(rcpt)}>`);
      await s.reply([250, 251]);
    }
    await s.send("DATA");
    await s.reply([354]);
    await s.write(buildMessage(mail));
    await s.send(".");
    await s.reply([250]);
    await s.send("QUIT");
  } finally {
    try {
      await s.current.close();
    } catch {
      /* already closed */
    }
  }
}
