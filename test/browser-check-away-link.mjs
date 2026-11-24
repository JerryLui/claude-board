// Real-browser check of an away sign-in link's whole path: tapped on another site's page, its
// button pressed, the board it leads to. Whether a browser lets that form post at all turns on
// the headers the page ships (a `no-referrer` policy makes it send `Origin: null`, which the
// daemon refuses), and no check without a browser can see that.
//
// The daemon speaks plain http to a local forwarder, as it does behind Tailscale's: a TLS server
// here, reached through a CONNECT proxy because the away name is in no DNS.
//
//   node test/browser-check-away-link.mjs
//
// Without Chrome it prints a skip line and exits 0.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { runMain, skipFile, waitFor } from './support.mjs';
import { CHROME, evalIn, guardRun, postJson, row, scratchDir, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-away-link', `browser-check-away-link: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-away-link', { deadlineMs: 120000 });

const AWAY = 'board.example.ts.net';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function startForwarder(daemonPort) {
  const dir = scratchDir('away-link-tls-');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${AWAY}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const seen = [];
  const tls = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: daemonPort, method: req.method, path: req.url, headers: req.headers }, answer => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, status: answer.statusCode });
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const tlsPort = await listen(tls);
  const proxy = http.createServer((req, res) => res.writeHead(502).end());
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {});
    if (req.url !== `${AWAY}:443`) return socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const onward = net.connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      onward.pipe(socket).pipe(onward);
    });
    onward.on('error', () => socket.destroy());
  });
  return { proxyPort: await listen(proxy), seen };
}

async function startOtherSite(href) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><a style="position:fixed;inset:0" href="${href}">link</a>`);
  });
  return `http://127.0.0.1:${await listen(server)}/`;
}

async function main() {
  const daemon = await startScratchDaemon('away-link');
  const port = await daemon.port();
  writeFileSync(path.join(daemon.home, 'away'), `${AWAY}\n`, { mode: 0o600 });
  const { proxyPort, seen } = await startForwarder(port);
  const post = (pathName, body) => postJson(`http://127.0.0.1:${port}${pathName}`, body, daemon.secret);

  for (const theme of ['light', 'dark']) {
    await withChrome({ tag: `away-link-${theme}`, proxyPort }, async ({ send }) => {
      const { boardId } = await post('/api/board', { title: 'Away link', blocks: [{ kind: 'question', prompt: 'Merge?', widget: 'single', options: [{ label: 'Yes' }] }] });
      const { token } = await post('/api/handoff', { away: true, boardId });
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const sp = (method, params) => send(method, params, sessionId);
      const read = expression => evalIn(send, sessionId, expression);
      const at = want => waitFor(async () => (await read('document.readyState === "complete" && location.href').catch(() => null)) === want, { timeoutMs: 15000, what: want });
      const click = async (x, y) => {
        for (const type of ['mousePressed', 'mouseReleased']) await sp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      };
      await sp('Security.setIgnoreCertificateErrors', { ignore: true });
      await sp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await sp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      const link = `https://${AWAY}/auth/${token}`;
      const otherSite = await startOtherSite(link);

      await row(`a link tapped on another site opens the sign-in page, readable and tappable at 390px (${theme})`, async note => {
        await sp('Page.navigate', { url: otherSite });
        await at(otherSite);
        await click(195, 400);
        await at(link);
        const page = await read(`(() => {
          const b = document.querySelector('button').getBoundingClientRect();
          return { label: document.querySelector('button').textContent, top: b.top, left: b.left, width: b.width, height: b.height,
            sideways: document.documentElement.scrollWidth - innerWidth, width390: innerWidth, scheme: getComputedStyle(document.documentElement).colorScheme,
            loaded: performance.getEntriesByType('resource').map(r => r.name) };
        })()`);
        note(JSON.stringify(page));
        assert.equal(page.label, 'Sign this device in');
        assert.ok(page.height >= 44 && page.width >= 44, `the button is ${page.width}x${page.height}`);
        assert.deepEqual([page.width390, page.sideways, page.scheme], [390, 0, theme]);
        assert.deepEqual(page.loaded.filter(url => !url.startsWith('data:')), [], 'nothing is fetched beside the page');
        assert.equal(seen.at(-1).headers['sec-fetch-site'], 'cross-site', 'setup: the tap came from another site');
      });

      await row(`its button signs the browser in and lands on the board, whose page carries the cookie (${theme})`, async note => {
        const b = await read('(() => { const b = document.querySelector("button").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()');
        await click(b.x, b.y);
        await at(`https://${AWAY}/b/${boardId}`);
        const trip = seen.filter(r => r.path === `/auth/${token}` || r.path === `/b/${boardId}`);
        note(trip.map(r => `${r.method} ${r.path.slice(0, 6)} ${r.status} site=${r.headers['sec-fetch-site']} origin=${r.headers.origin} referer=${r.headers.referer}`).join('; '));
        assert.deepEqual(trip.map(r => [r.method, r.status]), [['GET', 200], ['POST', 303], ['GET', 200]]);
        assert.ok(await read('!!document.getElementById("board-data")'), 'the board itself, not a refusal');
        assert.ok(seen.every(r => !String(r.headers.referer ?? '').includes(token)), 'no request carries the token in its Referer');
        assert.ok(seen.every(r => r.path === `/auth/${token}` || !r.path.includes(token)), 'nor in its address');
      });
    });
  }
  await daemon.stop();
}

await runMain('browser-check-away-link', main);
process.exit(0); // the forwarder's sockets outlive the last row
