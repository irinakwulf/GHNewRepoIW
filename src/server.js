'use strict';

/**
 * hello-service: a tiny, stateless, plain-text greeting service built only on Node's `http` module.
 *
 * Interface (every application-generated response is `text/plain; charset=utf-8` with
 * `X-Content-Type-Options: nosniff`, a byte-accurate `Content-Length` and no trailing newline):
 *
 *   GET /                         -> 200 "Hello, world!"
 *   GET /?name=Ada                -> 200 "Hello, Ada!"  (surrounding whitespace trimmed)
 *   GET /?name= (blank or absent) -> 200 "Hello, world!"
 *   name over 50 code points      -> 400 "Name must be 50 characters or fewer."
 *   any other path                -> 404 "Not found."
 *   any non-GET method on /       -> 405 "Method not allowed." with "Allow: GET"
 *   an unexpected error           -> 500 "Something went wrong.", or a destroyed connection when a
 *                                    replacement response can no longer be written
 *
 * Precedence when several checks fail: 404, then 405, then 400, then 200.
 * CONNECT gets the same 405/404 rules through its own listener. Method tokens Node's parser does not
 * recognise get Node's native 400 before any listener runs.
 *
 * Configuration: the optional `PORT` environment variable, default 3000, read once at start-up.
 * The server listens only when this file is run directly (`node src/server.js` or `npm start`);
 * requiring it, as the tests do, only exposes `createServer` and `greet`.
 *
 * Statelessness: module scope holds only constants, frozen lookup tables and function declarations.
 * Nothing about a request, including the greeted name, is stored, written to disk or logged.
 */

const http = require('node:http');

/** Longest accepted name, in Unicode code points, measured after trimming. */
const MAX_NAME_LENGTH = 50;

/** Port used when `PORT` is unset or blank. */
const DEFAULT_PORT = 3000;

/** Media type of every response the service generates. */
const CONTENT_TYPE = 'text/plain; charset=utf-8';

/** Idle lifetime of a socket handed to the CONNECT listener, which Node's request timeouts no longer cover. */
const CONNECT_SOCKET_TIMEOUT_MS = 5000;

/** The fixed response bodies. Each has no trailing newline, so `curl` prints exactly this text. */
const MESSAGES = Object.freeze({
  helloWorld: 'Hello, world!',
  nameTooLong: 'Name must be 50 characters or fewer.',
  notFound: 'Not found.',
  methodNotAllowed: 'Method not allowed.',
  serverError: 'Something went wrong.',
});

/**
 * Built-in error classes paired with literal labels for diagnostics. `Error` is last because every
 * other class inherits from it. Labels are literals so that `err.name` or a subclass name, which a
 * caller can set from request data, never reaches the console.
 */
const ERROR_LABELS = Object.freeze([
  Object.freeze([AggregateError, 'AggregateError']),
  Object.freeze([EvalError, 'EvalError']),
  Object.freeze([RangeError, 'RangeError']),
  Object.freeze([ReferenceError, 'ReferenceError']),
  Object.freeze([SyntaxError, 'SyntaxError']),
  Object.freeze([TypeError, 'TypeError']),
  Object.freeze([URIError, 'URIError']),
  Object.freeze([Error, 'Error']),
]);

/** Error codes worth printing. A code is printed only when it strictly equals one of these literals. */
const KNOWN_ERROR_CODES = Object.freeze([
  'ERR_HTTP_HEADERS_SENT',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_HTTP_INVALID_STATUS_CODE',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_OUT_OF_RANGE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ECONNRESET',
  'EMFILE',
  'ENFILE',
  'EPIPE',
]);

/**
 * Chooses the response for a decoded `name` query value. Pure: the result depends only on `rawName`,
 * and a fresh object is returned on every call.
 *
 * - The name is trimmed with `String.prototype.trim()`, which removes leading and trailing whitespace
 *   and line terminators (space, tab, CR, LF, VT, FF, NBSP, BOM, Unicode space separators) and keeps
 *   interior whitespace, so "Ada Lovelace" keeps its inner space.
 * - An absent (`null`/`undefined`) or blank name falls back to "Hello, world!".
 * - A trimmed name longer than 50 Unicode code points is rejected with status 400 and no greeting.
 * - Any other name is echoed exactly as given. Nothing is escaped or rejected: `<b>` stays `<b>`,
 *   because the response is plain text with `nosniff`, so no browser renders it as HTML.
 *
 * @example
 *   greet(' Ada ');          // { statusCode: 200, body: 'Hello, Ada!' }
 *   greet(null);             // { statusCode: 200, body: 'Hello, world!' }
 *   greet('a'.repeat(51));   // { statusCode: 400, body: 'Name must be 50 characters or fewer.' }
 *
 * @param {string | null | undefined} rawName The decoded value of the first `name` query parameter,
 *   or `null` when the parameter is absent.
 * @returns {{ statusCode: 200 | 400, body: string }} The status code and exact body to send.
 */
function greet(rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';

  if (name === '') {
    return { statusCode: 200, body: MESSAGES.helloWorld };
  }

  // Count Unicode code points rather than `name.length`, which counts UTF-16 units and would make
  // each emoji count twice. Grapheme counting (`Intl.Segmenter`) depends on the ICU build, whereas
  // code points give the same answer on every Node build. No normalisation is applied.
  if (Array.from(name).length > MAX_NAME_LENGTH) {
    return { statusCode: 400, body: MESSAGES.nameTooLong };
  }

  return { statusCode: 200, body: 'Hello, ' + name + '!' };
}

/** Builds the plain-text headers every generated response carries, plus any extras such as `Allow`. */
function textHeaders(body, extraHeaders) {
  return {
    'Content-Type': CONTENT_TYPE,
    // A byte count, not a character count: "Hello, Zoë!" is 11 characters but 12 bytes.
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
}

/**
 * Writes one complete plain-text response. For HEAD, Node keeps the declared `Content-Length` of the
 * body this route selects and suppresses the body itself, which is the intended HEAD behaviour.
 */
function send(res, statusCode, body, extraHeaders) {
  res.writeHead(statusCode, textHeaders(body, extraHeaders));
  res.end(body);
}

/**
 * Splits a request target at its first `?` into the raw path and the raw query (`''` when absent).
 * The path is matched exactly, with no decoding or normalisation. `new URL(target, base)` is avoided
 * on purpose: `new URL('//', base)` throws, and `new URL('//about', base).pathname` is `/`, which
 * would greet on `GET //about`.
 */
function splitTarget(target) {
  const queryStart = target.indexOf('?');
  if (queryStart === -1) {
    return { path: target, query: '' };
  }
  return { path: target.slice(0, queryStart), query: target.slice(queryStart + 1) };
}

/**
 * Describes a thrown value using only literals from this file, and never throws.
 *
 * An error's message, name, code and stack frames can all be built from request data (a greeted
 * name can appear in a message, a code or a function name in a stack frame), and the service must
 * record nothing about who is greeted. So only two things are reported: the built-in class, matched
 * by `instanceof` and printed as a literal label, and the code, printed only when it strictly equals
 * an allowlisted literal (the allowlist's own string is printed). `message`, `name`, `stack` and the
 * constructor are never read. Any failure, such as a throwing `code` getter or a hostile prototype,
 * yields the fixed fallback text instead of a partial description.
 *
 * @param {unknown} err The thrown value.
 * @returns {string} For example `TypeError` or `RangeError [ERR_HTTP_INVALID_STATUS_CODE]`.
 */
function describeError(err) {
  try {
    let label = null;
    for (const [ErrorClass, classLabel] of ERROR_LABELS) {
      if (err instanceof ErrorClass) {
        label = classLabel;
        break;
      }
    }
    if (label === null) {
      return 'non-Error value thrown';
    }

    const code = err.code;
    for (const knownCode of KNOWN_ERROR_CODES) {
      if (knownCode === code) {
        return `${label} [${knownCode}]`;
      }
    }
    return label;
  } catch {
    return 'error details unavailable';
  }
}

/** Writes one diagnostic line to stderr. A failing console must never block the recovery that follows. */
function logSafely(line) {
  try {
    console.error(line);
  } catch {
    // Deliberately ignored: the diagnostic is best-effort, while answering the client is not.
  }
}

/**
 * Builds a complete raw HTTP/1.1 response for a socket that Node's response machinery no longer owns.
 * The reason phrase is read from `http.STATUS_CODES` at call time. Headers follow `textHeaders`
 * order plus `Connection: close`, because the server ends the connection after this response.
 */
function rawResponse(status, body, extraHeaders) {
  const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`];
  const headers = textHeaders(body, { ...extraHeaders, Connection: 'close' });
  for (const [headerName, headerValue] of Object.entries(headers)) {
    lines.push(`${headerName}: ${headerValue}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * The server's `connect` listener. Node never passes CONNECT to the request listener, and without a
 * `connect` listener it closes the connection with no response at all, so CONNECT would neither get
 * its 405 on `/` nor its 404 elsewhere. This listener applies the same rules as the request handler
 * and answers with a raw response, then ends the connection. No tunnel is ever opened.
 *
 * A handed-off socket is outside Node's request timeouts and `closeAllConnections()`, so this
 * listener bounds its life itself: an idle timeout and an `error` listener both destroy it.
 *
 * Failures follow the same policy as the request handler: log a literal-only diagnostic, send a raw
 * 500 while nothing has been committed and the socket is writable, and otherwise destroy the socket.
 */
function rejectConnect(req, socket) {
  let committed = false;
  try {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(CONNECT_SOCKET_TIMEOUT_MS, () => socket.destroy());
    // Discard anything the client sends after the request head.
    socket.resume();

    const { path } = splitTarget(req.url);
    const response =
      path === '/'
        ? rawResponse(405, MESSAGES.methodNotAllowed, { Allow: 'GET' })
        : rawResponse(404, MESSAGES.notFound);

    committed = true;
    socket.end(response);
  } catch (err) {
    logSafely(`Unexpected error while handling a request (stage: connect): ${describeError(err)}`);
    if (!committed && socket.writable) {
      try {
        socket.end(rawResponse(500, MESSAGES.serverError));
        return;
      } catch (recoveryErr) {
        logSafely(`Could not send the 500 response: ${describeError(recoveryErr)}`);
      }
    }
    socket.destroy();
  }
}

/**
 * Creates a new, independent hello-service HTTP server that is not yet listening; the caller decides
 * where it listens. Each call builds a fresh server, and nothing is shared between servers.
 *
 * @example
 *   const server = createServer();
 *   server.listen(0, '127.0.0.1', () => console.log(server.address().port));
 *
 * @param {{ greet?: typeof greet }} [options] `options.greet` replaces the greeting function. It
 *   exists so tests can force the 500 path through the real error boundary; production code passes
 *   nothing and gets `greet`.
 * @returns {import('node:http').Server} A server with the request and CONNECT listeners attached.
 */
function createServer(options) {
  const greetFn = options && typeof options.greet === 'function' ? options.greet : greet;

  // Fully synchronous (no I/O, promises or callbacks), so the try/catch below sees every exception
  // raised while the request is handled, including one from writing the response itself.
  function handleRequest(req, res) {
    // Stage label for diagnostics only; always one of three literals.
    let stage = 'routing';
    try {
      // Drain and discard any request body chunk by chunk, without buffering it, so a 405 reply to
      // a POST with a body never stalls the connection on unread input.
      req.resume();

      const { path, query } = splitTarget(req.url);

      // Precedence is path, then method, then name: 404, 405, 400, 200.
      if (path !== '/') {
        stage = 'responding';
        send(res, 404, MESSAGES.notFound);
        return;
      }

      // Every recognised method except GET, including HEAD and OPTIONS. CONNECT never reaches this
      // listener; `rejectConnect` answers it.
      if (req.method !== 'GET') {
        stage = 'responding';
        send(res, 405, MESSAGES.methodNotAllowed, { Allow: 'GET' });
        return;
      }

      stage = 'greeting';
      // `get` returns the first `name` value or null. The key is case-sensitive, other parameters
      // are ignored, and WHATWG decoding is lenient (`+` is a space, a malformed `%` stays literal,
      // invalid UTF-8 becomes U+FFFD), so it never throws.
      const result = greetFn(new URLSearchParams(query).get('name'));

      stage = 'responding';
      send(res, result.statusCode, result.body);
    } catch (err) {
      logSafely(`Unexpected error while handling a request (stage: ${stage}): ${describeError(err)}`);
      if (!res.headersSent) {
        try {
          send(res, 500, MESSAGES.serverError);
          return;
        } catch (recoveryErr) {
          logSafely(`Could not send the 500 response: ${describeError(recoveryErr)}`);
        }
      }
      // Once a status line is committed, or the 500 itself cannot be written, ending the connection
      // is the only signal that does not lie. The server keeps listening either way.
      res.destroy();
    }
  }

  const server = http.createServer(handleRequest);
  server.on('connect', rejectConnect);
  return server;
}

/**
 * Parses the `PORT` environment value. Returns `DEFAULT_PORT` when unset or blank, the port for
 * decimal digits from 0 to 65535 (0 lets the OS choose), and `null` for anything else.
 *
 * The value is trimmed because cmd's `set PORT=4000 && npm start` leaves a trailing space. Strict
 * validation is needed because a non-numeric string would make Node listen on a pipe or socket path,
 * and an out-of-range number would throw `ERR_SOCKET_BAD_PORT` with a stack trace.
 */
function parsePort(raw) {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const value = String(raw).trim();
  if (value === '') {
    return DEFAULT_PORT;
  }
  if (/^[0-9]+$/.test(value) && Number(value) <= 65535) {
    return Number(value);
  }
  return null;
}

/**
 * Starts the service on `PORT` (default 3000). Runs only when this file is the entry point.
 *
 * Failures set `process.exitCode = 1` instead of calling `process.exit`, because an explicit exit can
 * truncate pending stderr writes. With nothing listening, the process ends on its own once stderr
 * is flushed.
 */
function start() {
  const rawPort = process.env.PORT;
  const port = parsePort(rawPort);
  if (port === null) {
    console.error(`Invalid PORT "${rawPort}": expected a whole number from 0 to 65535.`);
    process.exitCode = 1;
    return;
  }

  const server = createServer();

  server.on('error', (err) => {
    if (!server.listening) {
      // A start-up failure happens before any request exists, so its message holds no request data.
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${port} is already in use. Stop the other process or set PORT to a free port.`,
        );
      } else {
        console.error(`Could not start the server on port ${port}: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }
    // An error after listening has begun is logged and the server keeps serving; an `error` event
    // without a listener would otherwise end the process.
    logSafely(`Server error: ${describeError(err)}`);
  });

  // No host argument: bind the unspecified address (dual-stack `::`, or `0.0.0.0`), so `localhost`
  // answers whether it resolves to `::1` or `127.0.0.1`. The reported port is the one actually
  // bound, which matters when PORT=0.
  server.listen(port, () => {
    console.log(`Listening on http://localhost:${server.address().port}`);
  });
}

// Comparing module objects is unaffected by Windows separators, drive-letter case, symlinks or a
// missing extension, unlike comparing paths. Requiring this file, as the tests do, never listens.
if (require.main === module) {
  start();
}

module.exports = { createServer, greet };
