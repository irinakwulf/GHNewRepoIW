'use strict';

/**
 * HTTP contract tests for the Express application exported by `app.js`.
 *
 * The suite starts the app on an ephemeral loopback port, sends requests with
 * the global `fetch`, and checks these five cases:
 *   GET /                     -> 200, text/plain; charset=utf-8, "Hello world"
 *   GET /good-evening         -> 200, text/plain; charset=utf-8, "Good evening"
 *   GET /good-evening?name=x  -> the same response as GET /good-evening
 *   GET /no-such-path         -> 404, text/html; charset=utf-8, Express's
 *                                default not-found page containing
 *                                "Cannot GET /no-such-path"
 *   POST /good-evening        -> 404, text/html; charset=utf-8, Express's
 *                                default not-found page containing
 *                                "Cannot POST /good-evening"
 *
 * Each 200 case checks the body's UTF-8 byte count before the exact text: the
 * count must equal the contract's own — 11 for `Hello world`, 12 for
 * `Good evening` — so an added trailing newline fails on the count and a
 * same-length change fails on the body. Each 404 case checks for Express's own
 * default not-found page, rather than a 404 the application produced. No case
 * accepts a response reached through a redirect, and every request is bounded
 * by `REQUEST_TIMEOUT_MS`, so a stalled request fails the suite instead of
 * hanging it.
 *
 * The expected bodies are literals in this file and are never read from
 * `app.js`, so changing a response string in `app.js` fails the suite.
 * `server.js` is never required, because it binds its configured port as soon
 * as it loads.
 *
 * Only Node built-ins are used, and only APIs present in Node 18.1.0, the
 * earliest release with `node --test`. That is why the suite has one parent
 * `test` with `t.test` subtests instead of before/after hooks (added in
 * 18.8.0), and tracks sockets itself instead of the http.Server method
 * `server.closeAllConnections` (added in 18.2.0).
 */

// `test`: the `node:test` registration function that declares the parent test.
const test = require('node:test');

// `assert`: the `node:assert/strict` module; `assert.equal` is strict equality.
const assert = require('node:assert/strict');

// `app`: the Express application under test, from `../app`.
const app = require('../app');

// `TEST_SERVER_PORT`: port `0`, so the operating system picks a free port for
// the test server.
const TEST_SERVER_PORT = 0;

// `TEST_SERVER_HOST`: the loopback address, so the test server stays off
// external interfaces.
const TEST_SERVER_HOST = '127.0.0.1';

// `TEXT_PLAIN_UTF8`: the Content-Type both 200 responses must carry.
const TEXT_PLAIN_UTF8 = 'text/plain; charset=utf-8';

// `HTTP_OK`: the status the three 200 cases expect.
const HTTP_OK = 200;

// `HTTP_NOT_FOUND`: the status the two 404 cases expect.
const HTTP_NOT_FOUND = 404;

// `TEXT_HTML_UTF8`: the Content-Type of Express's default not-found response.
const TEXT_HTML_UTF8 = 'text/html; charset=utf-8';

// `REQUEST_TIMEOUT_MS`: how long one request may take before it is aborted.
// Five seconds is far more than any response of this application needs, since
// the whole suite runs in well under a second, and far less than the time a
// stalled request would otherwise hold the run, so the value neither flakes on
// a loaded host nor lets a stalled request hang `npm test`.
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Starts `app` on an ephemeral loopback port and tracks its open connections.
 *
 * A bind failure reaches the listen callback as `error`. The server is closed
 * and every tracked socket destroyed before the promise rejects, so a failed
 * bind leaves no listener and no open handle behind for the runner.
 *
 * @returns {Promise<{ server: http.Server, sockets: Set<net.Socket> }>}
 *   Resolves once the server is listening; rejects with the bind error.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const sockets = new Set();

    const server = app.listen(TEST_SERVER_PORT, TEST_SERVER_HOST, (error) => {
      if (error) {
        stopServer({ server, sockets }).then(() => {
          reject(error);
        });
        return;
      }
      resolve({ server, sockets });
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
  });
}

/**
 * Stops a server started by `startServer`, settling once it has closed.
 *
 * `server.close` stops the server from accepting new connections and calls
 * back once it has closed. A server that is not running — the state a bind
 * failure leaves behind — reports that as an `ERR_SERVER_NOT_RUNNING` error to
 * the callback, so the callback settles the promise whatever argument it
 * carries and teardown never waits on a server that will not close again.
 *
 * The tracked sockets are then drained: each is destroyed and removed from the
 * set, so a connection accepted just before the close cannot survive into
 * teardown. Destroying them ends fetch's idle keep-alive connections, so
 * closing completes at once instead of after Node 18's idle keep-alive timeout
 * of about 4 to 5 seconds.
 *
 * @param {object} handle The value that startServer resolved, destructured.
 * @param {http.Server} handle.server The test server to close.
 * @param {Set<net.Socket>} handle.sockets The tracked connections to destroy.
 * @returns {Promise<void>} Resolves once the server has closed and every
 *   tracked socket has been destroyed; never rejects.
 */
function stopServer({ server, sockets }) {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });

    for (const socket of sockets) {
      socket.destroy();
      sockets.delete(socket);
    }
  });
}

test('HTTP endpoints', async (t) => {
  const running = await startServer();

  const baseUrl = `http://${TEST_SERVER_HOST}:${running.server.address().port}`;

  /**
   * Requests `path` and reads the whole response, so that every case reads the
   * response the same way — the status, the response headers and the body — and
   * no request can run unbounded.
   *
   * The timer covers the whole exchange, the body included: a server that
   * answers with headers and then stalls aborts the body read too, and the
   * abort propagates to the caller as a failed subtest rather than being
   * caught here, which is what makes a stalled request fail the run instead of
   * hanging it. The timer is cleared as soon as the exchange is over, so no
   * pending timer outlives the case or delays the run's exit. An explicit
   * `AbortController` with `setTimeout` is what makes that clearing possible;
   * `AbortSignal.timeout` would leave the timer to fire on its own.
   *
   * @param {string} path Request path, including any query string.
   * @param {object} [init] Extra `fetch` options, such as `{ method: 'POST' }`.
   * @returns {Promise<{ status: number, headers: Headers, redirected: boolean,
   *   body: string }>}
   *   `status`: the response status code. `headers`: the response's `Headers`
   *   object, the single place every response header is read from, by its
   *   lower-case name, such as `content-type`. `redirected`: whether `fetch`
   *   followed a redirect to reach this response. `body`: the whole body text.
   *   Rejects on a network error, on the timeout and on a body that fails to
   *   read.
   */
  async function request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.text();

      return {
        status: response.status,
        headers: response.headers,
        redirected: response.redirected,
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Asserts the whole contract row of one 200 case: the status, that the
   * response was not reached through a redirect, the Content-Type, the body's
   * UTF-8 byte length and the exact body.
   *
   * The byte length is checked against the contract's own count and before the
   * body comparison, so a body whose length changed fails on the byte count
   * with the contract's number in the message: `'Hello world\n'` has 12 bytes
   * against the 11 the contract allows, which is what makes the "no trailing
   * newline" row explicit. The body comparison then catches a change that
   * leaves the byte count unchanged.
   *
   * `fetch` follows redirects for the caller, so the case also rejects a
   * response that arrived that way: the path must answer itself, not hand off
   * to another one that answers with this row.
   *
   * @param {string} path Request path, including any query string.
   * @param {string} expectedBody Exact expected response body.
   * @param {number} expectedByteLength The byte count the contract allows for
   *   that body: 11 for `Hello world`, 12 for `Good evening`.
   * @returns {Promise<void>} Resolves when every assertion has passed.
   */
  async function assertTextResponse(path, expectedBody, expectedByteLength) {
    const response = await request(path);
    assert.equal(response.status, HTTP_OK);
    assert.equal(response.redirected, false);
    assert.equal(response.headers.get('content-type'), TEXT_PLAIN_UTF8);
    assert.equal(Buffer.byteLength(response.body, 'utf8'), expectedByteLength);
    assert.equal(response.body, expectedBody);
  }

  /**
   * Asserts Express's own default not-found response for one 404 case: the
   * status, that the response was not reached through a redirect, the
   * Content-Type, the two marker headers only Express's `finalhandler` sets and
   * the message inside the default HTML body.
   *
   * The message is compared with `includes`, because Express wraps it in its
   * own page. The marker headers — `X-Content-Type-Options: nosniff` and
   * `Content-Security-Policy: default-src 'none'` — are what identify that page
   * as the default one, since a hand-rolled 404 that copies its status, its
   * content type and its text sets neither. A custom not-found handler, a route
   * registered for the path, or a middleware that rewrites the status, the
   * content type or the body therefore fails the case. A path that redirects to
   * a 404 somewhere else fails too, because `fetch` would have followed it.
   *
   * @param {string} path Request path.
   * @param {object} [init] Extra `fetch` options, such as `{ method: 'POST' }`.
   * @param {string} expectedMessage The message the default not-found page must
   *   contain, such as `Cannot POST /good-evening`.
   * @returns {Promise<void>} Resolves when every assertion has passed.
   */
  async function assertNotFoundResponse(path, init, expectedMessage) {
    const response = await request(path, init);
    assert.equal(response.status, HTTP_NOT_FOUND);
    assert.equal(response.redirected, false);
    assert.equal(response.headers.get('content-type'), TEXT_HTML_UTF8);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'",
    );
    assert.ok(
      response.body.includes(expectedMessage),
      `default 404 body changed: ${response.body}`,
    );
  }

  try {
    await t.test('GET / returns 200 with Hello world', async () => {
      await assertTextResponse('/', 'Hello world', 11);
    });

    await t.test('GET /good-evening returns 200 with Good evening', async () => {
      await assertTextResponse('/good-evening', 'Good evening', 12);
    });

    await t.test('GET /good-evening?name=x ignores the query string', async () => {
      await assertTextResponse('/good-evening?name=x', 'Good evening', 12);
    });

    await t.test('GET /no-such-path returns 404', async () => {
      await assertNotFoundResponse(
        '/no-such-path',
        undefined,
        'Cannot GET /no-such-path',
      );
    });

    await t.test('POST /good-evening returns 404', async () => {
      await assertNotFoundResponse(
        '/good-evening',
        { method: 'POST' },
        'Cannot POST /good-evening',
      );
    });
  } finally {
    await stopServer(running);
  }
});
