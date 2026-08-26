/**
 * Localization: dictionary-based string lookup with English (default) and
 * complete Japanese coverage. All player-facing UI strings route through t().
 */

export type Lang = 'en' | 'ja';

const en = {
  // Generic
  'common.back': 'BACK',
  'common.play': 'PLAY',
  'common.settings': 'SETTINGS',
  'common.credits': 'CREDITS',
  'common.resume': 'RESUME',
  'common.quit': 'RETURN TO MENU',
  'common.startMatch': 'START MATCH',
  'common.playAgain': 'PLAY AGAIN',
  'common.mainMenu': 'MAIN MENU',
  'common.on': 'ON',
  'common.off': 'OFF',

  // Menu / lobby
  'menu.tagline': 'Single-player battle royale · 10 combatants · last one standing',
  'menu.hint': 'Desktop keyboard & mouse required · Click PLAY to lock the cursor',
  'menu.selectArena': 'SELECT ARENA',
  'menu.practice': 'PRACTICE MODE',
  'menu.difficulty': 'BOT DIFFICULTY',
  'menu.paused': 'MENU',
  'map.neocity.name': 'NEO CITY',
  'map.neocity.desc': 'Rain-slicked neon streets, rooftops and an underground transit hub.',
  'map.oldfront.name': 'OLD FRONT',
  'map.oldfront.desc': 'A worn frontier town: cathedral square, keep ruins and war remnants.',
  'map.eden.name': 'EDEN FACILITY',
  'map.eden.desc': 'Lakeside research station swallowed by green. Water routes and cliffs.',
  'diff.normal': 'NORMAL',
  'diff.hard': 'HARD',
  'diff.elite': 'ELITE',
  'diff.nightmare': 'NIGHTMARE',

  // Settings — controls
  'set.controls': 'CONTROLS',
  'set.mouseSens': 'Mouse sensitivity',
  'set.adsSens': 'ADS sensitivity',
  'set.invertY': 'Invert Y',
  'set.fov': 'Field of view',
  'set.resetKeys': 'RESET KEYS',
  'set.gamepad': 'Gamepad',
  'set.gamepadEnabled': 'Enable controller',
  'set.padLookSens': 'Controller look sensitivity',
  'set.padDeadzone': 'Stick deadzone',
  'set.vibration': 'Vibration',
  'bind.forward': 'Forward', 'bind.back': 'Back', 'bind.left': 'Left', 'bind.right': 'Right',
  'bind.jump': 'Jump', 'bind.sprint': 'Sprint', 'bind.crouch': 'Crouch / Slide',
  'bind.reload': 'Reload', 'bind.interact': 'Interact', 'bind.dash': 'Dash',
  'bind.grapple': 'Grapple', 'bind.groundPound': 'Ground pound',
  'bind.useMedkit': 'Med Kit', 'bind.useShield': 'Shield Cell',
  'bind.dropWeapon': 'Drop weapon', 'bind.cameraToggle': 'FP/TPS toggle', 'bind.mapToggle': 'Full map',
  'bind.fire': 'Fire', 'bind.ads': 'Aim (ADS)', 'bind.ping': 'Ping marker',
  'bind.pressKey': 'PRESS…',
  'bind.listenPad': 'PRESS BUTTON…',

  // Settings — graphics
  'set.graphics': 'GRAPHICS',
  'set.quality': 'Quality preset',
  'q.low': 'Low', 'q.medium': 'Medium', 'q.high': 'High', 'q.ultra': 'Ultra', 'q.cinematic': 'Cinematic',
  'set.resScale': 'Resolution scale',
  'set.shadows': 'Shadows',
  'set.shadowQuality': 'Shadow quality',
  'set.bloom': 'Post-processing + bloom',
  'set.ao': 'Ambient occlusion',
  'set.aa': 'Anti-aliasing',
  'aa.off': 'Off', 'aa.fxaa': 'FXAA', 'aa.smaa': 'SMAA',
  'set.motionBlur': 'Motion blur',
  'set.reducedMotion': 'Reduced motion mode',

  // Settings — audio
  'set.audio': 'AUDIO',
  'set.masterVol': 'Master volume',
  'set.musicVol': 'Music',
  'set.sfxVol': 'Effects',
  'set.ambVol': 'Ambience',
  'set.uiVol': 'UI',
  'set.captions': 'Sound captions',

  // Settings — gameplay & accessibility
  'set.gameplay': 'GAMEPLAY & ACCESSIBILITY',
  'set.language': 'Language',
  'set.cameraMode': 'Camera mode',
  'cam.fps': 'First person', 'cam.tps': 'Third person',
  'onb.welcome': 'WELCOME TO XO BETA',
  'onb.chooseLanguage': 'Choose your language',
  'onb.chooseView': 'Choose your default view',
  'onb.viewNote': 'This only sets your default view. Change it any time in Settings or with {camera}.',
  'onb.langEn': 'English',
  'onb.langJa': '日本語',
  'onb.step': 'Step {n} of 2',
  'set.rerunOnboarding': 'First-run setup',
  'set.rerunOnboardingHint': 'Run the welcome screens again',
  'set.crosshairColor': 'Crosshair color',
  'set.crosshairSize': 'Crosshair size',
  'set.crosshairDot': 'Center dot',
  'set.camShake': 'Camera shake',
  'set.damageNumbers': 'Damage numbers',
  'set.colorVision': 'Color-vision support',
  'cv.none': 'Default', 'cv.protanopia': 'Protanopia', 'cv.deuteranopia': 'Deuteranopia', 'cv.tritanopia': 'Tritanopia',
  'set.showFps': 'Show FPS counter',

  // HUD
  'hud.alive': 'ALIVE',
  'hud.elims': 'ELIMS',
  'hud.stormClosesIn': 'STORM CLOSES IN',
  'hud.stormShrinking': 'STORM SHRINKING',
  'hud.finalCircle': 'FINAL CIRCLE',
  'hud.unarmed': 'UNARMED',
  'hud.spectating': 'SPECTATING',
  'hud.spectateHint': '{prev} {next} switch combatant · {camera} camera · {map} map',
  'hud.tabFullMap': '{map} — full map',
  'banner.drop': '{jump} — JUMP FROM TRANSPORT · FIGHT TO BE THE LAST ONE STANDING',
  'banner.jumpUnlocked': 'DROP ZONE AHEAD — {jump} TO JUMP',
  'banner.lastStanding': 'LAST ONE STANDING WINS',
  'banner.eliminatedYou': 'YOU WERE ELIMINATED — SPECTATING',
  'heal.medkit': 'Applying Med Kit…',
  'heal.shieldpot': 'Drinking Shield Cell…',
  'storm.advancing': 'STORM ADVANCING · CIRCLE {n} IN {s}s',
  'storm.closing': 'THE STORM IS CLOSING IN',
  'kill.storm': 'STORM',

  // Interaction / loot
  'interact.openChest': 'Open Chest',
  'interact.openElite': 'Open Elite Chest',
  'interact.openVault': 'Open Vault Cache',
  'interact.pickupWeapon': 'Pick up {rarity} {weapon}',
  'interact.pickupMedkit': 'Pick up Med Kit',
  'interact.pickupShield': 'Pick up Shield Cell',
  'loot.type.weapon': 'WEAPON',
  'loot.type.heal': 'MEDICAL',
  'loot.type.ammo': 'AMMO',
  'ammo.light': 'LIGHT AMMO',
  'ammo.medium': 'MEDIUM AMMO',
  'ammo.shells': 'SHELLS',
  'ammo.heavy': 'HEAVY AMMO',
  'loot.inventoryFull': 'INVENTORY FULL — SWAP OR DROP',
  'rarity.common': 'Common',
  'rarity.uncommon': 'Uncommon',
  'rarity.rare': 'Rare',
  'rarity.epic': 'Epic',
  'rarity.legendary': 'Legendary',

  // Tactical map
  'tac.title': 'TACTICAL MAP',
  'tac.you': 'YOU',
  'tac.markerPlaced': 'MARKER PLACED',

  // Results
  'results.victory': 'VICTORY',
  'results.subtitle.win': '{name} stands victorious',
  'results.subtitle.lose': '{name} wins the match',
  'stats.placement': 'PLACEMENT',
  'stats.eliminations': 'ELIMINATIONS',
  'stats.damage': 'DAMAGE',
  'stats.accuracy': 'ACCURACY',
  'stats.headshots': 'HEADSHOTS',
  'stats.survived': 'SURVIVED',

  // Notices
  'notice.mobileTitle': 'DESKTOP REQUIRED',
  'notice.mobileBody': 'Xo Beta is designed for desktop browsers with keyboard & mouse. Open this page on a desktop browser to play.',
  'notice.loadFailed': 'Failed to load — please reload the page.',
  'notice.loading': 'Loading…',
  'load.preparing': 'Preparing systems…',
  'load.assets': 'Streaming assets…',
  'load.materials': 'Compiling materials…',
  'load.warming': 'Warming up…',
  'load.ready': 'Ready',
  'load.map': 'Loading {name}…',
  'load.deploying': 'Deploying combatants…',
  'load.final': 'Final checks…',

  // Credits
  'credits.body': 'An original open-source battle royale built with Three.js and Rapier. Third-party art & audio assets are CC0 or permissively licensed — full provenance in docs/ASSET_MANIFEST.md.',

  // Sound captions (accessibility)
  'cap.gunfire': 'Gunfire',
  'cap.explosion': 'Explosion',
  'cap.storm': 'Storm warning',
  'cap.elimination': 'Combatant eliminated',
  'cap.shieldBreak': 'Shield broken',
  'cap.chest': 'Chest opened',

  // Weapon names (kept simple/readable)
  'wpn.pistol': 'Pistol',
  'wpn.smg': 'Submachine Gun',
  'wpn.ar': 'Assault Rifle',
  'wpn.shotgun': 'Pump Shotgun',
  'wpn.sniper': 'Sniper Rifle',
};

type Dict = typeof en;

const ja: Dict = {
  'common.back': '戻る',
  'common.play': 'プレイ',
  'common.settings': '設定',
  'common.credits': 'クレジット',
  'common.resume': '再開',
  'common.quit': 'メニューへ戻る',
  'common.startMatch': 'マッチ開始',
  'common.playAgain': 'もう一度プレイ',
  'common.mainMenu': 'メインメニュー',
  'common.on': 'オン',
  'common.off': 'オフ',

  'menu.tagline': 'シングルプレイヤー・バトルロイヤル · 10人の戦闘員 · 最後の一人が勝者',
  'menu.hint': 'デスクトップのキーボードとマウスが必要です · 「プレイ」をクリックしてカーソルを固定',
  'menu.selectArena': 'アリーナ選択',
  'menu.practice': '練習モード',
  'menu.difficulty': 'ボット難易度',
  'menu.paused': 'メニュー',
  'map.neocity.name': 'ネオシティ',
  'map.neocity.desc': '雨に濡れたネオン街、屋上、そして地下駅。夜の都市で戦う。',
  'map.oldfront.name': 'オールドフロント',
  'map.oldfront.desc': '風化した辺境の町：大聖堂広場、要塞跡、戦争の名残。',
  'map.eden.name': 'エデン施設',
  'map.eden.desc': '緑に吞まれた湖畔の研究施設。水路と崖が広がる。',
  'diff.normal': 'ノーマル',
  'diff.hard': 'ハード',
  'diff.elite': 'エリート',
  'diff.nightmare': 'ナイトメア',

  'set.controls': '操作',
  'set.mouseSens': 'マウス感度',
  'set.adsSens': 'ADS感度',
  'set.invertY': 'Y軸反転',
  'set.fov': '視野角 (FOV)',
  'set.resetKeys': 'キーリセット',
  'set.gamepad': 'コントローラー',
  'set.gamepadEnabled': 'コントローラー有効化',
  'set.padLookSens': 'スティック視点感度',
  'set.padDeadzone': 'デッドゾーン',
  'set.vibration': '振動',
  'bind.forward': '前進', 'bind.back': '後退', 'bind.left': '左', 'bind.right': '右',
  'bind.jump': 'ジャンプ', 'bind.sprint': 'ダッシュ', 'bind.crouch': 'しゃがみ / スライディング',
  'bind.reload': 'リロード', 'bind.interact': 'インタラクト', 'bind.dash': 'ダッシュ動作',
  'bind.grapple': 'グラップル', 'bind.groundPound': 'グラウンドパウンド',
  'bind.useMedkit': 'メディキット', 'bind.useShield': 'シールドセル',
  'bind.dropWeapon': '武器を捨てる', 'bind.cameraToggle': '視点切替', 'bind.mapToggle': '全体マップ',
  'bind.fire': '発射', 'bind.ads': '照準 (ADS)', 'bind.ping': 'ピン配置',
  'bind.pressKey': 'キーを押してください…',
  'bind.listenPad': 'ボタンを押してください…',

  'set.graphics': 'グラフィック',
  'set.quality': '品質プリセット',
  'q.low': '低', 'q.medium': '中', 'q.high': '高', 'q.ultra': 'ウルトラ', 'q.cinematic': 'シネマティック',
  'set.resScale': '解像度スケール',
  'set.shadows': '影',
  'set.shadowQuality': '影の品質',
  'set.bloom': 'ポストプロセス + ブルーム',
  'set.ao': 'アンビエントオクルージョン',
  'set.aa': 'アンチエイリアス',
  'aa.off': 'オフ', 'aa.fxaa': 'FXAA', 'aa.smaa': 'SMAA',
  'set.motionBlur': 'モーションブラー',
  'set.reducedMotion': 'モーション軽減モード',

  'set.audio': 'オーディオ',
  'set.masterVol': 'マスター音量',
  'set.musicVol': '音楽',
  'set.sfxVol': '効果音',
  'set.ambVol': '環境音',
  'set.uiVol': 'UI音',
  'set.captions': '重要音のキャプション',

  'set.gameplay': 'ゲームプレイ & アクセシビリティ',
  'set.language': '言語',
  'set.cameraMode': 'カメラモード',
  'cam.fps': '一人称', 'cam.tps': '三人称',
  'onb.welcome': 'XO BETA へようこそ',
  'onb.chooseLanguage': '言語を選択してください',
  'onb.chooseView': 'デフォルトの視点を選択してください',
  'onb.viewNote': 'これは初期視点の設定です。設定画面または {camera} でいつでも変更できます。',
  'onb.langEn': 'English',
  'onb.langJa': '日本語',
  'onb.step': 'ステップ {n} / 2',
  'set.rerunOnboarding': '初回セットアップ',
  'set.rerunOnboardingHint': 'ようこそ画面をもう一度表示する',
  'set.crosshairColor': 'クロスヘアの色',
  'set.crosshairSize': 'クロスヘアのサイズ',
  'set.crosshairDot': '中央ドット',
  'set.camShake': '画面揺れ',
  'set.damageNumbers': 'ダメージ数値',
  'set.colorVision': '色覚サポート',
  'cv.none': 'デフォルト', 'cv.protanopia': 'P型 (1型)', 'cv.deuteranopia': 'D型 (2型)', 'cv.tritanopia': 'T型 (3型)',
  'set.showFps': 'FPS表示',

  'hud.alive': '生存',
  'hud.elims': '撃破',
  'hud.stormClosesIn': 'ストーム接近まで',
  'hud.stormShrinking': 'ストーム縮小中',
  'hud.finalCircle': '最終サークル',
  'hud.unarmed': '非武装',
  'hud.spectating': '観戦中',
  'hud.spectateHint': '{prev} {next} 選択切替 · {camera} 視点 · {map} マップ',
  'hud.tabFullMap': '{map} — 全体マップ',
  'banner.drop': '{jump} — 輸送機から降りろ · 最後の一人になれ',
  'banner.jumpUnlocked': '降下地点が近づいた — {jump}で降りる',
  'banner.lastStanding': '最後の一人が勝者',
  'banner.eliminatedYou': '撃墜されました — 観戦中',
  'heal.medkit': 'メディキット使用中…',
  'heal.shieldpot': 'シールドセル使用中…',
  'storm.advancing': 'ストーム接近 · サークル{n}まで{s}秒',
  'storm.closing': 'ストームが縮小を開始',
  'kill.storm': 'ストーム',

  'interact.openChest': 'チェストを開ける',
  'interact.openElite': 'エリートチェストを開ける',
  'interact.openVault': 'ヴォールトを開ける',
  'interact.pickupWeapon': '{rarity}の{weapon}を拾う',
  'interact.pickupMedkit': 'メディキットを拾う',
  'interact.pickupShield': 'シールドセルを拾う',
  'loot.type.weapon': '武器',
  'loot.type.heal': '医療',
  'loot.type.ammo': '弾薬',
  'ammo.light': '小口径弾',
  'ammo.medium': '中口径弾',
  'ammo.shells': 'ショットシェル',
  'ammo.heavy': '大口径弾',
  'loot.inventoryFull': 'インベントリ満杯 — 入れ替えるか捨てる',
  'rarity.common': 'コモン',
  'rarity.uncommon': 'アンコモン',
  'rarity.rare': 'レア',
  'rarity.epic': 'エピック',
  'rarity.legendary': 'レジェンド',

  'tac.title': 'タクティカルマップ',
  'tac.you': '自分',
  'tac.markerPlaced': 'マーカー設置',

  'results.victory': '勝利',
  'results.subtitle.win': '{name}が勝利した',
  'results.subtitle.lose': '{name}がこのマッチを制した',
  'stats.placement': '順位',
  'stats.eliminations': '撃破数',
  'stats.damage': '与ダメージ',
  'stats.accuracy': '命中率',
  'stats.headshots': 'ヘッドショット',
  'stats.survived': '生存時間',

  'notice.mobileTitle': 'デスクトップ環境が必要です',
  'notice.mobileBody': 'Xo Betaはキーボードとマウスのあるデスクトップブラウザ向けに設計されています。お手数ですが、デスクトップで開いてください。',
  'notice.loadFailed': '読み込みに失敗しました — ページを再読み込みしてください。',
  'notice.loading': '読み込み中…',
  'load.preparing': 'システムを準備中…',
  'load.assets': 'アセットを読み込み中…',
  'load.materials': 'マテリアルをコンパイル中…',
  'load.warming': 'ウォームアップ中…',
  'load.ready': '準備完了',
  'load.map': '{name}を読み込み中…',
  'load.deploying': '戦闘員を配置中…',
  'load.final': '最終確認中…',

  'credits.body': 'Three.js と Rapier を用いたオリジナルのオープンソース バトルロイヤル。サードパーティの美術・音声アセットはCC0または寛容なライセンスで提供されています（詳細は docs/ASSET_MANIFEST.md）。',

  'cap.gunfire': '銃撃音',
  'cap.explosion': '爆発音',
  'cap.storm': 'ストーム警報',
  'cap.elimination': '戦闘員が倒されました',
  'cap.shieldBreak': 'シールド破壊',
  'cap.chest': 'チェスト解放',

  'wpn.pistol': 'ピストル',
  'wpn.smg': 'サブマシンガン',
  'wpn.ar': 'アサルトライフル',
  'wpn.shotgun': 'ポンプショットガン',
  'wpn.sniper': 'スナイパーライフル',
};

// Keep every locale exact and complete at compile time. Adding an English key
// without its Japanese counterpart is therefore a type error, not a runtime
// fallback that can escape into the shipped UI.
const dicts: Record<Lang, Dict> = { en, ja };

const POI_JA: Readonly<Record<string, string>> = {
  // Neo City
  'Spire Plaza': 'スパイア広場',
  'Neon Market': 'ネオンマーケット',
  Cyberdome: 'サイバードーム',
  'Resident Blocks': '住宅街',
  'Transit Hub': '交通ハブ',
  'Industrial Yard': '工業ヤード',
  'Sky Gardens': 'スカイガーデン',
  'East Kiosks': '東キオスク街',
  'West Alley': '西路地',
  'South Garage': '南ガレージ',
  'North Plaza': '北広場',
  'Server Bunker': 'サーバーバンカー',
  'Fountain Court': '噴水広場',
  'Freight Depot': '貨物基地',
  Overpass: '高架道路',
  'Cooling Yard': '冷却ヤード',
  'Old Billboard': '古い看板',

  // Old Front
  'Cathedral Square': '大聖堂広場',
  'Old Town': '旧市街',
  'The Keep': '城塞跡',
  Farmstead: '農場',
  Checkpoint: '検問所',
  'Forest Camp': '森林キャンプ',
  'Hill Tunnel': '丘陵トンネル',
  Chapel: '礼拝堂',
  Bridge: '橋',
  Quarry: '採石場',
  'Roadside Shrine': '道端の祠',
  'Water Mill': '水車小屋',
  Orchard: '果樹園',
  'Broken Column': '崩れた柱',
  Crossroads: '交差路',

  // Eden Facility
  'Research Complex': '研究区画',
  Dormitories: '居住棟',
  'Water Treatment': '水処理施設',
  'Lakeside Dock': '湖畔ドック',
  'Cliff Overlook': '崖の展望台',
  Greenhouses: '温室群',
  'Generator Yard': '発電ヤード',
  'Test Field': '実験場',
  'Ranger Cabin': '管理小屋',
  'South Ford': '南の浅瀬',
  'Boulder Field': '巨岩地帯',
  'East Meadow': '東の草原',
  'Pump House': 'ポンプ棟',
  'Watch Rock': '見張り岩',
};

let currentLang: Lang = 'en';
const listeners: Array<(l: Lang) => void> = [];

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  try {
    localStorage.setItem('xo-beta-lang', lang);
  } catch { /* storage unavailable */ }
  document.documentElement.lang = lang === 'ja' ? 'ja' : 'en';
  for (const fn of listeners) fn(lang);
}

export function onLangChanged(fn: (l: Lang) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function initLang(): void {
  try {
    const saved = localStorage.getItem('xo-beta-lang') as Lang | null;
    if (saved === 'ja' || saved === 'en') currentLang = saved;
    else if (navigator.language?.startsWith('ja')) currentLang = 'ja';
  } catch { /* default */ }
  document.documentElement.lang = currentLang === 'ja' ? 'ja' : 'en';
}

/** Translate a key with optional {placeholder} interpolation. */
export function t(key: keyof Dict, vars?: Record<string, string | number>): string {
  let s: string = dicts[currentLang][key] ?? en[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export type TextKey = keyof Dict;

/** Runtime guard for declarative HTML keys, which TypeScript cannot inspect. */
export function isTextKey(key: string): key is TextKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** Localize stable authored POI names without leaking UI concerns into maps. */
export function localizePoiName(name: string, lang: Lang = currentLang): string {
  return lang === 'ja' ? POI_JA[name] ?? name : name;
}
