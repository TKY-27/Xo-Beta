/**
 * UI layer: HUD (health/shield/ammo/slots/crosshair/killfeed/minimap/banners),
 * menu screens, settings panels, results. DOM-driven; no framework.
 */

import {
  RARITY_CSS, WEAPONS,
  type Difficulty,
} from '../core/balance';
import { getSettings, updateSettings, DEFAULT_BINDINGS, type KeyBindings } from '../core/settings';
import type { Match } from '../sim/match';
import type { MapId } from '../world';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export type DifficultyChoice = Difficulty;
export interface PlaySelection {
  map: MapId;
  difficulty: DifficultyChoice;
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
  onOpenSettingsFromPause = false;

  constructor(private maps: Array<{ id: MapId; name: string; description: string }>) {
    this.bindButtons();
    this.buildPlayMenu();
    this.buildSettings();
    this.show('main-menu');
  }

  private show(id: string): void {
    const ids = ['main-menu', 'play-menu', 'settings-menu', 'credits-menu', 'pause-menu', 'results-screen', 'loading-screen'];
    for (const other of ids) $(other).classList.add('hidden');
    if (id) $(id).classList.remove('hidden');
    const hud = $('hud');
    if (id === '') hud.classList.remove('hidden');
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
    $('btn-play').addEventListener('click', () => this.show('play-menu'));
    $('btn-settings').addEventListener('click', () => { this.onOpenSettingsFromPause = false; this.show('settings-menu'); });
    $('btn-credits').addEventListener('click', () => this.show('credits-menu'));
    $('btn-credits-back').addEventListener('click', () => this.show('main-menu'));
    $('btn-play-back').addEventListener('click', () => this.show('main-menu'));
    $('btn-play-start').addEventListener('click', () => {
      this.onPlayRequested({ map: this.selectedMap, difficulty: this.selectedDifficulty });
    });
    $('btn-settings-back').addEventListener('click', () => {
      this.show(this.onOpenSettingsFromPause ? 'pause-menu' : 'main-menu');
    });
    $('btn-resume').addEventListener('click', () => this.onResumeRequested());
    $('btn-pause-settings').addEventListener('click', () => {
      this.onOpenSettingsFromPause = true;
      this.show('settings-menu');
    });
    $('btn-quit').addEventListener('click', () => this.onQuitRequested());
    $('btn-results-menu').addEventListener('click', () => { $('results-screen').classList.add('hidden'); this.showMainMenu(); });
    $('btn-results-again').addEventListener('click', () => {
      $('results-screen').classList.add('hidden');
      this.onPlayRequested({ map: this.selectedMap, difficulty: this.selectedDifficulty });
    });
  }

  private buildPlayMenu(): void {
    const list = $('map-list');
    list.innerHTML = '';
    for (const m of this.maps) {
      const card = document.createElement('button');
      card.className = 'map-card' + (m.id === this.selectedMap ? ' selected' : '');
      card.innerHTML = `<h3>${m.name}</h3><p>${m.description}</p>`;
      card.addEventListener('click', () => {
        this.selectedMap = m.id;
        list.querySelectorAll('.map-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      list.appendChild(card);
    }

    const diffs: Array<[DifficultyChoice, string]> = [
      ['normal', 'NORMAL'], ['hard', 'HARD'], ['elite', 'ELITE'], ['nightmare', 'NIGHTMARE'],
    ];
    const dlist = $('difficulty-list');
    dlist.innerHTML = '';
    for (const [d, label] of diffs) {
      const btn = document.createElement('button');
      btn.className = 'diff-btn' + (d === this.selectedDifficulty ? ' selected' : '');
      btn.dataset.d = d;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.selectedDifficulty = d;
        dlist.querySelectorAll('.diff-btn').forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
      });
      dlist.appendChild(btn);
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private buildSettings(): void {
    const s = getSettings();

    const row = (labelText: string, inner: HTMLElement | string): HTMLElement => {
      const div = document.createElement('div');
      div.className = 'setting-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      div.appendChild(label);
      if (typeof inner === 'string') {
        div.insertAdjacentHTML('beforeend', inner);
      } else {
        div.appendChild(inner);
      }
      return div;
    };

    const slider = (min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement => {
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(value);
      inp.addEventListener('input', () => onInput(parseFloat(inp.value)));
      return inp;
    };
    const select = (options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement => {
      const sel = document.createElement('select');
      for (const [v, l] of options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = l;
        sel.appendChild(opt);
      }
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };

    // Controls
    const controls = $('settings-controls');
    controls.appendChild(row('Mouse sensitivity', slider(0.2, 3, 0.05, s.sensitivity, (v) => updateSettings({ sensitivity: v }))));
    controls.appendChild(row('ADS sensitivity', slider(0.2, 2, 0.05, s.adsSensitivity, (v) => updateSettings({ adsSensitivity: v }))));
    const invertWrap = document.createElement('input');
    invertWrap.type = 'checkbox';
    invertWrap.checked = s.invertY;
    invertWrap.addEventListener('change', () => updateSettings({ invertY: invertWrap.checked }));
    controls.appendChild(row('Invert Y', invertWrap));
    controls.appendChild(row('Field of view', slider(60, 110, 1, s.fov, (v) => updateSettings({ fov: v }))));
    const resetBtn = document.createElement('button');
    resetBtn.className = 'keybind';
    resetBtn.textContent = 'RESET KEYS';
    resetBtn.addEventListener('click', () => {
      updateSettings({ bindings: { ...DEFAULT_BINDINGS } });
      this.rebuildKeybinds();
    });
    controls.appendChild(resetBtn);

    // Graphics
    const graphics = $('settings-graphics');
    graphics.appendChild(row('Quality preset', select(
      [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
      s.quality, (v) => { updateSettings({ quality: v as never }); },
    )));
    graphics.appendChild(row('Resolution scale', slider(0.5, 1.5, 0.05, s.resolutionScale, (v) => updateSettings({ resolutionScale: v }))));
    const shadowToggle = document.createElement('input');
    shadowToggle.type = 'checkbox';
    shadowToggle.checked = s.shadows;
    shadowToggle.addEventListener('change', () => updateSettings({ shadows: shadowToggle.checked }));
    graphics.appendChild(row('Shadows', shadowToggle));
    graphics.appendChild(row('Shadow quality', select([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.shadowQuality, (v) => updateSettings({ shadowQuality: v as never }))));
    const bloomToggle = document.createElement('input');
    bloomToggle.type = 'checkbox';
    bloomToggle.checked = s.bloom && s.postProcessing;
    bloomToggle.addEventListener('change', () => updateSettings({ postProcessing: true, bloom: bloomToggle.checked }));
    graphics.appendChild(row('Post-processing + bloom', bloomToggle));
    graphics.appendChild(row('Anti-aliasing', select([['off', 'Off'], ['fxaa', 'FXAA'], ['smaa', 'SMAA']], s.aa === 'smaa' ? 'smaa' : s.aa, (v) => updateSettings({ aa: v as never }))));
    const motionBlurNote = row('Motion blur / DoF', '<span class="dim">off — competitive readability</span>');
    graphics.appendChild(motionBlurNote);

    // Audio
    const audio = $('settings-audio');
    audio.appendChild(row('Master volume', slider(0, 1, 0.05, s.masterVolume, (v) => updateSettings({ masterVolume: v }))));
    audio.appendChild(row('Music', slider(0, 1, 0.05, s.musicVolume, (v) => updateSettings({ musicVolume: v }))));
    audio.appendChild(row('Effects', slider(0, 1, 0.05, s.sfxVolume, (v) => updateSettings({ sfxVolume: v }))));
    audio.appendChild(row('Ambience', slider(0, 1, 0.05, s.ambienceVolume, (v) => updateSettings({ ambienceVolume: v }))));
    audio.appendChild(row('UI', slider(0, 1, 0.05, s.uiVolume, (v) => updateSettings({ uiVolume: v }))));

    // Gameplay
    const gameplay = $('settings-gameplay');
    gameplay.appendChild(row('Camera mode', select([['fps', 'First person'], ['tps', 'Third person']], s.cameraMode, (v) => updateSettings({ cameraMode: v as never }))));
    gameplay.appendChild(row('Crosshair color', `<input type="color" value="${s.crosshairColor}" data-setting="crosshairColor" />`));
    gameplay.appendChild(row('Crosshair size', slider(4, 20, 1, s.crosshairSize, (v) => updateSettings({ crosshairSize: v }))));
    const dotToggle = document.createElement('input');
    dotToggle.type = 'checkbox';
    dotToggle.checked = s.crosshairDot;
    dotToggle.addEventListener('change', () => updateSettings({ crosshairDot: dotToggle.checked }));
    gameplay.appendChild(row('Center dot', dotToggle));
    gameplay.appendChild(row('Camera shake', slider(0, 1.5, 0.1, s.cameraShake, (v) => updateSettings({ cameraShake: v }))));
    const fpsToggle = document.createElement('input');
    fpsToggle.type = 'checkbox';
    fpsToggle.checked = s.showFps;
    fpsToggle.addEventListener('change', () => updateSettings({ showFps: fpsToggle.checked }));
    gameplay.appendChild(row('Show FPS counter', fpsToggle));

    const colorInput = gameplay.querySelector<HTMLInputElement>('input[data-setting="crosshairColor"]');
    colorInput?.addEventListener('change', () => updateSettings({ crosshairColor: colorInput.value }));

    this.keybindSectionEl = $('settings-controls');
    this.buildKeybinds();
  }

  private keybindSectionEl: HTMLElement | null = null;
  private keybindRows: Array<{ code: keyof KeyBindings; el: HTMLElement }> = [];

  private buildKeybinds(): void {
    if (!this.keybindSectionEl) return;
    for (const kb of this.keybindRows) kb.el.remove();
    this.keybindRows = [];
    const b = getSettings().bindings;
    const labels: Partial<Record<keyof KeyBindings, string>> = {
      forward: 'Forward', back: 'Back', left: 'Left', right: 'Right',
      jump: 'Jump', sprint: 'Sprint', crouch: 'Crouch / Slide',
      reload: 'Reload', interact: 'Interact', dash: 'Dash',
      grapple: 'Grapple', groundPound: 'Ground pound',
      useMedkit: 'Med Kit', useShield: 'Shield Cell',
      dropWeapon: 'Drop weapon', cameraToggle: 'FP/TPS toggle', mapToggle: 'Full map',
    };
    for (const [code, label] of Object.entries(labels)) {
      const key = code as keyof KeyBindings;
      const btn = document.createElement('button');
      btn.className = 'keybind';
      btn.textContent = prettyKey(b[key]);
      btn.addEventListener('click', () => {
        btn.classList.add('listening');
        btn.textContent = 'PRESS…';
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
      lbl.textContent = label ?? code;
      rowEl.appendChild(lbl);
      rowEl.appendChild(btn);
      this.keybindSectionEl.appendChild(rowEl);
      this.keybindRows.push({ code: key, el: rowEl });
    }
  }

  private rebuildKeybinds(): void {
    this.buildKeybinds();
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
    title.textContent = opts.won ? 'VICTORY' : `#${opts.placement}`;
    title.className = opts.won ? 'win' : 'loss';
    $('results-subtitle').textContent = opts.won
      ? `Last one standing · ${opts.winnerName} wins`
      : `${opts.winnerName} wins the match`;
    const grid = $('results-grid');
    grid.innerHTML = '';
    const cells: Array<[string, string]> = [
      ['PLACEMENT', `#${opts.placement}`],
      ['ELIMINATIONS', String(opts.kills)],
      ['DAMAGE', String(Math.round(opts.damage))],
      ['ACCURACY', `${Math.round(opts.accuracy * 100)}%`],
      ['HEADSHOTS', String(opts.headshots)],
      ['SURVIVED', formatTime(opts.survivalTime)],
    ];
    for (const [k, v] of cells) {
      const cell = document.createElement('div');
      cell.className = 'stat-cell';
      cell.innerHTML = `<div class="v">${v}</div><div class="k">${k}</div>`;
      grid.appendChild(cell);
    }
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

export class Hud {
  private killfeedEntries: Array<{ el: HTMLElement; t: number }> = [];
  private bannerTimer = 0;
  private elimTimer = 0;
  private hitmarkerTimer = 0;
  private spectateIndex = 0;

  constructor() {
    this.applyCrosshair();
  }

  show(visible: boolean): void {
    $('hud').classList.toggle('hidden', !visible);
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
      $('weapon-name').textContent = def.name.toUpperCase();
    } else {
      $('ammo-mag').textContent = '—';
      $('ammo-reserve').textContent = '';
      $('weapon-name').textContent = 'UNARMED';
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
      $('heal-label').textContent = p.healing.itemId === 'medkit' ? 'Applying Med Kit…' : 'Drinking Shield Cell…';
      $('heal-fill').style.width = `${(1 - p.healing.remaining / p.healing.total) * 100}%`;
    } else {
      channel.classList.add('hidden');
    }

    // Storm timer text
    const st = match.storm;
    const stEl = $('storm-timer');
    if (st.state === 'idle') stEl.textContent = '';
    else if (st.state === 'waiting') stEl.textContent = `STORM CLOSES IN ${formatTime(st.timer)}`;
    else if (st.state === 'shrinking') stEl.textContent = `STORM SHRINKING — ${formatTime(st.timer)}`;
    else stEl.textContent = 'FINAL CIRCLE';

    // Damage vignette by health
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

    // FPS counter
    if (getSettings().showFps) {
      $('fps-counter').classList.remove('hidden');
    } else {
      $('fps-counter').classList.add('hidden');
    }
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
    const killerHtml = killer ? `<b class="killer">${killer}</b>` : `<b class="killer dim">${storm ? 'STORM' : '—'}</b>`;
    const wpnHtml = weaponIcon ? `<span class="wpn">[${weaponIcon}]</span>` : (storm ? '' : '');
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

  showSpectate(name: string): void {
    $('spectate-hud').classList.remove('hidden');
    $('spectate-name').textContent = name;
  }

  hideSpectate(): void {
    $('spectate-hud').classList.add('hidden');
  }

  /** Minimap: player-centered top-down view with POIs, storm circle, actors. */
  drawMinimap(match: Match, ctxProvider: () => CanvasRenderingContext2D | null): void {
    const ctx = ctxProvider();
    if (!ctx) return;
    const size = 176;
    const scale = size / (match.mapDef.size * 0.62); // zoomed to ~62% of map
    const me = match.player;
    const cx = me ? me.body.position.x : 0;
    const cz = me ? me.body.position.z : 0;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cz);

    // POI dots
    for (const poi of match.mapDef.pois) {
      ctx.fillStyle = 'rgba(140,165,195,0.35)';
      ctx.beginPath();
      ctx.arc(poi.x, poi.z, Math.max(4, poi.radius * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }

    // Water
    for (const w of match.mapDef.water) {
      ctx.fillStyle = 'rgba(70,140,190,0.4)';
      ctx.fillRect(w.minX, w.minZ, w.maxX - w.minX, w.maxZ - w.minZ);
    }

    // Storm circles
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

    // Actors
    for (const a of match.actors) {
      if (!a.alive || a === me) continue;
      ctx.fillStyle = '#ff5f5f';
      ctx.beginPath();
      ctx.arc(a.body.position.x, a.body.position.z, 5 / scale * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }

    // Me
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
