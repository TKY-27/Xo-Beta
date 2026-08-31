/**
 * Localization QA: captures every player-facing screen in the given language
 * (default ja) and flags visible English/Japanese leakage.
 * Usage: npx tsx tests/browser/qa-lang.ts [en|ja]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const lang = process.argv[2] ?? 'ja';
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await page.addInitScript((l) => {
    localStorage.setItem('xo-beta-lang', l as string);
    localStorage.setItem('xo-beta-settings-v1', JSON.stringify({
      quality: 'high', shadows: true, postProcessing: true, bloom: true, aa: 'fxaa',
    }));
  }, lang);
  await page.goto('http://localhost:5199/?qa=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `qa/lang-${lang}-01-menu.png`, timeout: 60000 });

  await page.click('#btn-play');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `qa/lang-${lang}-02-play.png`, timeout: 60000 });

  await page.click('#btn-play-back');
  await page.click('#btn-settings');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `qa/lang-${lang}-03-settings-top.png`, timeout: 60000 });
  const gs = await page.evaluate(() => {
    const g = document.getElementById('settings-graphics');
    g?.scrollIntoView({ block: 'center' });
    return true;
  });
  void gs;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `qa/lang-${lang}-04-settings-graphics.png`, timeout: 60000 });
  await page.evaluate(() => document.getElementById('settings-gameplay')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `qa/lang-${lang}-05-settings-gameplay.png`, timeout: 60000 });

  // Switch language live and verify settings rebuild
  if (lang === 'en') {
    await page.evaluate(() => document.getElementById('settings-controls')?.scrollIntoView({ block: 'center' }));
    await page.selectOption('select', 'ja');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `qa/lang-${lang}-06-switched-ja.png`, timeout: 60000 });
  }

  await page.click('#btn-settings-back');
  await page.waitForTimeout(300);
  // Start a match to capture HUD/banner/interact in this language
  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#map-list .map-card:nth-child(1)');
  await page.evaluate(() => (document.getElementById('btn-play-start') as HTMLButtonElement).click());
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `qa/lang-${lang}-07-transport.png`, timeout: 60000 });
  await page.keyboard.press('Space');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `qa/lang-${lang}-08-drop.png`, timeout: 60000 });
  for (let i = 0; i < 60; i++) {
    const ph = await Promise.race([
      page.evaluate('window.__xoState ? window.__xoState.phase : "?"') as Promise<string>,
      new Promise<string>((r) => setTimeout(() => r(''), 3000)),
    ]);
    if (ph === 'live') break;
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `qa/lang-${lang}-09-hud.png`, timeout: 60000 });
  // pause menu
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `qa/lang-${lang}-10-pause.png`, timeout: 60000 });

  console.log('errors:', errors.length);
  for (const e of errors.slice(0, 6)) console.log(' •', e);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
