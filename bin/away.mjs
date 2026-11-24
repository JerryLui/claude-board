#!/usr/bin/env node
// Away: this Mac's board on the owner's own devices, through Tailscale's forwarder.
//
//   node bin/away.mjs on <name>        turn it on, for this Mac's Tailscale name
//   node bin/away.mjs link [boardId]   print a one-time sign-in link for one device
//   node bin/away.mjs off              turn it off
//   node bin/away.mjs status           what is set, and what the forwarder publishes
//
// CLAUDE_BOARD_TAILSCALE_CMD names the Tailscale command line; otherwise it is `tailscale`
// on PATH, else the one inside Tailscale.app.

import { spawn } from 'node:child_process';
import { daemonPort } from '../src/secret.mjs';
import { awayCommand, AWAY_LINK_TTL_MS, HANDOFF_ORIGIN, SAFE_BOARD_ID } from '../src/handoff.mjs';
import { awayFileObstacle, awayPath, isAwayName, readAway, removeAway, writeAwayHost } from '../src/away.mjs';
import { die, mintHandoff, requireSecret } from '../src/mint-handoff.mjs';

const PORT = daemonPort();
const TARGET = `http://127.0.0.1:${PORT}`;
const HTTPS_PORT = '443';
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const SERVE_ON = ['serve', '--bg', `--https=${HTTPS_PORT}`, TARGET];
const SERVE_OFF = ['serve', `--https=${HTTPS_PORT}`, 'off'];
// With HTTPS or Serve not allowed in the tailnet, `tailscale serve` prints a link to turn it
// on and then waits for that to happen.
const TAILSCALE_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_TAILSCALE_TIMEOUT_MS) || 30_000;

const USAGE = [
  'Usage: node bin/away.mjs on <name>       turn away on for this Mac, by its Tailscale name',
  '       node bin/away.mjs link [boardId]  print a one-time sign-in link',
  '       node bin/away.mjs off             turn away off',
  '       node bin/away.mjs status',
];

const command = args => awayCommand(args, PORT);

function run(binary, args) {
  return new Promise(resolve => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The binary inside Tailscale.app opens the app unless it is told it is the command line.
      env: { ...process.env, TAILSCALE_BE_CLI: '1' },
    });
    const out = [];
    const err = [];
    const said = () => Buffer.concat([...out, ...err]).toString('utf8').trim();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok: false, missing: false, stdout: '', said: `${said()}\n(no answer after ${TAILSCALE_TIMEOUT_MS / 1000} s)` });
    }, TAILSCALE_TIMEOUT_MS);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, missing: error.code === 'ENOENT', stdout: '', said: error.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, missing: false, stdout: Buffer.concat(out).toString('utf8'), said: said() });
    });
  });
}

async function tailscale(args) {
  const named = process.env.CLAUDE_BOARD_TAILSCALE_CMD;
  if (named) return run(named, args);
  const onPath = await run('tailscale', args);
  return onPath.missing ? run(TAILSCALE_APP, args) : onPath;
}

const MISSING = 'Tailscale\'s command line was not found. Install Tailscale, or name it in CLAUDE_BOARD_TAILSCALE_CMD.';

async function tailscaleJson(args) {
  const result = await tailscale([...args, '--json']);
  if (result.missing) return { problem: MISSING };
  if (!result.ok) return { problem: `tailscale ${args.join(' ')} failed:\n${result.said}` };
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === 'object') return { value };
  } catch {}
  return { problem: `tailscale ${args.join(' ')} printed something other than its status:\n${result.said}` };
}

/** What the forwarder publishes on 443, as one line per handler, and whether anything on this
 * machine is public (Funnel). `ours` is a handler at `/` in front of this board. */
function readServe(config) {
  const foregrounds = Object.values(config.Foreground ?? {});
  const ours = [];
  const foreign = [];
  for (const part of [config, ...foregrounds]) {
    const tcp = part.TCP?.[HTTPS_PORT];
    if (tcp && Object.entries(tcp).some(([key, value]) => value && key !== 'HTTPS')) foreign.push(`port ${HTTPS_PORT}: ${JSON.stringify(tcp)}`);
    for (const [hostPort, site] of Object.entries(part.Web ?? {})) {
      if (!hostPort.endsWith(`:${HTTPS_PORT}`)) continue;
      for (const [mount, handler] of Object.entries(site?.Handlers ?? {})) {
        const isOurs = part === config && mount === '/' && Object.keys(handler).length === 1
          && typeof handler.Proxy === 'string' && handler.Proxy.replace(/\/$/, '') === TARGET;
        const line = `https://${hostPort.slice(0, -`:${HTTPS_PORT}`.length)}${mount} -> ${handler.Proxy ?? JSON.stringify(handler)}`;
        (isOurs ? ours : foreign).push(line);
      }
    }
  }
  const funnel = [config, ...foregrounds].flatMap(part => Object.entries(part.AllowFunnel ?? {}).filter(([, on]) => on).map(([hostPort]) => hostPort));
  return { ours, foreign, funnel };
}

async function serveNow() {
  const { value, problem } = await tailscaleJson(['serve', 'status']);
  return problem ? { problem } : readServe(value);
}

const refuse = (...lines) => die(`claude-board away: ${lines[0]}`, ...lines.slice(1), 'Nothing was changed.');

async function on(name) {
  requireSecret('away');
  const obstacle = awayFileObstacle();
  if (obstacle) refuse(`${obstacle.problem}.`, `Next: ${obstacle.removable ? `${command('off')} removes it` : 'remove it by hand'}, then run this again.`);

  const status = await tailscaleJson(['status']);
  if (status.problem) refuse(status.problem, 'Next: start Tailscale and sign in, then run this again.');
  const { BackendState: state, Self: self } = status.value;
  if (state !== 'Running') refuse(`Tailscale is not running (it says ${state}).`, 'Next: start Tailscale and sign in, then run this again.');
  const host = String(self?.DNSName ?? '').replace(/\.$/, '');
  if (!isAwayName(host)) refuse(`Tailscale reports no usable name for this Mac (${JSON.stringify(host)}).`, 'Next: turn MagicDNS on in Tailscale\'s admin page, then run this again.');
  const reported = host.split('.')[0];
  if (reported !== name) {
    refuse(`Tailscale calls this Mac ${JSON.stringify(reported)}, not ${JSON.stringify(name)}.`,
      `Next: rename it in Tailscale's admin page, or run ${command(`on ${reported}`)}.`,
      'The first certificate publishes the name for good, so it is checked before anything else.');
  }

  const before = await serveNow();
  if (before.problem) refuse(before.problem, 'Next: check `tailscale serve status`, then run this again.');
  if (before.funnel.length) {
    refuse(`Funnel is on for ${before.funnel.join(', ')}: it publishes to the whole internet, and the board is never public.`,
      'Next: turn it off with `tailscale funnel reset`, then run this again.');
  }
  if (before.foreign.length) {
    refuse(`Tailscale already serves something else on port ${HTTPS_PORT}:`, ...before.foreign.map(line => `  ${line}`),
      `Next: turn that off with \`tailscale ${SERVE_OFF.join(' ')}\`, then run this again.`);
  }

  const served = await tailscale(SERVE_ON);
  const after = served.ok ? await serveNow() : null;
  if (!served.ok || after.problem || after.funnel.length || after.foreign.length
    || !after.ours.some(line => line.startsWith(`https://${host}/ `))) {
    const undone = await undo();
    die('claude-board away: Tailscale did not turn the forwarder on. It said:',
      served.ok ? after.problem ?? (served.said || '(nothing)') : served.said || '(nothing)',
      'HTTPS certificates have to be on for the tailnet (Tailscale\'s admin page, DNS).',
      `Next: do what the message asks, then run ${command(`on ${name}`)} again.`,
      undone);
  }

  try {
    writeAwayHost(host);
    const now = readAway();
    if (now.host !== host) throw new Error(now.reason ?? 'it holds another name');
  } catch (err) {
    const undone = await undo();
    die(`claude-board away: the setting could not be written to ${awayPath()} (${err.message}).`,
      `Next: check that folder, then run ${command(`on ${name}`)} again.`,
      undone);
  }

  console.log([
    `Away is on: https://${host} is this Mac's board (port ${PORT}).`,
    'Who reaches it: devices on your Tailscale network, and only a browser signed in by a link. Nothing is on the internet.',
    'HTTPS certificates have to be on for the tailnet (Tailscale\'s admin page, DNS), or no device can open it.',
    `Next: ${command('link')} prints a sign-in link for one device.`,
    `Off again: ${command('off')}`,
  ].join('\n'));
}

/** Turns away off and takes the forwarder back down, and says how that went. An earlier `on`'s
 * setting goes too: what is published now is not known to be what it was set for. */
async function undo() {
  let setting = 'Away is off.';
  try {
    removeAway();
  } catch (err) {
    setting = `Away may still be on: ${awayPath()} could not be removed (${err.code || err.message}); remove it by hand.`;
  }
  return `${setting} ${await undoServe()}`;
}

async function undoServe() {
  const state = await serveNow();
  if (!state.problem && !state.ours.length) return 'Nothing is published.';
  if (!state.problem) {
    await tailscale(SERVE_OFF);
    const now = await serveNow();
    if (!now.problem && !now.ours.length) return 'The forwarder is off again; nothing is published.';
  }
  return `The forwarder may still be on: run \`tailscale ${SERVE_OFF.join(' ')}\`.`;
}

async function off() {
  try {
    console.log(removeAway()
      ? 'Away is off: the board now refuses every name but this Mac\'s own.'
      : 'Away was already off: there is no setting to remove.');
  } catch (err) {
    die(`claude-board away: ${awayPath()} could not be removed (${err.code || err.message}), so away may still be on.`,
      `Next: remove it by hand, then run ${command('off')} again.`);
  }
  const before = await serveNow();
  if (before.problem) {
    console.error(`The forwarder could not be asked: ${before.problem}`);
    console.error(`Next: once Tailscale runs, run ${command('off')} again. The board refuses the name either way.`);
    return;
  }
  if (before.ours.length) {
    const served = await tailscale(SERVE_OFF);
    if (!served.ok) console.error(`tailscale ${SERVE_OFF.join(' ')} failed:\n${served.said || '(nothing)'}`);
  }
  const now = before.ours.length ? await serveNow() : before;
  if (now.problem || now.ours.length) {
    console.error(now.problem ?? `The forwarder still publishes this board:\n${now.ours.join('\n')}`);
    console.error(`Next: run \`tailscale ${SERVE_OFF.join(' ')}\`. The board refuses the name either way.`);
    return;
  }
  console.log('The forwarder publishes nothing for this board.');
  reportForeign(now);
}

function reportForeign({ foreign, funnel }) {
  if (foreign.length) console.error(`Left alone, not this board's (port ${PORT}):\n${foreign.join('\n')}`);
  if (funnel.length) console.error(`Funnel is on for ${funnel.join(', ')}: it publishes to the whole internet. Turn it off with \`tailscale funnel reset\`.`);
}

async function link(boardId) {
  if (boardId !== null && !SAFE_BOARD_ID.test(boardId)) die(`claude-board away: ${JSON.stringify(boardId)} is not a board id.`, ...USAGE);
  requireOn();
  const minted = await mintHandoff('away', { boardId, away: true }, `Next: ${command('status')} says whether away is on here; the daemon has to read the same folder.`);
  if (minted.origin !== HANDOFF_ORIGIN.away) {
    die('claude-board away: the running board is older than away links.', 'Next: run ./install.sh from the claude-board repository, then run this again.');
  }
  // Read again, not kept from before the mint, so the link names what the gate answers to now.
  console.log(`https://${requireOn()}/auth/${minted.token}`);
  console.error(`Works once, for ${AWAY_LINK_TTL_MS / 60_000} minutes. Open it on the device and tap "Sign this device in". Whoever opens it first is signed in, so send it to yourself alone.`);
}

function requireOn() {
  const { host, reason } = readAway();
  return host ?? die(`claude-board away: ${reason}.`, `Next: ${command('on <name>')}, with this Mac's Tailscale name.`);
}

async function status() {
  const { host, reason } = readAway();
  console.log(host ? `Away is on: https://${host}` : `No away name: ${reason}.`);
  const now = await serveNow();
  if (now.problem) return console.error(now.problem);
  console.log(now.ours.length ? `The forwarder publishes this board:\n${now.ours.join('\n')}` : 'The forwarder publishes nothing for this board.');
  reportForeign(now);
}

const [verb, arg = null, ...rest] = process.argv.slice(2);
if (rest.length) die(...USAGE);
if (verb === 'on' && arg) await on(arg);
else if (verb === 'off' && !arg) await off();
else if (verb === 'link') await link(arg);
else if (verb === 'status' && !arg) await status();
else die(...USAGE);
