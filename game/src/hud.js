// The DOM HUD: crosshair, hit marker, health, money, ammo, timer, score, killfeed, the
// buy menu and the overlay panels. It never touches the simulation; main.js pushes numbers
// in and reads the play and buy callbacks out. Every setter skips a write when the value
// did not change, so the DOM is not touched sixty times a second for nothing.
const COPY = {
  start: {
    title: 'SANDLINE',
    copy: 'A two-site bomb map in a desert freight yard. You attack with four teammates against five defenders. Plant the bomb at A or B, or eliminate the other team — then spend what you earned.',
    action: 'Click to play',
  },
  paused: {
    title: 'SANDLINE',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  roundEnd: {
    title: 'Round over',
    copy: '',
    action: 'Next round',
  },
  matchEnd: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
  dead: {
    title: 'You are down',
    copy: 'Spectating a teammate until the round ends.',
    action: 'Keep watching',
  },
};

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay');
  const title = $('overlay-title');
  const copy = $('overlay-copy');
  const play = $('play');
  const ammoMag = $('ammo-mag');
  const ammoReserve = $('ammo-reserve');
  const weaponName = $('weapon-name');
  const healthValue = $('health-value');
  const healthBar = $('health-bar');
  const armorValue = $('armor-value');
  const armorBar = $('armor-bar');
  const moneyValue = $('money-value');
  const timerValue = $('timer-value');
  const roundScore = $('round-score');
  const killfeed = $('killfeed');
  const crosshair = $('crosshair');
  const hitmarker = $('hitmarker');
  const bombStatus = $('bomb-status');
  const progress = $('progress');
  const progressLabel = $('progress-label');
  const progressBar = $('progress-bar');
  const damageFlash = $('damage-flash');
  const spectate = $('spectate');
  const banner = $('round-banner');
  const bannerTitle = $('banner-title');
  const bannerSub = $('banner-sub');
  const buy = $('buy');
  const buyItems = $('buy-items');
  const buyMoney = $('buy-money');
  const buyHint = $('buy-hint');
  const grenadesEl = $('grenades');
  const grenadeFrag = $('grenade-frag');
  const grenadeSmoke = $('grenade-smoke');
  const utilityLine = $('utility-line');
  const dangerEl = $('danger');
  const cookEl = $('cook');
  const cookBar = $('cook-bar');

  let hitTimer = 0;
  let lastAmmo = '';
  let lastHealth = '';
  let lastMoney = -1;
  let lastTimer = '';
  let lastScore = '';
  let lastFeed = '';
  let lastBomb = '';
  let lastGrenades = '';
  let lastUtility = '';
  // The danger banner's two writers — a frag in the air and a grenade cooking in the
  // hand — share one element, so the banner is rendered from both states at once.
  let lastDangerText = null; // the text currently on the banner, or null when hidden
  let fragDanger = null; // the frag warning's text, or null when no frag threatens
  let cookWarning = false; // whether the cooked grenade in hand is about to go off

  // One render for both warnings, so neither writer can hide the other's banner: the
  // cook wins, because a frag in your hand is more urgent than a frag in the air, and
  // the banner only hides when neither is warning. The DOM is only touched when the
  // text actually changes.
  function renderDanger() {
    const text = cookWarning ? 'COOKED FRAG — THROW IT' : fragDanger;
    if (text === lastDangerText) return;
    lastDangerText = text;
    dangerEl.hidden = text === null;
    if (text !== null) dangerEl.textContent = text;
  }
  let buyHandler = null;

  return {
    setAmmo(mag, reserve, name) {
      const key = `${mag}/${reserve}/${name}`;
      if (key === lastAmmo) return;
      lastAmmo = key;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      weaponName.textContent = name;
      $('ammo').classList.toggle('empty', mag === 0);
    },
    // The player's grenade stock, beside the ammo: how many frags and smokes are
    // carried, and which one the G key will throw. The selected type is highlighted,
    // the empty one dims — the player should never have to guess what they are
    // holding, now that grenades decide rounds. Hidden entirely when the player
    // carries nothing.
    setGrenades(frag, smoke, selected) {
      const key = `${frag}/${smoke}/${selected}`;
      if (key === lastGrenades) return;
      lastGrenades = key;
      grenadeFrag.textContent = `FRAG ×${frag}`;
      grenadeSmoke.textContent = `SMOKE ×${smoke}`;
      grenadeFrag.classList.toggle('selected', selected === 'frag');
      grenadeSmoke.classList.toggle('selected', selected === 'smoke');
      grenadesEl.classList.toggle('empty', frag === 0 && smoke === 0);
    },
    setHealth(health, armor) {
      const key = `${health}/${armor}`;
      if (key === lastHealth) return;
      lastHealth = key;
      healthValue.textContent = String(Math.ceil(health));
      healthBar.style.width = `${Math.max(0, health)}%`;
      armorValue.textContent = String(Math.ceil(armor));
      armorBar.style.width = `${Math.min(100, armor)}%`;
    },
    setMoney(value) {
      if (value === lastMoney) return;
      lastMoney = value;
      moneyValue.textContent = `$${value}`;
    },
    setTimer(seconds, planted) {
      const total = Math.max(0, Math.ceil(seconds));
      const key = `${total}/${planted ? 1 : 0}`;
      if (key === lastTimer) return;
      lastTimer = key;
      timerValue.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      timerValue.classList.toggle('planted', planted);
    },
    setScore(atk, def, round) {
      const key = `${atk}-${def} R${round}`;
      if (key === lastScore) return;
      lastScore = key;
      roundScore.textContent = `ATK ${atk} — ${def} DEF · Round ${round}`;
    },
    // The live utility line, under the score: how many frags and smokes each side has
    // thrown this round, in the same words as the round-end feed line. It is the
    // running total of the grenade economy, so a player can see at a glance whether
    // the round has been quiet or loud.
    setUtility(text) {
      if (text === lastUtility) return;
      lastUtility = text;
      utilityLine.textContent = text;
      utilityLine.hidden = text === '';
    },
    setKillfeed(feed) {
      const key = feed.map((line) => line.text).join('|');
      if (key === lastFeed) return;
      lastFeed = key;
      killfeed.innerHTML = '';
      for (const line of feed) {
        const div = document.createElement('div');
        div.textContent = line.text;
        div.className = line.good ? 'good' : 'bad';
        killfeed.appendChild(div);
      }
    },
    setCrosshair(spread) {
      crosshair.style.setProperty('--gap', `${Math.round(3 + spread * 500)}px`);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    damageFlash() {
      damageFlash.classList.add('on');
      setTimeout(() => damageFlash.classList.remove('on'), 140);
    },
    // The frag danger banner: a live frag is close to the player and its fuse is
    // burning down. It is a warning, not damage — it shows while the player still
    // has time to move, and clears the moment the threat is gone. The distance in
    // the banner is the honest number: a frag 11 metres away is a warning, a frag
    // 3 metres away is a countdown.
    setDanger(on, distance) {
      fragDanger = on ? `FRAG ${Math.ceil(distance)}m — MOVE` : null;
      renderDanger();
    },
    // The cook indicator: how much of the held grenade's fuse has burned, as a bar
    // under the crosshair. A cook with no indicator is a guess, and a guess with a
    // 3-second fuse is a grenade in the hand. The bar shows while G is held and
    // clears the moment the grenade leaves.
    setCook(fraction) {
      if (fraction === null) {
        cookEl.hidden = true;
        return;
      }
      cookEl.hidden = false;
      cookBar.style.width = `${Math.round(fraction * 100)}%`;
    },
    // The cooked-frag warning: the grenade in the player's hand is a second from
    // going off. It shares the banner with the frag warning through renderDanger,
    // so turning it off never hides a frag warning that is still live.
    setCookWarning(on) {
      cookWarning = on;
      renderDanger();
    },
    setBombStatus(text) {
      if (text === lastBomb) return;
      lastBomb = text;
      bombStatus.textContent = text;
      bombStatus.hidden = text === '';
    },
    setProgress(label, fraction) {
      if (fraction === null) {
        progress.hidden = true;
        return;
      }
      progress.hidden = false;
      progressLabel.textContent = label;
      progressBar.style.width = `${Math.round(fraction * 100)}%`;
    },
    setSpectate(text) {
      spectate.textContent = text || '';
      spectate.hidden = !text;
    },
    showBanner(titleText, subText) {
      bannerTitle.textContent = titleText;
      bannerSub.textContent = subText;
      banner.hidden = false;
    },
    hideBanner() {
      banner.hidden = true;
    },
    showOverlay(mode, score) {
      const text = COPY[mode];
      title.textContent = text.title;
      copy.textContent = mode === 'roundEnd' || mode === 'matchEnd' ? score : text.copy;
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    showBuy(items, money) {
      buy.hidden = false;
      buyMoney.textContent = `$${money}`;
      buyItems.innerHTML = '';
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'buy-item';
        button.disabled = item.cost > money || item.owned;
        button.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.name}</span><span class="buy-cost">${item.owned ? 'OWNED' : '$' + item.cost}</span>`;
        button.addEventListener('click', () => {
          if (buyHandler) buyHandler(item.id);
        });
        buyItems.appendChild(button);
      }
    },
    hideBuy() {
      buy.hidden = true;
    },
    // The buy menu's hint line: what the bots carry this round, so the player buys
    // with the enemy's utility in mind instead of guessing. Set when the menu opens.
    setBuyHint(text) {
      buyHint.textContent = text;
    },
    onBuy(handler) {
      buyHandler = handler;
    },
  };
}
