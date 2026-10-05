'use strict';

/**
 * Process entry point, run by `npm start` (`node server.js`).
 *
 * Resolves the listening port from the optional `PORT` environment variable
 * and starts the Express application from `app.js` on it. This is the only
 * module that listens on a configured port; the tests start the same app on
 * an ephemeral port instead.
 *
 * Environment:
 *   `PORT` (optional string): the listening port and the only configuration
 *   value. Unset or empty means DEFAULT_PORT (3000). Any other value must
 *   match /^[0-9]+$/ and lie from MIN_PORT to MAX_PORT (1 to 65535), or the
 *   process exits with status 1 before any socket is opened.
 *
 * Outcomes:
 *   bound         stdout `Listening on port <port>`; the server keeps running.
 *   invalid PORT  stderr `Invalid PORT "<PORT>": expected a whole number from
 *                 1 to 65535`; exit status 1; app.listen is never called.
 *   bind failure  stderr `Cannot listen on port <port>: <error message>`;
 *                 exit status 1. EADDRINUSE, EACCES and every other listen
 *                 error take this same path.
 */

// `app`: the Express application exported by `app.js`; it holds the routes.
const app = require('./app');

// `DEFAULT_PORT`: the port used when `PORT` is unset or empty.
const DEFAULT_PORT = 3000;

// `MIN_PORT`, `MAX_PORT`: inclusive bounds of a valid port; also quoted in
// the invalid-PORT message.
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Resolves a raw `PORT` value to the port number to listen on.
 *
 * Unset or empty yields DEFAULT_PORT. Empty needs its own branch because
 * Node's listen coerces '' to port 0, which would bind a random port.
 * Any other value is valid only when it is ASCII digits and nothing else
 * (leading zeros allowed, so '04000' is 4000) and its number lies from
 * MIN_PORT to MAX_PORT inclusive. Signs, spaces, decimals, exponents and hex
 * ('+80', '-1', ' 3000', '3000.5', '1e3', '0x10') fail the digits check;
 * '0', '65536' and '99999999999999999999' fail the range check.
 *
 * @param {string|undefined} value Raw `PORT` value being resolved.
 * @returns {number|null} The port number, or null when `value` is invalid.
 */
function resolvePort(value) {
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  // `parsed`: the numeric candidate compared with MIN_PORT and MAX_PORT.
  // Converted only after the digits check, so forms Number() would accept,
  // such as '1e3' or '0x10', never reach the range check.
  const parsed = Number(value);
  if (parsed < MIN_PORT || parsed > MAX_PORT) {
    return null;
  }
  return parsed;
}

// `rawPort`: `PORT` exactly as given, a string or undefined when unset; read
// once and echoed in the invalid-PORT message.
const rawPort = process.env.PORT;

// `port`: the resolved port number, or null when `rawPort` is invalid (null
// means exit 1). app.listen only ever receives this number, never the raw
// string: Node treats a non-numeric string as a Unix socket path, so
// PORT=abc would otherwise create a socket file named `abc`.
const port = resolvePort(rawPort);

if (port === null) {
  console.error(
    `Invalid PORT "${rawPort}": expected a whole number from ${MIN_PORT} to ${MAX_PORT}`
  );
  process.exit(1);
} else {
  // No host argument: the server binds all interfaces, so
  // http://localhost:<port> reaches it. Express 5 calls the callback exactly
  // once: with no argument after a successful bind, or with the error the
  // server emitted.
  //   `error`: the bind failure (EADDRINUSE, EACCES or any other listen
  //   error), or undefined on success. Every failure is handled alike: it is
  //   logged and the process exits with status 1.
  app.listen(port, (error) => {
    if (error) {
      console.error(`Cannot listen on port ${port}: ${error.message}`);
      process.exit(1);
    } else {
      console.log(`Listening on port ${port}`);
    }
  });
}
