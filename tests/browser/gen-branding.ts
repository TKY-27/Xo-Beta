/**
 * Generates branding assets via headless Chromium:
 *  - og-card.jpg        1200x630 social share card (hero backdrop + wordmark)
 *  - apple-touch-icon   180x180 PNG of the XO mark
 * Run: npx tsx tests/browser/gen-branding.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu'] });

  // ---- OG card (1200x630) --------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: 'SairaCondensed'; src: url('/assets/fonts/SairaCondensed-900.woff2') format('woff2'); font-weight: 900; }
    @font-face { font-family: 'SairaCondensed'; src: url('/assets/fonts/SairaCondensed-600.woff2') format('woff2'); font-weight: 600; }
    @font-face { font-family: 'InterTight'; src: url('/assets/fonts/InterTight-500.woff2') format('woff2'); font-weight: 500; }
    html,body { margin:0; padding:0; width:1200px; height:630px; overflow:hidden; }
    .card { position:relative; width:1200px; height:630px;
      background: linear-gradient(100deg, rgba(6,13,24,0.94) 0%, rgba(6,13,24,0.82) 42%, rgba(6,13,24,0.30) 78%, rgba(6,13,24,0.15) 100%),
        url('/assets/maps/neocity.jpg') center/cover no-repeat; }
    .mark { position:absolute; left:84px; top:150px; }
    .word { font-family:'SairaCondensed'; font-weight:900; font-size:148px; letter-spacing:0.22em;
      color:#e8f1f8; line-height:1; margin:0; }
    .word span { color:#5fd0ff; font-weight:600; }
    .tag { font-family:'InterTight'; font-weight:500; font-size:27px; letter-spacing:0.14em;
      color:#9fb4c8; margin:26px 0 0 6px; }
    .rule { width:520px; height:3px; margin:34px 0 0 6px;
      background:linear-gradient(90deg,#5fd0ff 0%, rgba(95,208,255,0) 100%); }
    .foot { position:absolute; left:90px; bottom:56px; font-family:'InterTight'; font-weight:500;
      font-size:21px; letter-spacing:0.30em; color:#6d8299; }
  </style></head><body><div class="card">
    <div class="mark">
      <h1 class="word">XO<span>BETA</span></h1>
      <div class="rule"></div>
      <p class="tag">SINGLE-PLAYER BATTLE ROYALE · BROWSER-NATIVE</p>
    </div>
    <div class="foot">10 COMBATANTS · LAST ONE STANDING</div>
  </div></body></html>`, { waitUntil: 'networkidle' });
  await page.evaluate('document.fonts ? document.fonts.ready : null');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'public/assets/branding/og-card.jpg', type: 'jpeg', quality: 88 });

  // ---- Apple touch icon (180x180) -----------------------------------------
  const page2 = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await page2.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page2.setContent(`<!doctype html><html><head><style>
    html,body { margin:0; padding:0; width:180px; height:180px; overflow:hidden; }
    .icon { width:180px; height:180px; background:#0a1420; display:flex; align-items:center; justify-content:center; }
    .icon svg { width:150px; height:150px; }
  </style></head><body><div class="icon">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <g stroke-linecap="round">
        <g stroke="#e8f1f8" stroke-width="7">
          <line x1="12" y1="18" x2="28" y2="46"/>
          <line x1="28" y1="18" x2="12" y2="46"/>
        </g>
        <circle cx="45" cy="32" r="10" fill="none" stroke="#5fd0ff" stroke-width="7"/>
      </g>
    </svg>
  </div></body></html>`);
  await page2.waitForTimeout(300);
  await page2.screenshot({ path: 'public/assets/branding/apple-touch-icon.png' });

  await browser.close();
  await server.close();
  console.log('branding assets generated');
}

void main().catch((e) => { console.error(e); process.exit(1); });
