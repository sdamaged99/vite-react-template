import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const versions = [
  { key: "0.2-draft", file: "terms/versions/v0.2.txt", effective: "2026-10-10" },
  { key: "1.0", file: "terms/versions/v1.0.txt", effective: "2026-10-09" },
  { key: "1.1", file: "terms/versions/v1.1.txt", effective: "2026-10-11" },
];

const entries = versions.map(({ key, file, effective }) => {
  const text = readFileSync(file, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return { key, effective, sha256, text };
});

const body = entries
  .map(
    (e) => `  ${JSON.stringify(e.key)}: {
    version: ${JSON.stringify(e.key)},
    effective: ${JSON.stringify(e.effective)},
    sha256: ${JSON.stringify(e.sha256)},
    text: ${JSON.stringify(e.text)},
  },`,
  )
  .join("\n");

const out = `export interface TermsVersion {
  version: string;
  effective: string;
  sha256: string;
  text: string;
}

// GENERATED from terms/versions/*.txt — see README "Publishing new hire terms".
// Old versions are kept so that enquiries and bookings always resolve the
// exact wording they accepted; never edit or remove an entry.
export const TERMS_VERSIONS: Record<string, TermsVersion> = {
${body}
};

export const CURRENT_TERMS = TERMS_VERSIONS["1.1"]!;

export function termsText(version: string | null): TermsVersion {
  return (version && TERMS_VERSIONS[version]) || CURRENT_TERMS;
}
`;

writeFileSync("worker/lib/terms.ts", out);
for (const e of entries) console.log(e.key, e.effective, e.sha256, `${e.text.length} chars`);
