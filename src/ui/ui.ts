/**
 * UI layer: HUD, menus, settings, tactical map, loot panel, damage numbers,
 * captions, results. DOM-driven, fully localized via src/core/i18n.
 */

import {
  HEAL_ITEMS, RARITY_CSS, WEAPONS, type AmmoType, type Difficulty, type WeaponId,
} from '../core/balance';
import {
  PREFERRED_ITEM_CATEGORIES,
  type PreferredItemCategory,
  type PreferredItemSlots,
} from '../core/preferredSlots';
import { getSettings, onSettingsChanged, updateSettings, DEFAULT_BINDINGS, type KeyBindings } from '../core/settings';
import { SKIN_IDS } from '../render/characters';
import { SkinSelector, skinTextKey } from './skinSelector';
import {
  t, setLang, getLang, isTextKey, localizePoiName, onLangChanged, type TextKey,
} from '../core/i18n';
import type { Match } from '../sim/match';
import type { GameStateView, InventoryView } from '../sim/gameStateView';
import type { MapId } from '../world';
import type { MapDef } from '../world/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const settingCopy = (en: string, ja: string): string => getLang() === 'ja' ? ja : en;

export type DifficultyChoice = Difficulty;
export interface PlaySelection {
  map: MapId;
  difficulty: DifficultyChoice;
  practice?: boolean;
}

export interface MapMenuOption {
  id: MapId;
  nameKey?: string;
  name: string;
  descKey?: string;
  description: string;
  traits: {
    verticality: string;
    visibility: string;
    combatRange: string;
  };
}

/** Hydrate every [data-i18n] element; re-run on language change. */
function hydrateStatic(): void {
  const bindings = getSettings().bindings;
  const vars = {
    jump: prettyKey(bindings.jump),
    camera: prettyKey(bindings.cameraToggle),
    map: prettyKey(bindings.mapToggle),
    prev: prettyKey(bindings.spectatePrev),
    next: prettyKey(bindings.spectateNext),
  };
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key && isTextKey(key)) el.textContent = t(key, vars);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    const key = el.dataset.i18nAriaLabel;
    if (key && isTextKey(key)) el.setAttribute('aria-label', t(key, vars));
  });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export class Menus {
  /** An arena is intentionally unselected until the player chooses one. */
  selectedMap: MapId | null = null;
  selectedDifficulty: DifficultyChoice = 'hard';
  onPlayRequested: (sel: PlaySelection) => void = () => undefined;
  onCreateRoomRequested: () => void = () => undefined;
  onJoinRoomRequested: () => void = () => undefined;
  onResumeRequested: () => void = () => undefined;
  onQuitRequested: () => void = () => undefined;
  onUiSound?: (kind: 'click' | 'hover' | 'back' | 'confirm' | 'error') => void;
  private onOpenSettingsFromPause = false;
  private unsubs: Array<() => void> = [];
  private controlId = 0;
  private customizationSkinSelector: SkinSelector | null = null;
  private settingsSkinSelect: HTMLSelectElement | null = null;
  private playActionsEnabled = true;
  private menuGamepadFrame = 0;
  private menuGamepadButtons = new Array<boolean>(16).fill(false);

  constructor(private maps: MapMenuOption[]) {
    this.bindButtons();
    this.bindOnboarding();
    this.buildPlayMenu();
    this.buildSkinCustomization();
    this.buildSettings();
    hydrateStatic();
    if (!getSettings().onboarded) this.showOnboarding();
    else this.show('main-menu');
    this.menuGamepadFrame = requestAnimationFrame(() => this.pollMenuGamepad());
    this.unsubs.push(onSettingsChanged((settings) => {
      if (this.settingsSkinSelect) this.settingsSkinSelect.value = settings.playerSkin;
      const launchName = document.getElementById('skin-launch-name');
      if (launchName) launchName.textContent = t(skinTextKey(settings.playerSkin));
    }));
    this.unsubs.push(onLangChanged(() => {
      hydrateStatic();
      this.buildPlayMenu();
      this.customizationSkinSelector?.refresh();
      this.buildSettings();
    }));
  }

  dispose(): void {
    cancelAnimationFrame(this.menuGamepadFrame);
    this.customizationSkinSelector?.dispose();
    for (const u of this.unsubs) u();
  }

  /** Fired whenever a menu screen becomes active (id may be '' for none). */
  onScreenChanged: (id: string) => void = () => undefined;

  private show(id: string): void {
    const ids = [
      'main-menu', 'play-menu', 'create-room-menu', 'join-room-menu', 'online-lobby-menu',
      'settings-menu', 'skin-customization-menu', 'credits-menu', 'pause-menu', 'results-screen', 'loading-screen', 'onboarding-screen',
    ];
    for (const other of ids) $(other).classList.add('hidden');
    if (id) $(id).classList.remove('hidden');
    this.onScreenChanged(id);
    if (id === 'play-menu') {
      requestAnimationFrame(() => {
        const selected = this.selectedMap === null ? null
          : document.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`);
        (selected ?? document.querySelector<HTMLButtonElement>('.map-card'))?.focus();
      });
    }
    if (id === 'skin-customization-menu') {
      requestAnimationFrame(() => this.customizationSkinSelector?.focusSelected());
    }
  }

  /** Small menu-only Gamepad API bridge; gameplay owns GamepadInput. */
  private pollMenuGamepad(): void {
    this.menuGamepadFrame = requestAnimationFrame(() => this.pollMenuGamepad());
    const playMenu = $('play-menu');
    const skinMenu = $('skin-customization-menu');
    if ((playMenu.classList.contains('hidden') && skinMenu.classList.contains('hidden'))
      || !getSettings().gamepadEnabled || !navigator.getGamepads) {
      this.menuGamepadButtons.fill(false);
      return;
    }
    const pad = [...navigator.getGamepads()].find((candidate) => candidate?.connected) ?? null;
    if (!pad) {
      this.menuGamepadButtons.fill(false);
      return;
    }
    const edge = (index: number): boolean => {
      const pressed = !!pad.buttons[index]?.pressed;
      const rising = pressed && !this.menuGamepadButtons[index];
      this.menuGamepadButtons[index] = pressed;
      return rising;
    };
    const active = document.activeElement as HTMLElement | null;
    const skinFocused = !skinMenu.classList.contains('hidden')
      && active?.closest('#skin-customization-selector') != null;
    const previousHorizontal = edge(14);
    const previousVertical = edge(12);
    const nextHorizontal = edge(15);
    const nextVertical = edge(13);
    const previous = previousHorizontal || previousVertical;
    const next = nextHorizontal || nextVertical;
    if (previous) {
      if (skinFocused) this.customizationSkinSelector?.selectByOffset(-1);
      else {
        this.selectMapByOffset(-1);
        if (this.selectedMap) document.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
      }
    }
    if (next) {
      if (skinFocused) this.customizationSkinSelector?.selectByOffset(1);
      else {
        this.selectMapByOffset(1);
        if (this.selectedMap) document.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
      }
    }
    if (edge(0)) {
      if (active instanceof HTMLButtonElement) active.click();
      else if (this.selectedMap) document.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.click();
    }
    if (edge(1)) $(skinFocused ? 'btn-skin-customization-back' : 'btn-play-back').click();
  }

  showMainMenu(): void { this.show('main-menu'); }
  showOnlineScreen(id: 'main-menu' | 'create-room-menu' | 'join-room-menu' | 'online-lobby-menu'): void {
    this.show(id);
  }
  hideAll(): void { this.show(''); }

  setPlayEnabled(enabled: boolean): void {
    this.playActionsEnabled = enabled;
    for (const id of ['btn-play-start', 'btn-practice-start', 'btn-results-again']) {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      if (!button) continue;
      button.disabled = !enabled;
      this.updatePlayActionState(button);
    }
  }

  /** First-run onboarding: language choice, then default view. */
  showOnboarding(): void {
    this.show('onboarding-screen');
    $('onb-step-language').classList.remove('hidden');
    $('onb-step-view').classList.add('hidden');
    this.updateOnbStep(1);
  }

  private updateOnbStep(n: 1 | 2): void {
    $('onb-step').textContent = t('onb.step', { n });
  }

  onOnboardingDone: () => void = () => undefined;

  private bindOnboarding(): void {
    const click = (id: string, fn: () => void, sound: 'click' | 'back' | 'confirm' = 'click') => {
      $(id).addEventListener('click', () => {
        this.onUiSound?.(sound);
        fn();
      });
    };
    click('btn-onb-en', () => {
      setLang('en');
      updateSettings({ lang: 'en' });
      hydrateStatic();
      this.advanceOnboarding();
    }, 'confirm');
    click('btn-onb-ja', () => {
      setLang('ja');
      updateSettings({ lang: 'ja' });
      hydrateStatic();
      this.advanceOnboarding();
    }, 'confirm');
    click('btn-onb-fp', () => {
      updateSettings({ cameraMode: 'fps', onboarded: true });
      this.finishOnboarding();
    }, 'confirm');
    click('btn-onb-tp', () => {
      updateSettings({ cameraMode: 'tps', onboarded: true });
      this.finishOnboarding();
    }, 'confirm');
  }

  private advanceOnboarding(): void {
    $('onb-step-language').classList.add('hidden');
    $('onb-step-view').classList.remove('hidden');
    this.updateOnbStep(2);
  }

  private finishOnboarding(): void {
    this.showMainMenu();
    this.onOnboardingDone();
  }
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
      !document.getElementById('create-room-menu')!.classList.contains('hidden') ||
      !document.getElementById('join-room-menu')!.classList.contains('hidden') ||
      !document.getElementById('online-lobby-menu')!.classList.contains('hidden') ||
      !document.getElementById('settings-menu')!.classList.contains('hidden') ||
      !document.getElementById('skin-customization-menu')!.classList.contains('hidden') ||
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
    click('btn-play', () => {
      this.selectedMap = null;
      this.renderMapSelection();
      this.show('play-menu');
    });
    click('btn-skin-customization', () => this.show('skin-customization-menu'));
    click('btn-create-room', () => this.onCreateRoomRequested());
    click('btn-join-room', () => this.onJoinRoomRequested());
    click('btn-settings', () => { this.onOpenSettingsFromPause = false; this.show('settings-menu'); });
    click('btn-credits', () => this.show('credits-menu'));
    click('btn-credits-back', () => this.show('main-menu'), 'back');
    click('btn-play-back', () => this.show('main-menu'), 'back');
    click('btn-skin-customization-back', () => this.show('main-menu'), 'back');
    click('btn-play-start', () => {
      this.requestSelectedPlay();
    }, 'confirm');
    click('btn-practice-start', () => {
      this.requestSelectedPlay(true);
    }, 'confirm');
    click('btn-settings-back', () => this.show(this.onOpenSettingsFromPause ? 'pause-menu' : 'main-menu'), 'back');
    click('btn-resume', () => this.onResumeRequested(), 'confirm');
    click('btn-pause-settings', () => { this.onOpenSettingsFromPause = true; this.show('settings-menu'); });
    click('btn-quit', () => this.onQuitRequested(), 'back');
    click('btn-results-menu', () => { $('results-screen').classList.add('hidden'); this.onQuitRequested(); }, 'back');
    click('btn-results-again', () => {
      $('results-screen').classList.add('hidden');
      this.requestSelectedPlay();
    }, 'confirm');
  }

  selectMap(id: MapId): void {
    if (!this.maps.some((map) => map.id === id)) return;
    this.selectedMap = id;
    this.renderMapSelection();
  }

  selectMapByOffset(offset: number): void {
    if (this.maps.length === 0) return;
    if (this.selectedMap === null) {
      this.selectMap((offset < 0 ? this.maps.at(-1) : this.maps[0])!.id);
      return;
    }
    const current = this.maps.findIndex((map) => map.id === this.selectedMap);
    const index = current < 0 ? 0 : current;
    const next = (index + offset) % this.maps.length;
    this.selectMap(this.maps[(next + this.maps.length) % this.maps.length]!.id);
  }

  private buildPlayMenu(): void {
    const list = $('map-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('menu.selectArena'));
    list.innerHTML = '';
    const accents: Record<string, string> = {
      neocity: 'var(--map-neocity)',
      oldfront: 'var(--map-oldfront)',
      eden: 'var(--map-eden)',
      ashara: 'var(--map-ashara)',
    };
    for (const m of this.maps) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'map-card' + (m.id === this.selectedMap ? ' selected' : '');
      card.setAttribute('role', 'option');
      card.tabIndex = m.id === this.selectedMap ? 0 : -1;
      card.setAttribute('aria-pressed', String(m.id === this.selectedMap));
      card.setAttribute('aria-selected', String(m.id === this.selectedMap));
      card.dataset.mapId = m.id;
      card.style.setProperty('--mc-accent', accents[m.id] ?? 'var(--accent)');
      const art = document.createElement('div');
      art.className = 'mc-art';
      art.style.backgroundImage = `url('/assets/maps/${m.id}.jpg')`;
      const scrim = document.createElement('div');
      scrim.className = 'mc-scrim';
      const body = document.createElement('div');
      body.className = 'mc-body';
      const nameEl = document.createElement('h3');
      const descEl = document.createElement('p');
      const check = document.createElement('span');
      check.className = 'mc-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      const badge = document.createElement('span');
      badge.className = 'mc-badge';
      badge.textContent = t('menu.selectedBadge');
      badge.setAttribute('aria-hidden', 'true');
      const render = () => {
        nameEl.textContent = m.nameKey ? t(m.nameKey as TextKey) : m.name;
        descEl.textContent = m.descKey ? t(m.descKey as TextKey) : m.description;
      };
      render();
      body.append(nameEl, descEl);
      card.append(art, scrim, body, check, badge);
      card.addEventListener('click', () => {
        this.selectMap(m.id);
        this.onUiSound?.('click');
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault();
          this.selectMapByOffset(-1);
          list.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          event.preventDefault();
          this.selectMapByOffset(1);
          list.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
        } else if (event.key === 'Home') {
          event.preventDefault();
          this.selectMap(this.maps[0]!.id);
          list.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          this.selectMap(this.maps.at(-1)!.id);
          list.querySelector<HTMLButtonElement>(`.map-card[data-map-id="${this.selectedMap}"]`)?.focus();
        }
      });
      list.appendChild(card);
    }

    this.renderMapSelection();

    const diffs: Array<[DifficultyChoice, TextKey]> = [
      ['normal', 'diff.normal'], ['hard', 'diff.hard'], ['elite', 'diff.elite'], ['nightmare', 'diff.nightmare'],
    ];
    const dlist = $('difficulty-list');
    dlist.innerHTML = '';
    for (const [d, key] of diffs) {
      const btn = document.createElement('button');
      btn.className = 'diff-btn' + (d === this.selectedDifficulty ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(d === this.selectedDifficulty));
      btn.textContent = t(key);
      btn.addEventListener('click', () => {
        this.selectedDifficulty = d;
        dlist.querySelectorAll<HTMLButtonElement>('.diff-btn').forEach((c) => {
          c.classList.remove('selected');
          c.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
        this.onUiSound?.('click');
      });
      dlist.appendChild(btn);
    }
  }

  private renderMapSelection(): void {
    const selected = this.selectedMap === null
      ? null
      : this.maps.find((map) => map.id === this.selectedMap) ?? null;
    const list = $('map-list');
    list.querySelectorAll<HTMLButtonElement>('.map-card').forEach((card) => {
      const isSelected = selected !== null && card.dataset.mapId === selected.id;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
      card.setAttribute('aria-selected', String(isSelected));
      card.tabIndex = isSelected ? 0 : -1;
    });

    const panel = $('selected-arena');
    panel.replaceChildren();
    panel.classList.toggle('hidden', selected === null);
    panel.setAttribute('aria-hidden', String(selected === null));
    $('play-menu').querySelector('.play-body')?.classList.toggle('empty-selection', selected === null);
    if (!selected) {
      const empty = document.createElement('p');
      empty.className = 'selected-arena-empty';
      empty.textContent = t('menu.selectArenaFirst');
      panel.appendChild(empty);
      this.updatePlayActionState($('btn-play-start'));
      this.updatePlayActionState($('btn-practice-start'));
      return;
    }
    const label = document.createElement('span');
    label.className = 'selected-arena-label';
    label.textContent = t('menu.selectedArena');
    const preview = document.createElement('div');
    preview.className = 'selected-arena-preview';
    preview.style.backgroundImage = `url('/assets/maps/${selected.id}.jpg')`;
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', selected.nameKey ? t(selected.nameKey as TextKey) : selected.name);
    const content = document.createElement('div');
    content.className = 'selected-arena-content';
    const title = document.createElement('h3');
    title.id = 'selected-arena-title';
    title.textContent = selected.nameKey ? t(selected.nameKey as TextKey) : selected.name;
    const desc = document.createElement('p');
    desc.textContent = selected.descKey ? t(selected.descKey as TextKey) : selected.description;
    const traits = document.createElement('dl');
    traits.className = 'map-traits';
    const traitItems: Array<[TextKey, string]> = [
      ['menu.traitVerticality', selected.traits.verticality],
      ['menu.traitVisibility', selected.traits.visibility],
      ['menu.traitRange', selected.traits.combatRange],
    ];
    for (const [labelKey, valueKey] of traitItems) {
      const term = document.createElement('dt');
      term.textContent = t(labelKey);
      const value = document.createElement('dd');
      value.textContent = t(valueKey as TextKey);
      traits.append(term, value);
    }
    content.append(title, desc, traits);
    panel.append(label, preview, content);

    const start = $('btn-play-start') as HTMLButtonElement;
    start.textContent = t('menu.startMatchMap', { name: title.textContent ?? selected.name });
    $('btn-practice-start').textContent = t('menu.practice');
    $('play-selection-error').textContent = '';
    $('play-selection-error').classList.add('hidden');
    this.updatePlayActionState(start);
    this.updatePlayActionState($('btn-practice-start'));
  }

  private updatePlayActionState(button: HTMLButtonElement): void {
    const requiresMap = button.id === 'btn-play-start' || button.id === 'btn-practice-start' || button.id === 'btn-results-again';
    const needsSelection = requiresMap && this.selectedMap === null;
    button.classList.toggle('needs-selection', needsSelection);
    // A missing arena is a validation state, not a disabled control: the
    // action remains keyboard/pointer activatable so it can explain exactly
    // what the player must choose. Native disabled state is reserved for
    // lifecycle gates such as an active match or asset loading.
    button.setAttribute('aria-disabled', String(!this.playActionsEnabled));
    button.dataset.needsSelection = String(needsSelection);
    if (button.id === 'btn-results-again') return;
    button.title = needsSelection ? t('menu.selectArenaFirst') : '';
  }

  private requestSelectedPlay(practice = false): void {
    if (!this.playActionsEnabled) return;
    if (this.selectedMap === null) {
      const error = $('play-selection-error');
      error.textContent = t('menu.selectArenaFirst');
      error.classList.remove('hidden');
      error.setAttribute('role', 'alert');
      this.onUiSound?.('error');
      document.querySelector<HTMLButtonElement>('.map-card')?.focus();
      return;
    }
    this.onPlayRequested({ map: this.selectedMap, difficulty: this.selectedDifficulty, practice });
  }

  private buildSkinCustomization(): void {
    this.customizationSkinSelector?.dispose();
    this.customizationSkinSelector = new SkinSelector(
      $('skin-customization-selector'),
      () => this.onUiSound?.('click'),
      'skin-customization-selector-title',
    );
    const launchName = $('skin-launch-name');
    launchName.textContent = t(skinTextKey(getSettings().playerSkin));
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private row(labelText: string, inner: HTMLElement): HTMLElement {
    const div = document.createElement('div');
    div.className = 'setting-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const labelledControl = inner.matches('input,select,button,textarea')
      ? inner
      : inner.querySelector<HTMLElement>('input,select,button,textarea');
    const target = labelledControl ?? inner;
    if (!target.id) target.id = `setting-control-${++this.controlId}`;
    label.htmlFor = target.id;
    div.appendChild(label);
    div.appendChild(inner);
    return div;
  }

  private slider(
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
    format: (v: number) => string = (v) => String(v),
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'range-number-control';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(value);
    const number = document.createElement('input');
    number.type = 'number';
    number.min = String(min); number.max = String(max); number.step = String(step); number.value = String(value);
    number.inputMode = 'decimal';
    number.setAttribute('aria-label', settingCopy('Numeric value', '数値入力'));
    const output = document.createElement('output');
    output.textContent = format(value);
    output.setAttribute('aria-live', 'off');
    const precision = Math.max(0, (String(step).split('.')[1] ?? '').length);
    let committed = value;
    let editStart = value;
    const clamp = (raw: number): number => {
      if (!Number.isFinite(raw)) return committed;
      const stepped = min + Math.round((raw - min) / step) * step;
      return Number(Math.max(min, Math.min(max, stepped)).toFixed(precision + 2));
    };
    const setValue = (raw: number, notify: boolean): void => {
      const next = clamp(raw);
      range.value = String(next);
      number.value = String(next);
      output.textContent = format(next);
      range.setAttribute('aria-valuetext', format(next));
      committed = next;
      if (notify) onInput(next);
    };
    const readNumber = (fallback: number): number => {
      const text = number.value.trim();
      if (text === '') return fallback;
      const raw = Number(text);
      return Number.isFinite(raw) ? raw : fallback;
    };
    number.addEventListener('focus', () => { editStart = committed; });
    range.addEventListener('input', () => setValue(Number(range.value), true));
    number.addEventListener('input', () => {
      const raw = Number(number.value);
      if (Number.isFinite(raw)) {
        const next = clamp(raw);
        range.value = String(next);
        output.textContent = format(next);
        range.setAttribute('aria-valuetext', format(next));
        onInput(next);
      }
    });
    number.addEventListener('change', () => setValue(readNumber(editStart), true));
    number.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setValue(editStart, false);
        number.blur();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        setValue(readNumber(editStart), true);
        number.blur();
      }
    });
    setValue(value, false);
    wrap.append(range, number, output);
    return wrap;
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
    this.settingsSkinSelect = null;
    this.controlId = 0;
    // Idempotent: cleared and rebuilt (also on language change).
    for (const id of ['settings-controls', 'settings-graphics', 'settings-audio', 'settings-gameplay']) {
      $(id).innerHTML = '';
    }
    this.bindSettingsRail();

    // Controls
    const controls = $('settings-controls');
    controls.appendChild(this.row(t('set.language'), this.select(
      [['en', 'English'], ['ja', '日本語']], getLang(),
      (v) => setLang(v as 'en' | 'ja'),
    )));
    controls.appendChild(this.row(t('set.mouseSens'), this.slider(0.2, 3, 0.05, s.sensitivity, (v) => updateSettings({ sensitivity: v }), (v) => v.toFixed(2))));
    controls.appendChild(this.row(t('set.adsSens'), this.slider(0.2, 2, 0.05, s.adsSensitivity, (v) => updateSettings({ adsSensitivity: v }), (v) => v.toFixed(2))));
    controls.appendChild(this.row(t('set.invertY'), this.checkbox(s.invertY, (v) => updateSettings({ invertY: v }))));
    controls.appendChild(this.row(t('set.fov'), this.slider(60, 110, 1, s.fov, (v) => updateSettings({ fov: v }), (v) => `${Math.round(v)}°`)));

    const resetBtn = document.createElement('button');
    resetBtn.className = 'keybind';
    resetBtn.textContent = t('set.resetKeys');
    resetBtn.addEventListener('click', () => {
      updateSettings({ bindings: { ...DEFAULT_BINDINGS } });
      this.buildKeybinds();
      hydrateStatic();
      this.onUiSound?.('confirm');
    });
    controls.appendChild(resetBtn);

    // Gamepad
    controls.appendChild(this.sectionTitle(t('set.gamepad')));
    controls.appendChild(this.row(t('set.gamepadEnabled'), this.checkbox(s.gamepadEnabled, (v) => updateSettings({ gamepadEnabled: v }))));
    controls.appendChild(this.row(t('set.padLookSens'), this.slider(0.3, 3, 0.05, s.padLookSens, (v) => updateSettings({ padLookSens: v }), (v) => v.toFixed(2))));
    controls.appendChild(this.row(t('set.padDeadzone'), this.slider(0.05, 0.45, 0.01, s.padDeadzone, (v) => updateSettings({ padDeadzone: v }), (v) => `${Math.round(v * 100)}%`)));
    controls.appendChild(this.row(t('set.vibration'), this.checkbox(s.vibration, (v) => updateSettings({ vibration: v }))));

    // Graphics
    const graphics = $('settings-graphics');
    graphics.appendChild(this.row(t('set.quality'), this.select(
      [['low', t('q.low')], ['medium', t('q.medium')], ['high', t('q.high')], ['ultra', t('q.ultra')], ['cinematic', t('q.cinematic')]],
      s.quality, (v) => { updateSettings({ quality: v as never }); },
    )));
    graphics.appendChild(this.row(t('set.resScale'), this.slider(0.5, 1.5, 0.05, s.resolutionScale, (v) => updateSettings({ resolutionScale: v }), (v) => `${Math.round(v * 100)}%`)));
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
    audioSec.appendChild(this.row(t('set.masterVol'), this.slider(0, 1, 0.05, s.masterVolume, (v) => updateSettings({ masterVolume: v }), (v) => `${Math.round(v * 100)}%`)));
    audioSec.appendChild(this.row(t('set.musicVol'), this.slider(0, 1, 0.05, s.musicVolume, (v) => updateSettings({ musicVolume: v }), (v) => `${Math.round(v * 100)}%`)));
    audioSec.appendChild(this.row(t('set.sfxVol'), this.slider(0, 1, 0.05, s.sfxVolume, (v) => updateSettings({ sfxVolume: v }), (v) => `${Math.round(v * 100)}%`)));
    audioSec.appendChild(this.row(t('set.ambVol'), this.slider(0, 1, 0.05, s.ambienceVolume, (v) => updateSettings({ ambienceVolume: v }), (v) => `${Math.round(v * 100)}%`)));
    audioSec.appendChild(this.row(t('set.uiVol'), this.slider(0, 1, 0.05, s.uiVolume, (v) => updateSettings({ uiVolume: v }), (v) => `${Math.round(v * 100)}%`)));
    audioSec.appendChild(this.row(t('set.captions'), this.checkbox(s.captions, (v) => updateSettings({ captions: v }))));

    // Gameplay & accessibility
    const gameplay = $('settings-gameplay');
    gameplay.appendChild(this.row(t('set.cameraMode'), this.select(
      [['fps', t('cam.fps')], ['tps', t('cam.tps')]], s.cameraMode, (v) => updateSettings({ cameraMode: v as never }),
    )));
    gameplay.appendChild(this.row(
      settingCopy('TPS character side', '三人称キャラクター位置'),
      this.select(
        [['left', settingCopy('Left (recommended)', '左（推奨）')], ['right', settingCopy('Right', '右')]],
        s.tpsCharacterSide,
        (v) => updateSettings({ tpsCharacterSide: v as never }),
      ),
    ));
    const settingsSkinSelect = this.select(
      SKIN_IDS.map((id) => [id, t(skinTextKey(id))]),
      s.playerSkin,
      (v) => updateSettings({ playerSkin: v as never }),
    );
    this.settingsSkinSelect = settingsSkinSelect;
    gameplay.appendChild(this.row(settingCopy('Player skin', 'プレイヤースキン'), settingsSkinSelect));
    gameplay.appendChild(this.sectionTitle(t('set.preferredSlots')));
    const preferred = s.preferredItemSlots;
    const preferredUpdate = (patch: Partial<PreferredItemSlots>): void => {
      const current = getSettings().preferredItemSlots;
      const slots = patch.slots ?? current.slots;
      updateSettings({
        preferredItemSlots: {
          enabled: patch.enabled ?? current.enabled,
          slots: [slots[0]!, slots[1]!, slots[2]!, slots[3]!, slots[4]!],
        },
      });
    };
    gameplay.appendChild(this.row(
      t('set.preferredSlotsEnabled'),
      this.checkbox(preferred.enabled, (enabled) => preferredUpdate({ enabled })),
    ));
    const preferredHint = document.createElement('p');
    preferredHint.className = 'setting-note';
    preferredHint.textContent = t('set.preferredSlotHint');
    gameplay.appendChild(preferredHint);
    const categoryOptions: Array<[string, string]> = PREFERRED_ITEM_CATEGORIES.map((category) => [
      category,
      t(`itemCategory.${category}` as TextKey),
    ]);
    for (let i = 0; i < 5; i++) {
      const slotIndex = i as 0 | 1 | 2 | 3 | 4;
      gameplay.appendChild(this.row(
        t(`set.slot${i + 1}` as TextKey),
        this.select(categoryOptions, preferred.slots[slotIndex], (value) => {
          const slots = [...getSettings().preferredItemSlots.slots] as PreferredItemCategory[];
          slots[slotIndex] = value as PreferredItemCategory;
          preferredUpdate({ slots: [slots[0]!, slots[1]!, slots[2]!, slots[3]!, slots[4]!] });
        }),
      ));
    }
    const rerun = document.createElement('button');
    rerun.id = 'btn-rerun-onboarding';
    rerun.className = 'btn-quiet small';
    const rerunLabel = () => { rerun.textContent = t('set.rerunOnboarding'); };
    rerunLabel();
    rerun.addEventListener('click', () => {
      this.onUiSound?.('click');
      updateSettings({ onboarded: false });
      this.showOnboarding();
    });
    gameplay.appendChild(this.row(t('set.rerunOnboardingHint'), rerun));
    gameplay.appendChild(this.row(t('set.damageNumbers'), this.checkbox(s.damageNumbers, (v) => updateSettings({ damageNumbers: v }))));
    gameplay.appendChild(this.row(t('set.colorVision'), this.select(
      [['none', t('cv.none')], ['protanopia', t('cv.protanopia')], ['deuteranopia', t('cv.deuteranopia')], ['tritanopia', t('cv.tritanopia')]],
      s.colorVision, (v) => updateSettings({ colorVision: v as never }),
    )));
    gameplay.appendChild(this.row(t('set.reducedMotion'), this.checkbox(s.reducedMotion, (v) => updateSettings({ reducedMotion: v }))));
    gameplay.appendChild(this.row(t('set.camShake'), this.slider(0, 1.5, 0.1, s.cameraShake, (v) => updateSettings({ cameraShake: v }), (v) => `${Math.round(v * 100)}%`)));
    const crosshairColor = document.createElement('input');
    crosshairColor.type = 'color';
    crosshairColor.value = s.crosshairColor;
    crosshairColor.dataset.setting = 'crosshairColor';
    gameplay.appendChild(this.row(t('set.crosshairColor'), crosshairColor));
    gameplay.appendChild(this.row(t('set.crosshairSize'), this.slider(4, 20, 1, s.crosshairSize, (v) => updateSettings({ crosshairSize: v }), (v) => `${Math.round(v)} px`)));
    gameplay.appendChild(this.row(t('set.crosshairDot'), this.checkbox(s.crosshairDot, (v) => updateSettings({ crosshairDot: v }))));
    gameplay.appendChild(this.row(t('set.showFps'), this.checkbox(s.showFps, (v) => updateSettings({ showFps: v }))));

    const colorInput = gameplay.querySelector<HTMLInputElement>('input[data-setting="crosshairColor"]');
    colorInput?.addEventListener('change', () => updateSettings({ crosshairColor: colorInput.value }));

    this.buildKeybinds();
  }

  private sectionTitle(text: string): HTMLElement {
    const h = document.createElement('h3');
    h.className = 'setting-section-title';
    h.textContent = text.toUpperCase();
    return h;
  }

  /** Category rail: show one settings pane at a time. */
  private bindSettingsRail(): void {
    const rail = document.getElementById('settings-rail');
    if (!rail || rail.dataset.bound === '1') {
      // Still refresh selected names on the buttons after a language switch
      return;
    }
    rail.dataset.bound = '1';
    const buttons = [...rail.querySelectorAll<HTMLButtonElement>('.rail-btn')];
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        for (const b of buttons) {
          const selected = b === btn;
          b.classList.toggle('selected', selected);
          b.setAttribute('aria-selected', String(selected));
        }
        for (const pane of document.querySelectorAll('.settings-pane')) {
          const selected = pane.id === btn.dataset.pane;
          pane.classList.toggle('selected', selected);
          pane.setAttribute('aria-hidden', String(!selected));
        }
        this.onUiSound?.('click');
      });
    }
  }

  private keybindRows: Array<{ code: keyof KeyBindings; el: HTMLElement }> = [];

  private buildKeybinds(): void {
    const host = $('settings-controls');
    for (const kb of this.keybindRows) kb.el.remove();
    this.keybindRows = [];
    const b = getSettings().bindings;
    const labels: Partial<Record<keyof KeyBindings, TextKey | string>> = {
      forward: 'bind.forward', back: 'bind.back', left: 'bind.left', right: 'bind.right',
      jump: 'bind.jump', sprint: 'bind.sprint', crouch: 'bind.crouch',
      reload: 'bind.reload', interact: 'bind.interact', dash: 'bind.dash',
      grapple: 'bind.grapple', groundPound: 'bind.groundPound',
      useMedkit: 'bind.useMedkit', useShield: 'bind.useShield',
      dropWeapon: 'bind.dropWeapon', cameraToggle: 'bind.cameraToggle', mapToggle: 'bind.mapToggle',
    };
    labels.shoulderSwap = 'Shoulder swap / 肩切替';
    for (const [code, labelKey] of Object.entries(labels)) {
      const key = code as keyof KeyBindings;
      const btn = document.createElement('button');
      btn.className = 'keybind';
      btn.textContent = prettyKey(b[key]);
      btn.addEventListener('click', () => {
        btn.classList.add('listening');
        btn.textContent = t('bind.pressKey');
        const done = (label: string) => {
          btn.textContent = label;
          btn.classList.remove('listening');
          window.removeEventListener('keydown', handler, true);
        };
        const handler = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') { done(prettyKey(b[key])); return; }
          const patch: Partial<KeyBindings> = {};
          patch[key] = e.code;
          updateSettings({ bindings: { ...getSettings().bindings, ...patch } });
          hydrateStatic();
          done(prettyKey(e.code));
        };
        window.addEventListener('keydown', handler, true);
      });
      const rowEl = document.createElement('div');
      rowEl.className = 'setting-row';
      const lbl = document.createElement('label');
      lbl.textContent = labelKey && isTextKey(labelKey) ? t(labelKey) : labelKey ?? code;
      btn.id = `keybind-${code}`;
      lbl.htmlFor = btn.id;
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

  hideResults(): void {
    $('results-screen').classList.add('hidden');
    $('victory-flare').classList.remove('on');
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

const WEAPON_ICON_PATHS: Record<WeaponId, string> = {
  pistol: '<path d="M9 13h67l15 6v8H58l-7 17H35l4-17H9zM70 9h12v4H70z"/><path class="weapon-detail" d="M55 29h19c0 8-5 12-14 12M39 31h17"/>',
  smg: '<path d="M5 16h54l10 5h37v7H63l-3 15H45l2-15H5zM22 10h31v6H22zM70 12h25v8H70z"/><path class="weapon-detail" d="M61 31h18v11H67zM40 29h19"/>',
  ar: '<path d="M4 20h31L49 9h16l-6 11h29l8-4h20v8H91l-8 6H65L55 43H39l7-13H31L20 38H6l8-11H4z"/><path d="M55 12h32v7H55z"/><path class="weapon-detail" d="m65 31 16 1-4 12H63zM47 30h18"/>',
  shotgun: '<path d="M4 20h55l10-5h46v7l-17 5H65L53 42H37l9-15H31L20 36H7l8-10H4z"/><path d="M65 12h50v5H65z"/><path class="weapon-detail" d="M68 26h24M38 28h22"/>',
  sniper: '<path d="M3 21h34l14-8h15l6 8h44v6H71l-12 5-8 12H34l9-15H30l-11 8H5l10-10H3z"/><path d="M48 8h43v8H48zM58 4h20v4H58z"/><path class="weapon-detail" d="M72 30 84 44M73 30 66 44M43 29h24"/>',
};

function weaponIconSvg(id: WeaponId, label = ''): string {
  return `<svg class="weapon-icon-svg" viewBox="0 0 120 48" role="img" aria-label="${label}">${WEAPON_ICON_PATHS[id]}</svg>`;
}

function healIconSvg(itemId: 'medkit' | 'shieldpot'): string {
  if (itemId === 'medkit') {
    return '<svg class="item-icon-svg" viewBox="0 0 40 40" aria-hidden="true"><path d="M8 10h24a4 4 0 0 1 4 4v18H4V14a4 4 0 0 1 4-4Z"/><path d="M14 10V6h12v4M17 15h6v5h5v6h-5v5h-6v-5h-5v-6h5z" fill-rule="evenodd"/></svg>';
  }
  return '<svg class="item-icon-svg" viewBox="0 0 40 40" aria-hidden="true"><path d="M13 4h14v5l3 4v20a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V13l3-4z"/><path d="M12 22c5-4 11 5 16 0v10H12z" class="icon-liquid"/></svg>';
}

const AMMO_ICONS: Record<AmmoType, string> = {
  light: '<svg viewBox="0 0 32 32"><path d="M8 5h5v22H8zM19 3h5v24h-5z"/></svg>',
  medium: '<svg viewBox="0 0 32 32"><path d="M5 7h6v20H5zM14 4h6v23h-6zM23 7h5v20h-5z"/></svg>',
  shells: '<svg viewBox="0 0 32 32"><path d="M5 5h9v22H5zM18 5h9v22h-9z"/><path d="M5 5h9v6H5zM18 5h9v6h-9z" class="ammo-band"/></svg>',
  heavy: '<svg viewBox="0 0 32 32"><path d="m16 2 6 8v17H10V10z"/><path d="M10 21h12v6H10z" class="ammo-band"/></svg>',
};

/** Minimal fist glyph for the permanent melee slot (inline SVG, currentColor). */
const FIST_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6.5 3A2.5 2.5 0 0 0 4 5.5v7.2c0 1 .35 1.96 1 2.72l3.6 4.28c.66.79 1.64 1.25 2.67 1.25h4.48A4.25 4.25 0 0 0 20 16.75V12a2 2 0 0 0-1.5-1.94V9a2 2 0 0 0-2-2c-.18 0-.34.02-.5.06V6.5a2 2 0 0 0-2-2c-.54 0-1.04.17-1.45.46A2.5 2.5 0 0 0 10 3H8.5c-.74 0-1.43.32-1.92.83L6.5 3Z"/></svg>`;

export interface LootPanelInfo {
  iconId: WeaponId | 'medkit' | 'shieldpot';
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

interface InventoryPointerSession {
  readonly from: number;
  readonly pointerId: number;
  readonly rects: Array<{ index: number; left: number; right: number; top: number; bottom: number; cx: number; cy: number }>;
  readonly dropRect: { left: number; right: number; top: number; bottom: number };
  target: number | null;
  drop: boolean;
  graceUntil: number;
}

export interface TacMarker {
  x: number;
  z: number;
}

interface HudMapActorState {
  readonly id: number;
  readonly teamId: GameStateView['actors'][number]['teamId'];
  readonly alive: boolean;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly accentColor: number;
}

interface HudMapStormState {
  readonly state: GameStateView['storm']['state'];
  readonly timer: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly nextCircle?: () => { x: number; z: number; r: number };
}

interface HudMapState {
  readonly actors: readonly HudMapActorState[];
  readonly aliveCount: number;
  readonly localActorId: number | null;
  readonly localKills: number;
  readonly storm: HudMapStormState;
}

/**
 * Return the actor IDs that a normal replica map is allowed to draw.
 * Inventory and other owner-scoped fields are intentionally never read.
 */
export function replicaVisibleMapActorIds(
  view: {
    readonly actors: readonly Pick<GameStateView['actors'][number], 'id' | 'teamId' | 'alive'>[];
    readonly localActorId: number | null;
  },
): readonly number[] {
  const local = view.localActorId === null
    ? null
    : view.actors.find((actor) => actor.id === view.localActorId) ?? null;
  if (!local) return [];
  return view.actors
    .filter((actor) => actor.id === local.id
      || (actor.alive && local.teamId !== null && actor.teamId === local.teamId))
    .map((actor) => actor.id);
}

function replicaMapState(view: GameStateView): HudMapState {
  const visible = new Set(replicaVisibleMapActorIds(view));
  const actors = view.actors
    .filter((actor) => visible.has(actor.id))
    .map((actor): HudMapActorState => ({
      id: actor.id,
      teamId: actor.teamId,
      alive: actor.alive,
      x: actor.position.x,
      z: actor.position.z,
      yaw: actor.yaw,
      accentColor: actor.accentColor,
    }));
  const local = view.actors.find((actor) => actor.id === view.localActorId) ?? null;
  return {
    actors,
    aliveCount: view.actors.filter((actor) => actor.alive).length,
    localActorId: view.localActorId,
    localKills: local?.stats.kills ?? 0,
    storm: view.storm,
  };
}

function matchMapState(match: Match): HudMapState {
  const local = match.localActor;
  return {
    actors: local ? [{
      id: local.id,
      teamId: match.teamForActor(local),
      alive: local.alive,
      x: local.body.position.x,
      z: local.body.position.z,
      yaw: local.yaw,
      accentColor: local.accentColor,
    }] : [],
    aliveCount: match.actors.filter((actor) => actor.alive).length,
    localActorId: local?.id ?? null,
    localKills: local?.stats.kills ?? 0,
    storm: {
      state: match.storm.state,
      timer: match.storm.timer,
      centerX: match.storm.centerX,
      centerZ: match.storm.centerZ,
      radius: match.storm.radius,
      nextCircle: () => match.storm.nextCircle(),
    },
  };
}

function mapAccentColor(value: number): string {
  if (!Number.isFinite(value)) return '#74e0a1';
  return '#' + ((value >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

export type OnlineConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * Presentation-only online state. Network code owns these values; Hud never
 * derives gameplay state from them and never displays peer addresses.
 */
export interface OnlineHudState {
  connection: OnlineConnectionState;
  rttMs?: number | null;
  packetLossPercent?: number | null;
  teammates?: readonly OnlineTeammateHudState[];
  /** QA-only counters. They are never rendered in a normal production DOM. */
  diagnostics?: {
    hostTick?: number;
    snapshotBytes?: number;
    inputRate?: number;
  } | null;
}

export interface OnlineTeammateHudState {
  participantId: string;
  displayName: string;
  alive: boolean;
}

export type OnlinePresenceNotice = 'left' | 'rejoined' | 'hostDisconnected' | 'hostInactive';

export function onlineConnectionLabel(state: OnlineConnectionState): TextKey {
  switch (state) {
    case 'connected': return 'hud.onlineStatus';
    case 'reconnecting': return 'hud.connectionReconnecting';
    case 'disconnected': return 'hud.connectionDisconnected';
    case 'failed': return 'hud.connectionFailed';
    case 'connecting': return 'hud.connectionConnecting';
  }
}

function finiteMetric(value: number | null | undefined, max: number): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value))
    : null;
}

function boundedDuration(seconds: number, fallback: number): number {
  return Number.isFinite(seconds) ? Math.max(0.5, Math.min(12, seconds)) : fallback;
}

export class Hud {
  private killfeedEntries: Array<{ el: HTMLElement; t: number }> = [];
  private bannerTimer = 0;
  private elimTimer = 0;
  private hitmarkerTimer = 0;
  private minimapTimer = 1 / 12;
  private stormWarningTimer: number | null = null;
  private dmgNumbers: DamageNumberEntry[] = [];
  private captionEls = new Map<TextKey | string, HTMLElement>();
  private projector: ((x: number, y: number, z: number) => { x: number; y: number; visible: boolean }) | null = null;
  private onlineNoticeTimer: number | null = null;
  private tacticalPingExpiresAt = 0;
  tacMarker: TacMarker | null = null;
  onInventoryMove: (from: number, to: number) => void = () => undefined;
  onInventoryDrop: (slot: number) => void = () => undefined;
  onInventorySelect: (slot: number) => void = () => undefined;
  onInventoryClose: () => void = () => undefined;
  private inventoryPointerSession: InventoryPointerSession | null = null;
  private inventoryLastFocus: HTMLElement | null = null;
  private inventorySuppressClickUntil = 0;

  constructor() {
    this.applyCrosshair();
    this.buildInventoryOverlay();
    onLangChanged(() => {
      hydrateStatic();
      this.applyCrosshair();
    });
  }

  show(visible: boolean): void {
    $('hud').classList.toggle('hidden', !visible);
  }

  /**
   * Render host/guest transport health and the team roster. This is an
   * intentionally small adapter so the coordinator can push its measured
   * state without coupling networking to DOM details.
   */
  syncOnlineState(state: OnlineHudState | null): void {
    const status = $('online-hud-status');
    const team = $('online-team-status');
    if (!state) {
      status.classList.add('hidden');
      team.classList.add('hidden');
      return;
    }

    const connection = onlineConnectionLabel(state.connection);
    status.dataset.state = state.connection;
    $('online-hud-connection').textContent = t(connection);
    const rtt = finiteMetric(state.rttMs, 9_999);
    const loss = finiteMetric(state.packetLossPercent, 100);
    const metrics: string[] = [];
    if (rtt !== null) metrics.push(t('hud.networkRtt', { ms: Math.round(rtt) }));
    if (loss !== null) metrics.push(t('hud.networkLoss', { pct: Math.round(loss) }));
    const metricText = metrics.join(' · ');
    $('online-hud-metrics').textContent = metricText;
    status.setAttribute('aria-label', metricText ? `${t(connection)} ${metricText}` : t(connection));

    const diagnostics = $('online-hud-diagnostics');
    const qaDiagnosticsEnabled = import.meta.env.DEV
      && document.documentElement.dataset.xoQa === '1';
    if (qaDiagnosticsEnabled && state.diagnostics) {
      const bits: string[] = [];
      if (Number.isFinite(state.diagnostics.hostTick)) bits.push(`tick ${Math.max(0, Math.floor(state.diagnostics.hostTick!))}`);
      if (Number.isFinite(state.diagnostics.snapshotBytes)) bits.push(`snap ${Math.max(0, Math.floor(state.diagnostics.snapshotBytes!))} B`);
      if (Number.isFinite(state.diagnostics.inputRate)) bits.push(`in ${Math.max(0, Math.floor(state.diagnostics.inputRate!))}/s`);
      diagnostics.textContent = bits.join(' · ');
    } else {
      diagnostics.textContent = '';
    }
    status.classList.remove('hidden');

    const teammates = state.teammates ?? [];
    team.classList.toggle('hidden', teammates.length === 0);
    const list = $('online-team-list');
    list.replaceChildren(...teammates.slice(0, 4).map((mate) => {
      const item = document.createElement('li');
      item.classList.toggle('eliminated', !mate.alive);
      item.dataset.participantId = mate.participantId;
      const name = document.createElement('span');
      name.className = 'online-team-name';
      name.textContent = mate.displayName;
      const stateText = document.createElement('span');
      stateText.className = 'online-team-state';
      stateText.textContent = t(mate.alive ? 'hud.teammateAlive' : 'hud.teammateEliminated');
      item.append(name, stateText);
      return item;
    }));
  }

  /** Show a bounded, localized presence notice at the top-center of the HUD. */
  showPresenceNotice(kind: OnlinePresenceNotice, displayName = '', duration = 3.2): void {
    const notice = $('online-presence-notice');
    notice.classList.toggle('host-disconnected', kind === 'hostDisconnected');
    notice.classList.toggle('host-inactive', kind === 'hostInactive');
    const name = displayName.trim().slice(0, 24);
    notice.textContent = kind === 'left'
      ? t('hud.presenceLeft', { name: name || 'Player' })
      : kind === 'rejoined'
        ? t('hud.presenceRejoined', { name: name || 'Player' })
        : kind === 'hostInactive'
          ? t('hud.hostInactive')
          : t('hud.hostDisconnected');
    notice.classList.remove('hidden');
    if (this.onlineNoticeTimer !== null) window.clearTimeout(this.onlineNoticeTimer);
    this.onlineNoticeTimer = window.setTimeout(() => {
      notice.classList.add('hidden');
      this.onlineNoticeTimer = null;
    }, boundedDuration(duration, 3.2) * 1000);
  }

  clearPresenceNotice(): void {
    if (this.onlineNoticeTimer !== null) window.clearTimeout(this.onlineNoticeTimer);
    this.onlineNoticeTimer = null;
    const notice = $('online-presence-notice');
    notice.classList.add('hidden');
    notice.classList.remove('host-disconnected', 'host-inactive');
  }

  /** Clear the current online notice and any cosmetic tactical ping. */
  resetOnlineHud(): void {
    if (this.onlineNoticeTimer !== null) window.clearTimeout(this.onlineNoticeTimer);
    this.onlineNoticeTimer = null;
    const notice = $('online-presence-notice');
    notice.classList.add('hidden');
    notice.classList.remove('host-disconnected', 'host-inactive');
    $('online-hud-status').classList.add('hidden');
    $('online-team-status').classList.add('hidden');
    this.clearTacticalPing();
  }

  /**
   * Display one generic location ping. No label or arbitrary text crosses the
   * network/UI boundary; the existing minimap and tactical map render it.
   */
  showTacticalPing(x: number, z: number, duration = 5): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.tacMarker = { x, z };
    this.tacticalPingExpiresAt = performance.now() + boundedDuration(duration, 5) * 1000;
  }

  clearTacticalPing(): void {
    this.tacMarker = null;
    this.tacticalPingExpiresAt = 0;
  }

  /** Call once per render/update tick to expire cosmetic online UI state. */
  updateOnlineHud(): void {
    if (this.tacticalPingExpiresAt > 0 && performance.now() >= this.tacticalPingExpiresAt) this.clearTacticalPing();
  }

  isInventoryOpen(): boolean {
    return !$('inventory-overlay').classList.contains('hidden');
  }

  setInventoryOpen(open: boolean): void {
    this.cancelInventoryPointer();
    if (open) this.inventoryLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $('inventory-overlay').classList.toggle('hidden', !open);
    document.body.classList.toggle('inventory-open', open);
    if (open) {
      hydrateStatic();
      requestAnimationFrame(() => ($('inventory-grid-slots').querySelector<HTMLButtonElement>('.inventory-grid-slot.active, .inventory-grid-slot:not(.empty)')
        ?? $('btn-inventory-close')).focus());
    } else if (this.inventoryLastFocus?.isConnected) {
      this.inventoryLastFocus.focus();
      this.inventoryLastFocus = null;
    }
  }

  private buildInventoryOverlay(): void {
    const grid = $('inventory-grid-slots');
    grid.innerHTML = '';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', t('inventory.equipment'));
    for (let i = 0; i < 5; i++) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'inventory-grid-slot empty';
      slot.dataset.slot = String(i);
      slot.setAttribute('role', 'gridcell');
      slot.setAttribute('aria-posinset', String(i + 1));
      slot.setAttribute('aria-setsize', '5');
      slot.innerHTML = `<span class="inv-key">${i + 1}</span><span class="inv-icon"></span><span class="inv-name"></span><span class="inv-count"></span>`;
      slot.addEventListener('click', () => {
        if (performance.now() < this.inventorySuppressClickUntil) {
          this.inventorySuppressClickUntil = 0;
          return;
        }
        this.onInventorySelect(i);
      });
      slot.addEventListener('pointerdown', (event) => this.beginInventoryPointer(i, event));
      slot.addEventListener('pointermove', (event) => this.updateInventoryPointer(event.clientX, event.clientY));
      slot.addEventListener('pointerup', (event) => this.finishInventoryPointer(event));
      slot.addEventListener('pointercancel', () => this.cancelInventoryPointer());
      slot.addEventListener('lostpointercapture', (event) => {
        if (this.inventoryPointerSession?.pointerId === (event as PointerEvent).pointerId) this.cancelInventoryPointer();
      });
      slot.addEventListener('keydown', (event) => this.handleInventoryKey(i, event));
      grid.appendChild(slot);
    }
    $('btn-inventory-close').addEventListener('click', () => this.onInventoryClose());
    const drop = $('inventory-drop-zone');
    drop.addEventListener('pointermove', (event) => this.updateInventoryPointer(event.clientX, event.clientY));
    drop.addEventListener('pointerup', (event) => this.finishInventoryPointer(event));
    drop.addEventListener('pointercancel', () => this.cancelInventoryPointer());
    $('inventory-overlay').addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.inventoryPointerSession) {
        event.preventDefault();
        this.cancelInventoryPointer();
      }
    });
  }

  private beginInventoryPointer(index: number, event: PointerEvent): void {
    const slot = event.currentTarget as HTMLButtonElement;
    if (!event.isPrimary || event.button !== 0 || slot.dataset.hasItem !== '1') return;
    const grid = $('inventory-grid-slots');
    const rects = [...grid.querySelectorAll<HTMLButtonElement>('.inventory-grid-slot')].map((element, slotIndex) => {
      const rect = element.getBoundingClientRect();
      return { index: slotIndex, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
    });
    const drop = $('inventory-drop-zone').getBoundingClientRect();
    this.inventoryPointerSession = {
      from: index,
      pointerId: event.pointerId,
      rects,
      dropRect: { left: drop.left, right: drop.right, top: drop.top, bottom: drop.bottom },
      target: null,
      drop: false,
      graceUntil: performance.now() + 180,
    };
    try { slot.setPointerCapture(event.pointerId); } catch { /* browser may revoke capture during teardown */ }
    event.preventDefault();
    this.updateInventoryPointer(event.clientX, event.clientY);
    this.setInventoryLive(t('inventory.dragging', { slot: index + 1 }));
  }

  private updateInventoryPointer(clientX: number, clientY: number): void {
    const session = this.inventoryPointerSession;
    if (!session) return;
    const pad = 18;
    const inDrop = clientX >= session.dropRect.left - pad && clientX <= session.dropRect.right + pad
      && clientY >= session.dropRect.top - pad && clientY <= session.dropRect.bottom + pad;
    const candidates = session.rects
      .filter((rect) => rect.index !== session.from
        && clientX >= rect.left - pad && clientX <= rect.right + pad
        && clientY >= rect.top - pad && clientY <= rect.bottom + pad)
      .sort((a, b) => Math.hypot(clientX - a.cx, clientY - a.cy) - Math.hypot(clientX - b.cx, clientY - b.cy));
    if (inDrop) {
      session.drop = true;
      session.target = null;
      session.graceUntil = performance.now() + 180;
    } else if (candidates[0]) {
      session.drop = false;
      session.target = candidates[0].index;
      session.graceUntil = performance.now() + 180;
    } else if (performance.now() >= session.graceUntil) {
      session.drop = false;
      session.target = null;
    }
    this.syncInventoryPointerVisuals();
  }

  private finishInventoryPointer(event: PointerEvent): void {
    const session = this.inventoryPointerSession;
    if (!session || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    if (session.drop) {
      this.inventorySuppressClickUntil = performance.now() + 300;
      this.onInventoryDrop(session.from);
    } else if (session.target !== null && session.target !== session.from) {
      this.inventorySuppressClickUntil = performance.now() + 300;
      this.onInventoryMove(session.from, session.target);
    } else this.setInventoryLive(t('inventory.dragCancelled'));
    this.cancelInventoryPointer();
  }

  private cancelInventoryPointer(): void {
    this.inventoryPointerSession = null;
    this.syncInventoryPointerVisuals();
  }

  private syncInventoryPointerVisuals(): void {
    const session = this.inventoryPointerSession;
    const grid = document.getElementById('inventory-grid-slots');
    if (!grid) return;
    grid.querySelectorAll<HTMLElement>('.inventory-grid-slot').forEach((slot, index) => {
      slot.classList.toggle('dragging', session?.from === index);
      slot.classList.toggle('drop-target', session?.drop === false && session?.target === index);
    });
    document.getElementById('inventory-drop-zone')?.classList.toggle('active', session?.drop === true);
  }

  private setInventoryLive(message: string): void {
    const live = document.getElementById('inventory-live-region');
    if (live) live.textContent = message;
  }

  private handleInventoryKey(index: number, event: KeyboardEvent): void {
    const slot = event.currentTarget as HTMLButtonElement;
    if (event.key === 'Escape') {
      if (this.inventoryPointerSession) {
        event.preventDefault();
        this.cancelInventoryPointer();
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (slot.dataset.hasItem !== '1') return;
      event.preventDefault();
      this.onInventoryDrop(index);
      this.setInventoryLive(t('inventory.keyboardDropped', { slot: index + 1 }));
      return;
    }
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0;
    if (delta !== 0 && slot.dataset.hasItem === '1') {
      event.preventDefault();
      const target = Math.max(0, Math.min(4, index + delta));
      if (target !== index) {
        this.onInventoryMove(index, target);
        this.setInventoryLive(t('inventory.keyboardMoved', { from: index + 1, to: target + 1 }));
        requestAnimationFrame(() => (document.querySelector(`[data-slot="${target}"]`) as HTMLElement | null)?.focus());
      }
    }
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

  /** Sniper scope overlay: replaces the world-framing HUD while engaged. */
  setScoped(scoped: boolean): void {
    document.body.classList.toggle('scoped', scoped);
  }

  /** Magnification readout inside the scope lens (1x / 2x / 4x). */
  setScopeZoom(magnification: number): void {
    const el = document.getElementById('scope-zoom');
    if (el) el.textContent = `${magnification}×`;
  }

  syncPlayerState(match: Match, dt = 1 / 60): void {
    this.updateOnlineHud();
    const p = match.localActor;
    if (!p) return;

    // Dynamic crosshair: expands with fire bloom, tightens while aiming
    const bloom = p.wpn.bloom;
    const ads = p.wpn.adsAmount;
    const gap = Math.round(getSettings().crosshairSize * 0.7 + bloom * 240 * (1 - ads * 0.72));
    $('crosshair').style.setProperty('--ch-gap', `${gap}px`);

    // Shotgun: circular spread reticle whose diameter mirrors the actual
    // pellet-cone radius projected to screen distance (simulation-true).
    const selWpn = p.inv.selectedWeapon;
    const isShotgun = selWpn?.weaponId === 'shotgun';
    const chEl = $('crosshair');
    chEl.classList.toggle('shotgun', isShotgun);
    if (isShotgun && p.wpn.currentSpread > 0.0005) {
      const fovDeg = getSettings().fov - ads * 14;
      const halfFovTan = Math.tan((fovDeg * Math.PI) / 360);
      const spreadTan = Math.tan(p.wpn.currentSpread);
      const radiusPx = Math.min(
        window.innerHeight * 0.42,
        (spreadTan / halfFovTan) * window.innerHeight * 0.5,
      );
      chEl.style.setProperty('--ring-d', `${Math.max(12, Math.round(radiusPx * 2))}px`);
    }

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
      const ammoEl = $('ammo-display');
      ammoEl.classList.toggle('low', w.ammoInMag === 0);
      ammoEl.classList.toggle('warn', w.ammoInMag > 0 && w.ammoInMag / def.magSize <= 0.25);
    } else {
      $('ammo-mag').textContent = '—';
      $('ammo-reserve').textContent = '';
      $('weapon-name').textContent = t('hud.unarmed');
    }

    // Slots: [Fists] [1..5] — fists are a permanent pseudo-slot, leftmost.
    const slotsEl = $('inventory-slots');
    if (slotsEl.childElementCount !== 6) {
      slotsEl.innerHTML = '';
      const fist = document.createElement('div');
      fist.className = 'slot melee';
      fist.innerHTML = `<span class="num key-q">Q</span><span class="icon">${FIST_SVG}</span>`;
      slotsEl.appendChild(fist);
      for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'slot empty';
        slot.innerHTML = `<span class="num">${i + 1}</span><span class="icon"></span>`;
        slotsEl.appendChild(slot);
      }
    }
    const meleeSlot = slotsEl.children[0] as HTMLElement;
    const isMelee = p.inv.isMeleeSelected;
    meleeSlot.className = 'slot melee' + (isMelee ? ' active' : '');
    for (let i = 0; i < 5; i++) {
      const slot = slotsEl.children[i + 1] as HTMLElement;
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
        icon.style.textShadow = '';
        icon.innerHTML = weaponIconSvg(item.weaponId, t(`wpn.${item.weaponId}` as TextKey));
      } else {
        slot.className = `slot heal-${item.itemId}` + (i === p.inv.selected ? ' active' : '');
        icon.style.color = '';
        icon.style.textShadow = '';
        icon.innerHTML = `${healIconSvg(item.itemId)}<span class="slot-count">${item.count}</span>`;
      }
    }

    if (this.isInventoryOpen()) this.syncInventoryOverlay(match);

    $('alive-count').textContent = String(match.aliveCount);
    $('kills-count').textContent = String(p.stats.kills);

    // Healing channel bar
    const channel = $('heal-channel');
    if (p.healing) {
      const progress = Math.max(0, Math.min(1, 1 - p.healing.remaining / p.healing.total));
      channel.classList.remove('hidden');
      channel.dataset.item = p.healing.itemId;
      $('heal-label').textContent = p.healing.itemId === 'medkit' ? t('heal.medkit') : t('heal.shieldpot');
      $('heal-time').textContent = `${Math.max(0, p.healing.remaining).toFixed(1)}s`;
      $('heal-fill').style.width = `${progress * 100}%`;
      channel.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
      channel.setAttribute('aria-valuetext', `${$('heal-label').textContent ?? ''} ${$('heal-time').textContent ?? ''}`);
    } else {
      channel.classList.add('hidden');
      delete channel.dataset.item;
      channel.removeAttribute('aria-valuenow');
      channel.removeAttribute('aria-valuetext');
    }

    // Storm timer text
    const st = match.storm;
    const stEl = $('storm-timer');
    if (st.state === 'idle') stEl.textContent = '';
    else if (st.state === 'waiting') stEl.textContent = `${t('hud.stormClosesIn')} ${formatTime(st.timer)}`;
    else if (st.state === 'shrinking') stEl.textContent = `${t('hud.stormShrinking')} — ${formatTime(st.timer)}`;
    else stEl.textContent = t('hud.finalCircle');
    stEl.classList.toggle('urgent', st.state === 'shrinking');

    // Critical health bar state
    const hpBar = document.querySelector('.bar.health');
    if (hpBar) hpBar.classList.toggle('critical', p.health <= 30 && p.health > 0);

    // Vignettes
    const vig = $('vignette');
    vig.style.opacity = String(Math.max(0, 1 - p.health / 65));
    const stormVig = $('storm-vignette');
    stormVig.style.opacity = match.storm.isOutside(p.body.position.x, p.body.position.z) ? '0.8' : '0';

    const uiDt = Math.min(0.1, Math.max(0, dt));
    this.bannerTimer -= uiDt;
    this.elimTimer -= uiDt;
    this.hitmarkerTimer -= uiDt;
    if (this.hitmarkerTimer <= 0) $('hitmarker').classList.remove('show');
    if (this.elimTimer <= 0) $('elim-banner').classList.add('hidden');
    if (this.bannerTimer <= 0) $('center-banner').classList.add('hidden');

    if (getSettings().showFps) $('fps-counter').classList.remove('hidden');
    else $('fps-counter').classList.add('hidden');

    // Live-update damage number positions
    this.updateDamageNumbers();
  }

  /** Replica HUD path. Only the local actor's owner-scoped inventory is
   * rendered; remote ActorView inventory is deliberately null by contract. */
  syncReplicaState(view: GameStateView, dt = 1 / 60): void {
    this.updateOnlineHud();
    const p = view.actors.find((actor) => actor.id === view.localActorId) ?? null;
    if (!p) return;
    $('health-fill').style.width = `${p.health}%`;
    $('shield-fill').style.width = `${p.shield}%`;
    $('health-text').textContent = String(Math.ceil(p.health));
    $('shield-text').textContent = String(Math.ceil(p.shield));
    $('alive-count').textContent = String(view.actors.filter((actor) => actor.alive).length);
    $('kills-count').textContent = String(p.stats.kills);
    const hpBar = document.querySelector('.bar.health');
    if (hpBar) hpBar.classList.toggle('critical', p.health <= 30 && p.health > 0);
    const storm = view.storm;
    const stormEl = $('storm-timer');
    if (storm.state === 'idle') stormEl.textContent = '';
    else if (storm.state === 'waiting') stormEl.textContent = `${t('hud.stormClosesIn')} ${formatTime(storm.timer)}`;
    else if (storm.state === 'shrinking') stormEl.textContent = `${t('hud.stormShrinking')} — ${formatTime(storm.timer)}`;
    else stormEl.textContent = t('hud.finalCircle');
    stormEl.classList.toggle('urgent', storm.state === 'shrinking');
    $('vignette').style.opacity = String(Math.max(0, 1 - p.health / 65));
    const outside = storm.state !== 'idle'
      && Math.hypot(p.position.x - storm.centerX, p.position.z - storm.centerZ) > storm.radius;
    $('storm-vignette').style.opacity = outside ? '0.8' : '0';
    this.syncReplicaInventory(p.inventory);
    if (this.isInventoryOpen()) this.syncReplicaInventoryOverlay(p.inventory);
    const uiDt = Math.min(0.1, Math.max(0, dt));
    this.bannerTimer -= uiDt;
    this.elimTimer -= uiDt;
    this.hitmarkerTimer -= uiDt;
    if (this.hitmarkerTimer <= 0) $('hitmarker').classList.remove('show');
    if (this.elimTimer <= 0) $('elim-banner').classList.add('hidden');
    if (this.bannerTimer <= 0) $('center-banner').classList.add('hidden');
    if (getSettings().showFps) $('fps-counter').classList.remove('hidden');
    else $('fps-counter').classList.add('hidden');
    this.updateDamageNumbers();
  }

  private syncReplicaInventory(inventory: InventoryView | null): void {
    const w = inventory?.slots[inventory.selected] ?? null;
    if (w?.kind === 'weapon') {
      $('weapon-name').textContent = t(`wpn.${w.weaponId}` as TextKey).toUpperCase();
      $('ammo-mag').textContent = String(w.ammoInMag);
      $('ammo-reserve').textContent = String(inventory?.ammo[WEAPONS[w.weaponId].ammoType] ?? 0);
    } else {
      $('weapon-name').textContent = t('hud.unarmed');
      $('ammo-mag').textContent = '—';
      $('ammo-reserve').textContent = '';
    }
    const slotsEl = $('inventory-slots');
    if (slotsEl.childElementCount !== 6) {
      slotsEl.innerHTML = '';
      const fist = document.createElement('div');
      fist.className = 'slot melee';
      fist.innerHTML = `<span class="num key-q">Q</span><span class="icon">${FIST_SVG}</span>`;
      slotsEl.appendChild(fist);
      for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'slot empty';
        slot.innerHTML = `<span class="num">${i + 1}</span><span class="icon"></span>`;
        slotsEl.appendChild(slot);
      }
    }
    for (let i = 0; i < 5; i++) {
      const slot = slotsEl.children[i + 1] as HTMLElement;
      const item = inventory?.slots[i] ?? null;
      slot.className = 'slot' + (item ? '' : ' empty') + (i === (inventory?.selected ?? -1) ? ' active' : '');
      const icon = slot.querySelector<HTMLElement>('.icon');
      if (!icon) continue;
      icon.textContent = item?.kind === 'weapon' ? item.weaponId.toUpperCase() : item?.kind === 'heal' ? `×${item.count}` : '';
    }
  }

  private syncInventoryOverlay(match: Match): void {
    const p = match.localActor;
    if (!p) return;
    this.syncInventoryOverlayData(p.inv.selectedItem, p.inv.slots, p.inv.selected, p.inv.ammo);
  }

  private syncReplicaInventoryOverlay(inventory: InventoryView | null): void {
    this.syncInventoryOverlayData(
      inventory ? inventory.slots[inventory.selected] ?? null : null,
      inventory?.slots ?? [],
      inventory?.selected ?? -1,
      inventory?.ammo ?? { light: 0, medium: 0, shells: 0, heavy: 0 },
    );
  }

  private syncInventoryOverlayData(
    selected: InventoryView['slots'][number],
    slots: InventoryView['slots'],
    selectedIndex: number,
    ammoPools: InventoryView['ammo'],
  ): void {
    const detailIcon = $('inventory-detail-icon');
    const detailName = $('inventory-detail-name');
    const detailRarity = $('inventory-detail-rarity');
    const detailType = $('inventory-detail-type');
    const stats = $('inventory-detail-stats');

    if (!selected) {
      detailIcon.innerHTML = FIST_SVG;
      detailIcon.style.color = '#dce5ed';
      detailName.textContent = t('hud.unarmed');
      detailRarity.textContent = '';
      detailType.textContent = t('inventory.empty');
      stats.innerHTML = '';
    } else if (selected.kind === 'weapon') {
      const def = WEAPONS[selected.weaponId];
      const rarity = t(`rarity.${selected.rarity}` as TextKey);
      const color = RARITY_CSS[selected.rarity];
      detailIcon.innerHTML = weaponIconSvg(selected.weaponId, t(`wpn.${selected.weaponId}` as TextKey));
      detailIcon.style.color = color;
      detailName.textContent = t(`wpn.${selected.weaponId}` as TextKey);
      detailRarity.textContent = rarity.toUpperCase();
      detailRarity.style.color = color;
      detailType.textContent = `${t('loot.type.weapon')} · ${t(`ammo.${def.ammoType}` as TextKey)}`;
      const damage = def.damage[['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(selected.rarity)] ?? def.damage[0]!;
      stats.innerHTML = [
        [t('inventory.damage'), String(damage)],
        [t('inventory.fireRate'), `${def.rpm} RPM`],
        [t('inventory.magazine'), `${selected.ammoInMag} / ${def.magSize}`],
        [t('inventory.reload'), `${def.reloadTactical.toFixed(1)} s`],
      ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    } else {
      const def = HEAL_ITEMS[selected.itemId];
      const color = selected.itemId === 'medkit' ? '#ff7d89' : '#53d8ff';
      detailIcon.innerHTML = healIconSvg(selected.itemId);
      detailIcon.style.color = color;
      detailName.textContent = selected.itemId === 'medkit' ? t('bind.useMedkit') : t('bind.useShield');
      detailRarity.textContent = t(selected.itemId === 'medkit' ? 'rarity.rare' : 'rarity.uncommon').toUpperCase();
      detailRarity.style.color = color;
      detailType.textContent = t('loot.type.heal');
      stats.innerHTML = [
        [t('inventory.count'), String(selected.count)],
        [selected.itemId === 'medkit' ? t('inventory.restoreHealth') : t('inventory.restoreShield'), `+${def.amount}`],
        [t('inventory.useTime'), `${def.useTime.toFixed(1)} s`],
      ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
    }

    const ammo = $('inventory-ammo');
    const ammoTypes: AmmoType[] = ['light', 'medium', 'shells', 'heavy'];
    ammo.innerHTML = ammoTypes.map((type) => `
      <div class="inventory-ammo-stack">
        <span class="ammo-icon">${AMMO_ICONS[type]}</span>
        <span>${t(`ammo.${type}` as TextKey)}</span>
        <strong>${ammoPools[type]}</strong>
      </div>`).join('');

    const grid = $('inventory-grid-slots');
    for (let i = 0; i < 5; i++) {
      const slot = grid.children[i] as HTMLButtonElement;
      const item = slots[i];
      const icon = slot.querySelector<HTMLElement>('.inv-icon')!;
      const name = slot.querySelector<HTMLElement>('.inv-name')!;
      const count = slot.querySelector<HTMLElement>('.inv-count')!;
      slot.className = 'inventory-grid-slot' + (item ? '' : ' empty') + (i === selectedIndex ? ' active' : '');
      slot.dataset.hasItem = item ? '1' : '0';
      slot.setAttribute('aria-label', item
        ? `${i + 1}: ${item.kind === 'weapon' ? t(`wpn.${item.weaponId}` as TextKey) : item.itemId === 'medkit' ? t('bind.useMedkit') : t('bind.useShield')}`
        : `${i + 1}: ${t('inventory.empty')}`);
      slot.setAttribute('aria-selected', String(i === selectedIndex));
      slot.style.removeProperty('--slot-rarity');
      if (!item) {
        icon.innerHTML = '';
        name.textContent = t('inventory.empty');
        count.textContent = '';
      } else if (item.kind === 'weapon') {
        slot.style.setProperty('--slot-rarity', RARITY_CSS[item.rarity]);
        icon.innerHTML = weaponIconSvg(item.weaponId, t(`wpn.${item.weaponId}` as TextKey));
        name.textContent = t(`wpn.${item.weaponId}` as TextKey);
        count.textContent = String(item.ammoInMag);
      } else {
        const color = item.itemId === 'medkit' ? '#ff7d89' : '#53d8ff';
        slot.style.setProperty('--slot-rarity', color);
        icon.innerHTML = healIconSvg(item.itemId);
        name.textContent = item.itemId === 'medkit' ? t('bind.useMedkit') : t('bind.useShield');
        count.textContent = `×${item.count}`;
      }
    }
    this.syncInventoryPointerVisuals();
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
    if (this.stormWarningTimer !== null) window.clearTimeout(this.stormWarningTimer);
    this.stormWarningTimer = window.setTimeout(() => {
      el.classList.add('hidden');
      this.stormWarningTimer = null;
    }, duration * 1000);
  }

  addKillfeed(killer: string | null, victim: string, weaponIcon: string | null, headshot: boolean, storm: boolean): void {
    const feed = $('killfeed');
    const entry = document.createElement('div');
    entry.className = 'kf-entry';
    const killerEl = document.createElement('b');
    killerEl.className = killer ? 'killer' : 'killer dim';
    killerEl.textContent = killer ?? (storm ? t('kill.storm') : '—');
    entry.appendChild(killerEl);
    if (weaponIcon) {
      const wpn = document.createElement('span');
      wpn.className = 'wpn';
      wpn.textContent = `[${weaponIcon}]`;
      entry.appendChild(wpn);
    }
    if (headshot) {
      const hs = document.createElement('span');
      hs.className = 'hs';
      hs.textContent = '✦';
      entry.appendChild(hs);
    }
    const victimEl = document.createElement('b');
    victimEl.className = 'victim';
    victimEl.textContent = victim;
    entry.appendChild(victimEl);
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
    const kbd = el.querySelector('kbd');
    if (kbd) kbd.textContent = prettyKey(getSettings().bindings.interact);
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
    $('lp-icon').innerHTML = info.iconId === 'medkit' || info.iconId === 'shieldpot'
      ? healIconSvg(info.iconId)
      : weaponIconSvg(info.iconId, info.name);
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

  private tacImage: HTMLCanvasElement | null = null;

  setTacMapImage(img: HTMLCanvasElement | null): void {
    this.tacImage = img;
  }

  /**
   * Draw the fullscreen tactical map. Returns the canvas so main can attach
   * click handlers once.
   */
  drawTacMap(match: Match): HTMLCanvasElement {
    const canvas = $<HTMLCanvasElement>('tac-map');
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    return this.drawMapCanvas(canvas, ctx, match.mapDef, matchMapState(match));
  }

  /** Minimap: player-centered crop of the real aerial render plus safe overlays. */
  drawMinimap(match: Match, ctxProvider: () => CanvasRenderingContext2D | null, dt = 1 / 60): void {
    this.minimapTimer += Math.max(0, Math.min(dt, 0.1));
    if (this.minimapTimer < 1 / 12) return;
    this.minimapTimer = 0;
    const ctx = ctxProvider();
    if (!ctx) return;
    this.drawMinimapCanvas(ctx, match.mapDef, matchMapState(match));
  }

  /** Replica-safe fullscreen map; only the local actor and living allies are eligible for markers. */
  drawTacMapReplica(mapDef: MapDef, view: GameStateView): HTMLCanvasElement {
    const canvas = $<HTMLCanvasElement>('tac-map');
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    return this.drawMapCanvas(canvas, ctx, mapDef, replicaMapState(view));
  }

  /** Replica-safe player-centred minimap using the same map projection. */
  drawMinimapReplica(
    mapDef: MapDef,
    view: GameStateView,
    ctxProvider: () => CanvasRenderingContext2D | null,
    dt = 1 / 60,
  ): void {
    this.minimapTimer += Math.max(0, Math.min(dt, 0.1));
    if (this.minimapTimer < 1 / 12) return;
    this.minimapTimer = 0;
    const ctx = ctxProvider();
    if (!ctx) return;
    this.drawMinimapCanvas(ctx, mapDef, replicaMapState(view));
  }

  private drawMapCanvas(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    mapDef: MapDef,
    state: HudMapState,
  ): HTMLCanvasElement {
    const size = canvas.width;
    const half = mapDef.size / 2;
    const toPx = (value: number): number => ((value + half) / mapDef.size) * size;
    ctx.clearRect(0, 0, size, size);

    if (this.tacImage) {
      ctx.drawImage(this.tacImage, 0, 0, size, size);
    } else {
      ctx.fillStyle = 'rgba(14,19,30,0.96)';
      ctx.fillRect(0, 0, size, size);
    }

    ctx.fillStyle = 'rgba(64,130,190,0.4)';
    for (const water of mapDef.water) {
      ctx.fillRect(
        toPx(water.minX),
        toPx(water.minZ),
        ((water.maxX - water.minX) / mapDef.size) * size,
        ((water.maxZ - water.minZ) / mapDef.size) * size,
      );
    }

    for (const poi of mapDef.pois) {
      ctx.fillStyle = 'rgba(140,165,195,0.16)';
      ctx.beginPath();
      ctx.arc(toPx(poi.x), toPx(poi.z), (poi.radius / mapDef.size) * size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.74)';
      ctx.shadowBlur = 2;
      ctx.fillText(localizePoiName(poi.name), toPx(poi.x), toPx(poi.z));
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(toPx(mapDef.transportRoute.from[0]!), toPx(mapDef.transportRoute.from[1]!));
    ctx.lineTo(toPx(mapDef.transportRoute.to[0]!), toPx(mapDef.transportRoute.to[1]!));
    ctx.stroke();
    ctx.setLineDash([]);

    const storm = state.storm;
    let routeTarget: { x: number; z: number; r: number } | null = null;
    if (storm.state !== 'idle') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(toPx(storm.centerX), toPx(storm.centerZ), (storm.radius / mapDef.size) * size, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(118,52,196,0.34)';
      ctx.fill('evenodd');
      ctx.restore();
      ctx.strokeStyle = '#b078ff';
      ctx.lineWidth = 2.6;
      ctx.shadowColor = 'rgba(150,90,255,0.8)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(toPx(storm.centerX), toPx(storm.centerZ), (storm.radius / mapDef.size) * size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      const next = storm.state === 'done' ? null : storm.nextCircle?.() ?? null;
      if (next) {
        routeTarget = next;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.arc(toPx(next.x), toPx(next.z), (next.r / mapDef.size) * size, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([9, 7]);
        ctx.beginPath();
        ctx.arc(toPx(next.x), toPx(next.z), (next.r / mapDef.size) * size, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (storm.state === 'done') {
        routeTarget = { x: storm.centerX, z: storm.centerZ, r: storm.radius };
      }
    }

    const me = state.actors.find((actor) => actor.id === state.localActorId) ?? null;
    if (me?.alive && routeTarget) {
      const dx = me.x - routeTarget.x;
      const dz = me.z - routeTarget.z;
      if (Math.hypot(dx, dz) > routeTarget.r) {
        const angle = Math.atan2(dz, dx);
        const tx = routeTarget.x + Math.cos(angle) * (routeTarget.r - 6);
        const tz = routeTarget.z + Math.sin(angle) * (routeTarget.r - 6);
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 2.4;
        ctx.setLineDash([10, 6]);
        ctx.beginPath();
        ctx.moveTo(toPx(me.x), toPx(me.z));
        ctx.lineTo(toPx(tx), toPx(tz));
        ctx.stroke();
        ctx.setLineDash([]);
        const arrowAngle = Math.atan2(tz - me.z, tx - me.x);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(toPx(tx) + Math.cos(arrowAngle) * 10, toPx(tz) + Math.sin(arrowAngle) * 10);
        ctx.lineTo(toPx(tx) + Math.cos(arrowAngle + 2.5) * 9, toPx(tz) + Math.sin(arrowAngle + 2.5) * 9);
        ctx.lineTo(toPx(tx) + Math.cos(arrowAngle - 2.5) * 9, toPx(tz) + Math.sin(arrowAngle - 2.5) * 9);
        ctx.closePath();
        ctx.fill();
      }
    }

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

    for (const actor of state.actors) {
      if (!actor.alive) continue;
      ctx.save();
      ctx.translate(toPx(actor.x), toPx(actor.z));
      if (actor.id === state.localActorId) {
        ctx.rotate(-actor.yaw - Math.PI / 2);
        ctx.fillStyle = '#5fd0ff';
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(11, 0);
        ctx.lineTo(-7, 8);
        ctx.lineTo(-7, -8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = mapAccentColor(actor.accentColor);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.textAlign = 'left';
    ctx.font = '700 15px "Saira Condensed", "Noto Sans JP", system-ui, sans-serif';
    let header = '';
    if (storm.state === 'waiting') header = t('hud.stormClosesIn') + ' ' + formatTime(storm.timer);
    else if (storm.state === 'shrinking') header = t('hud.stormShrinking') + ' — ' + formatTime(storm.timer);
    else if (storm.state === 'done') header = t('hud.finalCircle');
    if (header) {
      const width = ctx.measureText(header).width;
      ctx.fillStyle = 'rgba(10,14,22,0.72)';
      ctx.fillRect(14, 12, width + 20, 26);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(header, 24, 30);
    }
    const right = t('hud.alive') + ' ' + state.aliveCount + ' · ' + t('hud.elims') + ' ' + state.localKills;
    ctx.textAlign = 'right';
    const rightWidth = ctx.measureText(right).width;
    ctx.fillStyle = 'rgba(10,14,22,0.72)';
    ctx.fillRect(size - rightWidth - 34, 12, rightWidth + 20, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(right, size - 24, 30);
    return canvas;
  }

  private drawMinimapCanvas(
    ctx: CanvasRenderingContext2D,
    mapDef: MapDef,
    state: HudMapState,
  ): void {
    const size = 188;
    const scale = size / (mapDef.size * 0.62);
    const me = state.actors.find((actor) => actor.id === state.localActorId) ?? null;
    const cx = me?.x ?? 0;
    const cz = me?.z ?? 0;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cz);

    const half = mapDef.size / 2;
    if (this.tacImage) {
      ctx.save();
      ctx.filter = 'brightness(0.74) saturate(0.82) contrast(1.08)';
      ctx.drawImage(this.tacImage, -half, -half, mapDef.size, mapDef.size);
      ctx.restore();
    } else {
      const span = size / scale;
      ctx.fillStyle = 'rgba(14,19,30,0.96)';
      ctx.fillRect(cx - span / 2, cz - span / 2, span, span);
    }

    for (const poi of mapDef.pois) {
      ctx.fillStyle = 'rgba(140,165,195,0.32)';
      ctx.beginPath();
      ctx.arc(poi.x, poi.z, Math.max(4, poi.radius * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const water of mapDef.water) {
      ctx.fillStyle = 'rgba(70,140,190,0.4)';
      ctx.fillRect(water.minX, water.minZ, water.maxX - water.minX, water.maxZ - water.minZ);
    }

    const storm = state.storm;
    if (storm.state !== 'idle') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - size / scale, cz - size / scale, (size * 2) / scale, (size * 2) / scale);
      ctx.arc(storm.centerX, storm.centerZ, storm.radius, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(118,52,196,0.3)';
      ctx.fill('evenodd');
      ctx.restore();
      ctx.strokeStyle = '#b078ff';
      ctx.lineWidth = 3 / scale;
      ctx.beginPath();
      ctx.arc(storm.centerX, storm.centerZ, storm.radius, 0, Math.PI * 2);
      ctx.stroke();
      const next = storm.state === 'done' ? null : storm.nextCircle?.() ?? null;
      if (next) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.setLineDash([8 / scale, 8 / scale]);
        ctx.beginPath();
        ctx.arc(next.x, next.z, next.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (this.tacMarker) {
      ctx.strokeStyle = '#ffb43a';
      ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      ctx.arc(this.tacMarker.x, this.tacMarker.z, 10 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const actor of state.actors) {
      if (!actor.alive) continue;
      ctx.save();
      ctx.translate(actor.x, actor.z);
      if (actor.id === state.localActorId) {
        ctx.rotate(-actor.yaw - Math.PI / 2);
        ctx.fillStyle = '#5fd0ff';
        ctx.beginPath();
        ctx.moveTo(10 / scale, 0);
        ctx.lineTo(-6 / scale, 7 / scale);
        ctx.lineTo(-6 / scale, -7 / scale);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = mapAccentColor(actor.accentColor);
        ctx.beginPath();
        ctx.arc(0, 0, 7 / scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  minimapContext(): CanvasRenderingContext2D | null {
    return ($('minimap') as unknown as HTMLCanvasElement).getContext('2d');
  }
}
