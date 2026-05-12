const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai", re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._\-]+/gi },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "aws_secret_key", re: /(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9])/g },
  { name: "google_api_key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
];

export function redact(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}
