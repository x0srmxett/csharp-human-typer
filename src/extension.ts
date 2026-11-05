import * as path from 'path';
import * as vscode from 'vscode';
import { generateCSharp } from './apiClient';
import { ExtensionConfig, getConfig } from './config';
import { HumanTyper } from './humanTyper';
import { sanitizeCSharp } from './sanitizer';
import { InstructionServer } from './server';

const OUTPUT_CHANNEL = vscode.window.createOutputChannel('C# Human Typer');
const typer = new HumanTyper();
let server: InstructionServer | null = null;
let serverToken = '';
let serverPort = 0;
let output: vscode.OutputChannel | undefined = OUTPUT_CHANNEL;
/** Archivo destino fijado con el comando `archivo <ruta>` de la terminal. */
let targetOverride: string | undefined;

/** Diagnostico opcional: CSHARP_HUMAN_TYPER_DEBUG=<ruta>.log escribe cada paso a un archivo. */
function trace(message: string): void {
  console.log(`[csharp-human-typer] ${message}`);
  const file = process.env.CSHARP_HUMAN_TYPER_DEBUG;
  if (!file) {
    return;
  }
  try {
    const fs = require('fs') as typeof import('fs');
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* el diagnostico nunca debe romper la extension */
  }
}

/* ------------------------------------------------------------------ */
/* Flujo principal: instruccion -> API -> limpieza -> tecleo humano    */
/* ------------------------------------------------------------------ */

/** Llama a la API y devuelve el codigo ya limpio. */
async function fetchCode(instruction: string, config: ExtensionConfig, signal?: AbortSignal): Promise<string> {
  trace(`POST ${config.apiUrl} modelo=${config.apiModel || '(defecto)'} clave=${config.apiKey ? 'si' : 'no'} tls=${config.tlsRejectUnauthorized}`);
  const result = await generateCSharp({ instruction, config, signal });
  trace(`api respondio: ${result.raw.length} chars`);
  output = output ?? OUTPUT_CHANNEL;
  output.appendLine('--- Respuesta cruda ---');
  output.appendLine(result.raw);

  const code = sanitizeCSharp(result.raw);
  if (!code.trim()) {
    throw new Error('La API devolvio un texto vacio tras la limpieza.');
  }
  output.appendLine('--- Codigo limpio ---');
  output.appendLine(code);
  output.appendLine('');
  return code;
}

async function handleInstruction(instruction: string, context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig(context);
  output = output ?? OUTPUT_CHANNEL;
  output.appendLine(`[${new Date().toISOString()}] Instruccion: ${instruction}`);
  trace(`instruccion: ${instruction}`);

  if (typer.isTyping) {
    throw new Error('Ya hay una escritura en curso.');
  }

  // Modo discreto: sin notificaciones ni barra de progreso, pero conservando la cancelacion.
  const requestAbort = new AbortController();
  let code: string;
  if (config.discreet) {
    code = await fetchCode(instruction, config, requestAbort.signal);
  } else {
    code = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'C# Human Typer: consultando la API...',
        cancellable: true,
      },
      async (progress, token) => {
        const sub = token.onCancellationRequested(() => requestAbort.abort());
        try {
          const result = await fetchCode(instruction, config, requestAbort.signal);
          progress.report({ message: `escribiendo ${result.length} caracteres...` });
          return result;
        } finally {
          sub.dispose();
        }
      }
    );
  }

  // Destino: archivo fijo (comando o ajuste), o el editor activo.
  const target = targetOverride || config.targetFile;
  if (target || config.discreet) {
    await handleTypeText(code, target || undefined, config.discreet, context);
    return;
  }

  const editor = vscode.window.activeTextEditor ?? (await openOrCreateCSharpEditor());
  if (!editor) {
    throw new Error('No hay editor activo ni se pudo crear un archivo .cs para escribir.');
  }
  if (editor.document.uri.scheme !== 'file' && editor.document.uri.scheme !== 'untitled') {
    throw new Error('El editor activo no es editable (diff/output/virtual).');
  }

  await typer.type(code, config, editor);
  vscode.window.setStatusBarMessage(`$(check) ${code.split('\n').length} lineas escritas`, 4000);
  trace(`escritura terminada: ${editor.document.getText().length} chars en el documento`);
}

/** Escribe un texto ya generado en un archivo del proyecto, sin robar el foco. */
async function handleTypeText(
  text: string,
  file: string | undefined,
  silent: boolean,
  context: vscode.ExtensionContext
): Promise<void> {
  const config = getConfig(context);
  const relative = file || config.targetFile || 'Program.cs';
  let uri: vscode.Uri;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (relative.includes(':') || relative.startsWith('/')) {
    uri = vscode.Uri.file(relative);
  } else if (folder) {
    uri = vscode.Uri.joinPath(folder.uri, relative);
  } else {
    throw new Error('Abre la carpeta del proyecto en VS Code para escribir en un archivo relativo.');
  }

  // Si el archivo no existe, se crea vacio para poder escribirlo y guardarlo.
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
  }

  const document = await vscode.workspace.openTextDocument(uri);

  // preserveFocus: la pestana se abre sin quitar el foco al usuario.
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: silent });
  trace(`type: ${document.uri.toString()} silent=${silent} chars=${text.length}`);

  // En modo silencioso se escribe rapido pero conservando las paradas de Undo.
  const typing = silent
    ? { ...config.typing, minDelayMs: 1, maxDelayMs: 3, pauseAtNewlineMs: 1, clearEditorBeforeTyping: true, saveAfterTyping: true }
    : config.typing;

  const start = new vscode.Position(0, 0);
  editor.selection = new vscode.Selection(start, start);

  await typer.type(text, { ...config, typing }, editor);

  // Verificacion final: si el buffer no coincide exactamente, se corrige de una vez.
  const actual = document.getText();
  if (actual.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
    trace(`type: desajuste (${actual.length} vs ${text.length} chars), se corrige`);
    const lastLine = document.lineAt(document.lineCount - 1);
    const full = new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
    const ok = await editor.edit((b) => b.replace(full, text), { undoStopBefore: true, undoStopAfter: true });
    if (!ok) {
      throw new Error('No se pudo corregir el contenido del documento.');
    }
  }

  await document.save();
  if (!silent) {
    vscode.window.setStatusBarMessage(`$(check) ${relative} escrito`, 4000);
  }
  trace(`type terminado: ${relative}`);
}

/** Si no hay editor activo, abre Program.cs del proyecto o crea un archivo C# sin guardar. */
async function openOrCreateCSharpEditor(): Promise<vscode.TextEditor | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const candidates = await vscode.workspace.findFiles('**/Program.cs', '**/{bin,obj,node_modules}/**', 1);
    if (candidates.length > 0) {
      const document = await vscode.workspace.openTextDocument(candidates[0]);
      return vscode.window.showTextDocument(document, { preview: false });
    }
  }

  const document = await vscode.workspace.openTextDocument({ language: 'csharp', content: '' });
  return vscode.window.showTextDocument(document, { preview: false });
}

/* ------------------------------------------------------------------ */
/* Pseudoterminal: escribe `escribir "mi instruccion"` y pulsa Enter   */
/* ------------------------------------------------------------------ */

class InstructionTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private closed = false;
  private line = '';
  private history: string[] = [];
  private historyIndex = -1;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getInfo: () => { port: number },
  ) {}

  open(): void {
    // Bracketed paste: permite distinguir un pegado multilinea de pulsar Enter.
    this.emit('\x1b[?2004h');
    this.printWelcome();
    this.prompt();
  }

  close(): void {
    this.closed = true;
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  handleInput(data: string): void {
    // --- Pegado entre marcadores (bracketed paste) ---
    const pasteStart = data.indexOf('\x1b[200~');
    if (pasteStart >= 0) {
      const before = data.slice(0, pasteStart);
      if (before) {
        this.handleInput(before);
      }
      const afterStart = data.slice(pasteStart + 6);
      const pasteEnd = afterStart.indexOf('\x1b[201~');
      if (pasteEnd >= 0) {
        this.finishPaste(afterStart.slice(0, pasteEnd));
        const rest = afterStart.slice(pasteEnd + 6);
        if (rest) {
          this.handleInput(rest);
        }
      } else {
        this.pasteBuffer = (this.pasteBuffer ?? '') + afterStart;
      }
      return;
    }
    if (this.pasteBuffer !== null) {
      const end = data.indexOf('\x1b[201~');
      if (end >= 0) {
        const contenido = this.pasteBuffer + data.slice(0, end);
        this.pasteBuffer = null;
        this.finishPaste(contenido);
        const rest = data.slice(end + 6);
        if (rest) {
          this.handleInput(rest);
        }
      } else {
        this.pasteBuffer += data;
      }
      return;
    }

    // --- Pegado sin marcadores: un bloque multilinea se toma como una sola instruccion ---
    if (data.length > 1 && /[\r\n]/.test(data) && !/^[\r\n]+$/.test(data)) {
      this.finishPaste(data);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Enter
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i + 1] === '\n') {
          i++;
        }
        this.emit('\r\n');
        const input = this.line;
        this.line = '';
        void this.execute(input);
        continue;
      }

      // Ctrl+C
      if (ch === '\x03') {
        this.emit('^C\r\n');
        this.line = '';
        this.prompt();
        continue;
      }

      // Ctrl+L (limpiar)
      if (ch === '\x0c') {
        this.emit('\x1b[2J\x1b[H');
        this.printWelcome();
        this.prompt();
        continue;
      }

      // Ctrl+U (borrar linea)
      if (ch === '\x15') {
        this.line = '';
        this.emit('\x1b[2K\r');
        this.prompt();
        continue;
      }

      // Backspace
      if (ch === '\x7f' || ch === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emit('\b \b');
        }
        continue;
      }

      // Secuencias de escape (flechas)
      if (ch === '\x1b') {
        const rest = data.slice(i + 1, i + 3);
        if (rest === '[A') {
          this.navigateHistory(-1);
          i += 2;
        } else if (rest === '[B') {
          this.navigateHistory(1);
          i += 2;
        } else if (rest === '[C' || rest === '[D') {
          i += 2;
        }
        continue;
      }

      if (ch >= ' ' || ch === '\t') {
        this.line += ch;
        this.emit(ch === '\t' ? '  ' : ch);
      }
    }
  }

  private pasteBuffer: string | null = null;

  /** Procesa un bloque pegado como UNA sola instruccion (conserva los saltos de linea). */
  private finishPaste(raw: string): void {
    const texto = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
    if (!texto.trim()) {
      this.prompt();
      return;
    }

    // Eco compacto: se muestra el bloque y no cada caracter.
    for (const linea of texto.split('\n')) {
      this.emit(`${linea}\r\n`);
    }
    this.line = texto;
    const input = this.line;
    this.line = '';
    void this.execute(input);
  }

  private printWelcome(): void {
    const { port } = this.getInfo();
    this.emit('\x1b[90mInstruccion C#. Ejemplo:\x1b[0m\r\n');
    this.emit('  \x1b[36mescribir "clase Alumno con Nombre y Nota"\x1b[0m\r\n');
    this.emit('\x1b[90mComandos: detener, estado, archivo <ruta>, limpiar\x1b[0m\r\n');
    if (port > 0) {
      this.emit(`\x1b[90mhttp://127.0.0.1:${port}\x1b[0m\r\n`);
    }
    this.emit('\r\n');
  }

  private prompt(): void {
    if (!this.closed) {
      this.emit('\x1b[32m>\x1b[0m ');
    }
  }

  private navigateHistory(direction: -1 | 1): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIndex === -1) {
      this.historyIndex = this.history.length;
    }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    const value = this.history[this.historyIndex] ?? '';
    this.line = value === this.history[this.history.length] ? '' : value;
    this.emit('\x1b[2K\r');
    this.prompt();
    this.emit(this.line);
  }

  private async execute(raw: string): Promise<void> {
    const input = raw.trim();
    if (!input) {
      this.prompt();
      return;
    }

    this.history.push(input);
    this.historyIndex = -1;

    const lower = input.toLowerCase();
    if (lower === 'detener' || lower === ':stop') {
      typer.stop();
      this.emit('Escribiendo detenido.\r\n');
      this.prompt();
      return;
    }
    if (lower === 'estado' || lower === ':status') {
      const { port } = this.getInfo();
      this.emit(`servidor: ${port > 0 ? `ok (${port})` : 'detenido'}\r\n`);
      this.emit(`escribiendo: ${typer.isTyping ? 'si' : 'no'}\r\n`);
      this.emit(`destino: ${targetOverride || getConfig(this.context).targetFile || 'editor activo'}\r\n`);
      this.prompt();
      return;
    }
    const archivo = /^(?:archivo|file|:file)\s+(.+)$/i.exec(input);
    if (archivo) {
      targetOverride = archivo[1].trim().replace(/^"(.*)"$/s, '$1');
      void this.context.workspaceState.update('targetFile', targetOverride);
      this.emit(`destino: ${targetOverride}\r\n`);
      this.prompt();
      return;
    }
    if (lower === 'limpiar' || lower === ':clear') {
      this.emit('\x1b[2J\x1b[H');
      this.printWelcome();
      this.prompt();
      return;
    }
    if (lower === 'ayuda' || lower === ':help' || lower === 'help') {
      this.printWelcome();
      this.prompt();
      return;
    }

    const match = /^(?:escribir|write|:type)\s+([\s\S]+)$/i.exec(input);
    const instruction = (match ? match[1] : input).trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim();
    if (!instruction) {
      this.emit('\r\n\x1b[31mFalta la instruccion. Ejemplo: escribir "una clase Calculadora"\x1b[0m\r\n');
      this.prompt();
      return;
    }

    this.emit(`\x1b[90m> consultando la API y tecleando...\x1b[0m\r\n`);
    try {
      await handleInstruction(instruction, this.context);
      this.emit('\r\n\x1b[32m> listo. Ctrl+Z en el editor retrocede paso a paso.\x1b[0m\r\n\r\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(`\r\n\x1b[31m> error: ${message}\x1b[0m\r\n\r\n`);
    } finally {
      this.prompt();
    }
  }

  private emit(text: string): void {
    if (!this.closed) {
      this.writeEmitter.fire(text.replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n'));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Activacion                                                          */
/* ------------------------------------------------------------------ */

const AUTOTEST_ENV = 'CSHARP_HUMAN_TYPER_AUTOTEST';
const NETTEST_ENV = 'CSHARP_HUMAN_TYPER_NETTEST';

/** Diagnostico de red dentro del Extension Host (DNS, TCP, TLS y fetch por separado). */
async function runNetTest(): Promise<void> {
  const file = process.env[NETTEST_ENV]!;
  const fs = require('fs') as typeof import('fs');
  const net = require('net') as typeof import('net');
  const tls = require('tls') as typeof import('tls');
  const dns = require('dns') as typeof import('dns');
  const log = (msg: string) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  };
  const host = 'api.deepseek.com';

  await new Promise<void>((resolve) => {
    dns.lookup(host, (err, address) => {
      log(`dns: ${err ? 'ERROR ' + err.message : address}`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    const socket = net.connect({ host, port: 443, timeout: 10000 });
    socket.on('connect', () => {
      log('tcp: conectado');
      socket.destroy();
      resolve();
    });
    socket.on('timeout', () => {
      log('tcp: TIMEOUT');
      socket.destroy();
      resolve();
    });
    socket.on('error', (e) => {
      log(`tcp: ERROR ${(e as Error).message}`);
      resolve();
    });
  });

  for (const rejectUnauthorized of [false, true]) {
    await new Promise<void>((resolve) => {
      const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized, timeout: 10000 }, () => {
        log(`tls(rejectUnauthorized=${rejectUnauthorized}): OK authorized=${socket.authorized}`);
        socket.destroy();
        resolve();
      });
      socket.on('timeout', () => {
        log(`tls(rejectUnauthorized=${rejectUnauthorized}): TIMEOUT`);
        socket.destroy();
        resolve();
      });
      socket.on('error', (e) => {
        log(`tls(rejectUnauthorized=${rejectUnauthorized}): ERROR ${(e as Error).message}`);
        resolve();
      });
    });
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`https://${host}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'di ok' }], stream: false }),
      signal: controller.signal,
    });
    log(`fetch: status=${r.status} (sin auth, se espera 401)`);
  } catch (e) {
    log(`fetch: ERROR ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Solo se ejecuta si CSHARP_HUMAN_TYPER_AUTOTEST apunta a un archivo.
 * Abre un documento .cs nuevo, escribe texto, comprueba el contenido y cuenta los pasos de Undo.
 */
async function runAutotest(context: vscode.ExtensionContext): Promise<void> {
  const reportPath = process.env[AUTOTEST_ENV]!;
  const summary: { ok: boolean; steps: string[]; error?: string; [key: string]: unknown } = { ok: false, steps: [] };
  const config = vscode.workspace.getConfiguration('editor', { languageId: 'csharp' });
  const original = config.get('formatOnType');
  const originalGlobal = vscode.workspace.getConfiguration().get('editor.formatOnType');
  try {
    const document = await vscode.workspace.openTextDocument({
      language: 'csharp',
      content: 'using System;\n',
    });
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));

    // Se guarda la configuracion original y solo se restaura si se habia cambiado.
    // La hoja se recarga al persistirse el contenido.
    await config.update('formatOnType', true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration().update('editor.formatOnType', true, vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    summary.settings = {
      formatOnType: vscode.workspace.getConfiguration('editor', { languageId: 'csharp' }).get('formatOnType'),
      globalFormatOnType: vscode.workspace.getConfiguration().get('editor.formatOnType'),
      tabSize: vscode.workspace.getConfiguration('editor', { languageId: 'csharp' }).get('tabSize'),
    };
    summary.originals = { original, originalGlobal };

    const typing = getConfig(context).typing;
    const fast = { ...typing, minDelayMs: 1, maxDelayMs: 3, pauseAtNewlineMs: 1 };
    summary.config = fast;

    await typer.type('class Hola\n{\n    static void Main() {}\n}', { apiUrl: '', apiKey: '', apiModel: '', httpPort: 0, serverToken: '', systemPrompt: '', tlsRejectUnauthorized: true, requestTimeoutMs: 120000, discreet: true, targetFile: '', typing: fast }, editor);
    const typed = editor.document.getText();
    summary.typed = typed;
    summary.noLossNoDuplicate = typed.endsWith('class Hola\n{\n    static void Main() {}\n}');
    summary.formattedLikeIde = /static void Main\(\)/.test(typed);
    summary.lineCount = editor.document.lineCount;

    let previous = editor.document.getText();
    const lengths: number[] = [];
    for (let i = 0; i < 2000; i++) {
      await vscode.commands.executeCommand('undo');
      const now = editor.document.getText();
      if (now === previous) {
        break;
      }
      lengths.push(now.length);
      previous = now;
    }
    summary.undoSteps = lengths.length;
    summary.undoLengths = lengths.slice(0, 12);
    summary.afterUndo = previous;
    summary.ok = Boolean(summary.noLossNoDuplicate) && lengths.length > 1;
    summary.steps.push('typing+undo');
  } catch (error) {
    summary.error = error instanceof Error ? error.stack : String(error);
  } finally {
    try { await config.update('formatOnType', original, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    try { await vscode.workspace.getConfiguration().update('editor.formatOnType', originalGlobal, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(reportPath), Buffer.from(JSON.stringify(summary, null, 2), 'utf8'));
    } catch (error) {
      console.error('autotest: no se pudo escribir el informe', error);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  trace('activado');

  if (process.env[AUTOTEST_ENV]) {
    void runAutotest(context);
  }

  if (process.env[NETTEST_ENV]) {
    void runNetTest();
  }

  // El token se resuelve una vez y se reutiliza (ademas se escribe para el script CLI).
  const initialConfig = getConfig(context);
  serverToken = initialConfig.serverToken;
  targetOverride = context.workspaceState.get<string>('targetFile') || undefined;

  const startServer = async (config: ExtensionConfig) => {
    if (server) {
      await server.stop();
    }
    server = new InstructionServer({
      port: config.httpPort,
      token: serverToken,
      onInstruction: (instruction) => handleInstruction(instruction, context),
      onTypeText: (text, file, silent) => handleTypeText(text, file, silent, context),
      onStop: () => typer.stop(),
      onError: (message) => {
        output?.appendLine(`[error] ${message}`);
        trace(`error: ${message}`);
        if (!config.discreet) {
          void vscode.window.showErrorMessage(`C# Human Typer: ${message}`);
        }
      },
      getStatus: () => ({ typing: typer.isTyping, hasEditor: !!vscode.window.activeTextEditor }),
    });

    try {
      serverPort = await server.start();
      // Deja el token y el puerto disponibles para el script `escribir` y otros clientes.
      const runtimeDir = path.join(context.globalStorageUri.fsPath);
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(vscode.Uri.file(runtimeDir), 'server.json'),
        Buffer.from(JSON.stringify({ port: serverPort, token: serverToken }, null, 2), 'utf8')
      );
      output?.appendLine(`[server] escuchando en http://127.0.0.1:${serverPort}`);
      trace(`server escuchando en ${serverPort}`);
    } catch (error) {
      serverPort = 0;
      const message = error instanceof Error ? error.message : String(error);
      trace(`server error: ${message}`);
      output?.appendLine(`[server] no se pudo abrir el puerto ${config.httpPort}: ${message}`);
      if (!config.discreet) {
        void vscode.window.showErrorMessage(
          `C# Human Typer: no se pudo abrir el puerto ${config.httpPort} (${message}). Cambia "csharpHumanTyper.httpPort".`
        );
      }
    }
  };

  void startServer(initialConfig);

  context.subscriptions.push(
    OUTPUT_CHANNEL,
    vscode.commands.registerCommand('csharp-human-typer.ask', async () => {
      const instruction = await vscode.window.showInputBox({
        title: 'Instruccion C#',
        prompt: 'Describe el codigo C# que quieres que se escriba',
        placeHolder: 'ej. estructura de una clase Empleado con nombre y salario',
      });
      if (!instruction?.trim()) {
        return;
      }
      try {
        await handleInstruction(instruction.trim(), context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output?.appendLine(`[error] ${message}`);
        trace(`error: ${message}`);
      }
    }),

    vscode.commands.registerCommand('csharp-human-typer.openTerminal', () => {
      const terminal = vscode.window.createTerminal({
        name: 'escribir',
        pty: new InstructionTerminal(context, () => ({ port: serverPort })),
      });
      terminal.show();
    }),

    vscode.commands.registerCommand('csharp-human-typer.stopTyping', () => {
      typer.stop();
      output?.appendLine('[stop] escritura detenida');
    }),

    vscode.commands.registerCommand('csharp-human-typer.showServerInfo', () => {
      output?.appendLine(`[server] http://127.0.0.1:${serverPort || '(detenido)'} token=${serverToken}`);
      output?.show(true);
    }),

    vscode.window.registerTerminalProfileProvider('csharp-human-typer.instructionTerminal', {
      provideTerminalProfile: () =>
        new vscode.TerminalProfile({
          name: 'escribir',
          pty: new InstructionTerminal(context, () => ({ port: serverPort })),
        }),
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('csharpHumanTyper.httpPort') || event.affectsConfiguration('csharpHumanTyper.serverToken')) {
        serverToken = getConfig(context).serverToken;
        void startServer(getConfig(context));
      }
    }),

    { dispose: () => void server?.stop() }
  );
}

export function deactivate(): void {
  typer.stop();
  void server?.stop();
  server = null;
}
