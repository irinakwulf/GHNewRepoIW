'use strict';

/**
 * Test suite for hello-service (`src/server.js`), run by `npm test`.
 *
 * It covers every row of the service's interface, both sides of the 50/51 name-length boundary,
 * CONNECT and the parser's method boundary, the 500 and failed-recovery paths, and the start-up
 * lifecycle: cases T1 to T20, one top-level test each.
 *
 * Isolation and portability:
 * - Every server listens on an OS-assigned port on the 127.0.0.1 loopback, so the run needs no
 *   network, no DNS, and never needs port 3000 to be free.
 * - Every server, socket and child process a test opens is closed or killed in that test's own
 *   `t.after`, and every wait is bounded by a socket or test timeout, so the run exits on its own.
 * - Child processes run `process.execPath` on an absolute path built with `path.join`, with no
 *   shell, so the suite behaves the same on macOS, Linux and Windows.
 * - Top-level tests in one file run one at a time (the `node:test` default). T17 and T19 rely on
 *   that, because each briefly overrides a process-wide built-in and restores it before it ends.
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

/** Loopback address for every client connection; never `localhost`, so no DNS or IPv6 ordering. */
const HOST = '127.0.0.1';

/** Media type every application-generated response must carry. */
const TEXT_TYPE = 'text/plain; charset=utf-8';

/** The fixed response bodies, character for character, with no trailing newline. */
const HELLO_WORLD = 'Hello, world!';
const NAME_TOO_LONG = 'Name must be 50 characters or fewer.';
const NOT_FOUND = 'Not found.';
const METHOD_NOT_ALLOWED = 'Method not allowed.';
const SERVER_ERROR = 'Something went wrong.';

/** Upper bound on any single client exchange, so a stalled response fails instead of hanging. */
const IO_TIMEOUT_MS = 5000;

/** Options for each test that spawns the real entry point: a bound on the whole test. */
const LIFECYCLE_TEST = Object.freeze({ timeout: 10000 });

/** Diagnostic prefix the service logs for an exception raised while a request is handled. */
const UNEXPECTED_ERROR_LOG = 'Unexpected error while handling a request';

/**
 * Starts a fresh in-process server on an OS-assigned loopback port and registers its shutdown.
 *
 * `closeAllConnections()` ends any keep-alive socket before the awaited `close()`, so shutdown never
 * waits on an idle connection. Sockets handed to the CONNECT listener are outside that call; they
 * close when the raw client ends its side, and in any case within the listener's own idle timeout.
 *
 * @param {import('node:test').TestContext} t The running test, which owns the server.
 * @param {{ greet?: Function }} [options] Passed through to `createServer`.
 * @returns {Promise<number>} The port the server is listening on.
 */
function startServer(t, options) {
  const server = createServer(options);
  t.after(() => {
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
 * caller can check its `code` (for example `ECONNRESET` for a destroyed connection).
 *
 * @param {number} port Port on 127.0.0.1.
 * @param {{ method?: string, path?: string }} [options] Method (default `GET`) and request target
 *   (default `/`).
 * @returns {Promise<{ status: number, headers: object, body: string }>} The status code, the
 *   lower-cased response headers, and the body decoded as UTF-8.
 */
function request(port, { method = 'GET', path: target = '/' } = {}) {
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
 * @param {string} text Everything received on the connection.
 * @returns {{ statusLine: string, headers: object, body: string }}
 */
function parseRawResponse(text) {
  const headEnd = text.indexOf('\r\n\r\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const body = headEnd === -1 ? '' : text.slice(headEnd + 4);
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
 * until it closes the connection.
 *
 * Used for CONNECT, whose response `http.request` would deliver through its own `connect` event,
 * and for unrecognised method tokens, which `http.request` would upper-case or refuse to send.
 * When the server ends its side, this client ends its side too (the `net` default), so the server
 * socket closes promptly. A 5-second idle timeout destroys a stalled connection and rejects.
 *
 * @param {number} port Port on 127.0.0.1.
 * @param {string} text The complete raw request, including the blank line that ends the head.
 * @returns {Promise<{ statusLine: string, headers: object, body: string }>}
 */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, HOST, () => socket.write(text));
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy(new Error('raw request timed out')));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    // After an error the promise is already rejected, and this later settle attempt is ignored.
    socket.on('close', () => {
      try {
        resolve(parseRawResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
  });
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
  closed.catch(() => {});

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
 * Ensures a spawned child does not outlive its test: kills it if it is still running, then waits
 * for it to close. On Windows `kill()` always terminates forcefully, which is fine here.
 */
function stopChildAfter(t, spawned) {
  t.after(async () => {
    const { child } = spawned;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await spawned.closed;
  });
}

/**
 * Listens on an OS-assigned port with no host, which binds the same unspecified address the service
 * binds, so a service started on that port collides with it on every platform.
 *
 * @returns {Promise<import('node:net').Server>}
 */
function holdPort() {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.once('error', reject);
    holder.listen(0, () => {
      holder.removeListener('error', reject);
      resolve(holder);
    });
  });
}

/** Closes a `net` server and resolves once it has stopped listening. */
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Finds a port that is free at the moment of the call. Another process could take it before the
 * child binds it; that would fail the test clearly, never hang it, and never involves port 3000.
 *
 * @returns {Promise<number>}
 */
async function findFreePort() {
  const holder = await holdPort();
  const { port } = holder.address();
  await closeServer(holder);
  return port;
}

/** Returns the arguments of every call recorded by a `t.mock.method` mock. */
function callArguments(mockFn) {
  return mockFn.mock.calls.map((call) => call.arguments);
}

// ---------------------------------------------------------------------------------------------
// Interface rows: greeting, trimming, fallback, length boundary, routes and methods (T1 to T12)
// ---------------------------------------------------------------------------------------------

test('T1: GET / returns 200 Hello, world! as plain text with no trailing newline', async (t) => {
  const port = await startServer(t);

  const res = await request(port, { path: '/' });

  assertText(res, 200, HELLO_WORLD);
  assert.strictEqual(res.headers['content-length'], '13');
});

test('T2: GET /?name=Ada greets Ada', async (t) => {
  const port = await startServer(t);

  assertText(await request(port, { path: '/?name=Ada' }), 200, 'Hello, Ada!');
  assert.deepStrictEqual(greet('Ada'), { statusCode: 200, body: 'Hello, Ada!' });
});

test('T3: surrounding whitespace in the name is trimmed and interior spaces are kept', async (t) => {
  const port = await startServer(t);
  const cases = [
    ['/?name=%20Ada%20', 'Hello, Ada!'],
    ['/?name=+Ada+', 'Hello, Ada!'],
    ['/?name=%09Ada%0A', 'Hello, Ada!'],
    ['/?name=Ada%20Lovelace', 'Hello, Ada Lovelace!'],
  ];

  for (const [target, body] of cases) {
    assertText(await request(port, { path: target }), 200, body, target);
  }
});

test('T4: GET /?name= that is empty, only spaces, absent or differently cased falls back to Hello, world!', async (t) => {
  const port = await startServer(t);
  const targets = ['/?name=', '/?name=%20%20%20', '/?name', '/?', '/?Name=Ada'];

  for (const target of targets) {
    assertText(await request(port, { path: target }), 200, HELLO_WORLD, target);
  }
  assert.deepStrictEqual(greet(null), { statusCode: 200, body: HELLO_WORLD });
  assert.deepStrictEqual(greet('   '), { statusCode: 200, body: HELLO_WORLD });
});

test('T5: a name of exactly 50 characters, with or without surrounding spaces, is greeted', async (t) => {
  const port = await startServer(t);
  const name = 'a'.repeat(50);
  const targets = [`/?name=${name}`, `/?name=%20${name}%20`];

  for (const target of targets) {
    assertText(await request(port, { path: target }), 200, `Hello, ${name}!`, target);
  }
});

test('T6: a name of 51 characters, with or without surrounding spaces, is rejected with 400', async (t) => {
  const port = await startServer(t);
  const name = 'a'.repeat(51);
  const targets = [`/?name=${name}`, `/?name=%20${name}%20`];

  for (const target of targets) {
    const res = await request(port, { path: target });
    assertText(res, 400, NAME_TOO_LONG, target);
    assert.strictEqual(res.headers['content-length'], '36', target);
  }
  assert.deepStrictEqual(greet(name), { statusCode: 400, body: NAME_TOO_LONG });
});

test('T7: the 50-character limit counts code points, so 50 emoji are greeted and 51 are rejected', async (t) => {
  const port = await startServer(t);
  const fifty = '\u{1F600}'.repeat(50);
  const fiftyOne = '\u{1F600}'.repeat(51);
  // 50 emoji are 100 UTF-16 units, so a limit counted with `String.length` would reject them.
  assert.strictEqual(fifty.length, 100);

  const accepted = await request(port, { path: `/?name=${encodeURIComponent(fifty)}` });
  assertText(accepted, 200, `Hello, ${fifty}!`, '50 emoji');
  assert.strictEqual(accepted.headers['content-length'], '208', '50 emoji');

  const rejected = await request(port, { path: `/?name=${encodeURIComponent(fiftyOne)}` });
  assertText(rejected, 400, NAME_TOO_LONG, '51 emoji');
});

test('T8: any path other than / returns 404 Not found. for every method, including HEAD', async (t) => {
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
    const res = await request(port, options);
    assertText(res, 404, NOT_FOUND, label);
    assert.strictEqual(res.headers['content-length'], '10', label);
  }

  const head = await request(port, { method: 'HEAD', path: '/about' });
  assertHead(head, 404, '10', 'HEAD /about');
});

test('T9: any method other than GET on / returns 405 Method not allowed. with Allow: GET', async (t) => {
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
    const res = await request(port, options);
    assertText(res, 405, METHOD_NOT_ALLOWED, label);
    assert.strictEqual(res.headers.allow, 'GET', label);
    assert.strictEqual(res.headers['content-length'], '19', label);
  }

  // HEAD declares the length of the 405 body it selects and transfers none; never `0`.
  const head = await request(port, { method: 'HEAD', path: '/' });
  assertHead(head, 405, '19', 'HEAD /');
  assert.strictEqual(head.headers.allow, 'GET', 'HEAD /');
});

test('T10: a name containing HTML is echoed unescaped as plain text with nosniff', async (t) => {
  const port = await startServer(t);

  const res = await request(port, { path: '/?name=%3Cb%3EAda%3C%2Fb%3E' });

  assertText(res, 200, 'Hello, <b>Ada</b>!');
});

test('T11: with repeated name parameters the first is used and other parameters are ignored', async (t) => {
  const port = await startServer(t);

  assertText(await request(port, { path: '/?name=Ada&name=Bob&lang=fr' }), 200, 'Hello, Ada!');
});

test('T12: names are decoded as UTF-8, leniently, with a byte-accurate content-length', async (t) => {
  const port = await startServer(t);

  const zoe = await request(port, { path: '/?name=Zo%C3%AB' });
  assertText(zoe, 200, 'Hello, Zo\u00EB!', 'Zo%C3%AB');
  // 11 characters but 12 bytes: the length is counted in bytes.
  assert.strictEqual(zoe.headers['content-length'], '12', 'Zo%C3%AB');

  assertText(await request(port, { path: '/?name=%ZZ' }), 200, 'Hello, %ZZ!', '%ZZ');

  const invalid = await request(port, { path: '/?name=%FF' });
  assertText(invalid, 200, 'Hello, \uFFFD!', '%FF');
  assert.strictEqual(invalid.headers['content-length'], '11', '%FF');
});


// ---------------------------------------------------------------------------------------------
// Error boundary, start-up lifecycle, CONNECT and the parser boundary (T13 to T20)
// ---------------------------------------------------------------------------------------------

test('T13: an unexpected error returns 500, logs no request data, and the server keeps serving', async (t) => {
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

  const first = await request(port, { path: '/?name=Zelda7f3k' });
  assertText(first, 500, SERVER_ERROR, 'first GET /?name=Zelda7f3k');
  assert.strictEqual(first.headers['content-length'], '21');

  assertText(await request(port, { path: '/about' }), 404, NOT_FOUND, 'GET /about after a 500');
  assertText(
    await request(port, { path: '/?name=Zelda7f3k' }),
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
});

test('T14: PORT selects the listening port of the real entry point', LIFECYCLE_TEST, async (t) => {
  const port = await findFreePort();
  const spawned = spawnServer({ PORT: String(port) });
  stopChildAfter(t, spawned);

  const line = `Listening on http://localhost:${port}`;
  await spawned.waitForStdout(`${line}\n`);
  assert.strictEqual(spawned.stdout, `${line}\n`);

  // The service binds the unspecified address, so the IPv4 loopback reaches it.
  assertText(await request(port, { path: '/' }), 200, HELLO_WORLD);
});

test('T15: a port already in use prints a message naming the port and exits with code 1', LIFECYCLE_TEST, async (t) => {
  const holder = await holdPort();
  t.after(() => closeServer(holder));
  const { port } = holder.address();

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

test('T17: CONNECT gets a raw 405 on / and 404 elsewhere, and a raw 500 when answering fails', async (t) => {
  const port = await startServer(t);

  const onRoot = await rawRequest(port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assertRawText(onRoot, 'HTTP/1.1 405 Method Not Allowed', METHOD_NOT_ALLOWED, 'CONNECT /');
  assert.strictEqual(onRoot.headers.allow, 'GET', 'CONNECT /');
  assert.strictEqual(onRoot.headers['content-length'], '19', 'CONNECT /');

  // Any other target is an unknown path: 404 takes precedence over 405, as for other methods.
  const elsewhere = await rawRequest(
    port,
    'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n',
  );
  assertRawText(elsewhere, 'HTTP/1.1 404 Not Found', NOT_FOUND, 'CONNECT example.com:443');
  assert.strictEqual(elsewhere.headers.allow, undefined, 'CONNECT example.com:443');
  assert.strictEqual(elsewhere.headers['content-length'], '10', 'CONNECT example.com:443');

  // Force a failure before the response is committed: the listener reads the reason phrase for 405
  // from `http.STATUS_CODES` while building it. The original data property is restored straight
  // after the request, and again in `t.after` should the request itself fail.
  const original = Object.getOwnPropertyDescriptor(http.STATUS_CODES, '405');
  assert.strictEqual(original.value, 'Method Not Allowed');
  const restore = () => Object.defineProperty(http.STATUS_CODES, '405', original);
  t.after(restore);

  const log = t.mock.method(console, 'error', () => {});
  Object.defineProperty(http.STATUS_CODES, '405', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('status lookup failed');
    },
  });
  let failed;
  try {
    failed = await rawRequest(port, 'CONNECT / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  } finally {
    restore();
  }

  assertRawText(failed, 'HTTP/1.1 500 Internal Server Error', SERVER_ERROR, 'failing CONNECT /');
  assert.strictEqual(failed.headers['content-length'], '21', 'failing CONNECT /');
  assert.strictEqual(log.mock.callCount(), 1);
  assert.deepStrictEqual(callArguments(log), [[`${UNEXPECTED_ERROR_LOG} (stage: connect): Error`]]);

  // The same server keeps serving ordinary requests.
  assertText(await request(port, { path: '/' }), 200, HELLO_WORLD, 'GET / after CONNECT');
});

test('T18: a method token the parser does not recognise gets Node native 400 and the server keeps serving', async (t) => {
  const port = await startServer(t);

  for (const requestLine of ['FOO / HTTP/1.1', 'get / HTTP/1.1']) {
    const res = await rawRequest(port, `${requestLine}\r\nHost: 127.0.0.1\r\n\r\n`);
    assert.strictEqual(res.statusLine, 'HTTP/1.1 400 Bad Request', requestLine);
    assert.strictEqual(res.headers['content-type'], undefined, requestLine);
    assert.deepStrictEqual(res.headers, { connection: 'close' }, requestLine);
    assert.strictEqual(res.body, '', requestLine);
  }

  assertText(await request(port, { path: '/' }), 200, HELLO_WORLD, 'GET / after native 400s');
});

test('T19: when the 500 cannot be written either, the connection is destroyed and the server keeps serving', async (t) => {
  const port = await startServer(t);
  const log = t.mock.method(console, 'error', () => {});
  // Only server responses use `ServerResponse.prototype.writeHead`; the test client does not.
  const writeHead = t.mock.method(http.ServerResponse.prototype, 'writeHead', () => {
    throw new Error('write failed');
  });

  await assert.rejects(request(port, { path: '/' }), (err) => {
    assert.strictEqual(err.code, 'ECONNRESET');
    return true;
  });
  assert.strictEqual(log.mock.callCount(), 2);
  assert.deepStrictEqual(callArguments(log), [
    [`${UNEXPECTED_ERROR_LOG} (stage: responding): Error`],
    ['Could not send the 500 response: Error'],
  ]);

  writeHead.mock.restore();
  assertText(await request(port, { path: '/' }), 200, HELLO_WORLD, 'GET / after a destroyed connection');
});

test('T20: an unreadable error and a failing console still produce the 500, and the server keeps serving', async (t) => {
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

  const first = await request(port, { path: '/' });
  assertText(first, 500, SERVER_ERROR, 'unreadable error');
  assert.strictEqual(first.headers['content-length'], '21');
  const expected = `${UNEXPECTED_ERROR_LOG} (stage: greeting): error details unavailable`;
  assert.deepStrictEqual(log.mock.calls[0].arguments, [expected]);

  // The next diagnostic throws inside the console; answering the client must not depend on it.
  log.mock.mockImplementationOnce(() => {
    throw new Error('console failed');
  });
  assertText(await request(port, { path: '/' }), 500, SERVER_ERROR, 'failing console');

  assertText(await request(port, { path: '/about' }), 404, NOT_FOUND, 'GET /about afterwards');

  assert.strictEqual(log.mock.callCount(), 2);
  assert.deepStrictEqual(log.mock.calls[1].arguments, [expected]);
  assert.ok(log.mock.calls[1].error instanceof Error, 'the second console call threw');
  assert.strictEqual(log.mock.calls[1].error.message, 'console failed');
});
