'use strict';

/**
 * Express 5 application serving two plain-text endpoints.
 *
 *   GET /              -> 200, text/plain; charset=utf-8, body "Hello world"
 *   GET /good-evening  -> 200, text/plain; charset=utf-8, body "Good evening"
 *
 * This module only builds and exports the application; it never binds a port.
 * `server.js` starts it on the configured port and `test/app.test.js` starts
 * it on an ephemeral port. Everything else keeps Express's defaults: unmatched
 * paths and methods get the built-in 404 response, HEAD and OPTIONS are
 * answered automatically, and query strings do not affect route matching.
 */

// `express`: the `express` module export, a function that creates an application.
const express = require('express');

// `app`: the Express application holding the two routes; exported for
// `server.js` and the tests.
const app = express();

// Route handler parameters, used by both routes:
//   `req`: the Express request; unused, kept for Express's handler signature.
//   `res`: the Express response; sets the Content-Type and sends the body.
// `res.type('text/plain')` is explicit because sending a bare string answers
// text/html; Express appends `; charset=utf-8` when it writes the header.

app.get('/', (req, res) => {
  res.type('text/plain').send('Hello world');
});

app.get('/good-evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

module.exports = app;
