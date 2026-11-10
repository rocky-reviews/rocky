// The server image's HEALTHCHECK (P10-1, ADR 0043 S8): GET /healthz on the loopback, which the
// server answers 200 only when it can reach the database. Exit 0 on 200, 1 otherwise; prints
// nothing. Plain Node: the distroless image has no shell or curl.
const port = Number(process.env["PORT"] ?? "4310");
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5_000);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: controller.signal,
    redirect: "manual",
  });
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  clearTimeout(timer);
}
