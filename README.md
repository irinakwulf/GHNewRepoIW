# Hello service

A tiny stateless web service that returns a plain-text greeting, with no dependencies beyond Node.js.
`GET /` returns `Hello, world!`, and `GET /?name=Ada` returns `Hello, Ada!`.

## Requirements

- Node.js 20 or later, with the npm that ships with it. Nothing else is needed: no third-party
  packages, databases, external services or API keys.
- macOS, Linux or Windows. The service behaves the same on all three.

Node.js 20 reached end-of-life on 2026-04-30. Any later Node.js release also satisfies the
`"engines": { "node": ">=20" }` setting in `package.json`, so a maintained LTS line is recommended:
Node.js 22 is supported until 2027-04-30, and Node.js 24 until 2028-04-30.

Check the installed version with:

```sh
node --version
```

## Install

From the project root:

```sh
npm install
```

The project has no dependencies, so this downloads nothing and creates no `node_modules` directory.
It only writes or confirms `package-lock.json`.

## Run

```sh
npm start
```

This runs `node src/server.js`, which prints:

```text
Listening on http://localhost:3000
```

Open `http://localhost:3000/` in a browser to see `Hello, world!`, or `http://localhost:3000/?name=Ada`
to see `Hello, Ada!`. Press Ctrl+C to stop the server.

The server listens on every network interface, so `localhost` works over both IPv4 and IPv6. It is
therefore also reachable from other machines on your local network while it runs.

## Choose a port

The service listens on port 3000 unless the optional `PORT` environment variable is set. Set it in
your shell before running `npm start`.

macOS and Linux (bash, zsh):

```sh
PORT=4000 npm start
```

Windows Command Prompt (cmd):

```bat
set "PORT=4000" && npm start
```

The quotes keep the space before `&&` out of the value. The variable stays set for the rest of that
cmd session; clear it with `set "PORT="`.

Windows PowerShell:

```powershell
$env:PORT = "4000"; npm start
```

The variable stays set for the rest of that PowerShell session. Clear it afterwards with:

```powershell
Remove-Item Env:PORT
```

`PORT` is read once at start-up, and surrounding whitespace is ignored. Valid values are whole numbers
from 0 to 65535, where `0` lets the operating system choose a free port (the `Listening on` line shows
which). An unset or blank `PORT` means the default, 3000. Any other value prints an error and exits
with code 1 (see [Troubleshooting](#troubleshooting)).

With `PORT` set to 4000, `npm start` prints:

```text
Listening on http://localhost:4000
```

To check the change, first stop any server still running on the default port, such as the one
started under [Run](#run), by pressing Ctrl+C in its terminal. Then, with the server running on
port 4000, run these commands in another terminal. In Windows PowerShell, use `curl.exe` instead of
`curl`.

```sh
curl http://localhost:4000/
```

```text
Hello, world!
```

```sh
curl http://localhost:3000/
```

No server is listening on port 3000 any more, so curl fails to connect. It reports a connection
failure, such as `Failed to connect`, and exits with status 7. The exact message differs between
curl versions.

## Test

```sh
npm test
```

This runs `node --test test/server.test.js`. The tests need no network access and no installs beyond
`npm install`. They start and stop their own servers on ports chosen at run time and send every
request to `127.0.0.1`, so port 3000 does not need to be free, and a server already running from
`npm start` does not interfere. Most tests run the service in-process, listening on `127.0.0.1`
only. The start-up tests run the real server, which listens on every network interface as
`npm start` does, and the port-in-use test holds its port on every interface in the same way.

A passing run ends with a summary reporting `tests 20`, `pass 20` and `fail 0`, and the exit status
is 0. On Node.js 20 and 22, each summary line starts with `ℹ` in a terminal, or `#` when the output
is piped or redirected. From Node.js 23 on, it starts with `ℹ` in both cases.
Check the exit status straight after the run:

macOS and Linux (bash, zsh):

```sh
echo $?
```

Windows Command Prompt (cmd):

```bat
echo %ERRORLEVEL%
```

Windows PowerShell:

```powershell
$LASTEXITCODE
```

## Example requests

Start the server with `npm start` in one terminal, then run these commands in another. Each command
is followed by its output.

- Response bodies end without a newline, so your shell prompt may appear on the same line as the
  output.
- In Windows PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` with the same
  arguments instead, for example `curl.exe http://localhost:3000/`. Windows 10 and 11 include
  `curl.exe`.
- With `-i`, curl also prints the status line and response headers. Only the headers that matter are
  shown below, and `…` stands for the rest, such as the `Date`, `Connection` and `Keep-Alive` headers
  that Node adds. Header order and capitalisation can differ between curl versions.

The default greeting:

```sh
curl http://localhost:3000/
```

```text
Hello, world!
```

A named greeting:

```sh
curl "http://localhost:3000/?name=Ada"
```

```text
Hello, Ada!
```

Surrounding spaces are trimmed (`%20` is an encoded space):

```sh
curl "http://localhost:3000/?name=%20Ada%20"
```

```text
Hello, Ada!
```

An empty name falls back to the default greeting:

```sh
curl -i "http://localhost:3000/?name="
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 13
X-Content-Type-Options: nosniff
…

Hello, world!
```

A name of 51 characters is rejected:

```sh
curl -i "http://localhost:3000/?name=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

```text
HTTP/1.1 400 Bad Request
…

Name must be 50 characters or fewer.
```

A name of exactly 50 characters is greeted:

```sh
curl -i "http://localhost:3000/?name=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

```text
HTTP/1.1 200 OK
…

Hello, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!
```

Any other path is not found:

```sh
curl -i http://localhost:3000/about
```

```text
HTTP/1.1 404 Not Found
…

Not found.
```

Any method Node's HTTP parser recognises, other than `GET`, is not allowed on `/` (see
[Behaviour](#behaviour) for unrecognised method tokens):

```sh
curl -i -X POST http://localhost:3000/
```

```text
HTTP/1.1 405 Method Not Allowed
…
Allow: GET
…

Method not allowed.
```

## Behaviour

Every response the service generates, including its answers to `CONNECT`, is plain text, with
`Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, and a `Content-Length`
giving the exact size in bytes of the body selected for it. The table calls these the common three.
Responses to every method except `CONNECT` also carry the `Date` and `Connection` headers Node adds:
`Connection: keep-alive` with `Keep-Alive: timeout=5`, or `Connection: close` when the client asks
for it. Node's native parser-error responses, such as the 400 for an unrecognised method token or
the 431 for a request head over 16 KiB, are outside the service's response-header guarantee and
carry only `Connection: close`. No body ends with a newline.

| Request | Status | Headers beyond the common three | Body |
| --- | --- | --- | --- |
| `GET /` (also `GET /?`, or any query with no `name` key) | `200 OK` | `Content-Length: 13` | `Hello, world!` |
| `GET /?name=Ada` | `200 OK` | `Content-Length: 11`. In general 8 plus the name's UTF-8 bytes | `Hello, Ada!` |
| `GET /?name=` (empty, or only whitespace) | `200 OK` | `Content-Length: 13` | `Hello, world!` |
| `GET /?name=<more than 50 code points after trimming>` | `400 Bad Request` | `Content-Length: 36` | `Name must be 50 characters or fewer.` |
| Any recognised method on any path other than `/`, such as `GET /about`, `POST /about` or `HEAD /about` | `404 Not Found` | `Content-Length: 10` | `Not found.` (`HEAD`: no body is sent, but `Content-Length: 10` is still declared) |
| Any recognised method other than `GET` on `/`, including `HEAD`, `OPTIONS` and `PROPFIND` | `405 Method Not Allowed` | `Allow: GET`, `Content-Length: 19` | `Method not allowed.` (`HEAD`: no body is sent, but `Content-Length: 19` is still declared) |
| `CONNECT /` | `405 Method Not Allowed` | `Allow: GET`, `Content-Length: 19`, `Connection: close`. No `Date` | `Method not allowed.`, after which the server ends the connection |
| `CONNECT` to any other target, such as `example.com:443` | `404 Not Found` | `Content-Length: 10`, `Connection: close`. No `Date` | `Not found.`, after which the server ends the connection |
| A method token Node's parser does not recognise, such as `FOO /` or `get /` | `400 Bad Request` (Node's native response) | None of the common three. Only `Connection: close` | Empty, after which Node closes the connection |
| An unexpected error while handling a request, while a replacement response can still be written | `500 Internal Server Error` | `Content-Length: 21`. For `CONNECT`, a raw response with `Connection: close` and no `Date` | `Something went wrong.` |
| An unexpected error after the response has started (for `CONNECT`, after it was committed), or when the 500 itself cannot be written | No further response | — | None. The connection is destroyed |

On an unexpected error, the error is logged to the console without any request data. The 500 is
sent only while a replacement response can still be written. If the response had already started
(for `CONNECT`, once it was committed), or the 500 itself cannot be written, the server destroys
the connection instead, and the client must reconnect. The server keeps running either way.

How names are handled:

- Names are trimmed of surrounding whitespace, and inner spaces are kept, so
  `?name=Ada%20Lovelace` greets `Ada Lovelace`.
- Length is counted in characters (Unicode code points) after trimming, with 50 the maximum. Exactly
  50 is accepted. A single-code-point emoji such as 😀 counts as one, but the family emoji 👨‍👩‍👧
  (three emoji joined by two zero-width joiners) counts as five. Names are not Unicode-normalised,
  so a letter typed with a combining accent counts as two characters and is echoed exactly as sent.
- Only the first `name` parameter is used. The key is case-sensitive, so `?Name=Ada` is ignored, and
  other query parameters are ignored.
- A name is shown as text, never as HTML, so `?name=%3Cb%3EAda%3C%2Fb%3E` shows `Hello, <b>Ada</b>!`
  literally.

Paths and methods:

- On `/`, every method Node's HTTP parser recognises (`http.METHODS`) other than `GET` returns 405
  with `Allow: GET`. That covers `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, WebDAV methods
  such as `PROPFIND`, and `CONNECT`, which is answered without ever opening a tunnel.
- `HEAD` gets the status and headers only, with no body: `HEAD /` gets 405 with `Allow: GET` and
  `Content-Length: 19`, and `HEAD /about` or any other path gets 404 with `Content-Length: 10`.
  That `Content-Length` declares the size of the body the route and method select,
  `Method not allowed.` or `Not found.`, not the size of the transfer, which is empty.
- Unknown paths return 404 for every recognised method, `CONNECT` included. When a request fails
  more than one check, the path is checked first, then the method, then the name.
- Method tokens the parser does not recognise, such as `FOO` or lower-case `get`, never reach the
  service's routing. Node answers them with its native `400 Bad Request` and an empty body, without
  the service's text headers, and closes the connection.

The service is stateless: it stores nothing between requests and records nothing about who is
greeted.

## Troubleshooting

### Port already in use

```text
Port 3000 is already in use. Stop the other process or set PORT to a free port.
```

Another program, possibly another copy of this service, is already listening on that port, and the
server exits with code 1. Stop the other process, or start this one on a different port as shown in
[Choose a port](#choose-a-port).

### Invalid PORT

```text
Invalid PORT "abc": expected a whole number from 0 to 65535.
```

`PORT` must be a whole number from 0 to 65535, with no sign, decimal point or other characters. The
server exits with code 1 without listening. Correct or clear the value. In cmd, set it with the quoted
form, `set "PORT=4000"`, so nothing after the number ends up in the value.

### Other start-up failures

```text
Could not start the server on port <port>: <message>
```

The port could not be opened for another reason, such as the operating system denying permission to
use it. The message ends with the reason the operating system gave, and the server exits with code 1.
Choose a different port as shown in [Choose a port](#choose-a-port).

### Windows firewall prompt

On Windows, a firewall prompt may appear the first time the server starts, because it listens on all
network interfaces. Requests to `localhost` from the same machine work whichever option you choose.
