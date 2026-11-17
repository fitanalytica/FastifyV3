import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The layering rules of README.md ("Layout"), enforced. If one of these fails, the code is in the wrong layer.
//   routes -> controller -> services -> (types, errors, config);  hooks, plugins and errors sit beside them.
//   schemas (request shapes) are used by routes, and types are derived from them.
const SRC = path.resolve(import.meta.dirname, '../src');

interface Source { file: string; layer: string; text: string; imports: { spec: string; layer: string | null }[] }

const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => f.split(path.sep).join('/'));

function load(rel: string): Source {
  const text = readFileSync(path.join(SRC, rel), 'utf8');
  const layer = rel.includes('/') ? rel.split('/')[0] : '(root)';
  const specs = [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?\sfrom\s+['"]([^'"]+)['"]/g), // import ... from 'x' / export ... from 'x'
    ...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),                              // import 'x'
  ].map((m) => m[1]);
  const imports = specs.map((spec) => {
    if (!spec.startsWith('.')) return { spec, layer: null };
    const target = path.relative(SRC, path.resolve(path.dirname(path.join(SRC, rel)), spec)).split(path.sep)[0];
    return { spec, layer: target };
  });
  return { file: rel, layer, text, imports };
}

const sources = files.map(load);
const inLayer = (l: string) => sources.filter((s) => s.layer === l);

// layer -> the layers it may import (itself is always allowed)
const MAY_IMPORT: Record<string, string[]> = {
  routes: ['controller', 'schemas'],
  controller: ['services', 'types'],
  services: ['types', 'errors', 'config'],
  hooks: ['services', 'errors', 'types', 'config'],
  plugins: ['hooks', 'types', 'config'],
  errors: ['types'],
  types: ['schemas'],
  schemas: [],
  config: [],
};

test('the scan sees the code (so the rules below cannot pass on nothing)', () => {
  expect(sources.length).toBeGreaterThan(25);
  for (const l of Object.keys(MAY_IMPORT)) expect(inLayer(l).length, `layer ${l}`).toBeGreaterThan(0);
});

describe('each layer imports only what it may', () => {
  for (const [layer, allowed] of Object.entries(MAY_IMPORT)) {
    test(layer, () => {
      for (const s of inLayer(layer)) {
        for (const i of s.imports) {
          if (i.layer === null || i.layer === layer || allowed.includes(i.layer)) continue;
          expect.fail(`${s.file} imports ${i.spec} (${i.layer}); ${layer} may only import ${[layer, ...allowed].join(', ')}`);
        }
      }
    });
  }
});

test('schemas import no package but typebox', () => {
  for (const s of inLayer('schemas')) {
    for (const i of s.imports.filter((x) => x.layer === null)) expect(i.spec, s.file).toBe('@sinclair/typebox');
  }
});

test('routes and controllers import no package but fastify', () => {
  for (const s of [...inLayer('routes'), ...inLayer('controller')]) {
    for (const i of s.imports.filter((x) => x.layer === null)) expect(i.spec, s.file).toBe('fastify');
  }
});

test('a router is a list: no if, no await, no throw, no SQL, no database', () => {
  for (const s of inLayer('routes')) {
    const code = s.text.replace(/\/\/.*$/gm, '');
    expect(code, s.file).not.toMatch(/\b(if|for|while|switch|throw|await)\b/);
    expect(code, s.file).not.toMatch(/\.pg\b|query\(|SELECT |INSERT /);
  }
});

test('a controller is thin: no database, no SQL, no throw, at most 20 lines', () => {
  for (const s of inLayer('controller')) {
    const code = s.text.replace(/\/\/.*$/gm, '');
    expect(code, s.file).not.toMatch(/\.pg\b|query\(|SELECT |INSERT |\bthrow\b/);
    expect(s.text.split('\n').length, `${s.file} has too many lines`).toBeLessThanOrEqual(20);
  }
});

test('a service knows nothing about the request or reply, nor about the layers above it', () => {
  for (const s of inLayer('services')) {
    expect(s.text, s.file).not.toMatch(/\bFastifyRequest\b|\bFastifyReply\b|\breq\.|\breply\./);
  }
});

test('only config/env.ts reads process.env', () => {
  for (const s of sources.filter((x) => x.file !== 'config/env.ts')) expect(s.text, s.file).not.toMatch(/process\.env/);
});

test('every controller export ends in a version, as in v2 (…V3)', () => {
  for (const s of inLayer('controller').filter((x) => x.file.includes('/v'))) {
    const names = [...s.text.matchAll(/export (?:const|async function|function) (\w+)/g)].map((m) => m[1]);
    expect(names.length, s.file).toBeGreaterThan(0);
    for (const n of names) expect(n, s.file).toMatch(/V\d+$/);
  }
});
