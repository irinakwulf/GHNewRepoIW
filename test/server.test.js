'use strict';

/**
 * Test suite for hello-service (`src/server.js`), run by `npm test`.
 *
 * It covers every row of the service's interface, both sides of the 50/51 name-length boundary,
 * CONNECT and the parser's method boundary, the 500 and failed-recovery paths, and the start-up
 * lifecycle.
 *
 * Every client connection goes to 127.0.0.1 on a port the OS assigns at run time, so the run needs
 * no network or DNS and never depends on a fixed port, such as 3000, being free.
 *
 * Top-level tests run one at a time (the `node:test` default). Tests that briefly override
 * process-wide built-ins rely on that: each override is undone before the next test starts, so it
 * never leaks into another test.
 *
 * Expected texts are written out here rather than imported from the module under test, so a change
 * to any response string fails the suite instead of silently changing what it checks. Non-ASCII
 * expectations are JavaScript escapes, so the file stays ASCII whatever the editor's encoding.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createServer, greet } = require('../src/server.js');

/** Absolute, platform-correct path of the service entry point, for the lifecycle tests. */
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');

/**
 * Loopback address of every client connection and in-process server; never `localhost`, so no DNS
 * or IPv6 ordering.
 */
const HOST = '127.0.0.1';

const TEXT_TYPE = 'text/plain; charset=utf-8';

/** The fixed response bodies, character for character, with no trailing newline. */
const HELLO_WORLD = 'Hello, world!';
const NAME_TOO_LONG = 'Name must be 50 characters or fewer.';
const NOT_FOUND = 'Not found.';
const METHOD_NOT_ALLOWED = 'Method not allowed.';
const SERVER_ERROR = 'Something went wrong.';

/**
 * Inactivity timeout armed on every client socket the helpers open: a connection that sends or
 * receives nothing for 5 seconds is destroyed and its exchange rejects, so a stall fails instead
 * of hanging. Traffic resets it, so it does not cap an exchange's total duration; the 10-second
 * per-test timeout bounds that instead.
 */
const IO_TIMEOUT_MS = 5000;

const LIFECYCLE_TEST = Object.freeze({ timeout: 10000 });

/** Options for each in-process test: a bound on the whole test, set-up waits included. */
const IN_PROCESS_TEST = Object.freeze({ timeout: 10000 });

/**
 * Deadline for each cleanup step. A test's timeout does not cover its `t.after` hook, and a
 * server's `close()` may wait out the service's 5-second CONNECT idle timeout, so the bound is
 * longer than that.
 */
const CLEANUP_TIMEOUT_MS = 10000;

const UNEXPECTED_ERROR_LOG = 'Unexpected error while handling a request';

/** Each running test's cleanup steps, keyed by its context, in the order they were registered. */
const cleanupSteps = new WeakMap();

/**
 * Registers a step that releases a resource the test opened. The first step registered for a test
 * also registers that test's one `t.after` hook, which runs them all. That hook has no timeout:
 * `node:test` skips a test's later `after` hooks once one fails and stops waiting on a hook that
 * times out, so per-resource hooks or a hook deadline could leave steps unrun or unawaited. Each
 * step carries its own deadline instead.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the resource.
 * @param {() => unknown} step Releases the resource, optionally returning a promise. It must be
 *   idempotent, because it also runs when the resource already closed on completion.
 */
function onCleanup(t, step) {
  let steps = cleanupSteps.get(t);
  if (steps === undefined) {
    steps = [];
    cleanupSteps.set(t, steps);
    t.after(() => runCleanup(steps));
  }
  steps.push(step);
}

/**
 * Runs a test's cleanup steps newest first, so clients close before their server and a child is
 * stopped before the port holder registered ahead of it. Every step runs even when an earlier one
 * throws, rejects or misses its deadline; the failures are thrown once all steps have run, so the
 * test still fails visibly.
 *
 * @param {Array<() => unknown>} steps The test's registered steps, emptied as they run.
 * @returns {Promise<void>}
 */
async function runCleanup(steps) {
  const failures = [];
  while (steps.length > 0) {
    const step = steps.pop();
    try {
      // Calling the step inside `then` turns a synchronous throw into a rejection.
      await withCleanupDeadline(Promise.resolve().then(step));
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    // Reporters print an error's message, not the entries of `errors`, so the message names each.
    const reasons = failures.map((err) => (err instanceof Error ? err.message : String(err)));
    throw new AggregateError(
      failures,
      `${failures.length} cleanup steps failed: ${reasons.join('; ')}`,
    );
  }
}

/**
 * Settles as `promise` does, or rejects once CLEANUP_TIMEOUT_MS pass first. The timer stays ref'd,
 * so a step that never settles keeps the run alive until its deadline reports it, and it is cleared
 * as soon as either side settles.
 *
 * @param {Promise<unknown>} promise A running cleanup step.
 * @returns {Promise<unknown>}
 */
function withCleanupDeadline(promise) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`cleanup step did not finish within ${CLEANUP_TIMEOUT_MS} ms`)),
      CLEANUP_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Starts a fresh in-process server on an OS-assigned loopback port and registers its shutdown.
 *
 * `closeAllConnections()` ends any keep-alive socket before the awaited `close()`, so shutdown never
 * waits on an idle connection. Sockets handed to the CONNECT listener are outside that call; they
 * close once their response is flushed, and in any case within the listener's own idle timeout.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the server.
 * @param {{ greet?: Function }} [options] Passed through to `createServer`.
 * @returns {Promise<number>} The port the server is listening on.
 */
function startServer(t, options) {
  const server = createServer(options);
  onCleanup(t, () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, HOST, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/**
 * Sends one request with `node:http` and collects the whole response.
 *
 * `agent: false` gives each request its own connection that closes after the response, so nothing
 * pooled outlives a test. The request target is sent exactly as given, so `//`, `/%2F` and
 * `/?name=%ZZ` reach the server unchanged. A transport error rejects with the original error, so a
 * caller can check its `code` (for example `ECONNRESET` for a destroyed connection). A cleanup step
 * of the test destroys the request, which does nothing once the exchange has finished, so a test
 * that fails or times out mid-exchange cannot leave the connection open.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the connection.
 * @param {number} port Port to connect to on 127.0.0.1.
 * @param {{ method?: string, path?: string }} [options] Method (default `GET`) and request target
 *   (default `/`).
 * @returns {Promise<{ status: number, headers: object, body: string }>} The status code, the
 *   lower-cased response headers, and the body decoded as UTF-8.
 */
function request(t, port, { method = 'GET', path: target = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port, method, path: target, agent: false, timeout: IO_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    onCleanup(t, () => {
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Formats an optional assertion label as a message prefix. */
function prefix(label) {
  return label ? `${label}: ` : '';
}

/**
 * Asserts a plain-text response that transferred its body: the status, the exact body, and the
 * three headers every generated response carries, with `content-length` as the UTF-8 byte count of
 * the expected body. Not for HEAD, whose declared length and transferred body differ by design.
 *
 * @param {{ status: number, headers: object, body: string }} res A response from `request`.
 * @param {number} status Expected status code.
 * @param {string} body Expected exact body.
 * @param {string} [label] Identifies the request in assertion messages.
 */
function assertText(res, status, body, label) {
  const p = prefix(label);
  assert.strictEqual(res.status, status, `${p}expected status ${status}, received ${res.status}`);
  assert.strictEqual(
    res.body,
    body,
    `${p}expected body ${JSON.stringify(body)}, received ${JSON.stringify(res.body)}`,
  );
  assert.strictEqual(res.headers['content-type'], TEXT_TYPE, `${p}content-type`);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', `${p}x-content-type-options`);
  assert.strictEqual(
    res.headers['content-length'],
    String(Buffer.byteLength(body)),
    `${p}content-length must be the UTF-8 byte count of the body`,
  );
}

/**
 * Asserts a HEAD response: the selected status, the plain-text headers, a `content-length` that
 * declares the length of the body the route and method select, and an empty received body.
 *
 * @param {{ status: number, headers: object, body: string }} res A response from `request`.
 * @param {number} status Expected status code.
 * @param {string} declaredLength Expected `content-length` header, as sent.
 * @param {string} [label] Identifies the request in assertion messages.
 */
function assertHead(res, status, declaredLength, label) {
  const p = prefix(label);
  assert.strictEqual(res.status, status, `${p}expected status ${status}, received ${res.status}`);
  assert.strictEqual(res.headers['content-type'], TEXT_TYPE, `${p}content-type`);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', `${p}x-content-type-options`);
  assert.strictEqual(res.headers['content-length'], declaredLength, `${p}declared content-length`);
  assert.strictEqual(res.body, '', `${p}a HEAD response transfers no body`);
}

/**
 * Splits a raw HTTP/1.1 response into its status line, lower-cased headers and body.
 *
 * Throws when the blank line that ends the head is missing: bytes cut off inside the head are not a
 * complete response, so they must not read as a full header section with an empty body.
 *
 * @param {string} text Everything received on the connection.
 * @returns {{ statusLine: string, headers: object, body: string }}
 */
function parseRawResponse(text) {
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    throw new Error(
      `Raw response ends before the blank line that closes its head: ${JSON.stringify(text)}`,
    );
  }
  const head = text.slice(0, headEnd);
  const body = text.slice(headEnd + 4);
  const [statusLine, ...headerLines] = head.split('\r\n');
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`Malformed header line in raw response: ${JSON.stringify(line)}`);
    }
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { statusLine, headers, body };
}

/**
 * Writes `text` verbatim on a new `node:net` connection and collects everything the server sends
 * until it closes the connection, without interpreting it.
 *
 * When the server ends its side, this client ends its side too (the `net` default), so its own
 * socket closes promptly. A 5-second idle timeout destroys a stalled connection and rejects, so a
 * connection the server leaves open fails the exchange rather than resolving. A cleanup step of
 * the test destroys the socket, which does nothing once it has closed, so a test that fails or
 * times out mid-exchange cannot leave it open.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the connection.
 * @param {number} port Port to connect to on 127.0.0.1.
 * @param {string} text The complete raw request, including the blank line that ends the head.
 * @returns {Promise<string>} Everything received, decoded as UTF-8; empty when the server closed
 *   the connection without sending anything.
 */
function rawExchange(t, port, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, HOST, () => socket.write(text));
    onCleanup(t, () => {
      socket.destroy();
    });
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy(new Error('raw request timed out')));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    // After an error the promise is already rejected, and this later settle attempt is ignored.
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * Sends `text` with `rawExchange` and splits what came back with `parseRawResponse`, so the
 * exchange rejects unless a complete response head arrived before the server closed the connection.
 *
 * Used for CONNECT, whose response `http.request` would deliver through its own `connect` event,
 * for unrecognised method tokens, which `http.request` would upper-case or refuse to send, and for
 * reading exactly what a response the server cut short delivered.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the connection.
 * @param {number} port Port to connect to on 127.0.0.1.
 * @param {string} text The complete raw request, including the blank line that ends the head.
 * @returns {Promise<{ statusLine: string, headers: object, body: string }>}
 */
async function rawRequest(t, port, text) {
  return parseRawResponse(await rawExchange(t, port, text));
}

/**
 * Asserts a raw response from the CONNECT listener: the exact status line and body, the three
 * plain-text headers, `connection: close`, and no `date` header (the response bypasses Node's
 * response machinery).
 *
 * @param {{ statusLine: string, headers: object, body: string }} res A response from `rawRequest`.
 * @param {string} statusLine Expected status line, for example `HTTP/1.1 404 Not Found`.
 * @param {string} body Expected exact body.
 * @param {string} [label] Identifies the request in assertion messages.
 */
function assertRawText(res, statusLine, body, label) {
  const p = prefix(label);
  assert.strictEqual(res.statusLine, statusLine, `${p}status line`);
  assert.strictEqual(res.body, body, `${p}body`);
  assert.strictEqual(res.headers['content-type'], TEXT_TYPE, `${p}content-type`);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', `${p}x-content-type-options`);
  assert.strictEqual(
    res.headers['content-length'],
    String(Buffer.byteLength(body)),
    `${p}content-length`,
  );
  assert.strictEqual(res.headers.connection, 'close', `${p}connection`);
  assert.strictEqual(res.headers.date, undefined, `${p}a raw response carries no date header`);
}

/**
 * Writes two pieces of raw request text on one persistent `node:net` connection: `first` on
 * connect, and `second` only once a complete response to `first` has arrived. That response is
 * framed in bytes by its `content-length`; everything after it, until the server closes the
 * connection, is the second response.
 *
 * A POST must be answered while its body is still arriving, and the rest of that body must be
 * drained so the connection stays in step. `http.request` with `agent: false` asks the server to
 * close the connection after its response, so it cannot show what becomes of the rest of the body;
 * a keep-alive connection can. When `first` holds the head and only part of the body, a complete
 * response to it shows the server answered without waiting for the body. When `second` holds the
 * rest of the body and then a request with `Connection: close`, an exact response to that request
 * shows the server discarded the body and kept the connection in step.
 *
 * The exchange rejects unless the first response's head carries exactly one decimal
 * `content-length` and that head and the body it declares arrive in full before the connection
 * closes. The second response is collected rather than framed, because the server's close ends it:
 * once the connection closes, the exchange resolves if a complete second head has arrived, and
 * takes every byte after that head as the body without comparing it with the declared
 * `content-length`. The caller's assertions therefore validate the second body, and an exact
 * comparison catches one cut short or followed by extra bytes. The exchange also rejects on a close
 * before the second head is complete, a header line without a colon or a repeated `content-length`
 * in either head, a transport error, or a 5-second idle timeout. A cleanup step of the test
 * destroys the socket, which does nothing once it has closed, so a test that fails or times out
 * mid-exchange cannot leave it open.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the connection.
 * @param {number} port Port to connect to on 127.0.0.1.
 * @param {string} first Raw text written on connect.
 * @param {string} second Raw text written once the response to `first` is complete. Its last
 *   request must ask the server to close the connection, which ends the exchange.
 * @returns {Promise<{ first: object, second: object }>} Each response as
 *   `{ statusLine, status, headers, body }`, with lower-cased headers and the body decoded as
 *   UTF-8.
 */
function keepAliveExchange(t, port, first, second) {
  return new Promise((resolve, reject) => {
    // Bytes not yet assigned to a response: the first response, then whatever follows it.
    let received = Buffer.alloc(0);
    let firstResponse = null;

    // Parses the head that ends at byte `headEnd` of `received`, which excludes the blank line.
    function parseHead(headEnd) {
      const head = received.subarray(0, headEnd).toString('utf8');
      const [statusLine, ...headerLines] = head.split('\r\n');
      const headers = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon === -1) {
          throw new Error(`Malformed header line in raw response: ${JSON.stringify(line)}`);
        }
        const name = line.slice(0, colon).trim().toLowerCase();
        // The first response is framed by this field, so a second copy would make it ambiguous.
        if (name === 'content-length' && name in headers) {
          throw new Error('Raw response repeats content-length');
        }
        headers[name] = line.slice(colon + 1).trim();
      }
      return { statusLine, status: Number(statusLine.split(' ')[1]), headers };
    }

    const socket = net.connect(port, HOST, () => socket.write(first));
    onCleanup(t, () => {
      socket.destroy();
    });
    socket.setTimeout(IO_TIMEOUT_MS, () => {
      const awaited = firstResponse === null ? 'first' : 'second';
      socket.destroy(new Error(`keep-alive exchange timed out awaiting the ${awaited} response`));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (firstResponse !== null) {
        return;
      }
      const headEnd = received.indexOf('\r\n\r\n');
      if (headEnd === -1) {
        return;
      }
      try {
        const head = parseHead(headEnd);
        const declared = head.headers['content-length'];
        if (declared === undefined || !/^\d+$/.test(declared)) {
          throw new Error(
            `First raw response has no usable content-length: ${JSON.stringify(declared)}`,
          );
        }
        const bodyEnd = headEnd + 4 + Number(declared);
        if (received.length < bodyEnd) {
          return;
        }
        const body = received.subarray(headEnd + 4, bodyEnd).toString('utf8');
        firstResponse = { ...head, body };
        received = received.subarray(bodyEnd);
        // Sent only now, so `second` reaches the server strictly after the first response is out.
        socket.write(second);
      } catch (err) {
        socket.destroy(err);
      }
    });
    socket.on('error', reject);
    // After an error the promise is already rejected, and this later settle attempt is ignored.
    socket.on('close', () => {
      const text = JSON.stringify(received.toString('utf8'));
      if (firstResponse === null) {
        reject(new Error(`connection closed before the first response was complete: ${text}`));
        return;
      }
      const headEnd = received.indexOf('\r\n\r\n');
      if (headEnd === -1) {
        reject(
          new Error(
            'connection closed before a second response was complete, after ' +
              `${JSON.stringify(firstResponse.statusLine)}: ${text}`,
          ),
        );
        return;
      }
      try {
        const body = received.subarray(headEnd + 4).toString('utf8');
        resolve({ first: firstResponse, second: { ...parseHead(headEnd), body } });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Runs the real entry point, `node src/server.js`, as a child process with `env` merged over the
 * current environment. No shell is involved (`shell` defaults to `false`).
 *
 * @param {Record<string, string>} env Variables to set in the child, for example `{ PORT: '0' }`.
 * @returns {{
 *   child: import('node:child_process').ChildProcess,
 *   stdout: string,
 *   stderr: string,
 *   closed: Promise<{ code: number | null, signal: string | null }>,
 *   waitForStdout: (text: string) => Promise<void>,
 * }} The child, its output so far (live getters), a promise for its `close` event, and a wait for
 *   a piece of stdout that rejects if the child closes first.
 */
function spawnServer(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exit = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  // Marks the promise as handled, so a spawn failure surfaces where it is awaited (the test or its
  // cleanup) rather than as an unhandled rejection.
  closed.catch(() => undefined);

  function waitForStdout(text) {
    return new Promise((resolve, reject) => {
      const describeExit = (code, signal) =>
        new Error(
          `server exited (code ${code}, signal ${signal}) before printing ${JSON.stringify(text)}; ` +
            `stdout: ${JSON.stringify(stdout)}; stderr: ${JSON.stringify(stderr)}`,
        );
      const cleanup = () => {
        child.stdout.removeListener('data', check);
        child.removeListener('close', onClose);
      };
      // Registered after the accumulating listener above, so `stdout` already holds each chunk.
      function check() {
        if (stdout.includes(text)) {
          cleanup();
          resolve();
        }
      }
      function onClose(code, signal) {
        cleanup();
        reject(describeExit(code, signal));
      }
      child.stdout.on('data', check);
      child.on('close', onClose);
      check();
      if (exit !== null && !stdout.includes(text)) {
        cleanup();
        reject(describeExit(exit.code, exit.signal));
      }
    });
  }

  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    closed,
    waitForStdout,
  };
}

/**
 * Kills a spawned child if it is still running, then waits for it to close. Calling it again once
 * the child has closed only waits on the settled `closed` promise. On Windows `kill()` always
 * terminates forcefully, which is fine here.
 *
 * @param {ReturnType<typeof spawnServer>} spawned A child started by `spawnServer`.
 * @returns {Promise<void>}
 */
async function stopChild(spawned) {
  const { child } = spawned;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
  await spawned.closed;
}

/**
 * Ensures a spawned child does not outlive its test: a cleanup step stops it with `stopChild`, so a
 * test that fails or times out before stopping the child itself still leaves nothing running.
 */
function stopChildAfter(t, spawned) {
  onCleanup(t, () => stopChild(spawned));
}

/**
 * Listens on an OS-assigned port with no host, which binds the same unspecified address the service
 * binds, so a service started on that port collides with it on every platform. The release is
 * registered as a cleanup step before listening, so the test owns the holder even if listening
 * fails; releasing a holder that has already stopped is harmless.
 *
 * The holder only occupies the port and serves nothing, so it destroys every connection it accepts
 * as soon as it arrives. An incidental connection, such as another program probing the port, would
 * otherwise keep `close()` waiting on that peer past the cleanup deadline and keep the runner
 * alive. The release also destroys any accepted socket the holder still tracks before it closes
 * the holder, so shutdown never depends on a peer closing its side.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the holder.
 * @returns {Promise<{ port: number, release: () => Promise<void> }>} The held port, and a release
 *   that resolves once the holder has stopped listening and holds no connection.
 */
function holdPort(t) {
  return new Promise((resolve, reject) => {
    const accepted = new Set();
    const holder = net.createServer((socket) => {
      accepted.add(socket);
      socket.once('close', () => accepted.delete(socket));
      // A socket error with no listener would be thrown as an uncaught exception and end the run.
      socket.on('error', () => undefined);
      socket.destroy();
    });
    const release = () => {
      for (const socket of accepted) {
        socket.destroy();
      }
      return new Promise((resolveClose) => holder.close(() => resolveClose()));
    };
    onCleanup(t, release);
    holder.once('error', reject);
    holder.listen(0, () => {
      holder.removeListener('error', reject);
      resolve({ port: holder.address().port, release });
    });
  });
}

/**
 * Finds a port that is free at the moment of the call. Another process could take it before the
 * child binds it; that would fail the test clearly, never hang it, and never involves port 3000.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the temporary holder.
 * @returns {Promise<number>}
 */
async function findFreePort(t) {
  const { port, release } = await holdPort(t);
  await release();
  return port;
}

/**
 * Runs the entry point with `PORT` set to `raw` and checks the port it selects: stdout must be
 * exactly one readiness line, naming `expectedPort` as a bare decimal number, and GET / on that
 * port must return the default greeting. The child is then stopped, so a test can check several
 * values one after another with only one child running; if an assertion fails first, the cleanup
 * step from `stopChildAfter` stops it.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the child.
 * @param {string} raw The `PORT` value, exactly as the child receives it.
 * @param {number | null} expectedPort The port the readiness line must name, or `null` when the OS
 *   chooses it (`PORT=0`), in which case the line must name a port from 1 to 65535.
 * @returns {Promise<void>}
 */
async function assertServesWithPort(t, raw, expectedPort) {
  const label = `PORT=${JSON.stringify(raw)}`;
  const spawned = spawnServer({ PORT: raw });
  stopChildAfter(t, spawned);

  // The readiness line is all the service prints, and its newline ends it, so this waits for the
  // complete line. A child that exits first rejects the wait, and the label names the value.
  try {
    await spawned.waitForStdout('\n');
  } catch (err) {
    throw new Error(`${label}: ${err.message}`, { cause: err });
  }
  const match = /^Listening on http:\/\/localhost:(\d+)\n$/.exec(spawned.stdout);
  assert.ok(
    match,
    `${label}: stdout must be one readiness line; received ${JSON.stringify(spawned.stdout)}`,
  );
  const port = Number(match[1]);
  if (expectedPort === null) {
    // The line must name the port actually bound, never the 0 that was asked for.
    assert.ok(
      Number.isInteger(port) && port >= 1 && port <= 65535,
      `${label}: the readiness line must name the assigned port; received ${match[1]}`,
    );
  } else {
    assert.strictEqual(port, expectedPort, `${label}: port named by the readiness line`);
  }
  // Compared whole, so a line that repeats PORT's padding or leading zeros fails.
  assert.strictEqual(
    spawned.stdout,
    `Listening on http://localhost:${port}\n`,
    `${label}: readiness line`,
  );

  // The service binds the unspecified address, so the IPv4 loopback reaches it.
  assertText(await request(t, port, { path: '/' }), 200, HELLO_WORLD, `${label}: GET /`);
  await stopChild(spawned);
}

/** Returns the arguments of every call recorded by a `t.mock.method` mock. */
function callArguments(mockFn) {
  return mockFn.mock.calls.map((call) => call.arguments);
}

/**
 * Sends GET requests one after another over one persistent connection and collects each response
 * together with the socket that carried it.
 *
 * `request` gives every exchange its own connection, so it cannot show that a connection survives a
 * response. This helper owns a keep-alive agent limited to one socket and sends each request only
 * after the previous one has closed. For a kept-alive response that means its socket is back in the
 * agent's pool, so the next request reuses it; if the server closed or destroyed the connection,
 * the next request gets a new socket or fails. Each result records the carrying socket and
 * `reusedSocket`, so a test can assert continuity. The agent is destroyed by a cleanup step
 * registered before the first request, which closes the pooled socket, so nothing pooled outlives
 * the test. Each request also registers its own destroy, and the 5-second socket timeout fails a
 * stalled exchange instead of hanging.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the agent and its socket.
 * @param {number} port Port to connect to on 127.0.0.1.
 * @param {string[]} targets Request targets, each sent as a GET, in order.
 * @returns {Promise<Array<{
 *   status: number,
 *   headers: object,
 *   body: string,
 *   socket: import('node:net').Socket,
 *   reusedSocket: boolean,
 * }>>} One result per target: what `request` returns, plus the socket that carried the response
 *   and whether the agent reused it from an earlier exchange.
 */
async function keepAliveRequests(t, port, targets) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  onCleanup(t, () => {
    agent.destroy();
  });
  const results = [];
  for (const target of targets) {
    const result = await new Promise((resolve, reject) => {
      let response = null;
      const req = http.request(
        { host: HOST, port, path: target, agent, timeout: IO_TIMEOUT_MS },
        (res) => {
          // Read while the response is live: a kept-alive socket is detached from it once it ends.
          const { socket } = res;
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            response = {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              socket,
              reusedSocket: req.reusedSocket,
            };
          });
        },
      );
      onCleanup(t, () => {
        req.destroy();
      });
      req.on('timeout', () => req.destroy(new Error(`request for ${target} timed out`)));
      req.on('error', reject);
      // 'close' follows the response's 'end' once the socket is released, back to the pool or
      // closed; earlier, it means the connection ended mid-exchange. After an error the promise is
      // already rejected, and this later settle attempt is ignored.
      req.on('close', () => {
        if (response === null) {
          reject(new Error(`connection closed before the response for ${target} ended`));
        } else {
          resolve(response);
        }
      });
      req.end();
    });
    results.push(result);
  }
  return results;
}

test('T1: GET / returns 200 Hello, world! as plain text with no trailing newline', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);

  const res = await request(t, port, { path: '/' });

  assertText(res, 200, HELLO_WORLD);
  assert.strictEqual(res.headers['content-length'], '13');
});

test('T2: GET /?name=Ada greets Ada, and later requests without a name on the same server get Hello, world!', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  // The order matters: all five requests go to one server, and each request without a name comes
  // after a name was greeted, so a server that remembered the previous name would answer with it.
  const cases = [
    ['/?name=Ada', 'Hello, Ada!'],
    ['/', HELLO_WORLD],
    ['/?name=', HELLO_WORLD],
    ['/?name=Bob', 'Hello, Bob!'],
    ['/', HELLO_WORLD],
  ];

  for (const [target, body] of cases) {
    assertText(await request(t, port, { path: target }), 200, body, target);
  }
  assert.deepStrictEqual(greet('Ada'), { statusCode: 200, body: 'Hello, Ada!' });
});

test('T3: surrounding whitespace in the name, Unicode whitespace included, is trimmed and interior whitespace is kept', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const cases = [
    ['/?name=%20Ada%20', 'Hello, Ada!'],
    ['/?name=+Ada+', 'Hello, Ada!'],
    ['/?name=%09Ada%0A', 'Hello, Ada!'],
    ['/?name=Ada%20Lovelace', 'Hello, Ada Lovelace!'],
  ];

  for (const [target, body] of cases) {
    assertText(await request(t, port, { path: target }), 200, body, target);
  }

  // `String.prototype.trim()` also strips NBSP, the BOM, the other Unicode space separators and
  // the Unicode line terminators, so a trim limited to ASCII whitespace, or one that leaves out
  // the BOM, fails these. U+200B (zero-width space) is not whitespace to `trim()` and stays, so a
  // trim that strips more than that set fails too. Each byte length is written out, not derived
  // from the expected body.
  const unicodeCases = [
    // NBSP (U+00A0) on both sides.
    ['/?name=%C2%A0Ada%C2%A0', 'Hello, Ada!', '11'],
    // BOM (U+FEFF) on both sides; `URLSearchParams` keeps it, so only the trim can remove it.
    ['/?name=%EF%BB%BFAda%EF%BB%BF', 'Hello, Ada!', '11'],
    // Space separators U+1680, U+2000, U+200A before the name; U+202F, U+205F, U+3000 after it.
    ['/?name=%E1%9A%80%E2%80%80%E2%80%8AAda%E2%80%AF%E2%81%9F%E3%80%80', 'Hello, Ada!', '11'],
    // Line separator U+2028, CR and VT before the name; FF and paragraph separator U+2029 after it.
    ['/?name=%E2%80%A8%0D%0BAda%0C%E2%80%A9', 'Hello, Ada!', '11'],
    // An interior NBSP is kept, like an interior space.
    ['/?name=Ada%C2%A0Lovelace', 'Hello, Ada\u00A0Lovelace!', '21'],
    // A surrounding zero-width space is kept, because it is not whitespace.
    ['/?name=%E2%80%8BAda%E2%80%8B', 'Hello, \u200BAda\u200B!', '17'],
  ];

  for (const [target, body, contentLength] of unicodeCases) {
    const res = await request(t, port, { path: target });
    assertText(res, 200, body, target);
    assert.strictEqual(res.headers['content-length'], contentLength, target);
  }
});

test('T4: GET /?name= that is empty, only whitespace, absent or differently cased falls back to Hello, world!', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const targets = ['/?name=', '/?name=%20%20%20', '/?name', '/?', '/?Name=Ada'];

  for (const target of targets) {
    assertText(await request(t, port, { path: target }), 200, HELLO_WORLD, target);
  }
  assert.deepStrictEqual(greet(null), { statusCode: 200, body: HELLO_WORLD });
  assert.deepStrictEqual(greet('   '), { statusCode: 200, body: HELLO_WORLD });

  // A name made only of non-ASCII whitespace is just as blank, because `trim()` strips all of it.
  // A trim limited to ASCII whitespace would greet all three, and one that keeps the BOM the first.
  const unicodeBlankTargets = [
    // NBSP, BOM and ideographic space (U+00A0, U+FEFF, U+3000).
    '/?name=%C2%A0%EF%BB%BF%E3%80%80',
    // Space separators U+1680, U+2000, U+200A, U+202F and U+205F.
    '/?name=%E1%9A%80%E2%80%80%E2%80%8A%E2%80%AF%E2%81%9F',
    // Line and paragraph separators (U+2028, U+2029), VT, FF and CR.
    '/?name=%E2%80%A8%E2%80%A9%0B%0C%0D',
  ];

  for (const target of unicodeBlankTargets) {
    const res = await request(t, port, { path: target });
    assertText(res, 200, HELLO_WORLD, target);
    assert.strictEqual(res.headers['content-length'], '13', target);
  }
  assert.deepStrictEqual(greet('\u00A0\uFEFF\u3000\u2028'), { statusCode: 200, body: HELLO_WORLD });
});

test('T5: a name of exactly 50 characters, with or without surrounding spaces, is greeted', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const name = 'a'.repeat(50);
  const targets = [`/?name=${name}`, `/?name=%20${name}%20`];

  for (const target of targets) {
    assertText(await request(t, port, { path: target }), 200, `Hello, ${name}!`, target);
  }
});

test('T6: a name of 51 characters, with or without surrounding spaces, is rejected with 400', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const name = 'a'.repeat(51);
  const targets = [`/?name=${name}`, `/?name=%20${name}%20`];

  for (const target of targets) {
    const res = await request(t, port, { path: target });
    assertText(res, 400, NAME_TOO_LONG, target);
    assert.strictEqual(res.headers['content-length'], '36', target);
  }
  assert.deepStrictEqual(greet(name), { statusCode: 400, body: NAME_TOO_LONG });
});

test('T7: the 50-character limit counts code points, not UTF-16 units or graphemes, with no normalisation', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const fifty = '\u{1F600}'.repeat(50);
  const fiftyOne = '\u{1F600}'.repeat(51);
  // 50 emoji are 100 UTF-16 units, so a limit counted with `String.length` would reject them.
  assert.strictEqual(fifty.length, 100);

  const accepted = await request(t, port, { path: `/?name=${encodeURIComponent(fifty)}` });
  assertText(accepted, 200, `Hello, ${fifty}!`, '50 emoji');
  assert.strictEqual(accepted.headers['content-length'], '208', '50 emoji');

  const rejected = await request(t, port, { path: `/?name=${encodeURIComponent(fiftyOne)}` });
  assertText(rejected, 400, NAME_TOO_LONG, '51 emoji');

  // Man, ZWJ, woman, ZWJ, girl: one grapheme of 5 code points. Ten of them are 50 code points and
  // are greeted; eleven are 55 and are rejected, although a limit that counted graphemes would see
  // only 11 characters and greet them.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.strictEqual(Array.from(family).length, 5);
  const tenFamilies = family.repeat(10);
  const elevenFamilies = family.repeat(11);

  const families = await request(t, port, { path: `/?name=${encodeURIComponent(tenFamilies)}` });
  assertText(families, 200, `Hello, ${tenFamilies}!`, '10 family sequences');
  assert.strictEqual(families.headers['content-length'], '188', '10 family sequences');

  const tooManyFamilies = await request(t, port, {
    path: `/?name=${encodeURIComponent(elevenFamilies)}`,
  });
  assertText(tooManyFamilies, 400, NAME_TOO_LONG, '11 family sequences');
  assert.strictEqual(tooManyFamilies.headers['content-length'], '36', '11 family sequences');

  // `e` plus a combining acute accent is 2 code points, which NFC would compose into 1. Counted as
  // sent, 25 of them are 50 code points and are greeted with the decomposed text unchanged; 26 are
  // 52 and are rejected, although normalising before counting would see 26 and greet them.
  const acute = 'e\u0301';
  assert.strictEqual(Array.from(acute).length, 2);
  const twentyFiveAcutes = acute.repeat(25);
  const twentySixAcutes = acute.repeat(26);

  const decomposed = await request(t, port, {
    path: `/?name=${encodeURIComponent(twentyFiveAcutes)}`,
  });
  assertText(decomposed, 200, `Hello, ${twentyFiveAcutes}!`, '25 decomposed e-acute');
  assert.strictEqual(decomposed.headers['content-length'], '83', '25 decomposed e-acute');

  const tooManyAcutes = await request(t, port, {
    path: `/?name=${encodeURIComponent(twentySixAcutes)}`,
  });
  assertText(tooManyAcutes, 400, NAME_TOO_LONG, '26 decomposed e-acute');
  assert.strictEqual(tooManyAcutes.headers['content-length'], '36', '26 decomposed e-acute');

  // The echoed name is not normalised either. NFC would return the precomposed `Zo\u00EB` in
  // 12 bytes, and NFKC would turn the U+FB01 ligature into `fi`.
  const combining = await request(t, port, { path: '/?name=Zoe%CC%88' });
  assertText(combining, 200, 'Hello, Zoe\u0308!', 'Zoe%CC%88');
  assert.strictEqual(combining.headers['content-length'], '13', 'Zoe%CC%88');

  const ligature = await request(t, port, { path: '/?name=%EF%AC%81' });
  assertText(ligature, 200, 'Hello, \uFB01!', '%EF%AC%81');
  assert.strictEqual(ligature.headers['content-length'], '11', '%EF%AC%81');
});

test('T8: any path other than / returns 404 Not found. for every method, including HEAD', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const requests = [
    { method: 'GET', path: '/about' },
    { method: 'GET', path: '/about/' },
    { method: 'GET', path: '//' },
    { method: 'GET', path: '/index.html' },
    { method: 'GET', path: '/%2F' },
    // 404 takes precedence over 405 for a non-GET method on an unknown path.
    { method: 'POST', path: '/about' },
  ];

  for (const options of requests) {
    const label = `${options.method} ${options.path}`;
    const res = await request(t, port, options);
    assertText(res, 404, NOT_FOUND, label);
    assert.strictEqual(res.headers['content-length'], '10', label);
  }

  const head = await request(t, port, { method: 'HEAD', path: '/about' });
  assertHead(head, 404, '10', 'HEAD /about');
});

test('T9: any method other than GET on / returns 405 Method not allowed. with Allow: GET, promptly even while a request body is still arriving', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const requests = [
    { method: 'POST', path: '/' },
    { method: 'PUT', path: '/' },
    { method: 'PATCH', path: '/' },
    { method: 'DELETE', path: '/' },
    { method: 'OPTIONS', path: '/' },
    { method: 'PROPFIND', path: '/' },
    // 405 takes precedence over the 400 that the over-long name would otherwise produce.
    { method: 'POST', path: `/?name=${'a'.repeat(51)}` },
  ];

  for (const options of requests) {
    const label = `${options.method} ${options.path}`;
    const res = await request(t, port, options);
    assertText(res, 405, METHOD_NOT_ALLOWED, label);
    assert.strictEqual(res.headers.allow, 'GET', label);
    assert.strictEqual(res.headers['content-length'], '19', label);
  }

  // HEAD declares the length of the 405 body it selects and transfers none; never `0`.
  const head = await request(t, port, { method: 'HEAD', path: '/' });
  assertHead(head, 405, '19', 'HEAD /');
  assert.strictEqual(head.headers.allow, 'GET', 'HEAD /');

  // A request body never holds up the reply. Only part of the declared body is sent before the 405
  // must arrive. The rest follows on the same connection, then a GET, which is answered correctly
  // only if the server consumed exactly the declared body and kept the connection in step.
  const bodyStart = 'the first part of a request body';
  const bodyRest = ', then the rest of it.';
  const contentLength = Buffer.byteLength(bodyStart + bodyRest);
  const { first, second } = await keepAliveExchange(
    t,
    port,
    `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${contentLength}\r\n\r\n${bodyStart}`,
    `${bodyRest}GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  );

  const post = 'POST / while its body is still arriving';
  assert.strictEqual(first.statusLine, 'HTTP/1.1 405 Method Not Allowed', post);
  assertText(first, 405, METHOD_NOT_ALLOWED, post);
  assert.strictEqual(first.headers.allow, 'GET', post);
  assert.strictEqual(first.headers['content-length'], '19', post);
  // The server offers to reuse the connection, so it must read past the rest of the body.
  assert.strictEqual(first.headers.connection, 'keep-alive', post);

  const reused = 'GET / after the rest of the body, on the same connection';
  assert.strictEqual(second.statusLine, 'HTTP/1.1 200 OK', reused);
  assertText(second, 200, HELLO_WORLD, reused);

  assertText(await request(t, port, { path: '/' }), 200, HELLO_WORLD, 'GET / on a new connection');
});

test('T10: a name containing HTML is echoed unescaped as plain text with nosniff', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);

  const res = await request(t, port, { path: '/?name=%3Cb%3EAda%3C%2Fb%3E' });

  assertText(res, 200, 'Hello, <b>Ada</b>!');
});

test('T11: with repeated name parameters the first is used and other parameters are ignored', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);

  assertText(await request(t, port, { path: '/?name=Ada&name=Bob&lang=fr' }), 200, 'Hello, Ada!');
});

test('T12: names are decoded as UTF-8, leniently, with a byte-accurate content-length', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);

  const zoe = await request(t, port, { path: '/?name=Zo%C3%AB' });
  assertText(zoe, 200, 'Hello, Zo\u00EB!', 'Zo%C3%AB');
  // 11 characters but 12 bytes: the length is counted in bytes.
  assert.strictEqual(zoe.headers['content-length'], '12', 'Zo%C3%AB');

  assertText(await request(t, port, { path: '/?name=%ZZ' }), 200, 'Hello, %ZZ!', '%ZZ');

  const invalid = await request(t, port, { path: '/?name=%FF' });
  assertText(invalid, 200, 'Hello, \uFFFD!', '%FF');
  assert.strictEqual(invalid.headers['content-length'], '11', '%FF');
});

test('T13: an unexpected error returns 500, logs no request data, and the server keeps serving', IN_PROCESS_TEST, async (t) => {
  // Throws an error whose message, code and stack frame are all built from the requested name, so
  // logging any of them would reveal who was greeted.
  const leakyGreet = (rawName) => {
    const holder = {
      [rawName]() {
        const err = new Error(`could not greet ${rawName} at /?name=${rawName}`);
        err.code = `ERR_${String(rawName).toUpperCase()}`;
        throw err;
      },
    };
    return holder[rawName]();
  };

  // The privacy assertions below only mean something if the payload really carries the name.
  assert.throws(
    () => leakyGreet('Zelda7f3k'),
    (err) => {
      assert.strictEqual(err.code, 'ERR_ZELDA7F3K');
      assert.match(err.message, /Zelda7f3k/);
      assert.match(err.stack, /at (Object\.)?Zelda7f3k/);
      return true;
    },
  );

  const log = t.mock.method(console, 'error', () => {});
  const port = await startServer(t, { greet: leakyGreet });

  const first = await request(t, port, { path: '/?name=Zelda7f3k' });
  assertText(first, 500, SERVER_ERROR, 'first GET /?name=Zelda7f3k');
  assert.strictEqual(first.headers['content-length'], '21');

  assertText(await request(t, port, { path: '/about' }), 404, NOT_FOUND, 'GET /about after a 500');
  assertText(
    await request(t, port, { path: '/?name=Zelda7f3k' }),
    500,
    SERVER_ERROR,
    'second GET /?name=Zelda7f3k',
  );

  // ERR_ZELDA7F3K is not on the service's allowlist, so only the class label is printed.
  const expected = `${UNEXPECTED_ERROR_LOG} (stage: greeting): Error`;
  assert.strictEqual(log.mock.callCount(), 2);
  assert.deepStrictEqual(callArguments(log), [[expected], [expected]]);

  const logged = callArguments(log)
    .flat()
    .map((value) => String(value))
    .join('\n');
  assert.doesNotMatch(logged, /zelda7f3k/i);
  assert.doesNotMatch(logged, /\?name=/);

  // The thrown values the payload above leaves untried, each selected by a requested name that
  // carries the same token. Every message, thrown string, `name` and subclass name is built from
  // that name, as is the prefixed code, so a diagnostic that read any of them would fail the
  // privacy checks. The other codes are fixed copies of allowlist entries, which the service may
  // print. Those and the prefixed code test selection: only an error whose `code` strictly equals
  // an entry gets that code appended. Each variant's label is the literal the service must print.
  const variantMessage = (rawName) => `could not greet ${rawName} at /?name=${rawName}`;
  // A subclass of a built-in error class, named after the requested name, with that name as its
  // `name` too. AggregateError takes its inner errors before the message.
  const subclassError = (BuiltIn, rawName) => {
    const Subclass = { [rawName]: class extends BuiltIn {} }[rawName];
    const err =
      BuiltIn === AggregateError
        ? new Subclass([new Error(rawName)], variantMessage(rawName))
        : new Subclass(variantMessage(rawName));
    err.name = rawName;
    return err;
  };
  const builtInClasses = [
    [AggregateError, 'AggregateError'],
    [EvalError, 'EvalError'],
    [RangeError, 'RangeError'],
    [ReferenceError, 'ReferenceError'],
    [SyntaxError, 'SyntaxError'],
    [TypeError, 'TypeError'],
    [URIError, 'URIError'],
  ];
  const variants = [
    {
      name: 'Zelda7f3kNamed',
      label: 'Error',
      build: (rawName) => {
        const err = new Error(variantMessage(rawName));
        err.name = rawName;
        return err;
      },
    },
    ...builtInClasses.map(([BuiltIn, label]) => ({
      name: `Zelda7f3k${label}`,
      label,
      build: (rawName) => subclassError(BuiltIn, rawName),
    })),
    // An allowlisted code follows the class label, printed as the allowlist's own string.
    {
      name: 'Zelda7f3kAllowlistedCode',
      label: 'RangeError [ERR_HTTP_INVALID_STATUS_CODE]',
      build: (rawName) => {
        const err = subclassError(RangeError, rawName);
        err.code = 'ERR_HTTP_INVALID_STATUS_CODE';
        return err;
      },
    },
    // Only strict equality selects a code: one that merely contains an allowlisted code, or a
    // boxed string equal to one, is left out.
    {
      name: 'Zelda7f3kPrefixedCode',
      label: 'TypeError',
      build: (rawName) => {
        const err = subclassError(TypeError, rawName);
        err.code = `ECONNRESET_${rawName.toUpperCase()}`;
        return err;
      },
    },
    {
      name: 'Zelda7f3kBoxedCode',
      label: 'Error',
      build: (rawName) => {
        const err = new Error(variantMessage(rawName));
        err.name = rawName;
        err.code = new String('EPIPE');
        return err;
      },
    },
    // A value that is not an error gets the fixed fallback, whatever it contains.
    {
      name: 'Zelda7f3kString',
      label: 'non-Error value thrown',
      build: (rawName) => variantMessage(rawName),
    },
    {
      name: 'Zelda7f3kObject',
      label: 'non-Error value thrown',
      build: (rawName) => ({ name: rawName, message: variantMessage(rawName), code: 'ECONNRESET' }),
    },
  ];
  const variantsByName = new Map(variants.map((variant) => [variant.name, variant]));
  // Throws the variant a requested name selects, and greets every other name as the service does.
  const variantGreet = (rawName) => {
    const variant = variantsByName.get(rawName);
    if (variant === undefined) {
      return greet(rawName);
    }
    throw variant.build(rawName);
  };

  // Again, the privacy checks only mean something if each payload really carries the name.
  for (const { name } of variants) {
    assert.throws(
      () => variantGreet(name),
      (thrown) => {
        if (typeof thrown === 'string') {
          assert.match(thrown, /Zelda7f3k/, name);
          return true;
        }
        assert.strictEqual(thrown.name, name, name);
        assert.match(thrown.message, /Zelda7f3k/, name);
        if (thrown instanceof Error && thrown.constructor !== Error) {
          assert.strictEqual(thrown.constructor.name, name, name);
        }
        return true;
      },
    );
  }

  // Every variant and two greetings, on one keep-alive connection: a 500 that could be written
  // leaves the connection open for the next request.
  log.mock.resetCalls();
  const variantPort = await startServer(t, { greet: variantGreet });
  const failing = ({ name }) => ({ target: `/?name=${name}`, status: 500, body: SERVER_ERROR });
  const greeting = { target: '/?name=Ada', status: 200, body: 'Hello, Ada!' };
  const exchanges = [failing(variants[0]), greeting, ...variants.slice(1).map(failing), greeting];
  const responses = await keepAliveRequests(
    t,
    variantPort,
    exchanges.map(({ target }) => target),
  );

  assert.strictEqual(responses.length, exchanges.length);
  assert.strictEqual(responses[0].reusedSocket, false, 'the first request opens the connection');
  for (const [index, { target, status, body }] of exchanges.entries()) {
    const res = responses[index];
    const label = `keep-alive GET ${target} (#${index + 1})`;
    assertText(res, status, body, label);
    if (status === 500) {
      assert.strictEqual(res.headers['content-length'], '21', label);
      assert.strictEqual(res.headers.connection, 'keep-alive', `${label}: connection`);
    }
    if (index > 0) {
      assert.strictEqual(res.socket, responses[0].socket, `${label}: same connection`);
      assert.strictEqual(res.reusedSocket, true, `${label}: reused connection`);
    }
  }

  // One single-string diagnostic per 500, in order, each holding only the literal label.
  assert.deepStrictEqual(
    callArguments(log),
    variants.map(({ label }) => [`${UNEXPECTED_ERROR_LOG} (stage: greeting): ${label}`]),
  );
  const variantLogged = callArguments(log)
    .flat()
    .map((value) => String(value))
    .join('\n');
  assert.doesNotMatch(variantLogged, /zelda7f3k/i);
  assert.doesNotMatch(variantLogged, /\?name=/);

  assertText(
    await request(t, variantPort, { path: '/?name=Ada' }),
    200,
    'Hello, Ada!',
    'GET /?name=Ada on a new connection',
  );
});

test('T14: PORT selects the listening port of the real entry point', LIFECYCLE_TEST, async (t) => {
  const port = await findFreePort(t);
  await assertServesWithPort(t, String(port), port);

  // The value is trimmed, because cmd's `set PORT=4000 && npm start` leaves a trailing space, and
  // read as decimal digits, so leading zeros are accepted too.
  const spacedPort = await findFreePort(t);
  await assertServesWithPort(t, ` ${spacedPort} `, spacedPort);
  const zeroPaddedPort = await findFreePort(t);
  await assertServesWithPort(t, `0${zeroPaddedPort}`, zeroPaddedPort);

  // PORT=0 lets the OS choose, and the readiness line names the port it assigned.
  await assertServesWithPort(t, '0', null);
});

test('T15: a port already in use prints a message naming the port and exits with code 1', LIFECYCLE_TEST, async (t) => {
  const { port } = await holdPort(t);

  const spawned = spawnServer({ PORT: String(port) });
  stopChildAfter(t, spawned);
  const { code } = await spawned.closed;

  assert.strictEqual(code, 1);
  const message = `Port ${port} is already in use. Stop the other process or set PORT to a free port.`;
  assert.ok(
    spawned.stderr.includes(message),
    `stderr should contain ${JSON.stringify(message)}; received ${JSON.stringify(spawned.stderr)}`,
  );
  assert.strictEqual(spawned.stdout, '');
});

test('T16: an invalid PORT prints an error and exits with code 1 without listening', LIFECYCLE_TEST, async (t) => {
  for (const raw of ['abc', '70000', '-1', '3000.5']) {
    const spawned = spawnServer({ PORT: raw });
    stopChildAfter(t, spawned);
    const { code } = await spawned.closed;

    assert.strictEqual(code, 1, `PORT=${raw}`);
    const message = `Invalid PORT "${raw}": expected a whole number from 0 to 65535.`;
    assert.ok(
      spawned.stderr.includes(message),
      `PORT=${raw}: stderr should contain ${JSON.stringify(message)}; ` +
        `received ${JSON.stringify(spawned.stderr)}`,
    );
    assert.strictEqual(spawned.stdout, '', `PORT=${raw}`);
  }
});

test('T17: CONNECT gets a raw 405 on / and 404 elsewhere, a raw 500 when answering fails, and a closed connection when no 500 is possible', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);

  const onRoot = await rawRequest(t, port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assertRawText(onRoot, 'HTTP/1.1 405 Method Not Allowed', METHOD_NOT_ALLOWED, 'CONNECT /');
  assert.strictEqual(onRoot.headers.allow, 'GET', 'CONNECT /');
  assert.strictEqual(onRoot.headers['content-length'], '19', 'CONNECT /');

  // Any other target is an unknown path: 404 takes precedence over 405, as for other methods.
  const elsewhere = await rawRequest(
    t,
    port,
    'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n',
  );
  assertRawText(elsewhere, 'HTTP/1.1 404 Not Found', NOT_FOUND, 'CONNECT example.com:443');
  assert.strictEqual(elsewhere.headers.allow, undefined, 'CONNECT example.com:443');
  assert.strictEqual(elsewhere.headers['content-length'], '10', 'CONNECT example.com:443');

  // A peer that withholds its end and keeps sending refreshes the listener's idle timeout forever,
  // so the server itself must close a rejected CONNECT once its response is flushed.
  const halfOpenExchange = (text) =>
    new Promise((resolve, reject) => {
      const deadlineMs = 2000;
      const chunks = [];
      let trickle = null;
      const socket = net.connect({ port, host: HOST, allowHalfOpen: true }, () => {
        socket.write(text);
      });
      onCleanup(t, () => {
        socket.destroy();
      });
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `the server kept a half-open CONNECT socket open for ${deadlineMs} ms after its ` +
              `response to ${JSON.stringify(text.split('\r\n')[0])}`,
          ),
        );
        socket.destroy();
      }, deadlineMs);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        trickle = setInterval(() => socket.write('x'), 50);
      });
      socket.on('error', (err) => {
        // Once the trickle starts, EPIPE or ECONNRESET is how a server-side close shows up.
        if (trickle === null) {
          reject(err);
        }
      });
      socket.on('close', () => {
        clearTimeout(deadline);
        clearInterval(trickle);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

  const halfOpenRoot = parseRawResponse(
    await halfOpenExchange('CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
  );
  assertRawText(
    halfOpenRoot,
    'HTTP/1.1 405 Method Not Allowed',
    METHOD_NOT_ALLOWED,
    'half-open CONNECT /',
  );
  assert.strictEqual(halfOpenRoot.headers.allow, 'GET', 'half-open CONNECT /');

  // Force a failure before the response is committed: the listener reads the reason phrase for 405
  // from `http.STATUS_CODES` while building it. The original data property is restored straight
  // after the request, and again in `t.after` should the request itself fail.
  const original = Object.getOwnPropertyDescriptor(http.STATUS_CODES, '405');
  assert.strictEqual(original.value, 'Method Not Allowed');
  const restore = () => Object.defineProperty(http.STATUS_CODES, '405', original);
  onCleanup(t, restore);
  const breakStatusLookup = () =>
    Object.defineProperty(http.STATUS_CODES, '405', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('status lookup failed');
      },
    });

  const log = t.mock.method(console, 'error', () => {});
  breakStatusLookup();
  let failed;
  try {
    failed = await rawRequest(t, port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  } finally {
    restore();
  }

  assertRawText(failed, 'HTTP/1.1 500 Internal Server Error', SERVER_ERROR, 'failing CONNECT /');
  assert.strictEqual(failed.headers['content-length'], '21', 'failing CONNECT /');
  assert.strictEqual(log.mock.callCount(), 1);
  assert.deepStrictEqual(callArguments(log), [[`${UNEXPECTED_ERROR_LOG} (stage: connect): Error`]]);

  log.mock.resetCalls();
  breakStatusLookup();
  let halfOpenFailedText;
  try {
    halfOpenFailedText = await halfOpenExchange('CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  } finally {
    restore();
  }
  assertRawText(
    parseRawResponse(halfOpenFailedText),
    'HTTP/1.1 500 Internal Server Error',
    SERVER_ERROR,
    'half-open failing CONNECT /',
  );
  assert.deepStrictEqual(callArguments(log), [[`${UNEXPECTED_ERROR_LOG} (stage: connect): Error`]]);

  // From here every `end` on this server's accepted sockets throws. Client sockets keep the real
  // method, because `net` ends them itself once the server's side closes. Each exchange must close
  // with nothing received: a socket the listener left open would instead time out and reject.
  const realEnd = net.Socket.prototype.end;
  const end = t.mock.method(net.Socket.prototype, 'end', function (...args) {
    if (this.localPort === port) {
      throw new Error('end failed');
    }
    return realEnd.apply(this, args);
  });
  try {
    // Writing the committed 405 fails: no 500 may follow a committed response, so the listener
    // destroys the socket after its one diagnostic.
    log.mock.resetCalls();
    const committed = await rawExchange(t, port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    assert.strictEqual(committed, '', 'a CONNECT response that fails once committed gets no 500');
    assert.deepStrictEqual(callArguments(log), [
      [`${UNEXPECTED_ERROR_LOG} (stage: connect): Error`],
    ]);

    // Failing before the commit, as above, while the raw 500 cannot be written either: the listener
    // logs both failures and destroys the socket.
    log.mock.resetCalls();
    breakStatusLookup();
    let unrecoverable;
    try {
      unrecoverable = await rawExchange(t, port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    } finally {
      restore();
    }
    assert.strictEqual(unrecoverable, '', 'a CONNECT whose raw 500 also fails gets nothing');
    assert.deepStrictEqual(callArguments(log), [
      [`${UNEXPECTED_ERROR_LOG} (stage: connect): Error`],
      ['Could not send the 500 response: Error'],
    ]);
  } finally {
    end.mock.restore();
  }

  // With the response-writing overrides restored, CONNECT is answered normally again.
  const recovered = await rawRequest(t, port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assertRawText(
    recovered,
    'HTTP/1.1 405 Method Not Allowed',
    METHOD_NOT_ALLOWED,
    'CONNECT / after the failures',
  );
  assert.strictEqual(recovered.headers.allow, 'GET', 'CONNECT / after the failures');

  assertText(await request(t, port, { path: '/' }), 200, HELLO_WORLD, 'GET / after CONNECT');
});

test('T18: a method token the parser does not recognise gets Node native 400 and the server keeps serving', IN_PROCESS_TEST, async (t) => {
  // The framing assertions below only mean something if bytes cut off before the blank line that
  // ends the head fail to parse, instead of reading as a complete head with an empty body.
  const truncated = 'HTTP/1.1 400 Bad Request\r\nConnection: close';
  assert.throws(() => parseRawResponse(truncated), {
    message:
      'Raw response ends before the blank line that closes its head: ' + JSON.stringify(truncated),
  });

  const port = await startServer(t);

  for (const requestLine of ['FOO / HTTP/1.1', 'get / HTTP/1.1']) {
    const res = await rawRequest(t, port, `${requestLine}\r\nHost: 127.0.0.1\r\n\r\n`);
    assert.strictEqual(res.statusLine, 'HTTP/1.1 400 Bad Request', requestLine);
    assert.strictEqual(res.headers['content-type'], undefined, requestLine);
    assert.deepStrictEqual(res.headers, { connection: 'close' }, requestLine);
    assert.strictEqual(res.body, '', requestLine);
  }

  assertText(await request(t, port, { path: '/' }), 200, HELLO_WORLD, 'GET / after native 400s');
});

test('T19: when the 500 cannot be written, or headers were already sent, the connection is destroyed and the server keeps serving', IN_PROCESS_TEST, async (t) => {
  const port = await startServer(t);
  const log = t.mock.method(console, 'error', () => {});
  // Only server responses use `ServerResponse.prototype.writeHead`; the test client does not.
  const writeHead = t.mock.method(http.ServerResponse.prototype, 'writeHead', () => {
    throw new Error('write failed');
  });

  await assert.rejects(request(t, port, { path: '/' }), (err) => {
    assert.strictEqual(err.code, 'ECONNRESET');
    return true;
  });
  assert.strictEqual(log.mock.callCount(), 2);
  assert.deepStrictEqual(callArguments(log), [
    [`${UNEXPECTED_ERROR_LOG} (stage: responding): Error`],
    ['Could not send the 500 response: Error'],
  ]);

  writeHead.mock.restore();
  assertText(
    await request(t, port, { path: '/' }),
    200,
    HELLO_WORLD,
    'GET / after a destroyed connection',
  );

  // Now fail after the status line is committed: the real `writeHead` runs and its head is flushed
  // to the client before the throw, so no 500 can replace it. The connection must end with only
  // that head delivered, and only the handling failure is logged, since no 500 is attempted.
  log.mock.resetCalls();
  const realWriteHead = http.ServerResponse.prototype.writeHead;
  const committedWriteHead = t.mock.method(
    http.ServerResponse.prototype,
    'writeHead',
    function (...args) {
      realWriteHead.apply(this, args);
      this.flushHeaders();
      throw new Error('failed after the head was sent');
    },
  );
  let cutShort;
  try {
    // A raw client shows exactly what arrived; `http.request` would report only the abort.
    cutShort = await rawRequest(t, port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  } finally {
    committedWriteHead.mock.restore();
  }

  assert.strictEqual(cutShort.statusLine, 'HTTP/1.1 200 OK', 'committed GET /');
  assert.strictEqual(cutShort.headers['content-type'], TEXT_TYPE, 'committed GET /');
  assert.strictEqual(cutShort.headers['content-length'], '13', 'committed GET /');
  assert.strictEqual(cutShort.body, '', 'the connection ends before any of the declared body');
  assert.deepStrictEqual(callArguments(log), [
    [`${UNEXPECTED_ERROR_LOG} (stage: responding): Error`],
  ]);

  assertText(
    await request(t, port, { path: '/' }),
    200,
    HELLO_WORLD,
    'GET / after a committed response was destroyed',
  );
});

test('T20: an unreadable error and a failing console still produce the 500, and the server keeps serving', IN_PROCESS_TEST, async (t) => {
  // An error whose `code` and `stack` cannot even be read.
  const unreadableGreet = () => {
    const err = new Error('greeting failed');
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('code getter');
      },
    });
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('stack getter');
      },
    });
    throw err;
  };

  const log = t.mock.method(console, 'error', () => {});
  const port = await startServer(t, { greet: unreadableGreet });

  const first = await request(t, port, { path: '/' });
  assertText(first, 500, SERVER_ERROR, 'unreadable error');
  assert.strictEqual(first.headers['content-length'], '21');
  const expected = `${UNEXPECTED_ERROR_LOG} (stage: greeting): error details unavailable`;
  assert.deepStrictEqual(log.mock.calls[0].arguments, [expected]);

  // The next diagnostic throws inside the console; answering the client must not depend on it.
  log.mock.mockImplementationOnce(() => {
    throw new Error('console failed');
  });
  assertText(await request(t, port, { path: '/' }), 500, SERVER_ERROR, 'failing console');

  assertText(await request(t, port, { path: '/about' }), 404, NOT_FOUND, 'GET /about afterwards');

  assert.strictEqual(log.mock.callCount(), 2);
  assert.deepStrictEqual(log.mock.calls[1].arguments, [expected]);
  assert.ok(log.mock.calls[1].error instanceof Error, 'the second console call threw');
  assert.strictEqual(log.mock.calls[1].error.message, 'console failed');

  // The 500 for an unreadable error leaves a keep-alive connection open for the next request too.
  const [failed, after] = await keepAliveRequests(t, port, ['/', '/about']);
  assertText(failed, 500, SERVER_ERROR, 'keep-alive unreadable error');
  assert.strictEqual(failed.headers['content-length'], '21', 'keep-alive unreadable error');
  assert.strictEqual(failed.headers.connection, 'keep-alive', 'keep-alive unreadable error');
  assertText(after, 404, NOT_FOUND, 'keep-alive GET /about after the 500');
  assert.strictEqual(after.socket, failed.socket, 'GET /about rides the connection of the 500');
  assert.strictEqual(after.reusedSocket, true, 'GET /about reuses the connection of the 500');

  // That 500 adds exactly one diagnostic, and the console no longer throws.
  assert.strictEqual(log.mock.callCount(), 3);
  assert.deepStrictEqual(log.mock.calls[2].arguments, [expected]);
  assert.strictEqual(log.mock.calls[2].error, undefined, 'the third console call returned');
});
