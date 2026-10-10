'use strict';

/**
 * HTTP contract tests for the Express application exported by `app.js`.
 *
 * The suite starts the app on an ephemeral loopback port, sends requests with
 * the global `fetch`, and checks these five cases:
 *   GET /                     -> 200, text/plain; charset=utf-8, "Hello world"
 *   GET /good-evening         -> 200, text/plain; charset=utf-8, "Good evening"
 *   GET /good-evening?name=x  -> the same response as GET /good-evening
 *   GET /no-such-path         -> 404
 *   POST /good-evening        -> 404
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

// `test`: the `node:test` module export, a function that registers the parent test.
const test = require('node:test');

// `assert`: the `node:assert/strict` module; `assert.equal` is strict equality.
const assert = require('node:assert/strict');

// `app`: the Express application under test, exported by `app.js`.
const app = require('../app');

// `TEXT_PLAIN_UTF8`: the expected Content-Type of both 200 responses.
const TEXT_PLAIN_UTF8 = 'text/plain; charset=utf-8';

/**
 * Starts `app` on an ephemeral loopback port and tracks its open connections.
 *
 * Port 0 lets the operating system pick a free port, and 127.0.0.1 keeps the
 * test server off external interfaces.
 *
 * @returns {Promise<{ server: http.Server, sockets: Set<net.Socket> }>}
 *   Resolves once the server is listening; rejects with the bind error.
 */
function startServer() {
  // `resolve`, `reject`: settle the start promise.
  return new Promise((resolve, reject) => {
    // `sockets`: Set of net.Socket, the open connections to destroy at teardown.
    const sockets = new Set();

    // `server`: the http.Server test handle. Express 5 calls the listen
    // callback exactly once, after the bind succeeds or fails.
    const server = app.listen(0, '127.0.0.1', (error) => {
      // `error`: the bind failure, which rejects startServer; undefined on success.
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, sockets });
    });

    // `socket`: a net.Socket connection, tracked from connect until it closes.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
  });
}

/**
 * Stops a server started by `startServer`.
 *
 * `server.close` stops new connections and calls back once the server has
 * closed. Destroying the tracked sockets ends fetch's idle keep-alive
 * connections, so closing completes at once instead of after Node 18's idle
 * keep-alive timeout of about 4 to 5 seconds.
 *
 * @param {object} handle The value that startServer resolved, destructured.
 * @param {http.Server} handle.server The test server to close.
 * @param {Set<net.Socket>} handle.sockets The tracked connections to destroy.
 * @returns {Promise<void>} Resolves once the server has closed.
 */
function stopServer({ server, sockets }) {
  // `resolve`: settles the stop promise once the server has closed.
  return new Promise((resolve) => {
    server.close(resolve);
    // `socket`: each tracked connection, destroyed so that close completes at once.
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

// `t`: the parent test's context, which runs the five subtests through `t.test`.
test('HTTP endpoints', async (t) => {
  // `running`: the { server, sockets } handle, passed to stopServer in `finally`.
  const running = await startServer();

  // `baseUrl`: `http://127.0.0.1:<ephemeral port>`, the prefix of every request.
  const baseUrl = `http://127.0.0.1:${running.server.address().port}`;

  /**
   * Shared assertions for the three 200 cases: requests `path`, then checks
   * the status, the Content-Type and the exact body.
   *
   * @param {string} path Request path, including any query string.
   * @param {string} expectedBody Exact expected response body.
   * @returns {Promise<void>} Resolves when every assertion has passed.
   */
  async function assertTextResponse(path, expectedBody) {
    // `response`: the fetch Response being asserted.
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), TEXT_PLAIN_UTF8);
    assert.equal(await response.text(), expectedBody);
  }

  try {
    await t.test('GET / returns 200 with Hello world', async () => {
      await assertTextResponse('/', 'Hello world');
    });

    await t.test('GET /good-evening returns 200 with Good evening', async () => {
      await assertTextResponse('/good-evening', 'Good evening');
    });

    await t.test('GET /good-evening?name=x ignores the query string', async () => {
      await assertTextResponse('/good-evening?name=x', 'Good evening');
    });

    await t.test('GET /no-such-path returns 404', async () => {
      // `response`: the fetch Response being asserted.
      const response = await fetch(`${baseUrl}/no-such-path`);
      assert.equal(response.status, 404);
    });

    await t.test('POST /good-evening returns 404', async () => {
      // `response`: the fetch Response being asserted.
      const response = await fetch(`${baseUrl}/good-evening`, { method: 'POST' });
      assert.equal(response.status, 404);
    });
  } finally {
    await stopServer(running);
  }
});
