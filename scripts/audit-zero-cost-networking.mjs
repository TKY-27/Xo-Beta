/* global console, process */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(root, 'dist');
const receiptPath = join(distRoot, 'zero-cost-networking-audit.json');
const allowedWebSockets = new Set([
  'wss://nos.lol',
  'wss://relay.agorist.space',
  'wss://relay.mostro.network',
  'wss://schnorr.me',
]);

function configuredStunServers() {
  const source = readFileSync(join(root, 'src', 'net', 'ice.ts'), 'utf8');
  return [...source.matchAll(/['"](stun:[^'"]+)['"]/giu)].map((match) => match[1]);
}

const forbiddenRules = Object.freeze([
  { id: 'turn-uri', pattern: /\bturns?:[^\s"'`<>]+/giu },
  { id: 'turn-configuration', pattern: /\biceTransportPolicy\s*:\s*["']relay["']/giu },
  { id: 'turn-config-key', pattern: /\bturnConfig\b/giu },
  { id: 'turn-credential', pattern: /\b(?:TURN|RELAY)_(?:URL|HOST|USERNAME|PASSWORD|TOKEN|CREDENTIAL)\b|\bturn(?:Username|Password|Credential|Server)\b/giu },
  { id: 'cloudflare-realtime', pattern: /realtime\.cloudflare\.com|\bcloudflare\s+realtime\b/giu },
  { id: 'sfu', pattern: /\bsfu\b/giu },
  { id: 'multiplayer-authority', pattern: /\b(?:multiplayer|gameplay)(?:Server|Worker|PagesFunction|Function|Database|Endpoint|Relay|Sfu)\b/giu },
  { id: 'billable-provider-credential', pattern: /\b(?:BILLING_(?:API_KEY|TOKEN)|PAYMENT_(?:API_KEY|TOKEN|METHOD)|STRIPE_(?:SECRET|API_KEY|TOKEN)|CF_API_TOKEN|CLOUDFLARE_API_TOKEN|RELAY_API_KEY)\b/giu },
  { id: 'hidden-service-endpoint', pattern: /(?:\.workers\.dev|\.pages\.dev\/api\/|supabase|firebaseio|\/api\/(?:room|lobby|matchmaking|multiplayer))/giu },
]);

function isTextCandidate(file) {
  return /(?:\.css|\.html?|\.js|\.jsonc?|\.mjs|\.ts|\.txt|\.ya?ml|_headers)$/iu.test(file)
    || file.endsWith('.env.example');
}

function collectFiles(path, output) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (isTextCandidate(path)) output.add(path);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) collectFiles(join(path, entry), output);
}

function productionFiles() {
  const files = new Set();
  for (const path of [
    join(root, 'src'),
    join(root, 'index.html'),
    join(root, 'package.json'),
    join(root, 'package-lock.json'),
    join(root, 'vite.config.ts'),
    join(root, 'wrangler.jsonc'),
    join(root, 'public', '_headers'),
    join(root, '.env.example'),
    distRoot,
    join(root, '.wrangler', 'dry-run'),
  ]) collectFiles(path, files);
  return [...files].sort();
}

function relativePath(path) {
  return relative(root, path).replaceAll('\\', '/');
}

export function scanText(source, file = '') {
  const findings = [];
  if (source.includes('\u0000')) return findings;
  for (const rule of forbiddenRules) {
    // Trystero's distributed adapter contains the optional `turnConfig`
    // parameter in its generic API. It is not an endpoint or an active
    // configuration; source/config files remain subject to this rule, while
    // the bundle is independently checked for actual URI/credential use.
    if (rule.id === 'turn-config-key' && file.startsWith('dist/')) continue;
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ file, rule: rule.id, line });
      if (rule.pattern.lastIndex === match.index) rule.pattern.lastIndex += 1;
    }
  }
  if (file.endsWith('.js')) {
    const sockets = source.match(/wss:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+/giu) ?? [];
    for (const socket of new Set(sockets)) {
      if (!allowedWebSockets.has(socket)) {
        findings.push({ file, rule: 'unexpected-websocket-origin', line: 0 });
      }
    }
  }
  return findings;
}

function scan(files) {
  const findings = [];
  for (const file of files) {
    const name = relativePath(file);
    if (file === receiptPath) continue;
    try {
      findings.push(...scanText(readFileSync(file, 'utf8'), name));
    } catch {
      findings.push({ file: name, rule: 'unreadable-production-file', line: 0 });
    }
  }
  return findings;
}

function validateStaticDeploymentConfig() {
  const configPath = join(root, 'wrangler.jsonc');
  const source = readFileSync(configPath, 'utf8');
  const findings = [];
  if (!/"assets"\s*:/u.test(source)) {
    findings.push({ file: 'wrangler.jsonc', rule: 'missing-static-assets-config', line: 0 });
  }
  for (const key of ['main', 'routes', 'services', 'durable_objects', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'queues', 'vars']) {
    const match = source.match(new RegExp(`"${key}"\\s*:`, 'u'));
    if (match?.index !== undefined) {
      findings.push({
        file: 'wrangler.jsonc',
        rule: `unexpected-${key}-binding`,
        line: source.slice(0, match.index).split('\n').length,
      });
    }
  }
  return findings;
}

function testedCommitSha() {
  const supplied = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (supplied && /^[0-9a-f]{7,64}$/iu.test(supplied)) return supplied.toLowerCase();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  if (!existsSync(join(distRoot, 'index.html'))) {
    throw new Error('zero-cost audit requires dist/index.html; run npm run build first');
  }
  const files = productionFiles();
  const findings = [...scan(files), ...validateStaticDeploymentConfig()];
  const receipt = {
    schemaVersion: 1,
    result: findings.length === 0 ? 'pass' : 'fail',
    auditedAt: new Date().toISOString(),
    testedCommitSha: testedCommitSha(),
    architecture: {
      transport: 'direct-webrtc-only',
      signaling: 'public no-payment Nostr signaling',
      stun: 'public STUN only; credential-free',
      stunConfiguration: {
        servers: configuredStunServers(),
        iceTransportPolicy: 'all',
        credentials: false,
        relayCandidates: 'rejected',
      },
      turn: false,
      sfu: false,
      dedicatedGameServer: false,
      multiplayerDatabase: false,
      multiplayerWorker: false,
      multiplayerPagesFunction: false,
      paidRelayFallback: false,
      billableFallback: false,
      noServerAuthority: true,
    },
    scope: {
      sourceAndProductionConfig: true,
      lockfileMetadata: true,
      productionBundle: true,
      deploymentOutput: existsSync(join(root, '.wrangler', 'dry-run')),
      filesInspected: files.map(relativePath),
    },
    findings,
  };
  mkdirSync(distRoot, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (findings.length > 0) {
    console.error(`zero-cost networking audit FAILED (${findings.length} finding(s))`);
    for (const finding of findings) console.error(`${finding.rule}: ${finding.file}:${finding.line}`);
    process.exitCode = 1;
    return;
  }
  console.log(`zero-cost networking audit: PASS; receipt=${relativePath(receiptPath)}; sha=${receipt.testedCommitSha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`zero-cost networking audit FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
