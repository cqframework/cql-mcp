"""mitmproxy addon for the e2e tlsproxy.

The client believes it is talking to repo1.maven.org through a TLS-intercepting proxy. The proxy
answers from the private mirror (adding the mirror's credentials) so that scenario C needs no
internet, and refuses everything else.
"""
import base64
import os

from mitmproxy import ctx, http

AUTH = "Basic " + base64.b64encode(
    f"{os.environ['E2E_MIRROR_USER']}:{os.environ['E2E_MIRROR_TOKEN']}".encode()
).decode()
PREFIX = "/maven2/"


def request(flow: http.HTTPFlow) -> None:
    req = flow.request
    if req.pretty_host == "repo1.maven.org" and req.path.startswith(PREFIX):
        # Orchestrate.mjs counts these markers; the token is never logged.
        ctx.log.info(f"E2E-PROXIED {req.method} https://repo1.maven.org{req.path}")
        req.scheme = "http"
        req.host = "mirror"
        req.port = 8080
        req.path = "/releases/" + req.path[len(PREFIX):]
        req.headers["Host"] = "mirror:8080"
        req.headers["Authorization"] = AUTH
    else:
        ctx.log.info(f"E2E-BLOCKED {req.method} {req.pretty_url}")
        flow.response = http.Response.make(403, b"blocked by e2e tlsproxy")
