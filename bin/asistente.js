#!/usr/bin/env node
/**
 * asistente — lanza o retoma March 7th en el directorio actual, igual que
 * `opencode` lo hace para su propio agente. Si March ya está corriendo
 * (control server en :3131), le avisa el nuevo workspace y trae el chat
 * al frente. Si no, levanta la app ya apuntando a este directorio.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const cwd = process.cwd();
const url = `http://127.0.0.1:3131/workspace?path=${encodeURIComponent(cwd)}`;

http.get(url, () => {
  http.get('http://127.0.0.1:3131/chat?action=open', () => {
    console.log(`March ya estaba corriendo — cambiado a: ${cwd}`);
  });
}).on('error', () => {
  const appRoot = path.join(__dirname, '..');
  console.log(`Iniciando March en: ${cwd}`);
  spawn('npx', ['electron', appRoot], {
    cwd: appRoot,
    env: { ...process.env, MARCH_WORKSPACE: cwd },
    stdio: 'inherit',
    detached: true,
  }).unref();
});
