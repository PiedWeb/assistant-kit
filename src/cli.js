/** Helpers for a project's `bin/assistant.js`. */

export function parseArguments(tokens) {
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
    const [name, inline] = token.slice(2).split(/=(.*)/s);
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
