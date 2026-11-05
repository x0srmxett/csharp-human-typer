import * as vscode from 'vscode';
import type { ExtensionConfig } from './config';
export interface TypingSettings {
  minDelayMs: number;
  maxDelayMs: number;
  maxChunkSize: number;
  undoEvery: number;
  pauseAtNewlineMs: number;
  clearEditorBeforeTyping: boolean;
  saveAfterTyping: boolean;
}

/** Fragmento que se enviara en una unica llamada a editor.edit(). */
interface TypingStep {
  chunk: string;
  /** Cierra la parada de Undo (true en el ultimo fragmento de cada ventana). */
  closeUndoStop: boolean;
  /** Es un salto de linea (pausa extra). */
  newlineAfter: boolean;
}

const NEWLINE_BREAK = /[\r\n]/;
const IDENTIFIER = /[A-Za-z0-9_]/;

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Escribiendo cancelado.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Divide el texto en "pulsaciones" (trozos). Se corta despues de:
 *  - cada salto de linea (la indentacion de la linea siguiente va en el trozo nuevo)
 *  - cada signo separador (espacio, ; { } ( ) , . etc.)
 *  - grupos de 2-4 caracteres de identificador (ej. "Cons", "ole.")
 * Asi Ctrl+Z retrocede palabra a palabra en lugar de borrar todo el bloque.
 */
export function splitIntoKeystrokes(text: string): string[] {
  const strokes: string[] = [];
  let current = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (NEWLINE_BREAK.test(ch)) {
      current += ch === '\r' && text[i + 1] === '\n' ? '\r\n' : ch;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      strokes.push(current);
      current = '';
      continue;
    }

    if (IDENTIFIER.test(ch)) {
      const groupSize = randomBetween(2, 4);
      let count = 0;
      while (i < n && IDENTIFIER.test(text[i]) && count < groupSize) {
        current += text[i];
        i++;
        count++;
      }
      strokes.push(current);
      current = '';
      continue;
    }

    // Indentacion: se agrupa con el siguiente token para no dejar lineas en blanco a medias.
    if ((ch === ' ' || ch === '\t') && current === '') {
      let spaces = '';
      while (i < n && (text[i] === ' ' || text[i] === '\t')) {
        spaces += text[i];
        i++;
      }
      if (i < n && NEWLINE_BREAK.test(text[i])) {
        strokes.push(spaces);
        continue;
      }
      current = spaces;
      continue;
    }

    current += ch;
    i++;
    strokes.push(current);
    current = '';
  }

  if (current) {
    strokes.push(current);
  }
  return strokes;
}

/** Agrupa pulsaciones en pasos (fragmentos) de a lo sumo maxChunkSize caracteres sin romper \r\n. */
function buildSteps(text: string, settings: TypingSettings): TypingStep[] {
  const strokes = splitIntoKeystrokes(text);
  const steps: TypingStep[] = [];

  let buffer = '';
  let newlinePending = false;

  const flush = () => {
    if (!buffer) {
      return;
    }
    steps.push({ chunk: buffer, closeUndoStop: false, newlineAfter: newlinePending });
    buffer = '';
    newlinePending = false;
  };

  for (const stroke of strokes) {
    const isNewline = /^\r?\n$/.test(stroke);
    if (buffer && (buffer.length + stroke.length > settings.maxChunkSize || isNewline)) {
      flush();
    }
    buffer += stroke;
    if (isNewline) {
      newlinePending = true;
      flush();
    }
  }
  flush();

  return steps;
}

export class HumanTyper {
  private controller: AbortController | null = null;
  /** Indice del paso en curso; null cuando no se esta escribiendo (filtra eventos de seleccion). */
  private typingStep: number | null = null;

  get isTyping(): boolean {
    return this.controller !== null;
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Escribe el texto en el editor activo simulando a un humano.
   * - Cada paso usa editor.edit(...) con `undoStopBefore: true` y `undoStopAfter: true`
   *   en el ultimo fragmento de cada ventana de Undo, de manera que la pila de Undo/Redo
   *   registra paradas independientes (Ctrl+Z retrocede paso a paso).
   * - Retardo aleatorio entre minDelayMs y maxDelayMs por fragmento.
   * - El cursor se mueve y se hace scroll (revealRange) tras cada fragmento.
   */
  async type(text: string, config: ExtensionConfig, editorChecked?: vscode.TextEditor): Promise<void> {
    if (!text) {
      return;
    }

    const settings: TypingSettings = config.typing;
    let editor = editorChecked ?? vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No hay un editor activo. Abre un archivo .cs y vuelve a intentarlo.');
    }
    const targetDocument = editor.document; // el editor de la ventana desde la que se lanzo la orden

    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;

    try {
      if (settings.clearEditorBeforeTyping) {
        const cleared = await editor.edit((builder) => builder.delete(this.fullRange(editor!.document)), {
          undoStopBefore: true,
          undoStopAfter: true,
        });
        if (!cleared) {
          throw new Error('VS Code no permitio limpiar el editor.');
        }
        editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      }

      // Se escribe inmediatamente despues de la posicion actual del cursor.
      let position = editor.selection.active;
      let expectedPosition = position;
      const steps = buildSteps(text, settings);
      // Movimientos del cursor producidos por el propio bloque de formato al escribir.
      let formatCursorMove: vscode.Position | undefined;

      // El formateo al escribir (abracematcher/autoindent) puede desplazar texto ya escrito.
      // Si el cursor queda en un sitio distinto al esperado, se sigue al editor en lugar de
      // asumir nuestra posicion, evitando insertar en medio de lo ya escrito.
      const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== editor || this.typingStep === null) {
          return;
        }
        const active = event.selections[0]?.active;
        if (active && !active.isEqual(expectedPosition)) {
          formatCursorMove = active;
        }
      });

      try {
        for (let s = 0; s < steps.length; s++) {
          if (signal.aborted) {
            throw new Error('Escribiendo cancelado.');
          }

          const step = steps[s];
          // Si el editor visible deja de ser el documento destino (otra pestana, otra ventana
          // de VS Code o la ventana cerrada), se detiene para no escribir en una pestana oculta.
          const visible = vscode.window.activeTextEditor;
          if (!visible || visible.document !== targetDocument || targetDocument.isClosed) {
            throw new Error('La escritura se detuvo: el editor destino dejo de estar activo.');
          }
          editor = visible;
          // TEMPORAL-DIAGNOSTICO
          try {
            const fs2 = require('fs') as typeof import('fs');
            fs2.appendFileSync(process.env.TEMP + '\\opencode\\pane.txt', visible.document.getText());
          } catch { /* ignore */ }

          // Tras el paso anterior, si el formateo movio el cursor, se acepta su posicion.
          if (formatCursorMove) {
            position = formatCursorMove;
            formatCursorMove = undefined;
          }

          // El fragmento que cierra la ventana marca undoStopAfter (parada real en el historial).
          const closeWindow = (s + 1) % settings.undoEvery === 0 || s === steps.length - 1;
          const insertAt = position;

          this.typingStep = s;
          let ok = false;
          try {
            ok = await editor.edit(
              (editBuilder) => {
                editBuilder.insert(insertAt, step.chunk);
              },
              {
                // undoStopBefore: true rompe el grupo de edicion anterior => nueva entrada en el historial.
                // undoStopAfter: true cierra el grupo en el ultimo fragmento de la ventana.
                undoStopBefore: true,
                undoStopAfter: closeWindow,
              }
            );
          } finally {
            this.typingStep = null;
          }

          if (!ok) {
            throw new Error('VS Code rechazo la edicion (archivo de solo lectura, diff o no editable).');
          }

          position = editor.document.validatePosition(insertAt.translate(0, step.chunk.length));
          expectedPosition = position;
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.Default);

          await delay(randomBetween(settings.minDelayMs, settings.maxDelayMs), signal);
          if (step.newlineAfter) {
            await delay(settings.pauseAtNewlineMs, signal);
          }
        }
      } finally {
        selectionListener.dispose();
      }
    } finally {
      this.typingStep = null;
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  private fullRange(document: vscode.TextDocument): vscode.Range {
    const lastLine = document.lineAt(document.lineCount - 1);
    return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
  }
}
