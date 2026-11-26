#!/usr/bin/env node
/**
 * Guards the profile README.
 *
 * Checks, in order:
 *   1. every file under assets/ stays inside the size budget
 *   2. every relative resource the README points at actually exists
 *   3. every #anchor the README links to matches a heading
 *   4. every external link answers
 *
 * Exit code 1 means a real defect: an oversized asset, a dangling relative
 * path, a dead anchor, or a 404/410 on a link. Refusals (401/403/429/5xx),
 * DNS failures and timeouts are warnings only, so that a site which blocks
 * bots cannot redden the build.
 *
 * Environment:
 *   MAX_ASSET_KB     asset size budget in KiB, default 200
 *   LINK_TIMEOUT_MS  per-link timeout, default 10000
 *   SKIP_LINKS       comma separated substrings to skip, e.g. "x.com,booth.pm"
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const readmePath = join(root, 'README.md');
const assetsDir = join(root, 'assets');

const MAX_ASSET_KB = Number(process.env.MAX_ASSET_KB ?? 200);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS ?? 10000);
const SKIP_LINKS = (process.env.SKIP_LINKS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const failures = [];
const warnings = [];
const passes = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pass(message) {
  passes.push(message);
}

/* 1. asset budget ------------------------------------------------------- */

function checkAssets() {
  if (!existsSync(assetsDir)) {
    pass('assets/ absent, nothing to weigh');
    return;
  }
  const entries = readdirSync(assetsDir).filter((name) => statSync(join(assetsDir, name)).isFile());
  let total = 0;
  for (const name of entries) {
    const bytes = statSync(join(assetsDir, name)).size;
    total += bytes;
    const kb = bytes / 1024;
    if (kb > MAX_ASSET_KB) {
      fail(`assets/${name} is ${kb.toFixed(1)} KB, over the ${MAX_ASSET_KB} KB budget`);
    } else {
      pass(`assets/${name} ${kb.toFixed(1)} KB`);
    }
  }
  const totalKb = (total / 1024).toFixed(1);
  if (entries.length > 0) {
    pass(`assets total ${totalKb} KB across ${entries.length} file(s)`);
  }
}

/* 2 and 3. references inside the README -------------------------------- */

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function collectAnchors(text) {
  const anchors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      anchors.add(slugify(heading[1]));
    }
  }
  const htmlHeading = /<h[1-6][^>]*\bid="([^"]+)"/gi;
  for (const match of text.matchAll(htmlHeading)) {
    anchors.add(match[1].toLowerCase());
  }
  return anchors;
}

function collectLinks(text) {
  const external = new Set();
  const relative = new Set();
  const anchors = new Set();

  const htmlRef = /\b(?:href|src)="([^"]+)"/g;
  const mdRef = /\]\(\s*([^)\s]+)\s*\)/g;

  const consider = (target) => {
    if (!target) return;
    if (target.startsWith('#')) {
      anchors.add(target.slice(1));
    } else if (/^https?:\/\//i.test(target)) {
      external.add(target);
    } else if (/^mailto:/i.test(target)) {
      // nothing to verify
    } else {
      relative.add(target.split('#')[0]);
    }
  };

  for (const match of text.matchAll(htmlRef)) consider(match[1]);
  for (const match of text.matchAll(mdRef)) consider(match[1]);

  return { external, relative, anchors };
}

function checkRelative(paths) {
  for (const target of paths) {
    const cleaned = decodeURIComponent(target).replace(/^\.\//, '');
    const resolved = normalize(join(root, cleaned));
    if (!resolved.startsWith(normalize(root))) {
      fail(`relative path escapes the repository: ${target}`);
      continue;
    }
    if (existsSync(resolved)) {
      pass(`relative ok  ${target}`);
    } else {
      fail(`relative path does not exist: ${target}`);
    }
  }
}

function checkAnchors(wanted, available) {
  for (const anchor of wanted) {
    const known = available.has(anchor.toLowerCase());
    if (known) {
      pass(`anchor ok    #${anchor}`);
    } else {
      const near = [...available].filter((a) => a.includes(anchor) || anchor.includes(a));
      const hint = near.length > 0 ? ` (headings include: ${near.join(', ')})` : '';
      fail(`anchor has no heading: #${anchor}${hint}`);
    }
  }
}

/* 4. external links ---------------------------------------------------- */

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  const headers = { 'user-agent': 'readme-link-check (+https://github.com/Nesarf/Nesarf)' };
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers });
    // Plenty of sites reject HEAD while answering GET fine.
    if ([400, 403, 405, 501].includes(response.status)) {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers });
      if (response.body) {
        await response.body.cancel();
      }
    }
    return { status: response.status, final: response.url };
  } catch (error) {
    return { error: error.name === 'AbortError' ? `timed out after ${LINK_TIMEOUT_MS} ms` : String(error.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkExternal(urls) {
  const queue = [...urls];
  const findings = [];

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (SKIP_LINKS.some((needle) => url.includes(needle))) {
        pass(`skipped      ${url}`);
        continue;
      }
      findings.push({ url, ...(await probe(url)) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, urls.length || 1) }, worker));

  for (const finding of findings) {
    if (finding.error) {
      warn(`unreachable  ${finding.url} (${finding.error})`);
      continue;
    }
    const { status } = finding;
    if (status >= 200 && status < 400) {
      pass(`link ok      ${status} ${finding.url}`);
    } else if (status === 404 || status === 410) {
      fail(`dead link    ${status} ${finding.url}`);
    } else {
      warn(`unverified   ${status} ${finding.url} (site refused or failed; not counted as a defect)`);
    }
  }
}

/* main ----------------------------------------------------------------- */

async function main() {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const text = readFileSync(readmePath, 'utf8');

  checkAssets();

  const { external, relative, anchors } = collectLinks(text);
  checkRelative(relative);
  checkAnchors(anchors, collectAnchors(text));
  await checkExternal(external);

  for (const line of passes) console.log(`ok       ${line}`);
  for (const line of warnings) {
    // Action annotations only mean something inside GitHub, so keep local runs clean.
    if (inActions) console.log(`::warning::${line}`);
    console.log(`warning  ${line}`);
  }
  for (const line of failures) {
    if (inActions) console.log(`::error::${line}`);
    console.log(`FAIL     ${line}`);
  }

  console.log('');
  console.log(`${passes.length} passed, ${warnings.length} warning(s), ${failures.length} failure(s)`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
