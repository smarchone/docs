#!/usr/bin/env node
// docs serve [repo]   start the daemon if it isn't running, then register <repo> (default: current folder)
// docs status         list the workspaces the daemon serves
// docs stop           stop the daemon
//
// The daemon runs detached from whoever started it (its own session, output to $DOCS_HOME/daemon.log),
// so closing the terminal or Claude session that ran `docs serve` doesn't stop it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const PORT = Number(process.env.PORT) || 3459;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.resolve(process.env.DOCS_HOME || path.join(os.homedir(), '.docs-daemon'));
const LOG = path.join(HOME, 'daemon.log');

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const running = () => call('GET', '/api/health').then(() => true, () => false);

async function startDaemon() {
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await running()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The daemon didn't start. See ${LOG}`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'serve') {
    const repo = path.resolve(arg || '.');
    const started = !(await running());
    if (started) await startDaemon();
    const w = await call('POST', '/api/workspaces', { repo });
    console.log(`${started ? 'Started the docs daemon. ' : ''}Serving ${w.root}`);
    console.log(`workspace: ${w.id}`);
    console.log(`url: ${w.url}`);
  } else if (cmd === 'status') {
    if (!(await running())) {
      console.log('The docs daemon is not running.');
    } else {
      const { workspaces } = await call('GET', '/api/workspaces');
      console.log(`Docs daemon at ${BASE}`);
      for (const w of workspaces) {
        const p = w.presence;
        const state = p.job ? 'working' : p.listening ? 'listening' : 'offline';
        console.log(`  ${w.id.padEnd(24)} ${state.padEnd(10)} ${w.root}`);
      }
    }
  } else if (cmd === 'stop') {
    if (await running()) {
      await call('POST', '/api/shutdown', {});
      console.log('Stopped the docs daemon.');
    } else {
      console.log('The docs daemon is not running.');
    }
  } else {
    console.log('Usage: docs serve [repo] | docs status | docs stop');
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
