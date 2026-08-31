/**
 * Reusable player-skin selector for the offline lobby and the Phase 3 lobby.
 * Settings remains the only source of truth; this component only renders and
 * updates that value.
 */

import { getSettings, onSettingsChanged, updateSettings, type SkinId } from '../core/settings';
import { t, type TextKey } from '../core/i18n';
import { SKIN_IDS, SKIN_SPECS } from '../render/characters';

export function skinTextKey(id: SkinId): TextKey {
  return `skin.${id}` as TextKey;
}

export function skinName(id: SkinId): string {
  return t(skinTextKey(id));
}

export function skinIdAtOffset(current: SkinId, offset: number): SkinId {
  const index = Math.max(0, SKIN_IDS.indexOf(current));
  const next = (index + offset) % SKIN_IDS.length;
  return SKIN_IDS[(next + SKIN_IDS.length) % SKIN_IDS.length]!;
}

export class SkinSelector {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSelect?: (id: SkinId) => void,
    private readonly headingId = 'skin-selector-title',
  ) {
    this.root.classList.add('skin-selector');
    this.unsubscribe = onSettingsChanged(() => this.sync());
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Re-render translated labels while preserving the settings selection. */
  refresh(): void {
    this.render();
  }

  selectByOffset(offset: number): void {
    this.select(skinIdAtOffset(getSettings().playerSkin, offset));
  }

  private select(id: SkinId): void {
    if (id === getSettings().playerSkin) return;
    updateSettings({ playerSkin: id });
    this.onSelect?.(id);
  }

  private render(): void {
    const selected = getSettings().playerSkin;
    this.root.replaceChildren();

    const heading = document.createElement('h3');
    heading.id = this.headingId;
    heading.textContent = t('menu.yourSkin');
    this.root.setAttribute('aria-labelledby', heading.id);

    const summary = document.createElement('div');
    summary.className = 'skin-summary';
    const summaryLabel = document.createElement('span');
    summaryLabel.className = 'skin-summary-label';
    summaryLabel.textContent = t('menu.selectedSkin');
    const selectedName = document.createElement('strong');
    selectedName.className = 'skin-selected-name';
    selectedName.textContent = skinName(selected);
    summary.append(summaryLabel, selectedName);

    const controls = document.createElement('div');
    controls.className = 'skin-nav';
    controls.append(
      this.navButton('previous', -1, 'menu.previousSkin', '←'),
      this.navButton('next', 1, 'menu.nextSkin', '→'),
    );

    const options = document.createElement('div');
    options.id = 'skin-options';
    options.className = 'skin-options';
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', t('menu.yourSkin'));
    for (const id of SKIN_IDS) {
      const spec = SKIN_SPECS[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'skin-card';
      card.dataset.skin = id;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-pressed', String(id === selected));
      card.setAttribute('aria-selected', String(id === selected));
      card.classList.toggle('selected', id === selected);
      card.tabIndex = id === selected ? 0 : -1;
      card.style.setProperty('--skin-primary', `#${spec.primary.toString(16).padStart(6, '0')}`);
      card.style.setProperty('--skin-accent', `#${spec.accent.toString(16).padStart(6, '0')}`);
      const swatch = document.createElement('span');
      swatch.className = 'skin-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'skin-card-label';
      label.textContent = skinName(id);
      card.append(swatch, label);
      card.addEventListener('click', () => {
        this.select(id);
        card.focus();
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          this.selectByOffset(-1);
          this.focusSelected();
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          this.selectByOffset(1);
          this.focusSelected();
        } else if (event.key === 'Home') {
          event.preventDefault();
          this.select(SKIN_IDS[0]!);
          this.focusSelected();
        } else if (event.key === 'End') {
          event.preventDefault();
          this.select(SKIN_IDS[SKIN_IDS.length - 1]!);
          this.focusSelected();
        }
      });
      options.appendChild(card);
    }

    this.root.append(heading, summary, controls, options);
  }

  private navButton(direction: 'previous' | 'next', offset: number, key: TextKey, symbol: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `skin-nav-button ${direction}`;
    button.dataset.gamepadAction = offset < 0 ? 'previous-skin' : 'next-skin';
    button.setAttribute('aria-label', t(key));
    button.textContent = symbol;
    button.addEventListener('click', () => {
      this.selectByOffset(offset);
      this.focusSelected();
    });
    return button;
  }

  private sync(): void {
    const selected = getSettings().playerSkin;
    const selectedName = this.root.querySelector<HTMLElement>('.skin-selected-name');
    if (selectedName) selectedName.textContent = skinName(selected);
    this.root.querySelectorAll<HTMLButtonElement>('.skin-card').forEach((card) => {
      const isSelected = card.dataset.skin === selected;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
      card.setAttribute('aria-selected', String(isSelected));
      card.tabIndex = isSelected ? 0 : -1;
    });
  }

  focusSelected(): void {
    this.root.querySelector<HTMLButtonElement>(`.skin-card[data-skin="${getSettings().playerSkin}"]`)?.focus();
  }
}
