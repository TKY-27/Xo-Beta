/** One-off: close-up screenshots of a lobby rig per skin (attachment check). */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const skins = (process.env.QA_SKINS ?? 'vanguard,serath,seraph').split(',').filter(Boolean);

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const skin of skins) {
    await page.addInitScript((s) => {
      window.localStorage.setItem('xo-beta-settings-v1', JSON.stringify({ playerSkin: s }));
    }, skin.trim());
    await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'networkidle' });
    for (let i = 0; i < 60; i++) {
      const onboarding = await page.$('#onboarding-screen:not(.hidden)');
      if (onboarding) {
        await page.click('#btn-onb-en');
        await page.waitForTimeout(200);
        await page.click('#btn-onb-fp');
        await page.waitForTimeout(300);
        break;
      }
      const menu = await page.$('#main-menu:not(.hidden)');
      if (menu) break;
      await page.waitForTimeout(500);
    }
    await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
    await page.waitForTimeout(1200);
    // Zoom the canvas on the character via CSS for a closer look.
    await page.addStyleTag({ content: '#game-canvas{transform:scale(2.2);transform-origin:62% 55%;}' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `qa/rig-${skin.trim()}.png` });
  }
  await browser.close();
  await server.close();
}

void main();
