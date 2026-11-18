// SANDLINE — a round-based tactical FPS in the Counter-Strike style, built original from
// the ground up: two bomb sites, money between rounds, a buy menu, five weapons, two
// grenades, and nine bots that route, hold, listen and shoot back. Since the post-opening
// revision the bots also throw grenades — a frag at an enemy they can see, a smoke when
// the planter executes a site or a defender covers a defuse — and the round reports how
// much utility each side spent, so the grenade economy is visible in the game itself.
//
// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// ?shot=start|play|end|utility with &seed=N sets up a deterministic frame for a capture,
// renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import {
  PHASE, MATCH_TARGET, MAX_ROUNDS, ROUND_SECONDS, BUY_SECONDS, BOMB_SECONDS,
  PLANT_SECONDS, DEFUSE_SECONDS, ROUND_END_SECONDS, START_MONEY, KILL_REWARD,
  PLANT_REWARD, WIN_REWARD, LOSS_REWARD, createState, roundPayout, pushFeed, resetUtility,
  utilitySummary, fragDamageSummary, matchUtilitySummary,
} from './state.js';
import { createWorld, SITES, SPAWNS } from './world.js';
import { createMover, newBody, syncBody } from './agents.js';
import { createBots } from './bots.js';
import { WEAPONS, GRENADES, ARMOR_COST, BUY_ORDER, createGun } from './weapons.js';
import { createCombat } from './combat.js';
import { createBomb } from './bomb.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const test = params.get('test'); // ?test=utility runs the grenade self-check instead of a frame
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

// One reused vector per job, so the hot loop allocates nothing.
const eyeVec = new THREE.Vector3();
const aimVec = new THREE.Vector3();
const muzzleVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 30, 80);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const state = createState();
const world = createWorld(scene);
const mover = createMover(world.colliders);
const combat = createCombat(scene, world, state, random);
const bomb = createBomb(scene);
const audio = createAudio();
const hud = createHud();
const input = createInput(renderer.domElement, onLockChange);

// The player is state.player with a body attached: one object, so combat, the HUD and the
// bots all read the same health, armour and position.
const player = state.player;
Object.assign(player, newBody(SPAWNS.atk[2][0], SPAWNS.atk[2][1], Math.PI), {
  id: 'player',
  name: 'You',
  team: 'atk',
  isPlayer: true,
  fall: 0,
  group: null,
  torso: null,
  head: null,
  hitMeshes: [],
});
player.owned = new Set(['pistol']);
player.primary = 'rifle';

const bots = createBots(scene, world, mover, random);
let agents = [player];
let gun = createGun(camera, player.weapon);
let spectateTarget = null;
let prevFiring = false;
let prevHealth = 100;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let buyOpen = false;
let dangerTickAt = 0; // match time of the last frag danger tick, throttled to 1 per second
let cooking = null; // the grenade being cooked: { kind, since } or null

function eyeOf(agent, out) {
  return out.set(agent.position.x, agent.position.y + agent.eye, agent.position.z);
}

function lookAt(agent, point) {
  const dx = point.x - agent.position.x;
  const dy = point.y - (agent.position.y + agent.eye);
  const dz = point.z - agent.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  agent.yaw = Math.atan2(-dx, -dz);
  agent.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
}

function resetAgentsForRound() {
  // The player keeps their primary and armour when they survived; a death costs both.
  const survived = player.alive;
  player.position.set(SPAWNS.atk[2][0], 0, SPAWNS.atk[2][1]);
  player.velocity.set(0, 0, 0);
  player.yaw = Math.PI;
  player.pitch = 0;
  player.alive = true;
  player.health = 100;
  player.armor = survived ? player.armor : 0;
  player.fall = 0;
  if (!survived) {
    player.owned = new Set(['pistol']);
    player.primary = 'pistol';
    player.grenades = { frag: 0, smoke: 0 };
  }
  player.weapon = player.primary;
  switchGun(player.weapon);
  gun.refill();
  // The player takes the middle attacker spawn (SPAWNS.atk[2]), so the bots spawn
  // from the other four: four bot attackers plus the player is five against five,
  // nine bots in all, and no bot shares the player's spawn point. Passing the full
  // SPAWNS would spawn a fifth attacker bot on the player's own spot, and the
  // loadout would wrap around and hand it the planter's smoke a second time.
  bots.resetRound(state, { atk: SPAWNS.atk.filter((_, i) => i !== 2), def: SPAWNS.def });
  agents = [player, ...bots.bots];
  spectateTarget = null;
  prevHealth = 100;
}

function switchGun(weaponId) {
  if (!player.owned.has(weaponId)) return;
  gun.dispose();
  player.weapon = weaponId;
  gun = createGun(camera, weaponId);
  hud.setAmmo(gun.state.mag, gun.state.reserve, WEAPONS[weaponId].name);
}

function buyItems() {
  const items = [];
  BUY_ORDER.forEach((id, index) => {
    const def = WEAPONS[id];
    items.push({ id, name: def.name, cost: def.cost, owned: player.owned.has(id), key: String(index + 1) });
  });
  items.push({ id: 'armor', name: 'Kevlar Vest (+100 armour)', cost: ARMOR_COST, owned: player.armor >= 100, key: '6' });
  items.push({ id: 'frag', name: 'Frag Grenade', cost: GRENADES.frag.cost, owned: player.grenades.frag >= 2, key: '7' });
  items.push({ id: 'smoke', name: 'Smoke Grenade', cost: GRENADES.smoke.cost, owned: player.grenades.smoke >= 2, key: '8' });
  return items;
}

function buyItem(id) {
  if (state.phase !== PHASE.BUY) return;
  const items = buyItems();
  const item = items.find((entry) => entry.id === id);
  if (!item || item.owned || item.cost > state.money) return;
  state.money -= item.cost;
  if (id === 'armor') {
    player.armor = 100;
  } else if (id === 'frag' || id === 'smoke') {
    player.grenades[id] += 1;
  } else {
    player.owned.add(id);
    player.primary = id;
    switchGun(id);
    gun.refill();
  }
  hud.showBuy(buyItems(), state.money);
  hud.setMoney(state.money);
}

function openBuy() {
  if (state.phase !== PHASE.BUY) return;
  buyOpen = true;
  hud.showBuy(buyItems(), state.money);
  // The hint line names the bots' utility this round, by team, so the player buys
  // with the enemy's grenades in mind: a round where the defenders carry two smokes
  // is a round to buy a frag of your own, not a second rifle.
  hud.setBuyHint(`Bots carry this round — ${bots.utilityReportByTeam()}.`);
}

function closeBuy() {
  buyOpen = false;
  hud.hideBuy();
}

function startRound() {
  bomb.reset();
  state.bomb.state = 'idle';
  state.bomb.site = null;
  state.bomb.carrier = null;
  state.bomb.progress = 0;
  state.bomb.position = null;
  state.feed = [];
  // A new round, a clean utility sheet: the counts combat.throwGrenade keeps are
  // per-round, so they reset here beside the feed, never mid-round.
  resetUtility(state);
  state.winner = null;
  state.roundResult = '';
  resetAgentsForRound();
  state.phase = PHASE.BUY;
  state.timer = BUY_SECONDS;
  hud.hideBanner();
  hud.hideOverlay();
  hud.setSpectate(null);
  openBuy();
}

function startMatch() {
  state.score = { atk: 0, def: 0 };
  state.round = 1;
  state.lossStreak = 0;
  state.money = START_MONEY;
  // A new match, a clean frag sheet: the damage total is per match, not per round.
  state.fragDamage = { atk: 0, def: 0 };
  state.matchUtility = { atk: { frag: 0, smoke: 0 }, def: { frag: 0, smoke: 0 } };
  player.kills = 0;
  player.deaths = 0;
  player.alive = true;
  player.owned = new Set(['pistol']);
  player.primary = 'rifle';
  startRound();
}

function endRound(winner, reason) {
  if (state.phase !== PHASE.LIVE && state.phase !== PHASE.BUY) return;
  state.phase = PHASE.ROUND_END;
  state.winner = winner;
  state.roundResult = reason;
  if (winner === 'atk') state.score.atk += 1;
  else if (winner === 'def') state.score.def += 1;
  roundPayout(state, winner === 'atk');
  audio.roundEnd(winner === 'atk');
  // The round's utility, in the feed: how many frags and smokes each side threw. The
  // numbers come from state.utility, which combat.throwGrenade records and startRound
  // resets, so the line always describes the round that just ended — and a round with
  // no throws says nothing at all.
  const utility = state.utility;
  const thrown = utility.atk.frag + utility.def.frag + utility.atk.smoke + utility.def.smoke;
  if (thrown > 0) {
    pushFeed(state, `Utility this round — ${utilitySummary(state)}`, winner === 'atk');
    hud.setKillfeed(state.feed);
  }
  closeBuy();
  // The banner carries the utility too, so the round's grenade use is visible without
  // opening the feed: the sub-text is the round, the score and the utility in one line.
  hud.showBanner(
    winner === 'atk' ? 'Attackers win the round' : 'Defenders win the round',
    `${reason} · ATK ${state.score.atk} — ${state.score.def} DEF${thrown > 0 ? ` · Utility — ${utilitySummary(state)}` : ''}`,
  );
  state.timer = ROUND_END_SECONDS;
  if (document.pointerLockElement) document.exitPointerLock();
}

function endMatch() {
  state.phase = PHASE.MATCH_END;
  const draw = state.score.atk === state.score.def;
  // The match summary carries the frag damage total beside the score: the grenades
  // were the revision, so the match report says what they did.
  const fragLine = fragDamageSummary(state);
  const utilityLine = matchUtilitySummary(state);
  const line = draw
    ? `A 7–7 draw. ATK ${state.score.atk} — ${state.score.def} DEF. ${fragLine} ${utilityLine}`
    : `${state.score.atk > state.score.def ? 'Attackers' : 'Defenders'} take the match ${state.score.atk} — ${state.score.def}. You scored ${player.kills} eliminations. ${fragLine} ${utilityLine}`;
  hud.showOverlay('matchEnd', line);
  if (document.pointerLockElement) document.exitPointerLock();
}

function nextAfterRound() {
  if (state.score.atk >= MATCH_TARGET || state.score.def >= MATCH_TARGET || state.round >= MAX_ROUNDS) {
    endMatch();
    return;
  }
  state.round += 1;
  startRound();
}

function onLockChange(locked) {
  if (shot) return;
  audio.unlock();
  if (locked) {
    started = true;
    hud.hideOverlay();
  } else if (state.phase === PHASE.LIVE && !player.alive) {
    // Dead players spectate without the pause panel.
  } else if (state.phase === PHASE.LIVE) {
    hud.showOverlay('paused');
  }
}

hud.onPlay(() => {
  if (shot) return;
  audio.unlock();
  if (state.phase === PHASE.MATCH_END) {
    startMatch();
    input.requestLock();
    return;
  }
  if (state.phase === PHASE.MENU) {
    startMatch();
  }
  input.requestLock();
});

hud.onBuy((id) => buyItem(id));

// --- Shooting ---------------------------------------------------------------

function playerShoot() {
  const def = WEAPONS[player.weapon];
  if (!gun.ready()) return;
  if (!gun.takeRound()) return;
  camera.getWorldDirection(aimVec);
  eyeOf(player, eyeVec);
  muzzleVec.copy(eyeVec).addScaledVector(aimVec, 0.6);
  camera.getWorldDirection(rightVec);
  rightVec.cross(new THREE.Vector3(0, 1, 0)).normalize();
  muzzleVec.addScaledVector(rightVec, 0.2);
  muzzleVec.y -= 0.15;
  const pellets = def.pellets || 1;
  let anyKill = false;
  for (let i = 0; i < pellets; i += 1) {
    const result = combat.shoot(player, muzzleVec, aimVec, gun.spread(mover.groundSpeed(player)), def, agents, world.shootables);
    if (result.hit && result.agent) {
      audio.hit(result.killed);
      hud.hitMarker(result.killed, 400);
      if (result.killed) {
        anyKill = true;
        state.money += KILL_REWARD;
        pushFeed(state, `You ✕ ${result.agent.name}${result.part === 'head' ? ' (headshot)' : ''}`, true);
      }
    }
  }
  gun.pullTrigger();
  player.pitch = Math.min(1.45, player.pitch + def.recoil * (0.8 + random() * 0.4));
  player.yaw += (random() * 2 - 1) * def.recoil * 0.4;
  audio.shot(player.weapon, false);
  state.events.push({ kind: 'shot', x: player.position.x, z: player.position.z, radius: 30 });
  hud.setAmmo(gun.state.mag, gun.state.reserve, def.name);
  hud.setMoney(state.money);
  if (anyKill) hud.setKillfeed(state.feed);
}

// --- Bot kills ---------------------------------------------------------------

function onBotHit(bot, result) {
  if (!result.agent) return;
  if (result.killed) {
    pushFeed(state, `${bot.name} ✕ ${result.agent.name}${result.part === 'head' ? ' (headshot)' : ''}`, bot.team === 'atk');
    hud.setKillfeed(state.feed);
    if (result.agent === player) {
      player.deaths += 1;
      hud.setSpectate('You are down — spectating a teammate.');
    }
  }
}

// --- The fixed step ----------------------------------------------------------

function plantOrDefuseAgents() {
  let planter = null;
  let defuser = null;
  const keys = input.state.keys;
  if (state.bomb.state === 'idle' || state.bomb.state === 'planting') {
    if (player.alive && keys.has('KeyE') && player.team === 'atk') planter = player;
    if (!planter) {
      const bot = bots.bots.find((b) => b.alive && b.team === 'atk' && b.ai.mode === 'plant');
      if (bot) planter = bot;
    }
  }
  if (state.bomb.state === 'planted' || state.bomb.state === 'defusing') {
    if (player.alive && keys.has('KeyE') && player.team === 'atk' && state.bomb.state === 'planted') {
      const distance = Math.hypot(player.position.x - state.bomb.position.x, player.position.z - state.bomb.position.z);
      if (distance < 1.8) defuser = player;
    }
    if (!defuser) {
      const bot = bots.bots.find((b) => b.alive && b.team === 'def' && b.ai.mode === 'defuse');
      if (bot) defuser = bot;
    }
  }
  return { planter, defuser };
}

function checkRoundEnd() {
  if (state.phase !== PHASE.LIVE) return;
  const atkAlive = agents.some((agent) => agent.team === 'atk' && agent.alive);
  const defAlive = agents.some((agent) => agent.team === 'def' && agent.alive);
  if (state.bomb.state === 'planted' || state.bomb.state === 'defusing') return; // the bomb decides
  if (!defAlive) endRound('atk', 'The defending team was eliminated.');
  else if (!atkAlive) endRound('def', 'The attacking team was eliminated.');
}

function step(dt) {
  state.time += dt;
  const bombPlanted = state.bomb.state === 'planted' || state.bomb.state === 'defusing';

  if (state.phase === PHASE.BUY) {
    state.timer -= dt;
    if (state.timer <= 0) {
      state.phase = PHASE.LIVE;
      state.timer = ROUND_SECONDS;
      closeBuy();
    }
  } else if (state.phase === PHASE.LIVE) {
    if (bombPlanted) {
      state.timer = state.bomb.fuse;
    } else {
      state.timer -= dt;
      if (state.timer <= 0) {
        endRound('def', 'Time expired before the bomb was planted.');
        return;
      }
    }
  } else if (state.phase === PHASE.ROUND_END) {
    state.timer -= dt;
    if (state.timer <= 0) {
      nextAfterRound();
      return;
    }
  } else {
    return; // menu / match end: the world waits
  }

  if (state.phase === PHASE.LIVE || state.phase === PHASE.BUY) {
    // Player movement and look.
    if (player.alive && (state.phase === PHASE.LIVE || !shot)) {
      const keys = input.state.keys;
      const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      let wishX = 0;
      let wishZ = 0;
      if (forward || strafe) {
        wishX = -sin * forward + cos * strafe;
        wishZ = -cos * forward - sin * strafe;
        const length = Math.hypot(wishX, wishZ);
        wishX /= length;
        wishZ /= length;
      }
      const crouching = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
      mover.step(player, dt, wishX, wishZ, keys.has('Space'), crouching);
    }
    gun.step(dt);

    // Bots move, see and shoot.
    bots.stepAll(dt, {
      state,
      combat,
      agents,
      time: state.time,
      onBotHit,
    });

    // The bomb, driven by whoever is holding E on it.
    const { planter, defuser } = plantOrDefuseAgents();
    const bombEvent = bomb.step(dt, state, planter, defuser, () => audio.beep(), combat.smokes);
    if (bombEvent === 'planted') {
      audio.plant();
      pushFeed(state, `The bomb is planted at Site ${state.bomb.site}.`, true);
      hud.setKillfeed(state.feed);
      for (const bot of bots.bots) {
        if (bot.alive && bot.team === 'atk') bot.ai.mode = 'retreat';
      }
    } else if (bombEvent === 'defused') {
      endRound('def', 'The bomb was defused.');
      return;
    } else if (bombEvent === 'exploded') {
      endRound('atk', 'The bomb detonated.');
      return;
    }

    combat.step(dt, agents);
    checkRoundEnd();

    // Grenade sounds and the frag danger warning, read off the sound events the step
    // just produced and the grenades still in the air. The events live for one step,
    // so each sound fires exactly once per throw and per explosion — a throw that
    // sounds twice is a bug, not a feature.
    for (const event of state.events) {
      if (event.kind === 'throw') audio.throwGrenade();
      else if (event.kind === 'explosion') {
        const distance = Math.hypot(event.x - player.position.x, event.z - player.position.z);
        audio.explosion(distance > 20);
      } else if (event.kind === 'smoke') audio.smoke();
    }
    // A live frag close to the player, fuse burning down: the danger banner and its
    // tick. The banner shows while the player still has time to move, and the tick
    // fires at most once a second so it warns instead of nagging.
    const danger = combat.grenadeDanger(player);
    hud.setDanger(danger !== null, danger === null ? 0 : danger.distance);
    if (danger !== null && state.time - dangerTickAt >= 1) {
      dangerTickAt = state.time;
      audio.danger();
    }
  }

  // Hurt feedback: a health drop since the last step flashes the screen.
  if (player.health < prevHealth) {
    hud.damageFlash();
    audio.hurt();
  }
  prevHealth = player.health;

  // Sound events live for one step: the bots heard them above, now they are gone.
  state.events.length = 0;
}

function syncCamera() {
  let target = player;
  if (!player.alive) {
    if (!spectateTarget || !spectateTarget.alive) {
      spectateTarget = bots.bots.find((bot) => bot.team === 'atk' && bot.alive) || null;
    }
    if (spectateTarget) target = spectateTarget;
  }
  camera.position.set(target.position.x, target.position.y + target.eye, target.position.z);
  camera.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
  const wantFov = player.weapon === 'sniper' && input.state.scoping && player.alive ? 30 : 74;
  if (Math.abs(camera.fov - wantFov) > 0.5) {
    camera.fov += (wantFov - camera.fov) * 0.2;
    camera.updateProjectionMatrix();
  }
}

function syncHud() {
  hud.setHealth(player.health, player.armor);
  hud.setMoney(state.money);
  hud.setAmmo(gun.state.mag, gun.state.reserve, WEAPONS[player.weapon].name);
  const planted = state.bomb.state === 'planted' || state.bomb.state === 'defusing';
  hud.setTimer(state.timer, planted);
  hud.setScore(state.score.atk, state.score.def, state.round);
  hud.setKillfeed(state.feed);
  hud.setCrosshair(gun.spread(mover.groundSpeed(player)));
  // The player's grenade stock, beside the ammo, and the live utility line under the
  // score. Both update every frame through the same cached setters as the ammo, so
  // the DOM is only touched when a number actually changes.
  hud.setGrenades(player.grenades.frag, player.grenades.smoke, player.selectedGrenade);
  const utility = state.utility;
  const thrown = utility.atk.frag + utility.def.frag + utility.atk.smoke + utility.def.smoke;
  hud.setUtility(thrown > 0 ? `Utility — ${utilitySummary(state)}` : '');
  if (state.bomb.state === 'planted') {
    hud.setBombStatus(`BOMB PLANTED — SITE ${state.bomb.site} — ${Math.ceil(state.bomb.fuse)}s`);
  } else if (state.bomb.state === 'defusing') {
    hud.setBombStatus('BOMB BEING DEFUSED');
  } else {
    hud.setBombStatus('');
  }
  // Spectating a bot shows that bot's grenade stock: the dead player can still read
  // whether their teammate has a frag left, which is the information that decides
  // whether to keep watching the round.
  if (!player.alive && spectateTarget) {
    hud.setSpectate(`Spectating ${spectateTarget.name} — ${spectateTarget.grenades.frag} frag ${spectateTarget.grenades.smoke} smoke.`);
  }
  const bomb = state.bomb;
  if ((bomb.state === 'planting' || bomb.state === 'defusing') && bomb.carrier === player) {
    hud.setProgress(bomb.state === 'planting' ? 'Planting the bomb…' : 'Defusing the bomb…', bomb.progress);
  } else {
    hud.setProgress('', null);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    const released = input.takeReleased();
    if (player.alive && input.state.locked) {
      player.yaw -= look.x * 0.0022;
      player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - look.y * 0.0022));
    }

    // Discrete keys, handled once per press.
    for (const code of input.takePressed()) {
      if (code === 'KeyR') gun.reload();
      else if (code === 'KeyB') {
        if (state.phase === PHASE.BUY) {
          if (buyOpen) closeBuy();
          else openBuy();
        }
      } else if (code === 'KeyQ') {
        player.selectedGrenade = player.selectedGrenade === 'frag' ? 'smoke' : 'frag';
      } else if (code === 'KeyG') {
        // Cooking starts on the press: the grenade stays in hand while G is held, its
        // fuse ticking down, and leaves on the release. A tap throws it uncooked,
        // exactly as before the revision.
        const kind = player.selectedGrenade;
        if (player.alive && player.grenades[kind] > 0 && state.phase === PHASE.LIVE && !cooking) {
          cooking = { kind, since: state.time };
        }
      } else if (code.startsWith('Digit')) {
        const index = Number(code.slice(5)) - 1;
        if (state.phase === PHASE.BUY) {
          const items = buyItems();
          if (items[index]) buyItem(items[index].id);
        } else if (index < BUY_ORDER.length) {
          switchGun(BUY_ORDER[index]);
        }
      }
    }

    // The cook, resolved every frame: release G to throw with the fuse shortened by
    // the time it was held, or hold it past the fuse minus a safety margin and it
    // leaves the hand on its own, 0.8 seconds from going off. A dead player or a
    // round that ended mid-cook drops the grenade unthrown — the stock is not spent.
    // The cook bar shows the fuse burning while G is held, so the player never has
    // to guess how cooked the grenade in their hand is.
    if (cooking) {
      if (!player.alive || state.phase !== PHASE.LIVE) {
        cooking = null;
        hud.setCook(null);
        hud.setCookWarning(false);
        combat.hideArcPreview();
      } else {
        const fuse = GRENADES[cooking.kind].fuse;
        const cooked = state.time - cooking.since;
        hud.setCook(Math.min(1, cooked / fuse));
        // The cook warning: inside the last 1.5 seconds of the fuse the grenade in
        // the hand is a danger to its owner, and the banner says so until it leaves.
        if (cooked >= fuse - 1.5) hud.setCookWarning(true);
        // The arc preview follows the cook: the ring shows where the grenade will
        // land from the player's current aim, so a cooked throw is aimed, not guessed.
        eyeOf(player, eyeVec);
        camera.getWorldDirection(aimVec);
        combat.updateArcPreview(eyeVec, aimVec);
        // The release is a discrete event, not a key that stopped being held: the
        // input module reports it once, on the frame it happened.
        if (cooked >= fuse - 0.8 || released.has('KeyG')) {
          const kind = cooking.kind;
          cooking = null;
          player.grenades[kind] -= 1;
          eyeOf(player, eyeVec);
          camera.getWorldDirection(aimVec);
          combat.throwGrenade(player, eyeVec, aimVec, kind, Math.max(0.5, fuse - cooked));
          combat.hideArcPreview();
          gun.throwKick();
          hud.setCook(null);
          hud.setCookWarning(false);
        }
      }
    }

    if (state.phase === PHASE.LIVE && player.alive && input.state.locked) {
      const def = WEAPONS[player.weapon];
      if (def.auto) {
        if (input.state.firing) playerShoot();
      } else if (input.state.firing && !prevFiring) {
        playerShoot();
      }
    }
    prevFiring = input.state.firing;

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
    syncHud();
    for (const bot of bots.bots) syncBody(bot, dt);
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let index = 0; index < steps; index += 1) {
    step(FIXED_STEP);
    syncCamera();
    for (const bot of bots.bots) syncBody(bot, FIXED_STEP);
  }
}

function runShot(name) {
  hud.hideOverlay();
  hud.hideBanner();
  closeBuy();
  startMatch();
  if (name === 'start') {
    // Buy phase at the attacker spawn, looking down mid toward Site A: the buy menu,
    // the map and the team all in one frame.
    player.position.set(-2, 0, 12);
    player.yaw = Math.PI * 0.92;
    player.pitch = -0.02;
    settle(30);
    openBuy();
    hud.setMoney(state.money);
    paintTwiceThenReady();
    return;
  }
  // Live round: jump the clock into the firefight, walk the player to mid, and let the
  // bots meet them there. A few scripted shots land a kill so the frame shows the fight.
  state.phase = PHASE.LIVE;
  state.timer = ROUND_SECONDS - 8;
  closeBuy();
  player.position.set(1.5, 0, 5);
  player.yaw = Math.PI;
  player.pitch = 0;
  settle(240);
  if (name === 'utility') {
    // The grenade showcase: a live round, the player at mid-left, a defender's frag in
    // the air and the planter's smoke blooming over Site A. The throws go through the
    // same functions the AI uses, so the frame shows the real mechanic, not a staged
    // prop. The player stands where the smoke at Site A's mouth and the frag arcing
    // down mid are both in frame.
    player.position.set(-2, 0, 6);
    player.yaw = Math.PI * 0.85;
    player.pitch = 0;
    // The showcase loadout: a frag and a smoke for the player to throw, since the
    // shot skips the buy phase and the player starts the round with empty pockets.
    player.grenades = { frag: 1, smoke: 1 };
    settle(60);
    const ctx = { state, combat, agents, time: state.time, onBotHit };
    const thrower = bots.bots
      .filter((bot) => bot.team === 'def' && bot.alive && bot.grenades.frag > 0)
      .sort((a, b) => a.position.distanceTo(player.position) - b.position.distanceTo(player.position))[0];
    if (thrower) bots.forceThrowFrag(thrower, player.position, ctx);
    const planter = bots.bots.find((bot) => bot.team === 'atk' && bot.alive && bot.ai.isPlanter && bot.grenades.smoke > 0);
    if (planter) bots.forceThrowSmoke(planter, 'A', ctx);
    // 75 steps: the smoke has popped (1.2 s fuse) and the frag is a second into its
    // 3-second fuse, close enough to the player that the danger banner shows.
    settle(75);
    // A second cloud for the frame: the mid defender's smoke at the site, the retake
    // cover going up while the planter's execute smoke is still blooming.
    const retaker = bots.bots.find((bot) => bot.team === 'def' && bot.alive && bot.grenades.smoke > 0);
    if (retaker) bots.forceThrowSmoke(retaker, 'A', { state, combat, agents, time: state.time, onBotHit });
    // Another 75 steps: the second smoke is just blooming, the first is a full cloud,
    // and the frag is 2.5 seconds into its fuse — a half second from going off, right
    // in front of the player.
    settle(75);
    // A third moment for the frame: a defender's frag at the planter, the counter to
    // the execute, arcing in while the smokes bloom.
    const counter = bots.bots.find((bot) => bot.team === 'def' && bot.alive && bot.grenades.frag > 0);
    if (counter && planter) bots.forceThrowFrag(counter, planter.position, { state, combat, agents, time: state.time, onBotHit });
    settle(30);
    // The player's own smoke, thrown at the site mouth from mid: the frame shows the
    // whole grenade game at once — a bot's frag, two bot smokes, and the player's.
    if (player.grenades.smoke > 0) {
      eyeOf(player, eyeVec);
      tmpVec.set(-12, 1.0, -8);
      const aim = tmpVec.sub(eyeVec).normalize();
      combat.throwGrenade(player, eyeVec, aim, 'smoke');
      player.grenades.smoke -= 1;
    }
    settle(30);
    paintTwiceThenReady();
    return;
  }
  const foe = bots.bots
    .filter((bot) => bot.team === 'def' && bot.alive)
    .sort((a, b) => a.position.distanceTo(player.position) - b.position.distanceTo(player.position))[0];
  if (foe) {
    // Re-aim before every shot: the target moves between rounds.
    for (let round = 0; round < 4; round += 1) {
      if (!foe.alive) break;
      tmpVec.set(foe.position.x, foe.position.y + 1.1, foe.position.z);
      lookAt(player, tmpVec);
      if (gun.ready()) playerShoot();
      settle(6);
    }
  }
  if (name === 'play') {
    settle(30);
    paintTwiceThenReady();
    return;
  }
  // end: clear the defenders and let the round close, then show the banner.
  for (const bot of bots.bots) {
    if (bot.team === 'def' && bot.alive) {
      combat.applyDamage(bot, 1000, player);
    }
  }
  settle(10);
  checkRoundEnd();
  settle(30);
  paintTwiceThenReady();
}

// A self-check for the grenade revision, run with ?test=utility: it starts a match,
// forces a frag and a smoke through the same functions the AI uses, steps the sim
// until both fuses have burned, then reports the result on window.__testResult. The
// headless playtest reads that object instead of guessing from pixels, and a human
// can run the same check from any browser by loading the page with the query. The
// gating checks are the contract: a throw is recorded, a cloud exists, and both
// grenades have left the air. The frag damage is reported but does not gate the
// result — a frag that lands behind a container still exploded, it just hurt no one.
function runUtilityTest() {
  hud.hideOverlay();
  hud.hideBanner();
  closeBuy();
  startMatch();
  state.phase = PHASE.LIVE;
  state.timer = ROUND_SECONDS - 8;
  closeBuy();
  player.position.set(0, 0, 2);
  player.yaw = Math.PI;
  player.pitch = 0;
  settle(120);
  const ctx = { state, combat, agents, time: state.time, onBotHit };
  const thrower = bots.bots
    .filter((bot) => bot.team === 'def' && bot.alive && bot.grenades.frag > 0)
    .sort((a, b) => a.position.distanceTo(player.position) - b.position.distanceTo(player.position))[0]
    ?? bots.bots.find((bot) => bot.team === 'def' && bot.alive);
  // The defenders may have spent both frags during the settle — the test stages a
  // throw, so one defender is re-issued a frag for the fixture, and the cooldown is
  // cleared beside it. The loadout caps are runEconomyTest's job, not this test's.
  if (thrower) {
    thrower.grenades.frag = Math.max(thrower.grenades.frag, 1);
    thrower.ai.grenadeReadyAt = 0;
  }
  const planter = bots.bots.find((bot) => bot.team === 'atk' && bot.alive && bot.ai.isPlanter && bot.grenades.smoke > 0);
  const fragThrown = thrower ? bots.forceThrowFrag(thrower, player.position, ctx) : false;
  const smokeThrown = planter ? bots.forceThrowSmoke(planter, 'A', ctx) : false;
  settle(200); // past both fuses: the frag has exploded, the smoke has bloomed
  // The danger warning, checked on a fresh throw: a frag forced at the player's feet
  // must read as dangerous while its fuse burns, and the cook's fuse override must
  // shorten the fuse it flies with. Both are the counterplay systems, so the test
  // covers them beside the throws.
  let dangerThrower = bots.bots.find((bot) => bot.team === 'def' && bot.alive && bot.grenades.frag > 0);
  if (!dangerThrower) {
    // Every defender may have spent its frag during the settles. The danger check
    // needs a fresh throw, so one defender is re-issued a frag for the fixture, and
    // its cooldown is cleared beside it.
    dangerThrower = bots.bots.find((bot) => bot.team === 'def' && bot.alive);
    if (dangerThrower) dangerThrower.grenades.frag = 1;
  }
  if (dangerThrower) dangerThrower.ai.grenadeReadyAt = 0;
  let dangerSeen = false;
  if (dangerThrower) {
    bots.forceThrowFrag(dangerThrower, player.position, { state, combat, agents, time: state.time, onBotHit });
    // A second and a half, not half a second: the frag flies 0.8–1.6 seconds to the
    // player's feet, and the danger check only reads a live frag within 12 metres
    // with its fuse under 2.5 seconds — at half a second it is still in the air,
    // thirteen metres out, and reads as nothing.
    settle(90); // the frag has landed near the player, its fuse still burning
    dangerSeen = combat.grenadeDanger(player) !== null;
  }
  // The cook's fuse override: a grenade thrown with a 0.5-second fuse flies with a
  // 0.5-second fuse, not the table's 3 seconds.
  eyeOf(player, eyeVec);
  camera.getWorldDirection(aimVec);
  const cooked = combat.throwGrenade(player, eyeVec, aimVec, 'frag', 0.5);
  const cookFuseOk = Boolean(cooked) && cooked.fuse === 0.5;
  // The arc preview: while the player cooks, the ring and the line must show, and
  // hide again when the throw leaves. The preview is only a cooking aid, so the
  // test checks it appears on demand and disappears on the throw.
  combat.updateArcPreview(eyeVec, aimVec);
  const arcShown = combat.arcVisible();
  combat.hideArcPreview();
  const arcHidden = !combat.arcVisible();
  settle(200); // let the fresh frag and the cooked grenade burn out
  const checks = {
    fragThrown: fragThrown && state.utility.def.frag >= 1,
    smokeThrown: smokeThrown && state.utility.atk.smoke >= 1,
    smokeActive: combat.smokes.length >= 1,
    grenadesGone: combat.grenades.length === 0,
    fragDamage: state.fragDamage.def > 0,
    dangerSeen,
    cookFuseOk,
    arcShown,
    arcHidden,
  };
  const passed = checks.fragThrown && checks.smokeThrown && checks.smokeActive && checks.grenadesGone && checks.dangerSeen && checks.cookFuseOk && checks.arcShown && checks.arcHidden;
  window.__testResult = {
    name: 'utility',
    passed,
    checks,
    utility: { ...state.utility },
    fragDamage: { ...state.fragDamage },
  };
  window.__shotReady = true;
  frozen = true;
}

// A self-check for the rebalance, run with ?test=economy: it reads the same numbers
// main.ts checks at build time — the prices, the payouts, the smoke radius against
// the site — and the live bot loadout, and reports them on window.__testResult. The
// build check guards the source; this one guards the running game, where the numbers
// are the live constants and not a text pattern, and where the loadout is the stocks
// the bots actually carry into the round.
function runEconomyTest() {
  hud.hideOverlay();
  hud.hideBanner();
  closeBuy();
  startMatch();
  const stocks = bots.bots.map((bot) => ({ frag: bot.grenades.frag, smoke: bot.grenades.smoke }));
  const totalFrags = stocks.reduce((sum, stock) => sum + stock.frag, 0);
  const totalSmokes = stocks.reduce((sum, stock) => sum + stock.smoke, 0);
  const rules = bots.grenadeRules();
  // The loadout's price, per team: the bots' utility is bought out of the same $300
  // table as the player's, so a round's bot utility has a price, and the price has a
  // cap — $1,200 for the attackers, $900 for the defenders. A loadout over its cap
  // is a loadout the round's economy could not pay for.
  const atkCost = stocks.filter((_, i) => bots.bots[i].team === 'atk').reduce((sum, stock) => sum + (stock.frag + stock.smoke) * 300, 0);
  const defCost = stocks.filter((_, i) => bots.bots[i].team === 'def').reduce((sum, stock) => sum + (stock.frag + stock.smoke) * 300, 0);
  const checks = {
    winFundsRifleVest: WIN_REWARD >= WEAPONS.rifle.cost + ARMOR_COST,
    lossFundsSmgVest: LOSS_REWARD >= WEAPONS.smg.cost + ARMOR_COST,
    grenadesPriced: GRENADES.frag.cost === 300 && GRENADES.smoke.cost === 300,
    smokeCoversSite: GRENADES.smoke.radius >= SITES.A.half + 1,
    botFragsCapped: totalFrags <= 6,
    botSmokesCapped: totalSmokes <= 2,
    noBotDoubleStock: stocks.every((stock) => stock.frag <= 1 && stock.smoke <= 1),
    fragRangeWindow: rules.throwMin > GRENADES.frag.radius,
    fragLandsBeforeFuse: GRENADES.frag.fuse > rules.throwMax / 14,
    cooldownSpaced: rules.cooldown >= 5,
    atkLoadoutPriced: atkCost <= 1200,
    defLoadoutPriced: defCost <= 900,
  };
  const passed = Object.values(checks).every(Boolean);
  window.__testResult = {
    name: 'economy',
    passed,
    checks,
    winReward: WIN_REWARD,
    lossReward: LOSS_REWARD,
    totalFrags,
    totalSmokes,
  };
  window.__shotReady = true;
  frozen = true;
}

// A self-check for the smoke objective modifier, run with ?test=smoke: it drives the
// bomb module directly with a fake planter and defuser, once on open ground and once
// under a smoke cloud, and compares the progress. The plant must run faster under
// smoke and the defuse slower — if either is equal, the modifier is not wired up.
// The bomb's own step is the unit under test, so the check calls it, not the game.
function runSmokeTest() {
  hud.hideOverlay();
  hud.hideBanner();
  closeBuy();
  startMatch();
  const planter = { position: { x: SITES.A.x, z: SITES.A.z }, alive: true, isPlayer: false };
  const defuser = { position: { x: SITES.A.x, z: SITES.A.z }, alive: true, isPlayer: false };
  const noOp = () => {};
  const cloud = [{ position: { x: SITES.A.x, y: 0.5, z: SITES.A.z }, radius: 5 }];
  // Plant on open ground: one step to start planting, then 60 steps (1 second).
  state.bomb.state = 'idle';
  bomb.step(1 / 60, state, planter, null, noOp, null);
  for (let i = 0; i < 60; i += 1) bomb.step(1 / 60, state, planter, null, noOp, null);
  const plainPlant = state.bomb.progress;
  // Plant under smoke: the same second, with a cloud over the site centre.
  bomb.reset();
  state.bomb.state = 'idle';
  state.bomb.site = null;
  state.bomb.carrier = null;
  state.bomb.progress = 0;
  bomb.step(1 / 60, state, planter, null, noOp, cloud);
  for (let i = 0; i < 60; i += 1) bomb.step(1 / 60, state, planter, null, noOp, cloud);
  const smokedPlant = state.bomb.progress;
  // Defuse on open ground: the bomb is planted, the defuser holds E on it.
  state.bomb.state = 'planted';
  state.bomb.site = 'A';
  state.bomb.fuse = BOMB_SECONDS;
  state.bomb.position = { x: SITES.A.x, z: SITES.A.z };
  state.bomb.progress = 0;
  bomb.step(1 / 60, state, null, defuser, noOp, null);
  for (let i = 0; i < 60; i += 1) bomb.step(1 / 60, state, null, defuser, noOp, null);
  const plainDefuse = state.bomb.progress;
  // Defuse under smoke: the same second, with the cloud over the site.
  state.bomb.state = 'planted';
  state.bomb.fuse = BOMB_SECONDS;
  state.bomb.progress = 0;
  bomb.step(1 / 60, state, null, defuser, noOp, cloud);
  for (let i = 0; i < 60; i += 1) bomb.step(1 / 60, state, null, defuser, noOp, cloud);
  const smokedDefuse = state.bomb.progress;
  // The negative control: a cloud over Site B while planting at Site A must change
  // nothing. The modifier is positional — it reads the cloud's place, not merely
  // that a cloud exists somewhere on the map — and this is the check that proves it.
  const farCloud = [{ position: { x: SITES.B.x, y: 0.5, z: SITES.B.z }, radius: 5 }];
  bomb.reset();
  state.bomb.state = 'idle';
  state.bomb.site = null;
  state.bomb.carrier = null;
  state.bomb.progress = 0;
  bomb.step(1 / 60, state, planter, null, noOp, farCloud);
  for (let i = 0; i < 60; i += 1) bomb.step(1 / 60, state, planter, null, noOp, farCloud);
  const farPlant = state.bomb.progress;
  const checks = {
    plantStarts: plainPlant > 0 && smokedPlant > 0,
    smokeSpeedsPlant: smokedPlant > plainPlant,
    defuseStarts: plainDefuse > 0 && smokedDefuse > 0,
    smokeSlowsDefuse: smokedDefuse < plainDefuse,
    farSmokeChangesNothing: Math.abs(farPlant - plainPlant) < 0.001,
  };
  const passed = Object.values(checks).every(Boolean);
  window.__testResult = {
    name: 'smoke',
    passed,
    checks,
    plainPlant,
    smokedPlant,
    plainDefuse,
    smokedDefuse,
    farPlant,
  };
  window.__shotReady = true;
  frozen = true;
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    syncHud();
    for (const bot of bots.bots) syncBody(bot, 0.016);
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
syncHud();
// A read-only handle for playtesting in a browser console: the state store, the agents,
// and the grenade revision's test hooks. The hooks force throws and read the utility
// counts through the same functions the game uses, so a playtest never reaches into
// module internals to stage a throw.
window.__sandline = {
  state,
  getAgents: () => agents,
  player,
  utility: () => state.utility,
  fragDamage: () => state.fragDamage,
  matchUtility: () => state.matchUtility,
  // The economy anchors, for the playtest: the payouts and the prices the rebalance
  // ties together, so a check can read them without reaching into the modules.
  economy: () => ({ win: WIN_REWARD, loss: LOSS_REWARD, rifle: WEAPONS.rifle.cost, smg: WEAPONS.smg.cost, armor: ARMOR_COST, frag: GRENADES.frag.cost, smoke: GRENADES.smoke.cost }),
  bots: () => bots.bots.map((bot) => ({ name: bot.name, team: bot.team, alive: bot.alive, frag: bot.grenades.frag, smoke: bot.grenades.smoke })),
  loadout: () => bots.utilityReport(),
  throwFrag: (botName, x, z) => {
    const bot = bots.bots.find((b) => b.name === botName);
    if (!bot) return false;
    return bots.forceThrowFrag(bot, { x, z }, { state, combat, agents, time: state.time, onBotHit });
  },
  throwSmoke: (botName, site) => {
    const bot = bots.bots.find((b) => b.name === botName);
    if (!bot) return false;
    return bots.forceThrowSmoke(bot, site, { state, combat, agents, time: state.time, onBotHit });
  },
  // The player's own throw, for the playtest: the same throw the G key makes, aimed
  // at a point instead of a direction, so a test can stage the player's smoke beside
  // the bots' without simulating input.
  throwPlayer: (kind, x, z) => {
    if (!player.alive || state.phase !== PHASE.LIVE) return false;
    if (player.grenades[kind] <= 0) return false;
    player.grenades[kind] -= 1;
    eyeOf(player, eyeVec);
    tmpVec.set(x, 1.0, z);
    const aim = tmpVec.sub(eyeVec).normalize();
    combat.throwGrenade(player, eyeVec, aim, kind);
    return true;
  },
};
if (test === 'utility') runUtilityTest();
else if (test === 'economy') runEconomyTest();
else if (test === 'smoke') runSmokeTest();
else if (shot) runShot(shot);
else requestAnimationFrame(frame);
