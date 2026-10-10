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

const express = require('express');

const app = express();

// `res.type('text/plain')` is explicit because sending a bare string answers
// text/html; Express appends `; charset=utf-8` when it writes the header.

app.get('/', (req, res) => {
  res.type('text/plain').send('Hello world');
});

app.get('/good-evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

module.exports = app;
