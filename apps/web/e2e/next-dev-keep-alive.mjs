// Preloaded (`node --import`) into the `next dev` server the e2e suite starts, never into the app.
//
// What: every HTTP server created in that process keeps an idle connection open for
// NEXT_KEEP_ALIVE_TIMEOUT milliseconds instead of Node's 5 s, which is what `next start
// --keepAliveTimeout` does; `next dev` has no such option.
//
// Why: Playwright's request client (`page.request`, `context.request`) keeps idle connections with
// no time limit, and Node closes them at about 6 s (5 s plus its 1 s buffer). A call after exactly
// that pause landed on the closing socket and failed with `read ECONNRESET`
// (master-data.spec.ts:691, 2026-11-08; a probe with Playwright's client failed 25 of 40 calls
// after 5.985 to 6.023 s idle). A request client lives only as long as its test, so with a timeout
// longer than any test its connections are never closed under it.
//
// Never: change anything but the idle timeout, or load in a production server.
import http from 'node:http';

const timeout = Number(process.env.NEXT_KEEP_ALIVE_TIMEOUT);
if (Number.isInteger(timeout) && timeout > 0) {
  // The default import is the module object Next's `require('http')` gets, so this reaches it.
  const createServer = http.createServer;
  http.createServer = function createServerKeepingIdleConnections(...args) {
    const server = createServer.apply(this, args);
    server.keepAliveTimeout = timeout;
    return server;
  };
}
