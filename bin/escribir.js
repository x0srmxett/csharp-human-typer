#!/usr/bin/env node
/**
 * CLI `escribir`: envia una instruccion al servidor local de la extension.
 *
 * Uso:
 *   escribir "crea una clase Persona"
 *   escribir --stop
 *   escribir --status
 *
 * Descubrimiento del servidor (en orden):
 *   1. HUMAN_TYPER_URL / HUMAN_TYPER_TOKEN (variables de entorno)
 *   2. %APPDATA%/Code/User/globalStorage/local.csharp-human-typer/server.json
 *      (~/.config/Code/User/... en Linux, ~/Library/Application Support/Code/... en macOS)
 *   3. Puerto por defecto 45678
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = Number(process.env.HUMAN_TYPER_PORT || 45678);

function candidateServerFiles() {
  const home = os.homedir();
  const files = [];
  if (process.env.APPDATA) {
    files.push(path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'local.csharp-human-typer', 'server.json'));
    files.push(path.join(process.env.APPDATA, 'Code - Insiders', 'User', 'globalStorage', 'local.csharp-human-typer', 'server.json'));
  }
  files.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', 'local.csharp-human-typer', 'server.json'));
  files.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'local.csharp-human-typer', 'server.json'));
  // .vscode-oss / VSCodium
  files.push(path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'local.csharp-human-typer', 'server.json'));
  return files;
}

function readServerInfo() {
  for (const file of candidateServerFiles()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.port) {
        return { port: Number(data.port), token: String(data.token || '') };
      }
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const words = args.filter((a) => !a.startsWith('--'));

  const info = readServerInfo();
  const url = process.env.HUMAN_TYPER_URL || `http://127.0.0.1:${(info && info.port) || DEFAULT_PORT}`;
  const token = process.env.HUMAN_TYPER_TOKEN || (info && info.token) || '';

  if (flags.has('--help') || flags.has('-h')) {
    console.log('Uso: escribir "mi instruccion"   |   escribir --stop   |   escribir --status');
    return;
  }

  const headers = { 'Content-Type': 'application/json', 'X-Human-Typer-Token': token };

  let endpoint = '/typing';
  let body = { instruction: words.join(' ').trim() };

  if (flags.has('--stop')) {
    endpoint = '/stop';
    body = {};
  } else if (flags.has('--status')) {
    endpoint = '/health';
    body = undefined;
  } else if (!body.instruction) {
    console.error('Falta la instruccion. Ejemplo: escribir "una clase Calculadora con Sumar y Restar"');
    process.exitCode = 2;
    return;
  }

  try {
    const method = endpoint === '/health' ? 'GET' : 'POST';
    const response = await fetch(url + endpoint, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    if (response.status === 401) {
      console.error('Token invalido. Abre VS Code y ejecuta "C# Human Typer: Mostrar URL/Token del servidor local".');
      process.exitCode = 1;
      return;
    }
    if (!response.ok) {
      console.error(`Error ${response.status}: ${text}`);
      process.exitCode = 1;
      return;
    }

    if (endpoint === '/health') {
      console.log('Servidor OK:', text);
    } else if (endpoint === '/stop') {
      console.log('Escritura detenida.');
    } else {
      console.log('Instruccion enviada. La extension esta escribiendo en el editor (Ctrl+Z retrocede paso a paso).');
    }
  } catch (error) {
    console.error(`No se pudo conectar con la extension en ${url}.`);
    console.error('Abre VS Code con la extension instalada/activada y vuelve a intentarlo.');
    if (process.env.HUMAN_TYPER_DEBUG) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}

main();
