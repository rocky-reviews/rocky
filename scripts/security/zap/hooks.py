# ZAP baseline hook (P7-3, ADR 0025). The web app renders its links with JavaScript, so the
# spider alone would only see index.html and its assets. Visit every server route family once so
# the passive scanner sees the answers of the auth pages, the session API, the webhook receiver,
# health, 404s and the SPA fallback. GET only: the baseline scan is passive.

PATHS = [
    "/",
    "/inbox",
    "/theme-init.js",
    "/healthz",
    "/api/session",
    "/api/no-such-route",
    "/auth/github/login?returnTo=/inbox",
    "/auth/github/callback?code=not-a-code&state=not-a-state",
    "/auth/github/callback?error=access_denied",
    "/auth/logout",
    "/webhooks/github",
    "/robots.txt",
    "/sitemap.xml",
]


def zap_started(zap, target):
    base = target.rstrip("/")
    for path in PATHS:
        zap.core.access_url(url=base + path, followredirects=False)
