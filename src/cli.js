import fs from 'node:fs';

/** Helpers for a project's `bin/assistant.js`. */

/**
 * `--flag value`, `--flag=value`, `--flag` (true) and `--` (everything after is
 * positional). With `known`, an unknown flag is refused: a command that writes
 * must stop on a typo rather than read `--help` as "no file named, so all".
 */
export function parseArguments(tokens, { known = null } = {}) {
  const allowed = known ? new Set(known) : null;
  const flagName = (name) => {
    if (allowed && !allowed.has(name)) {
      const list = [...allowed].map((item) => `--${item}`).join(', ') || 'aucune';
      throw new Error(`Option inconnue : --${name} (options : ${list}).`);
    }
    return name;
  };
  const positionals = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [raw, inline] = token.slice(2).split(/=(.*)/s);
    const name = flagName(raw);
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positionals, flags };
}

/**
 * JSON from a flag value, or from a file with `@file`: PowerShell strips the
 * inner double quotes of an argument, a file keeps them. No JSON value starts
 * with `@`, so the two forms cannot be confused. `fallback` when absent.
 */
export function jsonFlag(value, name = 'json', fallback = undefined) {
  if (value === undefined || value === true) {
    return fallback;
  }
  let text = String(value);
  if (text.startsWith('@')) {
    try {
      text = fs.readFileSync(text.slice(1), 'utf8').replace(/^\uFEFF/, '');
    } catch (error) {
      throw new Error(`--${name} ${value} : fichier illisible (${error.code || error.message}).`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`--${name} n’est pas un JSON valide (${error.message}). Sous PowerShell, les guillemets `
      + `internes disparaissent : écrire le JSON dans un fichier et passer --${name} @fichier.json.`);
  }
}

/** `--fields a,b,c` or `--fields '["a","b"]'` as an array; undefined when absent. */
export function listFlag(value, name = 'liste') {
  if (value === undefined || value === true) {
    return undefined;
  }
  const text = String(value).trim();
  if (text.startsWith('[') || text.startsWith('@')) {
    const list = jsonFlag(text, name);
    if (!Array.isArray(list)) {
      throw new Error(`--${name} attend une liste JSON ou des valeurs séparées par des virgules.`);
    }
    return list.map(String);
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Run a command's `main()` and turn its outcome into an exit code: the number
 * it returns, or 2 with `✗ message` on stderr (no stack, no secret) when it
 * throws (`error.exitCode` overrides). SIGINT exits 130 and SIGTERM 143.
 * Resolves to the exit code; only the launcher of a command should call it.
 */
export async function runCli(main, { signals = true, errorExitCode = 2, processImpl = process } = {}) {
  const handlers = { SIGINT: () => processImpl.exit(130), SIGTERM: () => processImpl.exit(143) };
  if (signals) {
    for (const [signal, handler] of Object.entries(handlers)) processImpl.on(signal, handler);
  }
  try {
    const code = await main();
    if (typeof code === 'number') {
      processImpl.exitCode = code;
    }
  } catch (error) {
    processImpl.stderr.write(`✗ ${error?.message || error}\n`);
    processImpl.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : errorExitCode;
  } finally {
    if (signals) {
      for (const [signal, handler] of Object.entries(handlers)) processImpl.off(signal, handler);
    }
  }
  return processImpl.exitCode ?? 0;
}

export function requireArguments(args, count, usage, command = 'assistant') {
  if (args.length < count) {
    throw new Error(`Usage : ${command} ${usage}`);
  }
}

export function requireFlag(flags, name) {
  if (!flags[name] || flags[name] === true) {
    throw new Error(`Option obligatoire : --${name}`);
  }
  return flags[name];
}

export function positiveInteger(value, fallback = null) {
  if (value === undefined && fallback !== null) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
    throw new Error(`Entier positif attendu, reçu : ${value}`);
  }
  return parsed;
}

export function print(value, stream = process.stdout) {
  if (value === null || value === undefined) {
    return;
  }
  stream.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

export function readStdin(stdin = process.stdin) {
  return new Promise((resolve, reject) => {
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

export function printPublication(results, stream = process.stdout) {
  for (const result of results.filter(Boolean)) {
    if (result.generated) {
      stream.write(`✓ statique ${result.host}/${result.slug}${result.durationMs ? ` (${result.durationMs} ms)` : ''}\n`);
    } else {
      stream.write(`○ statique ${result.host}/${result.slug} ignoré (${result.skipped || result.error})\n`);
    }
  }
}
