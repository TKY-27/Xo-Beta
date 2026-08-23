import { chromium } from 'playwright';
import { createServer } from 'vite';
async function main() {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('ERR', e.message.slice(0, 200)));
  await page.addInitScript(() => {
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'low', shadows: false, shadowQuality: 'low',
      postProcessing: false, bloom: false, aa: 'off', resolutionScale: 0.7,
    }));
  });
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'qa/lobby.png', timeout: 60000 });
  console.log('lobby shot saved');
  // settings screen shot
  await page.click('#btn-settings');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'qa/settings.png', timeout: 60000 });
  console.log('settings shot saved');
  await browser.close(); await server.close();
}
void main();
