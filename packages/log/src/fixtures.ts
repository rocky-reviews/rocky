/**
 * Real-looking but fake secrets for the redaction tests. Every value is assembled at runtime
 * from short pieces, so no token-shaped literal exists in the source tree and gitleaks (which
 * scans text) has nothing to flag. Do not "simplify" these into literals.
 */
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic pseudo-random alphanumerics (not a secret: reproducible and documented). */
export const chars = (length: number, seed = 7): string =>
  Array.from({ length }, (_, i) => CHARS[(i * seed + 3) % CHARS.length]).join("");

const B64 = CHARS + "+/";
const base64ish = (length: number): string =>
  Array.from({ length }, (_, i) => B64[(i * 11 + 5) % B64.length]).join("");

const pem = (): string =>
  [
    ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
    chars(64, 3),
    chars(64, 5),
    ["-----END", "RSA PRIVATE KEY-----"].join(" "),
  ].join("\n");

export const FAKE = {
  ghp: "ghp_" + chars(36),
  gho: "gho_" + chars(36, 11),
  ghs: "ghs_" + chars(36, 13),
  ghu: "ghu_" + chars(36, 17),
  ghr: "ghr_" + chars(76, 19),
  githubPat: ["github", "pat", chars(22) + "_" + chars(59, 23)].join("_"),
  anthropic: ["sk-ant", "api03", chars(93, 29) + "AA"].join("-"),
  genericSk: "sk-" + chars(48, 31),
  openaiProject: ["sk", "proj", chars(40, 37)].join("-"),
  jwt: ["eyJ" + chars(20, 41), "eyJ" + chars(60, 43), chars(43, 47)].join("."),
  email: "jane.doe+ci@example.com",
  pem: pem(),
  awsAccessKey:
    "AKIA" +
    chars(16, 53)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "Q"),
  awsSecretLine: "aws_secret_access_key = " + base64ish(40),
  bearer: "Bearer " + chars(40, 59),
  basic: "Basic " + Buffer.from("user:" + chars(20, 61)).toString("base64"),
} as const;

export type FakeSecretName = keyof typeof FAKE;
