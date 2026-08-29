import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTextKey, localizePoiName } from '../../src/core/i18n';
import { buildEdenFacility } from '../../src/world/maps/eden';
import { buildNeoCity } from '../../src/world/maps/neocity';
import { buildOldFront } from '../../src/world/maps/oldfront';
import { buildAsharaReach } from '../../src/world/maps/desert';

describe('localization contract', () => {
  it('defines every declarative data-i18n key used by the shipped HTML', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]!);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(isTextKey(key), key).toBe(true);
  });

  it('ships an explicit clickable spectator exit and a physical scope reticle', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('id="btn-spectate-exit"');
    expect(html).toContain('data-i18n="hud.spectateExit"');
    expect(html).toContain('class="scope-housing"');
    expect(html).toContain('class="scope-mil mil-h"');
    expect(html).toContain('class="scope-center-dot"');
    expect(html).toContain('id="heal-channel" class="hidden" role="progressbar"');
    expect(html).toContain('id="heal-time"');
  });

  it('localizes every authored POI on all four maps', () => {
    const maps = [buildNeoCity(), buildOldFront(), buildEdenFacility(), buildAsharaReach()];
    for (const map of maps) {
      for (const poi of map.pois) {
        expect(localizePoiName(poi.name, 'en')).toBe(poi.name);
        expect(localizePoiName(poi.name, 'ja'), `${map.id}: ${poi.name}`).not.toBe(poi.name);
      }
    }
  });
});
