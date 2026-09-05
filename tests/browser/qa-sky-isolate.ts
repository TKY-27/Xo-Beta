/** Screenshot the isolated sky page for dome-port verification. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto('http://localhost:5199/tests/browser/qa-sky-isolate.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await page.screenshot({ path: 'qa/sky-isolate.png' });
console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
await server.close();
