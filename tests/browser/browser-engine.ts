import { chromium, firefox, webkit } from 'playwright';

/** Select a Playwright-managed engine for cross-engine QA. */
export function selectedBrowserType() {
  const engine = process.env.XO_BROWSER ?? 'chromium';
  if (engine === 'chromium') return chromium;
  if (engine === 'firefox') return firefox;
  if (engine === 'webkit') return webkit;
  throw new Error(`Invalid XO_BROWSER: ${engine}`);
}
