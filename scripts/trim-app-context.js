'use strict';

const fs = require('fs');
const path = require('path');

const renderer = path.join(__dirname, '..', 'renderer');
const files = fs.readdirSync(renderer)
  .filter(name => /^app-.+\.js$/.test(name) && name !== 'app-bootstrap.js')
  .sort();

function occurrences(source, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = identifier.includes('$') ? escaped : `\\b${escaped}\\b`;
  return (source.match(new RegExp(boundary, 'g')) || []).length;
}

for (const name of files) {
  const file = path.join(renderer, name);
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/  const \{\r?\n([\s\S]*?)\r?\n  \} = context;\r?\n/);
  if (!match) continue;
  const identifiers = [...new Set(match[1]
    .split(',')
    .map(value => value.trim())
    .filter(value => /^[A-Za-z_$][\w$]*$/.test(value)))];
  const body = source.slice((match.index || 0) + match[0].length);
  const used = identifiers.filter(identifier => occurrences(body, identifier) > 0);
  const replacement = `  const {\n${used.map(identifier => `    ${identifier},`).join('\n')}\n  } = context;\n`;
  fs.writeFileSync(file, source.replace(match[0], replacement), 'utf8');
  process.stdout.write(`${name}: ${identifiers.length} -> ${used.length}\n`);
}
