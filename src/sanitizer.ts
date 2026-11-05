/**
 * Limpieza defensiva de la respuesta de la API.
 * Aunque el System Prompt prohibe markdown y comentarios, esta funcion elimina
 * cualquier residuo por seguridad antes de escribir en el editor.
 */

const FENCED_BLOCK = /```[ \t]*[a-zA-Z0-9_+#.-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Quita el Markdown: si hay bloques cercados se queda con su contenido, si no, elimina las cercas sueltas. */
export function stripMarkdown(raw: string): string {
  if (!raw) {
    return '';
  }
  let text = raw.replace(/\r\n/g, '\n');
  const blocks: string[] = [];
  text = text.replace(FENCED_BLOCK, (_match, body: string) => {
    blocks.push(body);
    return '';
  });
  if (blocks.length > 0) {
    // Se descarta el texto fuera de los bloques (suele ser charla del modelo).
    text = blocks.join('\n');
  }

  text = text
    // Cercas sueltas sin cierre.
    .replace(/```[ \t]*[a-zA-Z0-9_+#.-]*/g, '')
    // Comillas triples residuales: solo cercas en lineas completas (no toques strings C# """...""").
    .replace(/^[ \t]*```[ \t]*$/gm, '')
    // Negritas / cursivas solo entre texto de una linea (no toques el operador multiplicador *):
    // se limitan a `*texto*` y `**texto**` rodeados de inicio/espacio.
    .replace(/(^|\s)\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*(?=\s|$)/gm, '$1$2')
    .replace(/(^|\s)\*(?!\s)([^*\n\s][^*\n]*?)(?<!\s)\*(?=\s|$)/gm, '$1$2');

  return text;
}

/**
 * Elimina comentarios // y /* *\/ sin romper strings, caracteres,
 * strings verbatim (@"..."), raw strings ("""...""") ni #if/#region obligatorios de C#.
 */
export function stripComments(source: string): string {
  // 1) Comentarios de linea (son seguros fuera de strings salvo "http://", se protege abajo).
  const withoutLineComments = stripLineComments(source);
  // 2) Comentarios de bloque.
  const withoutBlockComments = stripBlockComments(withoutLineComments);
  // 3) Normaliza espacios sobrantes: los comentarios eliminados dejan huecos en la linea.
  //    No se toca la indentacion (solo huecos entre tokens).
  return withoutBlockComments
    .replace(/[ \t]+$/gm, '')
    .replace(/(\S)[ \t]{2,}(\S)/g, '$1 $2');
}

/** Elimina comentarios // respetando strings, chars y URLs dentro de strings. */
function stripLineComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === '"' || ch === '\'' || (ch === '@' && source[i + 1] === '"') || (ch === '$' && (source[i + 1] === '"' || source[i + 1] === '@'))) {
      const end = scanStringEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Elimina comentarios /* *\/ respetando strings, chars y raw strings. */
function stripBlockComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === '"' || ch === '\'' || (ch === '@' && source[i + 1] === '"') || (ch === '$' && (source[i + 1] === '"' || source[i + 1] === '@'))) {
      const end = scanStringEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        i++;
      }
      i = Math.min(n, i + 2);
      if (source[i] === '\r') {
        out += '\n';
        i += source[i + 1] === '\n' ? 2 : 1;
      } else if (source[i] === '\n') {
        out += '\n';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Devuelve el indice justo despues del literal que empieza en `start`
 * (comilla simple, string normal/interpolado/verbatim o raw string).
 */
function scanStringEnd(source: string, start: number): number {
  const n = source.length;
  let i = start;
  let verbatim = false;

  if (source[i] === '\'') {
    i++;
    while (i < n) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '\'') {
        return i + 1;
      }
      if (source[i] === '\n') {
        return i;
      }
      i++;
    }
    return n;
  }

  // Prefijos: @" / $@" / @$" / $
  while (i < n && (source[i] === '@' || source[i] === '$')) {
    if (source[i] === '@') {
      verbatim = true;
    }
    i++;
  }

  // Raw string """...""" (sin prefijo $/@ en la version basica).
  if (!verbatim && source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
    let quotes = 0;
    while (source[i + quotes] === '"') {
      quotes++;
    }
    const closing = '"'.repeat(quotes);
    i += quotes;
    const endIdx = source.indexOf(closing, i);
    return endIdx === -1 ? n : endIdx + closing.length;
  }

  if (source[i] !== '"') {
    return start + 1;
  }
  i++; // comilla de apertura

  while (i < n) {
    if (verbatim) {
      if (source[i] === '"') {
        if (source[i + 1] === '"') {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i++;
    } else {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '"') {
        return i + 1;
      }
      if (source[i] === '\n') {
        return i;
      }
      i++;
    }
  }
  return n;
}

/** Normaliza espacios en blanco sobrantes creados por la eliminacion de comentarios. */
function tidyWhitespace(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/** Pipeline completo: markdown -> comentarios -> limpieza fina. */
export function sanitizeCSharp(raw: string): string {
  const withoutMarkdown = stripMarkdown(raw);
  const withoutComments = stripComments(withoutMarkdown);
  return tidyWhitespace(withoutComments);
}
