#!/usr/bin/env node
/**
 * asistente — lanza o retoma el asistente personal en el directorio actual,
 * igual que `opencode` lo hace para su propio agente. Si el asistente ya está
 * corriendo (control server en :3131), le avisa el nuevo workspace y trae el
 * chat al frente. Si no, levanta la app ya apuntando a este directorio.
 */
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const cwd = process.cwd();
const base = 'http://127.0.0.1:3131';

function silentGet(p) {
  return new Promise((resolve) => {
    const req = http.get(base + p, (res) => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(800, () => { req.destroy(); resolve(-1); });
    req.on('error', () => resolve(-1));
  });
}

function isAlive() {
  return new Promise((resolve) => {
    const sock = net.connect(3131, '127.0.0.1');
    sock.setTimeout(800, () => { sock.destroy(); resolve(true); });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
  });
}

async function main() {
  if (await isAlive()) {
    await silentGet(`/workspace?path=${encodeURIComponent(cwd)}`);
    await silentGet('/chat?action=open');
    console.log(`El asistente ya estaba corriendo — cambiado a: ${cwd}`);
    console.log('Si no responde (instancia colgada), ciérrala y vuelve a ejecutar.');
    return;
  }

  const appRoot = path.join(__dirname, '..');
  console.log(`Iniciando asistente en: ${cwd}`);
  spawn('npx', ['electron', appRoot], {
    cwd: appRoot,
    env: { ...process.env, ASISTENTE_WORKSPACE: cwd },
    stdio: 'inherit',
    detached: true,
  }).unref();
}

main();
