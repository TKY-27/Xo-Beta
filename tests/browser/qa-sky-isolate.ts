/** Screenshot the isolated sky page for dome-port verification. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors: string[] = [];
page.on('console', (m) => { errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('requestfailed', (r) => errors.push(`REQFAIL ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto('http://localhost:5199/tests/browser/qa-weapon-isolate.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.waitForTimeout(4000);
await page.screenshot({ path: 'qa/weapon-isolate.png' });
console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
await server.close();
