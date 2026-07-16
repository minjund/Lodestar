'use strict';

/**
 * One-time stylesheet organizer used by the readability refactor.
 *
 * It reads the legacy cascade in document order, coalesces only identical
 * selector preludes within the same media context, and writes the result into
 * responsibility-based stylesheets. Different selectors, states, and media
 * queries remain independent so their cascade remains explicit.
 */

const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const inputFiles = [
  'styles.css',
  'styles-components.css',
  'styles-cards.css',
  'styles-overlays.css',
  'styles-agent-map.css',
  'styles-workflows.css',
  'styles-workflow-map.css',
  'styles-collaboration.css',
  'styles-tmux.css',
  'styles-terminal.css',
  'styles-run-composer.css',
  'styles-product.css',
  'styles-onboarding.css',
  'styles-settings.css',
  'styles-responsive.css',
  'styles-responsive-shell.css',
  'styles-responsive-workflows.css',
  'styles-responsive-runtime.css',
  'styles-responsive-product.css',
].filter(fileName => fs.existsSync(path.join(rendererDir, fileName)));

function stripComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
}

function findBlockEnd(source, openIndex) {
  let depth = 1;
  let quote = '';
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  throw new Error(`CSS block opened at ${openIndex} is not closed.`);
}

function parseBlocks(source) {
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /\s|;/.test(source[cursor])) cursor += 1;
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2);
      cursor = commentEnd < 0 ? source.length : commentEnd + 2;
      continue;
    }
    if (cursor >= source.length) break;

    let openIndex = cursor;
    let quote = '';
    for (; openIndex < source.length; openIndex += 1) {
      const character = source[openIndex];
      if (quote) {
        if (character === '\\') openIndex += 1;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (source.startsWith('/*', openIndex)) {
        const commentEnd = source.indexOf('*/', openIndex + 2);
        openIndex = commentEnd < 0 ? source.length : commentEnd + 1;
      } else if (character === '{') break;
    }
    if (openIndex >= source.length) break;

    const closeIndex = findBlockEnd(source, openIndex);
    const prelude = stripComments(source.slice(cursor, openIndex));
    if (prelude) {
      blocks.push({
        prelude,
        body: source.slice(openIndex + 1, closeIndex),
      });
    }
    cursor = closeIndex + 1;
  }
  return blocks;
}

function splitDeclarations(body) {
  const declarations = [];
  let start = 0;
  let quote = '';
  let parentheses = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index] || ';';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === ';' && parentheses === 0) {
      const declaration = stripComments(body.slice(start, index));
      start = index + 1;
      if (!declaration) continue;
      const colon = declaration.indexOf(':');
      if (colon < 1) throw new Error(`Invalid declaration: ${declaration}`);
      declarations.push({
        property: declaration.slice(0, colon).trim(),
        value: declaration.slice(colon + 1).trim(),
      });
    }
  }
  return declarations;
}

function splitSelectors(prelude) {
  const selectors = [];
  let start = 0;
  let quote = '';
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index <= prelude.length; index += 1) {
    const character = prelude[index] || ',';
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(prelude.slice(start, index).trim());
      start = index + 1;
    }
  }
  return selectors.filter(Boolean);
}

function normalizedSelectorPrelude(prelude) {
  return splitSelectors(prelude).join(',');
}

function ownerFor(prelude, sourceFile) {
  const selector = prelude.toLowerCase();
  if (/settings|update-|version-|release-|language-/.test(selector)) return 'settings';
  if (/beginner-|guide-|new-run|mobile-tools|onboarding/.test(selector)) return 'onboarding';
  if (/run-composer|run-step|run-prompt|run-provider|run-workspace|run-submit|run-modal|run-folder|run-advanced/.test(selector)) return 'runcomposer';
  if (/run-|provider-option|runtime-|permission-|prompt-example|shortcut-hint/.test(selector)) return 'product';
  if (/tmux/.test(selector)) return 'tmux';
  if (/terminal|tmux/.test(selector)) return 'terminal';
  if (/communication|collaboration|subagent|memory-|completed-agent|agent-dialog/.test(selector)) return 'collaboration';
  if (/graph-|tree-|focus-|provider-overview|global-stat|poc-/.test(selector)) return 'agentmap';
  if (/agent-workflow|workflow-summary|workflow-children|downstream-|upstream-/.test(selector)) return 'workflowmap';
  if (/agent-|workflow|relation|process-|live-/.test(selector)) return 'workflows';
  if (/drawer|modal|backdrop|toast|close-button/.test(selector)) return 'overlays';
  if (/^(:root|html|body|\*|button,input|button\{|\.hidden|\.app-shell|\.sidebar|\.brand|\.nav-|\.view-nav|\.main-stage|\.topbar|\.top-actions|\.subtitle|\.eyebrow)/.test(selector)) return 'base';
  if (/session-card|card-|now-strip|preview-line|context-meter|token-|provider-mark|status-pill/.test(selector)) return 'cards';
  if (sourceFile === 'styles-product.css') return 'product';
  return 'components';
}

const rules = [];
const specialBlocks = [];
let sequence = 0;

function collectBlocks(blocks, sourceFile, media = '') {
  for (const block of blocks) {
    if (block.prelude.startsWith('@media')) {
      collectBlocks(parseBlocks(block.body), sourceFile, block.prelude);
      continue;
    }
    if (block.prelude.startsWith('@font-face') || block.prelude.startsWith('@keyframes')) {
      specialBlocks.push({ ...block, sourceFile, sequence: sequence += 1 });
      continue;
    }
    if (block.prelude.startsWith('@')) {
      throw new Error(`Unsupported at-rule: ${block.prelude}`);
    }
    const declarations = splitDeclarations(block.body);
    for (const selector of splitSelectors(normalizedSelectorPrelude(block.prelude))) {
      rules.push({
        prelude: selector,
        declarations,
        sourceFile,
        media,
        sequence: sequence += 1,
      });
    }
  }
}

for (const inputFile of inputFiles) {
  collectBlocks(parseBlocks(fs.readFileSync(path.join(rendererDir, inputFile), 'utf8')), inputFile);
}

function mergeRules(sourceRules) {
  const grouped = new Map();
  for (const rule of sourceRules) {
    const key = `${rule.media}\u0000${rule.prelude}`;
    const group = grouped.get(key) || {
      prelude: rule.prelude,
      media: rule.media,
      sourceFile: rule.sourceFile,
      sequence: rule.sequence,
      blocks: [],
    };
    group.sourceFile = rule.sourceFile;
    group.sequence = rule.sequence;
    group.blocks.push(rule);
    grouped.set(key, group);
  }

  return [...grouped.values()].map(group => {
    const lastBlockForProperty = new Map();
    group.blocks.forEach((block, blockIndex) => {
      block.declarations.forEach(declaration => lastBlockForProperty.set(declaration.property, blockIndex));
    });
    group.declarations = group.blocks.flatMap((block, blockIndex) => block.declarations
      .filter(declaration => lastBlockForProperty.get(declaration.property) === blockIndex));
    return group;
  }).sort((left, right) => left.sequence - right.sequence);
}

const mergedRules = mergeRules(rules);

function formatPrelude(prelude, indent) {
  const selectors = splitSelectors(prelude);
  if (selectors.length === 1) return `${indent}${selectors[0]}`;
  return selectors.map((selector, index) => `${indent}${selector}${index < selectors.length - 1 ? ',' : ''}`).join('\n');
}

function formatRule(rule, indent = '') {
  const lines = [`${formatPrelude(rule.prelude, indent)} {`];
  for (const declaration of rule.declarations) {
    lines.push(`${indent}  ${declaration.property}: ${declaration.value};`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function formatSpecialBlock(block) {
  if (block.prelude.startsWith('@font-face')) {
    return formatRule({ prelude: block.prelude, declarations: splitDeclarations(block.body) });
  }
  const frames = parseBlocks(block.body).map(frame => ({
    prelude: frame.prelude,
    declarations: splitDeclarations(frame.body),
  }));
  return `${block.prelude} {\n${frames.map(frame => formatRule(frame, '  ')).join('\n\n')}\n}`;
}

const headers = {
  base: `/*\n * Foundation\n * -----------\n * Design tokens, document defaults, application shell, and primary navigation.\n */`,
  components: `/*\n * Shared components\n * -----------------\n * Reusable buttons, cards, lists, drawers, dialogs, and data presentation.\n */`,
  cards: `/*\n * Session cards and metrics\n * -------------------------\n * Session summaries, provider marks, status pills, context meters, and token data.\n */`,
  overlays: `/*\n * Overlays and transient UI\n * -------------------------\n * Drawers, modal surfaces, backdrops, close controls, and toast messages.\n */`,
  agentmap: `/*\n * Agent map\n * ---------\n * Graph navigation, relationship trees, focus layouts, and provider summaries.\n */`,
  workflows: `/*\n * Agent workflows\n * ---------------\n * Agent relationships, process maps, collaboration state, and live topology.\n */`,
  workflowmap: `/*\n * Directed workflow map\n * ---------------------\n * Upstream/downstream columns, connection ports, summaries, and routed edges.\n */`,
  collaboration: `/*\n * Collaboration detail\n * --------------------\n * Subagent state, delegated work, communication history, and memory detail.\n */`,
  terminal: `/*\n * Terminal workspaces\n * -------------------\n * Local PTY sessions, tmux topology, terminal controls, and command history.\n */`,
  tmux: `/*\n * tmux workspaces\n * ---------------\n * tmux topology, panes, sessions, controls, and runtime-specific presentation.\n */`,
  product: `/*\n * Product experiences\n * -------------------\n * Onboarding, run composer, settings, language, and release management.\n */`,
  runcomposer: `/*\n * Run composer\n * ------------\n * Provider selection, prompt entry, workspace suggestions, and submission flow.\n */`,
  onboarding: `/*\n * Onboarding and navigation help\n * ------------------------------\n * First-run guidance, progress cues, compact tools, and primary entry actions.\n */`,
  settings: `/*\n * Settings and releases\n * ---------------------\n * Language preferences, version state, release notes, and update actions.\n */`,
};

const outputs = { base: [], components: [], cards: [], overlays: [], agentmap: [], workflows: [], workflowmap: [], collaboration: [], terminal: [], tmux: [], product: [], runcomposer: [], onboarding: [], settings: [] };
for (const rule of mergedRules.filter(rule => !rule.media)) {
  outputs[ownerFor(rule.prelude, rule.sourceFile)].push(formatRule(rule));
}

for (const block of specialBlocks) {
  const name = block.prelude.toLowerCase();
  let owner = 'base';
  if (/update|orbit/.test(name)) owner = 'settings';
  else if (/agent|flow|pulse/.test(name)) owner = 'workflows';
  outputs[owner].push(formatSpecialBlock(block));
}

const outputFiles = {
  base: 'styles.css',
  components: 'styles-components.css',
  cards: 'styles-cards.css',
  overlays: 'styles-overlays.css',
  agentmap: 'styles-agent-map.css',
  workflows: 'styles-workflows.css',
  workflowmap: 'styles-workflow-map.css',
  collaboration: 'styles-collaboration.css',
  terminal: 'styles-terminal.css',
  tmux: 'styles-tmux.css',
  product: 'styles-product.css',
  runcomposer: 'styles-run-composer.css',
  onboarding: 'styles-onboarding.css',
  settings: 'styles-settings.css',
};
for (const [owner, fileName] of Object.entries(outputFiles)) {
  fs.writeFileSync(path.join(rendererDir, fileName), `${headers[owner]}\n\n${outputs[owner].join('\n\n')}\n`);
}

const responsiveDomains = {
  shell: {
    fileName: 'styles-responsive-shell.css',
    title: 'Responsive shell and shared components',
    description: 'Application shell, navigation, shared cards, and content density.',
  },
  workflows: {
    fileName: 'styles-responsive-workflows.css',
    title: 'Responsive agent workflows',
    description: 'Agent maps, routed workflows, collaboration detail, and live topology.',
  },
  runtime: {
    fileName: 'styles-responsive-runtime.css',
    title: 'Responsive terminal and tmux workspaces',
    description: 'Terminal workbench, tmux resources, command controls, and runtime panes.',
  },
  product: {
    fileName: 'styles-responsive-product.css',
    title: 'Responsive product surfaces',
    description: 'Overlays, run composer, onboarding, settings, and update surfaces.',
  },
};

const rootOwnerBySelector = new Map(mergedRules
  .filter(rule => !rule.media)
  .map(rule => [rule.prelude, ownerFor(rule.prelude, rule.sourceFile)]));

function responsiveDomain(rule) {
  const owner = rootOwnerBySelector.get(rule.prelude) || ownerFor(rule.prelude, rule.sourceFile);
  if (['agentmap', 'workflows', 'workflowmap', 'collaboration'].includes(owner)) return 'workflows';
  if (['terminal', 'tmux'].includes(owner)) return 'runtime';
  if (['overlays', 'product', 'runcomposer', 'onboarding', 'settings'].includes(owner)) return 'product';
  return 'shell';
}

const mediaGroupsByDomain = Object.fromEntries(Object.keys(responsiveDomains).map(domain => [domain, new Map()]));
for (const rule of mergedRules.filter(rule => rule.media)) {
  const mediaGroups = mediaGroupsByDomain[responsiveDomain(rule)];
  const items = mediaGroups.get(rule.media) || [];
  items.push(rule);
  mediaGroups.set(rule.media, items);
}

function breakpointLabel(media) {
  if (media.includes('prefers-reduced-motion')) return 'Reduced motion';
  const minimumWidth = media.match(/min-width:\s*(\d+)px/);
  const maximumWidth = media.match(/max-width:\s*(\d+)px/);
  const maximumHeight = media.match(/max-height:\s*(\d+)px/);
  if (minimumWidth && maximumWidth) return `Intermediate width ${minimumWidth[1]}–${maximumWidth[1]}px`;
  if (minimumWidth) return `Wide screens ≥ ${minimumWidth[1]}px`;
  if (maximumWidth) return `Compact screens ≤ ${maximumWidth[1]}px`;
  if (maximumHeight) return `Short screens ≤ ${maximumHeight[1]}px high`;
  return media.replace(/^@media\s*/, 'Conditional layout: ');
}

function responsivePurpose(domain, media) {
  if (media.includes('prefers-reduced-motion')) return 'preserve state changes while removing decorative movement';
  if (media.includes('max-height')) return domain === 'product'
    ? 'shorten dialogs while keeping their primary actions in view'
    : 'protect the active workspace in a shallow window';
  if (media.includes('min-width') && media.includes('max-width')) return domain === 'workflows'
    ? 'use a two-stage graph route before the single-column collapse'
    : 'balance the intermediate layout without stretching controls';
  if (media.includes('min-width')) return domain === 'workflows'
    ? 'expand workflow columns and downstream lanes into the available canvas'
    : 'use the extra width without increasing reading-line length';

  const width = Number(media.match(/max-width:\s*(\d+)px/)?.[1] || 0);
  const purposeByRange = width >= 1300
    ? {
        shell: 'reduce shared card density before navigation needs to collapse',
        workflows: 'tighten workflow columns and connector gutters',
        runtime: 'stack terminal toolbars while retaining side resources',
        product: 'wrap secondary actions without changing dialog structure',
      }
    : width >= 900
      ? {
          shell: 'collapse content columns and simplify the side rail',
          workflows: 'move graph branches into compact rows without collisions',
          runtime: 'move resource lists above the workbench and preserve console height',
          product: 'reflow onboarding and setup choices into fewer columns',
        }
      : width >= 640
        ? {
            shell: 'replace the side rail with bottom navigation and protect horizontal space',
            workflows: 'stack relationship cards and route connectors vertically',
            runtime: 'turn runtime panes into a vertical workbench with wrapped controls',
            product: 'use edge-to-edge dialogs and single-column task forms',
          }
        : {
            shell: 'trim labels and spacing for the narrowest supported window',
            workflows: 'compress graph summaries while preserving task identity',
            runtime: 'prioritize the console and primary runtime actions',
            product: 'keep compact forms and dialog actions inside the safe area',
          };
  return purposeByRange[domain];
}

function responsiveOrder([media]) {
  if (media.includes('prefers-reduced-motion')) return 50_000;
  const maximumWidth = media.match(/max-width:\s*(\d+)px/);
  if (maximumWidth) return 10_000 - Number(maximumWidth[1]);
  const minimumWidth = media.match(/min-width:\s*(\d+)px/);
  if (minimumWidth) return 1_000 - Number(minimumWidth[1]);
  const maximumHeight = media.match(/max-height:\s*(\d+)px/);
  if (maximumHeight) return 20_000 - Number(maximumHeight[1]);
  return 30_000;
}

for (const [domain, definition] of Object.entries(responsiveDomains)) {
  const mediaGroups = mediaGroupsByDomain[domain];
  const responsiveSections = [...mediaGroups.entries()]
    .sort((left, right) => responsiveOrder(left) - responsiveOrder(right))
    .map(([media, mediaRules]) => {
      const formattedMedia = media.replace(/^@media\s*/, '@media ');
      const body = mediaRules.map(rule => formatRule(rule, '  ')).join('\n\n');
      const purpose = responsivePurpose(domain, media);
      return `/* ${breakpointLabel(media)}: ${purpose}. */\n${formattedMedia} {\n${body}\n}`;
    });
  const responsiveHeader = `/*\n * ${definition.title}\n * ${'-'.repeat(definition.title.length)}\n * ${definition.description}\n * Breakpoints are ordered wide-to-narrow, followed by height and motion rules.\n */`;
  fs.writeFileSync(path.join(rendererDir, definition.fileName), `${responsiveHeader}\n\n${responsiveSections.join('\n\n')}\n`);
}

process.stdout.write(JSON.stringify({
  inputRules: rules.length,
  mergedRules: mergedRules.length,
  collapsedRules: rules.length - mergedRules.length,
  mediaGroups: Object.fromEntries(Object.entries(mediaGroupsByDomain).map(([domain, groups]) => [domain, groups.size])),
  owners: Object.fromEntries(Object.entries(outputs).map(([owner, entries]) => [owner, entries.length])),
}, null, 2));
