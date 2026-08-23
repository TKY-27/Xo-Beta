/**
 * UI layer: HUD, menus, settings, tactical map, loot panel, damage numbers,
 * captions, results. DOM-driven, fully localized via src/core/i18n.
 */

import {
  RARITY_CSS, WEAPONS, type Difficulty, type Rarity, type WeaponId,
} from '../core/balance';
import { getSettings, updateSettings, DEFAULT_BINDINGS, type KeyBindings } from '../core/settings';
import { t, setLang, getLang, onLangChanged, type TextKey } from '../core/i18n';
import type { Match } from '../sim/match';
import type { MapId } from '../world';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export type DifficultyChoice = Difficulty;
export interface PlaySelection {
  map: MapId;
  difficulty: DifficultyChoice;
}

/** Hydrate every [data-i18n] element; re-run on language change. */
function hydrateStatic(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as TextKey);
  });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export class Menus {
  selectedMap: MapId = 'neocity';
  selectedDifficulty: DifficultyChoice = 'hard';
  onPlayRequested: (sel: PlaySelection) => void = () => undefined;
  onResumeRequested: () => void = () => undefined;
  onQuitRequested: () => void = () => undefined;
  onUiSound?: (kind: 'click' | 'hover' | 'back' | 'confirm' | 'error') => void;
  private onOpenSettingsFromPause = false;
  private unsubs: Array<() => void> = [];

  constructor(private maps: Array<{ id: MapId; nameKey?: string; name: string; descKey?: string; description: string }>) {
    this.bindButtons();
    this.buildPlayMenu();
    this.buildSettings();
    hydrateStatic();
    this.show('main-menu');
    this.unsubs.push(onLangChanged(() => {
      hydrateStatic();
      this.buildPlayMenu();
    }));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }

  private show(id: string): void {
    const ids = ['main-menu', 'play-menu', 'settings-menu', 'credits-menu', 'pause-menu', 'results-screen', 'loading-screen'];
    for (const other of ids) $(other).classList.add('hidden');
    if (id) $(id).classList.remove('hidden');
  }

  showMainMenu(): void { this.show('main-menu'); }
  hideAll(): void { this.show(''); }
  showPause(): void {
    this.show('pause-menu');
    this.onOpenSettingsFromPause = false;
  }
  hidePause(): void {
    if (!$('pause-menu').classList.contains('hidden')) {
      this.show('');
      if (this.onOpenSettingsFromPause) this.onOpenSettingsFromPause = false;
    }
  }
  isAnyMenuOpen(): boolean {
    return !document.getElementById('main-menu')!.classList.contains('hidden') ||
      !document.getElementById('play-menu')!.classList.contains('hidden') ||
      !document.getElementById('settings-menu')!.classList.contains('hidden') ||
      !document.getElementById('credits-menu')!.classList.contains('hidden') ||
      !document.getElementById('pause-menu')!.classList.contains('hidden');
  }

  private bindButtons(): void {
    const click = (id: string, fn: () => void, sound: 'click' | 'back' | 'confirm' = 'click') => {
      $(id).addEventListener('click', () => {
        this.onUiSound?.(sound);
        fn();
      });
    };
    click('btn-play', () => this.show('play-menu'));
    click('btn-settings', () => { this.onOpenSettingsFromPause = false; this.show('settings-menu'); });
    click('btn-credits', () => this.show('credits-menu'));
    click('btn-credits-back', () => this.show('main-menu'), 'back');
    click('btn-play-back', () => this.show('main-menu'), 'back');
    click('btn-play-start', () => {
      this.onPlayRequested({ map: this.selectedMap, difficulty: this.selectedDifficulty });
    }, 'confirm');
    click('btn-settings-back', () => this.show(this.onOpenSettingsFromPause ? 'pause-menu' : 'main-menu'), 'back');
    click('btn-resume', () => this.onResumeRequested(), 'confirm');
    click('btn-pause-settings', () => { this.onOpenSettingsFromPause = true; this.show('settings-menu'); });
    click('btn-quit', () => this.onQuitRequested(), 'back');
    click('btn-results-menu', () => { $('results-screen').classList.add('hidden'); this.showMainMenu(); }, 'back');
    click('btn-results-again', () => {
      $('results-screen').classList.add('hidden');
      this.onPlayRequested({ map: this.selectedMap, difficulty: this.selectedDifficulty });
    }, 'confirm');
  }

  private buildPlayMenu(): void {
    const list = $('map-list');
    list.innerHTML = '';
    for (const m of this.maps) {
      const card = document.createElement('button');
      card.className = 'map-card' + (m.id === this.selectedMap ? ' selected' : '');
      const nameEl = document.createElement('h3');
      const descEl = document.createElement('p');
      const render = () => {
        nameEl.textContent = m.nameKey ? t(m.nameKey as TextKey) : m.name;
        descEl.textContent = m.descKey ? t(m.descKey as TextKey) : m.description;
      };
      render();
      card.append(nameEl, descEl);
      card.addEventListener('click', () => {
        this.selectedMap = m.id;
        list.querySelectorAll('.map-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.onUiSound?.('click');
      });
      list.appendChild(card);
    }

    const diffs: Array<[DifficultyChoice, TextKey]> = [
      ['normal', 'diff.normal'], ['hard', 'diff.hard'], ['elite', 'diff.elite'], ['nightmare', 'diff.nightmare'],
    ];
    const dlist = $('difficulty-list');
    dlist.innerHTML = '';
    for (const [d, key] of diffs) {
      const btn = document.createElement('button');
      btn.className = 'diff-btn' + (d === this.selectedDifficulty ? ' selected' : '');
      btn.textContent = t(key);
      btn.addEventListener('click', () => {
        this.selectedDifficulty = d;
        dlist.querySelectorAll('.diff-btn').forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
        this.onUiSound?.('click');
      });
      dlist.appendChild(btn);
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private row(labelText: string, inner: HTMLElement | string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'setting-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    div.appendChild(label);
    if (typeof inner === 'string') div.insertAdjacentHTML('beforeend', inner);
    else div.appendChild(inner);
    return div;
  }

  private slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
    inp.addEventListener('input', () => onInput(parseFloat(inp.value)));
    return inp;
  }

  private select(options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    for (const [v, l] of options) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = l;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  private checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = checked;
    inp.addEventListener('change', () => onChange(inp.checked));
    return inp;
  }

  private buildSettings(): void {
    const s = getSettings();

    // Controls
    const controls = $('settings-controls');
    controls.appendChild(this.row(t('set.language'), this.select(
      [['en', 'English'], ['ja', '日本語']], getLang(),
      (v) => setLang(v as 'en' | 'ja'),
    )));
    controls.appendChild(this.row(t('set.mouseSens'), this.slider(0.2, 3, 0.05, s.sensitivity, (v) => updateSettings({ sensitivity: v }))));
    controls.appendChild(this.row(t('set.adsSens'), this.slider(0.2, 2, 0.05, s.adsSensitivity, (v) => updateSettings({ adsSensitivity: v }))));
    controls.appendChild(this.row(t('set.invertY'), this.checkbox(s.invertY, (v) => updateSettings({ invertY: v }))));
    controls.appendChild(this.row(t('set.fov'), this.slider(60, 110, 1, s.fov, (v) => updateSettings({ fov: v }))));

    const resetBtn = document.createElement('button');
    resetBtn.className = 'keybind';
    resetBtn.textContent = t('set.resetKeys');
    resetBtn.addEventListener('click', () => {
      updateSettings({ bindings: { ...DEFAULT_BINDINGS } });
      this.buildKeybinds();
      this.onUiSound?.('confirm');
    });
    controls.appendChild(resetBtn);

    // Gamepad
    controls.appendChild(this.sectionTitle(t('set.gamepad')));
    controls.appendChild(this.row(t('set.gamepadEnabled'), this.checkbox(s.gamepadEnabled, (v) => updateSettings({ gamepadEnabled: v }))));
    controls.appendChild(this.row(t('set.padLookSens'), this.slider(0.3, 3, 0.05, s.padLookSens, (v) => updateSettings({ padLookSens: v }))));
    controls.appendChild(this.row(t('set.padDeadzone'), this.slider(0.05, 0.45, 0.01, s.padDeadzone, (v) => updateSettings({ padDeadzone: v }))));
    controls.appendChild(this.row(t('set.vibration'), this.checkbox(s.vibration, (v) => updateSettings({ vibration: v }))));

    // Graphics
    const graphics = $('settings-graphics');
    graphics.appendChild(this.row(t('set.quality'), this.select(
      [['low', t('q.low')], ['medium', t('q.medium')], ['high', t('q.high')], ['ultra', t('q.ultra')], ['cinematic', t('q.cinematic')]],
      s.quality, (v) => { updateSettings({ quality: v as never }); },
    )));
    graphics.appendChild(this.row(t('set.resScale'), this.slider(0.5, 1.5, 0.05, s.resolutionScale, (v) => updateSettings({ resolutionScale: v }))));
    graphics.appendChild(this.row(t('set.shadows'), this.checkbox(s.shadows, (v) => updateSettings({ shadows: v }))));
    graphics.appendChild(this.row(t('set.shadowQuality'), this.select(
      [['low', t('q.low')], ['medium', t('q.medium')], ['high', t('q.high')], ['cinematic', t('q.cinematic')]],
      s.shadowQuality, (v) => updateSettings({ shadowQuality: v as never }),
    )));
    graphics.appendChild(this.row(t('set.bloom'), this.checkbox(s.bloom && s.postProcessing, (v) => updateSettings({ postProcessing: true, bloom: v }))));
    graphics.appendChild(this.row(t('set.ao'), this.checkbox(s.ao, (v) => updateSettings({ ao: v }))));
    graphics.appendChild(this.row(t('set.aa'), this.select(
      [['off', t('aa.off')], ['fxaa', t('aa.fxaa')], ['smaa', t('aa.smaa')]],
      s.aa === 'smaa' ? 'smaa' : s.aa, (v) => updateSettings({ aa: v as never }),
    )));

    // Audio
    const audioSec = $('settings-audio');
    audioSec.appendChild(this.row(t('set.masterVol'), this.slider(0, 1, 0.05, s.masterVolume, (v) => updateSettings({ masterVolume: v }))));
    audioSec.appendChild(this.row(t('set.musicVol'), this.slider(0, 1, 0.05, s.musicVolume, (v) => updateSettings({ musicVolume: v }))));
    audioSec.appendChild(this.row(t('set.sfxVol'), this.slider(0, 1, 0.05, s.sfxVolume, (v) => updateSettings({ sfxVolume: v }))));
    audioSec.appendChild(this.row(t('set.ambVol'), this.slider(0, 1, 0.05, s.ambienceVolume, (v) => updateSettings({ ambienceVolume: v }))));
    audioSec.appendChild(this.row(t('set.uiVol'), this.slider(0, 1, 0.05, s.uiVolume, (v) => updateSettings({ uiVolume: v }))));
    audioSec.appendChild(this.row(t('set.captions'), this.checkbox(s.captions, (v) => updateSettings({ captions: v }))));

    // Gameplay & accessibility
    const gameplay = $('settings-gameplay');
    gameplay.appendChild(this.row(t('set.cameraMode'), this.select(
      [['fps', t('cam.fps')], ['tps', t('cam.tps')]], s.cameraMode, (v) => updateSettings({ cameraMode: v as never }),
    )));
    gameplay.appendChild(this.row(t('set.damageNumbers'), this.checkbox(s.damageNumbers, (v) => updateSettings({ damageNumbers: v }))));
    gameplay.appendChild(this.row(t('set.colorVision'), this.select(
      [['none', t('cv.none')], ['protanopia', t('cv.protanopia')], ['deuteranopia', t('cv.deuteranopia')], ['tritanopia', t('cv.tritanopia')]],
      s.colorVision, (v) => updateSettings({ colorVision: v as never }),
    )));
    gameplay.appendChild(this.row(t('set.reducedMotion'), this.checkbox(s.reducedMotion, (v) => updateSettings({ reducedMotion: v }))));
    gameplay.appendChild(this.row(t('set.camShake'), this.slider(0, 1.5, 0.1, s.cameraShake, (v) => updateSettings({ cameraShake: v }))));
    gameplay.appendChild(this.row(t('set.crosshairColor'), `<input type="color" value="${s.crosshairColor}" data-setting="crosshairColor" />`));
    gameplay.appendChild(this.row(t('set.crosshairSize'), this.slider(4, 20, 1, s.crosshairSize, (v) => updateSettings({ crosshairSize: v }))));
    gameplay.appendChild(this.row(t('set.crosshairDot'), this.checkbox(s.crosshairDot, (v) => updateSettings({ crosshairDot: v }))));
    gameplay.appendChild(this.row(t('set.showFps'), this.checkbox(s.showFps, (v) => updateSettings({ showFps: v }))));

    const colorInput = gameplay.querySelector<HTMLInputElement>('input[data-setting="crosshairColor"]');
    colorInput?.addEventListener('change', () => updateSettings({ crosshairColor: colorInput.value }));

    this.buildKeybinds();
  }

  private sectionTitle(text: string): HTMLElement {
    const h = document.createElement('h3');
    h.textContent = text.toUpperCase();
    h.style.cssText = 'margin-top:1rem;';
    return h;
  }

  private keybindRows: Array<{ code: keyof KeyBindings; el: HTMLElement }> = [];

  private buildKeybinds(): void {
    const host = $('settings-controls');
    for (const kb of this.keybindRows) kb.el.remove();
    this.keybindRows = [];
    const b = getSettings().bindings;
    const labels: Partial<Record<keyof KeyBindings, TextKey>> = {
      forward: 'bind.forward', back: 'bind.back', left: 'bind.left', right: 'bind.right',
      jump: 'bind.jump', sprint: 'bind.sprint', crouch: 'bind.crouch',
      reload: 'bind.reload', interact: 'bind.interact', dash: 'bind.dash',
      grapple: 'bind.grapple', groundPound: 'bind.groundPound',
      useMedkit: 'bind.useMedkit', useShield: 'bind.useShield',
      dropWeapon: 'bind.dropWeapon', cameraToggle: 'bind.cameraToggle', mapToggle: 'bind.mapToggle',
    };
    for (const [code, labelKey] of Object.entries(labels)) {
      const key = code as keyof KeyBindings;
      const btn = document.createElement('button');
      btn.className = 'keybind';
      btn.textContent = prettyKey(b[key]);
      btn.addEventListener('click', () => {
        btn.classList.add('listening');
        btn.textContent = t('bind.pressKey');
        const handler = (e: KeyboardEvent) => {
          e.preventDefault();
          const patch: Partial<KeyBindings> = {};
          patch[key] = e.code;
          updateSettings({ bindings: { ...getSettings().bindings, ...patch } });
          btn.textContent = prettyKey(e.code);
          btn.classList.remove('listening');
          window.removeEventListener('keydown', handler, true);
        };
        window.addEventListener('keydown', handler, true);
      });
      const rowEl = document.createElement('div');
      rowEl.className = 'setting-row';
      const lbl = document.createElement('label');
      lbl.textContent = labelKey ? t(labelKey) : code;
      rowEl.append(lbl, btn);
      host.appendChild(rowEl);
      this.keybindRows.push({ code: key, el: rowEl });
    }
  }

  showResults(opts: {
    won: boolean;
    winnerName: string;
    placement: number;
    kills: number;
    damage: number;
    accuracy: number;
    headshots: number;
    survivalTime: number;
  }): void {
    const title = $('results-title');
    title.textContent = opts.won ? t('results.victory') : `#${opts.placement}`;
    title.className = opts.won ? 'win' : 'loss';
    $('results-subtitle').textContent = opts.won
      ? t('results.subtitle.win', { name: opts.winnerName })
      : t('results.subtitle.lose', { name: opts.winnerName });
    const grid = $('results-grid');
    grid.innerHTML = '';
    const cells: Array<[TextKey, string]> = [
      ['stats.placement', `#${opts.placement}`],
      ['stats.eliminations', String(opts.kills)],
      ['stats.damage', String(Math.round(opts.damage))],
      ['stats.accuracy', `${Math.round(opts.accuracy * 100)}%`],
      ['stats.headshots', String(opts.headshots)],
      ['stats.survived', formatTime(opts.survivalTime)],
    ];
    let delay = 0;
    for (const [k, v] of cells) {
      const cell = document.createElement('div');
      cell.className = 'stat-cell';
      cell.style.animation = `rise 0.4s ${delay}s both`;
      delay += 0.07;
      const vEl = document.createElement('div');
      vEl.className = 'v'; vEl.textContent = v;
      const kEl = document.createElement('div');
      kEl.className = 'k'; kEl.textContent = t(k);
      cell.append(vEl, kEl);
      grid.appendChild(cell);
    }
    const flare = $('victory-flare');
    flare.classList.toggle('on', !!opts.won);
    $('results-screen').classList.remove('hidden');
  }
}

function prettyKey(code: string): string {
  return code
    .replace('Key', '').replace('Digit', '').replace('Arrow', '')
    .replace('Left', 'L-').replace('Right', 'R-')
    .replace('Mouse0', 'LMB').replace('Mouse2', 'RMB')
    .toUpperCase();
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const WEAPON_ICONS: Record<string, string> = {
  pistol: '⌐', smg: '⁝⁝', ar: '⟋', shotgun: '≡', sniper: '⌇',
};

export interface LootPanelInfo {
  name: string;
  typeText: string;
  rarityText: string;
  rarityColor: string;
  metaText: string;
  keyLabel: string;
  inventoryFull: boolean;
}

interface DamageNumberEntry {
  worldX: number; worldY: number; worldZ: number;
  el: HTMLElement;
  age: number;
  life: number;
}

export interface TacMarker {
  x: number;
  z: number;
}

export class Hud {
  private killfeedEntries: Array<{ el: HTMLElement; t: number }> = [];
  private bannerTimer = 0;
  private elimTimer = 0;
  private hitmarkerTimer = 0;
  private dmgNumbers: DamageNumberEntry[] = [];
  private captionEls = new Map<TextKey | string, HTMLElement>();
  private projector: ((x: number, y: number, z: number) => { x: number; y: number; visible: boolean }) | null = null;
  tacMarker: TacMarker | null = null;

  constructor() {
    this.applyCrosshair();
    onLangChanged(() => {
      hydrateStatic();
      this.applyCrosshair();
    });
  }

  show(visible: boolean): void {
    $('hud').classList.toggle('hidden', !visible);
  }

  /** World→screen projection used by damage numbers. */
  setProjector(fn: Hud['projector']): void {
    this.projector = fn;
  }

  applyCrosshair(): void {
    const s = getSettings();
    const ch = $('crosshair');
    ch.style.setProperty('--ch-color', s.crosshairColor);
    ch.style.setProperty('--ch-len', `${s.crosshairSize}px`);
    ch.style.setProperty('--ch-gap', `${Math.round(s.crosshairSize * 0.7)}px`);
    const dot = ch.querySelector<HTMLElement>('.ch-dot');
    if (dot) dot.style.display = s.crosshairDot ? 'block' : 'none';
  }

  syncPlayerState(match: Match): void {
    const p = match.player;
    if (!p) return;

    $('health-fill').style.width = `${p.health}%`;
    $('shield-fill').style.width = `${p.shield}%`;
    $('health-text').textContent = String(Math.ceil(p.health));
    $('shield-text').textContent = String(Math.ceil(p.shield));

    const w = p.inv.selectedWeapon;
    if (w) {
      const def = WEAPONS[w.weaponId];
      $('ammo-mag').textContent = String(w.ammoInMag);
      $('ammo-reserve').textContent = String(p.inv.ammo[def.ammoType]);
      $('weapon-name').textContent = t(`wpn.${w.weaponId}` as TextKey).toUpperCase();
    } else {
      $('ammo-mag').textContent = '—';
      $('ammo-reserve').textContent = '';
      $('weapon-name').textContent = t('hud.unarmed');
    }

    // Slots
    const slotsEl = $('inventory-slots');
    if (slotsEl.childElementCount !== 5) {
      slotsEl.innerHTML = '';
      for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'slot empty';
        slot.innerHTML = `<span class="num">${i + 1}</span><span class="icon"></span>`;
        slotsEl.appendChild(slot);
      }
    }
    for (let i = 0; i < 5; i++) {
      const slot = slotsEl.children[i] as HTMLElement;
      const item = p.inv.slots[i];
      slot.classList.toggle('active', i === p.inv.selected);
      const icon = slot.querySelector<HTMLElement>('.icon')!;
      if (!item) {
        slot.className = 'slot empty' + (i === p.inv.selected ? ' active' : '');
        icon.textContent = '';
        continue;
      }
      if (item.kind === 'weapon') {
        slot.className = 'slot' + (i === p.inv.selected ? ' active' : '');
        icon.style.color = RARITY_CSS[item.rarity];
        icon.style.textShadow = `0 0 6px ${RARITY_CSS[item.rarity]}`;
        icon.textContent = WEAPON_ICONS[item.weaponId] ?? '⌗';
      } else {
        const med = item.itemId === 'medkit';
        slot.className = `slot heal-${item.itemId}` + (i === p.inv.selected ? ' active' : '');
        icon.style.color = '';
        icon.style.textShadow = '';
        icon.textContent = med ? `✚${item.count}` : `◇${item.count}`;
      }
    }

    $('alive-count').textContent = String(match.aliveCount);
    $('kills-count').textContent = String(p.stats.kills);

    // Healing channel bar
    const channel = $('heal-channel');
    if (p.healing) {
      channel.classList.remove('hidden');
      $('heal-label').textContent = p.healing.itemId === 'medkit' ? t('heal.medkit') : t('heal.shieldpot');
      $('heal-fill').style.width = `${(1 - p.healing.remaining / p.healing.total) * 100}%`;
    } else {
      channel.classList.add('hidden');
    }

    // Storm timer text
    const st = match.storm;
    const stEl = $('storm-timer');
    if (st.state === 'idle') stEl.textContent = '';
    else if (st.state === 'waiting') stEl.textContent = `${t('hud.stormClosesIn')} ${formatTime(st.timer)}`;
    else if (st.state === 'shrinking') stEl.textContent = `${t('hud.stormShrinking')} — ${formatTime(st.timer)}`;
    else stEl.textContent = t('hud.finalCircle');

    // Vignettes
    const vig = $('vignette');
    vig.style.opacity = String(Math.max(0, 1 - p.health / 65));
    const stormVig = $('storm-vignette');
    stormVig.style.opacity = match.storm.isOutside(p.body.position.x, p.body.position.z) ? '0.85' : '0';

    this.bannerTimer -= 1 / 60;
    this.elimTimer -= 1 / 60;
    this.hitmarkerTimer -= 1 / 60;
    if (this.hitmarkerTimer <= 0) $('hitmarker').classList.remove('show');
    if (this.elimTimer <= 0) $('elim-banner').classList.add('hidden');
    if (this.bannerTimer <= 0) $('center-banner').classList.add('hidden');

    if (getSettings().showFps) $('fps-counter').classList.remove('hidden');
    else $('fps-counter').classList.add('hidden');

    // Live-update damage number positions
    this.updateDamageNumbers();
  }

  setFps(fps: number): void {
    $('fps-counter').textContent = `${Math.round(fps)} FPS`;
  }

  hitmarker(headshot: boolean): void {
    const hm = $('hitmarker');
    hm.classList.remove('show', 'headshot');
    void hm.offsetWidth;
    hm.classList.add('show');
    if (headshot) hm.classList.add('headshot');
    this.hitmarkerTimer = 0.18;
  }

  banner(text: string, duration = 3): void {
    const el = $('center-banner');
    el.textContent = text;
    el.classList.remove('hidden');
    this.bannerTimer = duration;
  }

  elimination(text: string): void {
    const el = $('elim-banner');
    el.textContent = text;
    el.classList.remove('hidden');
    this.elimTimer = 2.2;
  }

  stormWarning(text: string, duration = 4): void {
    const el = $('storm-warning');
    el.textContent = text;
    el.classList.remove('hidden');
    window.setTimeout(() => el.classList.add('hidden'), duration * 1000);
  }

  addKillfeed(killer: string | null, victim: string, weaponIcon: string | null, headshot: boolean, storm: boolean): void {
    const feed = $('killfeed');
    const entry = document.createElement('div');
    entry.className = 'kf-entry';
    const killerHtml = killer ? `<b class="killer">${killer}</b>` : `<b class="killer dim">${storm ? t('kill.storm') : '—'}</b>`;
    const wpnHtml = weaponIcon ? `<span class="wpn">[${weaponIcon}]</span>` : '';
    entry.innerHTML = `${killerHtml}${wpnHtml}${headshot ? '<span class="hs">✦</span>' : ''}<b class="victim">${victim}</b>`;
    feed.appendChild(entry);
    this.killfeedEntries.push({ el: entry, t: performance.now() });
    while (this.killfeedEntries.length > 6) {
      const old = this.killfeedEntries.shift()!;
      old.el.remove();
    }
    window.setTimeout(() => {
      entry.style.transition = 'opacity 0.5s';
      entry.style.opacity = '0';
      window.setTimeout(() => entry.remove(), 520);
    }, 6000);
  }

  interactPrompt(text: string | null): void {
    const el = $('interact-prompt');
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    $('interact-text').textContent = text;
    el.classList.remove('hidden');
  }

  /** Contextual loot panel shown when near ground items. */
  showLootPanel(info: LootPanelInfo | null): void {
    const panel = $('loot-panel');
    if (!info) {
      panel.classList.add('hidden');
      return;
    }
    panel.style.setProperty('--loot-rarity', info.rarityColor);
    $('lp-name').textContent = info.name;
    $('lp-type').textContent = info.typeText;
    $('lp-rarity').textContent = info.rarityText;
    $('lp-meta').textContent = info.metaText;
    $('lp-key').textContent = info.keyLabel;
    $('lp-full').classList.toggle('hidden', !info.inventoryFull);
    panel.classList.remove('hidden');
  }

  /** Spawn a floating damage number at a world position. */
  spawnDamageNumber(x: number, y: number, z: number, amount: number, kind: 'normal' | 'shield' | 'headshot' | 'kill'): void {
    if (!getSettings().damageNumbers) return;
    const layer = $('damage-numbers');
    const el = document.createElement('div');
    el.className = 'dmg-num' + (kind === 'normal' ? '' : ` ${kind}`);
    el.textContent = kind === 'kill' ? `✕ ${amount}` : String(Math.round(amount));
    layer.appendChild(el);
    this.dmgNumbers.push({
      worldX: x + (Math.random() - 0.5) * 0.35,
      worldY: y + 0.35 + Math.random() * 0.25,
      worldZ: z + (Math.random() - 0.5) * 0.35,
      el,
      age: 0,
      life: kind === 'headshot' ? 1.05 : 0.9,
    });
    if (this.dmgNumbers.length > 28) {
      const old = this.dmgNumbers.shift()!;
      old.el.remove();
    }
  }

  private updateDamageNumbers(): void {
    if (!this.projector) return;
    for (let i = this.dmgNumbers.length - 1; i >= 0; i--) {
      const n = this.dmgNumbers[i]!;
      n.age += 1 / 60;
      if (n.age >= n.life) {
        n.el.remove();
        this.dmgNumbers.splice(i, 1);
        continue;
      }
      const rise = n.age / n.life;
      const sp = this.projector(n.worldX, n.worldY + rise * 1.15, n.worldZ);
      if (!sp.visible) {
        n.el.style.opacity = '0';
        continue;
      }
      n.el.style.left = `${sp.x * 100}%`;
      n.el.style.top = `${sp.y * 100}%`;
    }
  }

  /** Accessibility captions for important sounds. */
  caption(key: string, important = false): void {
    if (!getSettings().captions) return;
    if (this.captionEls.has(key)) return;
    const host = $('captions');
    const chip = document.createElement('div');
    chip.className = 'caption-chip' + (important ? ' important' : '');
    chip.textContent = key;
    host.appendChild(chip);
    this.captionEls.set(key, chip);
    window.setTimeout(() => {
      chip.style.transition = 'opacity 0.4s';
      chip.style.opacity = '0';
      window.setTimeout(() => {
        chip.remove();
        this.captionEls.delete(key);
      }, 420);
    }, important ? 2200 : 1400);
  }

  showSpectate(name: string): void {
    $('spectate-hud').classList.remove('hidden');
    $('spectate-name').textContent = name;
  }

  hideSpectate(): void {
    $('spectate-hud').classList.add('hidden');
  }

  isTacMapOpen(): boolean {
    return !$('tac-map-overlay').classList.contains('hidden');
  }

  toggleTacMap(force?: boolean): void {
    const overlay = $('tac-map-overlay');
    const open = force ?? overlay.classList.contains('hidden');
    overlay.classList.toggle('hidden', !open);
  }

  /**
   * Draw the fullscreen tactical map. Returns the canvas so main can attach
   * click handlers once.
   */
  drawTacMap(match: Match): HTMLCanvasElement {
    const canvas = $<HTMLCanvasElement>('tac-map');
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const size = canvas.width;
    const half = match.mapDef.size / 2;
    const toPx = (wx: number) => ((wx + half) / match.mapDef.size) * size;
    ctx.clearRect(0, 0, size, size);

    // backdrop
    ctx.fillStyle = 'rgba(14,19,30,0.96)';
    ctx.fillRect(0, 0, size, size);

    // water
    ctx.fillStyle = 'rgba(64,130,190,0.4)';
    for (const w of match.mapDef.water) {
      ctx.fillRect(toPx(w.minX), toPx(w.minZ), ((w.maxX - w.minX) / match.mapDef.size) * size, ((w.maxZ - w.minZ) / match.mapDef.size) * size);
    }

    // POIs
    for (const poi of match.mapDef.pois) {
      ctx.fillStyle = 'rgba(140,165,195,0.16)';
      ctx.beginPath();
      ctx.arc(toPx(poi.x), toPx(poi.z), (poi.radius / match.mapDef.size) * size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(190,205,225,0.85)';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(poi.name, toPx(poi.x), toPx(poi.z));
    }

    // transport route
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(toPx(match.mapDef.transportRoute.from[0]!), toPx(match.mapDef.transportRoute.from[1]!));
    ctx.lineTo(toPx(match.mapDef.transportRoute.to[0]!), toPx(match.mapDef.transportRoute.to[1]!));
    ctx.stroke();
    ctx.setLineDash([]);

    // storm circles
    const st = match.storm;
    if (st.state !== 'idle') {
      ctx.strokeStyle = 'rgba(120,190,255,0.95)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(toPx(st.centerX), toPx(st.centerZ), (st.radius / match.mapDef.size) * size, 0, Math.PI * 2);
      ctx.stroke();
      if (st.state !== 'done') {
        const nc = st.nextCircle();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.arc(toPx(nc.x), toPx(nc.z), (nc.r / match.mapDef.size) * size, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // outside shading
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(toPx(st.centerX), toPx(st.centerZ), (st.radius / match.mapDef.size) * size, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(70,120,210,0.16)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    // marker
    if (this.tacMarker) {
      ctx.strokeStyle = '#ffb43a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(toPx(this.tacMarker.x), toPx(this.tacMarker.z), 9, 0, Math.PI * 2);
      ctx.moveTo(toPx(this.tacMarker.x) - 13, toPx(this.tacMarker.z));
      ctx.lineTo(toPx(this.tacMarker.x) + 13, toPx(this.tacMarker.z));
      ctx.moveTo(toPx(this.tacMarker.x), toPx(this.tacMarker.z) - 13);
      ctx.lineTo(toPx(this.tacMarker.x), toPx(this.tacMarker.z) + 13);
      ctx.stroke();
    }

    // me
    const me = match.player;
    if (me?.alive) {
      ctx.save();
      ctx.translate(toPx(me.body.position.x), toPx(me.body.position.z));
      ctx.rotate(me.yaw);
      ctx.fillStyle = '#5fd0ff';
      ctx.beginPath();
      ctx.moveTo(11, 0); ctx.lineTo(-7, 8); ctx.lineTo(-7, -8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    return canvas;
  }

  /** Minimap: player-centered top-down view with POIs, storm circle, actors, marker. */
  drawMinimap(match: Match, ctxProvider: () => CanvasRenderingContext2D | null): void {
    const ctx = ctxProvider();
    if (!ctx) return;
    const size = 188;
    const scale = size / (match.mapDef.size * 0.62);
    const me = match.player;
    const cx = me ? me.body.position.x : 0;
    const cz = me ? me.body.position.z : 0;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cz);

    for (const poi of match.mapDef.pois) {
      ctx.fillStyle = 'rgba(140,165,195,0.32)';
      ctx.beginPath();
      ctx.arc(poi.x, poi.z, Math.max(4, poi.radius * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }

    for (const w of match.mapDef.water) {
      ctx.fillStyle = 'rgba(70,140,190,0.4)';
      ctx.fillRect(w.minX, w.minZ, w.maxX - w.minX, w.maxZ - w.minZ);
    }

    const st = match.storm;
    if (st.state !== 'idle') {
      ctx.strokeStyle = 'rgba(120,190,255,0.9)';
      ctx.lineWidth = 3 / scale;
      ctx.beginPath();
      ctx.arc(st.centerX, st.centerZ, st.radius, 0, Math.PI * 2);
      ctx.stroke();
      if (st.state !== 'done') {
        const nc = st.nextCircle();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.setLineDash([8 / scale, 8 / scale]);
        ctx.beginPath();
        ctx.arc(nc.x, nc.z, nc.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (this.tacMarker) {
      ctx.strokeStyle = '#ffb43a';
      ctx.lineWidth = 2 / scale;
      const r = 10 / scale;
      ctx.beginPath();
      ctx.arc(this.tacMarker.x, this.tacMarker.z, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const a of match.actors) {
      if (!a.alive || a === me) continue;
      ctx.fillStyle = '#ff5f5f';
      ctx.beginPath();
      ctx.arc(a.body.position.x, a.body.position.z, 5 / scale * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }

    if (me) {
      ctx.save();
      ctx.translate(me.body.position.x, me.body.position.z);
      ctx.rotate(me.yaw);
      ctx.fillStyle = '#5fd0ff';
      ctx.beginPath();
      ctx.moveTo(10 / scale, 0);
      ctx.lineTo(-6 / scale, 7 / scale);
      ctx.lineTo(-6 / scale, -7 / scale);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  minimapContext(): CanvasRenderingContext2D | null {
    return ($('minimap') as unknown as HTMLCanvasElement).getContext('2d');
  }
}
