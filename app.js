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

// `express`: the `express` package's export, the factory that creates an
// application; the only dependency this project installs.
const express = require('express');

// `app`: the application holding the two routes below, exported at the end of
// this module.
const app = express();

// `res.type('text/plain')` is explicit because sending a bare string answers
// text/html; Express appends `; charset=utf-8` when it writes the header.

// Both handlers below take Express's route-handler parameters, `(req, res)`.
// `req` is the incoming request: unread, because neither route varies its
// answer with what the request carries, and present because Express passes
// the request ahead of the response in that signature. `res` is the response
// being filled in: it sets the content type and sends the body.

app.get('/', (req, res) => {
  res.type('text/plain').send('Hello world');
});

app.get('/good-evening', (req, res) => {
  res.type('text/plain').send('Good evening');
});

module.exports = app;
