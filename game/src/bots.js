// Bots: the other nine agents on the map. Each bot is a small state machine — route, hold,
// engage, investigate, plant, defuse, retreat — driven by what it can see and hear, not by
// a script of the round. It walks the waypoint graph, holds an angle, bursts at what it
// sees, and investigates a gunshot it heard. One attacker carries the bomb; every defender
// converges on a planted site. Reaction time and aim error are per-bot, so no two bots
// feel the same. Since the post-opening revision the bots also carry grenades: a frag when
// they engage a visible enemy, a smoke when the planter executes a site or a defender
// covers a defuse — the same $300 grenades the buy menu sells the player, issued as a
// per-round loadout instead of a purchase, because a bot has no buy phase.
import * as THREE from 'three';
import { losBlocked, createAgentBody, setGrenadeCarry } from './agents.js';
import { WEAPONS } from './weapons.js';
import { findRoute, nearestWaypoint, SITES, SITE_SMOKE_AIM, WAYPOINTS } from './world.js';

const ATK_NAMES = ['Vex', 'Mara', 'Kip', 'Sol', 'Ash'];
const DEF_NAMES = ['Rook', 'Hale', 'Nyx', 'Dax', 'Ivo'];
const ATK_LANES = [
  { route: ['atkSpawn', 'aLong1', 'aLong2', 'aCorner', 'aSite'], site: 'A' },
  { route: ['atkSpawn', 'atkMid', 'midDoors', 'midTop', 'aMain', 'aSite'], site: 'A' },
  { route: ['atkSpawn', 'atkMid', 'midDoors', 'midTop', 'bMain', 'bSite'], site: 'B' },
  { route: ['atkSpawn', 'bTun1', 'bTun2', 'bCorner', 'bSite'], site: 'B' },
];
const DEF_POSTS = [
  { at: 'aHold', site: 'A' },
  { at: 'aSite', site: 'A' },
  { at: 'bHold', site: 'B' },
  { at: 'bSite', site: 'B' },
  { at: 'defMid', site: null },
];
const ATK_WEAPONS = ['rifle', 'rifle', 'smg', 'shotgun'];
const DEF_WEAPONS = ['rifle', 'sniper', 'rifle', 'smg', 'rifle'];
const VISION_RANGE = 55;
const HEAR_RANGE = 30;

// Bot utility loadout, re-issued every round in assignRoundRole. Each entry is one bot's
// grenade stock for the round, priced at the buy menu's $300 a piece: a full attacker
// loadout costs $1,200 of utility, a defender's $900, so a bot never throws more
// utility than the round's economy would let it buy. One frag per bot keeps throws rare
// enough to dodge; the planter alone also carries a smoke, because the execute is the
// one moment a cloud is worth more than a kill, and the mid defender carries one to
// cover a defuse. Stock never carries over between rounds.
const BOT_LOADOUT = {
  atk: [
    { frag: 1, smoke: 1 }, // the planter (first attacker) — a smoke for the execute
    { frag: 1, smoke: 0 },
    { frag: 1, smoke: 0 },
    { frag: 0, smoke: 0 },
  ],
  def: [
    { frag: 1, smoke: 0 },
    { frag: 1, smoke: 0 },
    { frag: 0, smoke: 0 },
    { frag: 0, smoke: 0 },
    { frag: 0, smoke: 1 }, // the mid defender — a smoke to cover a defuse
  ],
};
const GRENADE_COOLDOWN_SECONDS = 8; // after any throw, before the next one
const FRAG_THROW_MIN = 12; // closer than this the frag would catch its own thrower
const FRAG_THROW_MAX = 28; // past this the fuse burns out before it lands close

const tmpVec = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();

export function createBots(scene, world, mover, random) {
  const bots = [];

  function makeBot(team, index, x, z, yaw) {
    const names = team === 'atk' ? ATK_NAMES : DEF_NAMES;
    const weaponId = team === 'atk' ? ATK_WEAPONS[index % ATK_WEAPONS.length] : DEF_WEAPONS[index % DEF_WEAPONS.length];
    const bot = {
      id: `${team}-${index}`,
      name: names[index % names.length],
      team,
      isPlayer: false,
      position: new THREE.Vector3(x, 0, z),
      velocity: new THREE.Vector3(),
      yaw,
      pitch: 0,
      eye: 1.6,
      onGround: true,
      crouching: false,
      height: 1.72,
      health: 100,
      armor: 0,
      alive: true,
      fall: 0,
      kills: 0,
      weaponId,
      def: WEAPONS[weaponId],
      mag: WEAPONS[weaponId].mag,
      reserve: WEAPONS[weaponId].reserve,
      cooldown: 0,
      reloadLeft: 0,
      grenades: { frag: 0, smoke: 0 }, // per-round stock, issued by assignRoundRole
      // AI state
      ai: {
        mode: 'route',
        route: [],
        routeIndex: 0,
        destination: null,
        holdUntil: 0,
        target: null,
        lastSeen: null,
        reactionAt: 0,
        burstLeft: 0,
        burstPause: 0,
        strafeDir: 1,
        strafeUntil: 0,
        scanYaw: yaw,
        plantSite: null,
        isPlanter: false,
        grenadeReadyAt: 0, // match time before which this bot may not throw again
        throwWindupUntil: 0, // match time until which the bot stands still after a throw
        // How willing this bot is to spend a frag: 0.5 throws only at closer range,
        // 1.0 throws at the full 28 metres. Rolled once per bot, so bots differ.
        utilityBias: 0.5 + random() * 0.5,
        visionAt: random() * 0.12,
        hearChecked: 0,
      },
    };
    createAgentBody(scene, bot);
    return bot;
  }

  function spawnAll(state, spawnPoints) {
    bots.length = 0;
    spawnPoints.atk.forEach(([x, z], index) => {
      const bot = makeBot('atk', index, x, z, Math.PI);
      bots.push(bot);
    });
    spawnPoints.def.forEach(([x, z], index) => {
      const bot = makeBot('def', index, x, z, 0);
      bots.push(bot);
    });
    // The first attacker carries the bomb.
    bots.find((bot) => bot.team === 'atk').ai.isPlanter = true;
    for (const bot of bots) assignRoundRole(bot, state);
  }

  function assignRoundRole(bot, state) {
    const ai = bot.ai;
    ai.mode = 'route';
    ai.route = [];
    ai.routeIndex = 0;
    ai.target = null;
    ai.lastSeen = null;
    ai.burstLeft = 0;
    // A fresh round, a fresh loadout: the bot's grenade stock is re-issued from
    // BOT_LOADOUT and its throw cooldown is reset. Stock never carries over.
    const teamIndex = bots.filter((b) => b.team === bot.team).indexOf(bot);
    const loadout = BOT_LOADOUT[bot.team][teamIndex % BOT_LOADOUT[bot.team].length];
    bot.grenades = { frag: loadout.frag, smoke: loadout.smoke };
    ai.grenadeReadyAt = 0;
    ai.throwWindupUntil = 0;
    // The belt grenade shows the loadout: a bot that carries utility wears it where
    // the player can see it, and the mesh hides itself the moment the stock is spent.
    bot.grenadeCarry = loadout.frag + loadout.smoke;
    setGrenadeCarry(bot, bot.grenadeCarry);
    // Veterancy: as the match goes on the bots spend their utility more freely. A bot
    // in round 8 throws at up to 0.21 more range than the same bot in round 1, because
    // a team that has played seven rounds together trusts its grenades. The bias is
    // capped at 1.0, so the latest rounds are aggressive, never reckless.
    ai.utilityBias = Math.min(1, ai.utilityBias + (state.round - 1) * 0.03);
    if (bot.team === 'atk') {
      const lane = ATK_LANES[teamIndex % ATK_LANES.length];
      ai.route = lane.route.slice();
      ai.plantSite = lane.site;
      ai.destination = lane.site;
    } else {
      const post = DEF_POSTS[teamIndex % DEF_POSTS.length];
      ai.route = [post.at];
      ai.destination = post.at;
      ai.plantSite = post.site;
    }
  }

  // The nearest enemy this bot can actually see: in range, inside its field of view, with
  // no wall and no smoke between the eyes. Checked on a stagger, not every step.
  function seeEnemy(bot, agents, combat, time) {
    const ai = bot.ai;
    if (time < ai.visionAt) return ai.target;
    ai.visionAt = time + 0.12;
    tmpEye.set(bot.position.x, bot.position.y + bot.eye, bot.position.z);
    let best = null;
    let bestDistance = Infinity;
    const forwardX = -Math.sin(bot.yaw);
    const forwardZ = -Math.cos(bot.yaw);
    for (const other of agents) {
      if (other.team === bot.team || !other.alive || other === bot) continue;
      tmpTarget.set(other.position.x, other.position.y + 1.1, other.position.z);
      const dx = tmpTarget.x - tmpEye.x;
      const dy = tmpTarget.y - tmpEye.y;
      const dz = tmpTarget.z - tmpEye.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > VISION_RANGE || distance >= bestDistance) continue;
      const dot = (dx * forwardX + dz * forwardZ) / Math.max(0.001, distance);
      if (dot < 0.35) continue; // outside ~140 degrees of view
      if (losBlocked(tmpEye, tmpTarget, world.colliders)) continue;
      if (combat.smokeBlocks(tmpEye, tmpTarget)) continue;
      best = other;
      bestDistance = distance;
    }
    if (best) {
      if (ai.target !== best) ai.reactionAt = time + 0.28 + random() * 0.22;
      ai.target = best;
      ai.lastSeen = { x: best.position.x, z: best.position.z, time };
    } else if (ai.target && time - (ai.lastSeen ? ai.lastSeen.time : 0) > 1.2) {
      ai.target = null;
    }
    return ai.target;
  }

  function hearShots(bot, state, time) {
    if (time - bot.ai.hearChecked < 0.5) return;
    bot.ai.hearChecked = time;
    for (const event of state.events) {
      if (event.kind !== 'shot' && event.kind !== 'explosion' && event.kind !== 'throw') continue;
      // A bot never investigates its own throw: the pin it just pulled is not news.
      if (event.kind === 'throw' && event.owner === bot) continue;
      const distance = Math.hypot(event.x - bot.position.x, event.z - bot.position.z);
      // Each sound carries its own radius — a shot carries 30 metres, a pin pull 18 —
      // instead of every sound being heard at the same distance.
      const radius = event.radius ?? HEAR_RANGE;
      if (distance > radius) continue;
      if (bot.ai.target) continue;
      bot.ai.mode = 'investigate';
      bot.ai.lastSeen = { x: event.x, z: event.z, time };
      const from = nearestWaypoint(bot.position.x, bot.position.z);
      const to = nearestWaypoint(event.x, event.z);
      bot.ai.route = findRoute(from, to);
      bot.ai.routeIndex = 0;
    }
  }

  function aimError(bot, target, distance) {
    const targetSpeed = Math.hypot(target.velocity.x, target.velocity.z);
    const ownSpeed = Math.hypot(bot.velocity.x, bot.velocity.z);
    return 0.012 + distance * 0.0009 + targetSpeed * 0.004 + ownSpeed * 0.006;
  }

  // Grenade throws. A bot thinks in points — where the enemy is standing, where the
  // site mouth is — so both helpers hand a point to combat.throwGrenadeAt, which solves
  // the ballistic arc. Every throw is gated the same way: stock, cooldown, range.
  // The release point is chest height, so the grenade leaves the hand instead of the
  // bot's own hitbox; tmpEye is reused because launchGrenade clones it on the way in.
  function throwOrigin(bot) {
    tmpEye.set(bot.position.x, bot.position.y + 1.5, bot.position.z);
    return tmpEye;
  }

  // A frag at a point: the enemy's position while engaging, or the site centre while
  // retaking. The guards are the whole economy — a bot with no stock or a live
  // cooldown simply does not throw, and the range window keeps the blast off the
  // thrower. The aim carries a 1-3 metre error in a random direction: a frag is a
  // threat, not a hitscan kill, and the 3-second fuse is the target's chance to move
  // out of the blast. `force` skips the range window for a scripted shot or a test —
  // the stock and cooldown still apply, so a forced throw never cheats the economy.
  function tryThrowFrag(bot, ctx, point, distance, time, force = false) {
    const ai = bot.ai;
    if (bot.grenades.frag <= 0) return false; // the round's loadout is spent
    if (time < ai.grenadeReadyAt) return false; // still on the 8-second cooldown
    // A cautious bot only throws at closer range; an aggressive one throws at the
    // full 28 metres. Either way the throw stays outside the frag's own 7-metre
    // radius, so the bot never catches its own explosion.
    const maxRange = FRAG_THROW_MIN + (FRAG_THROW_MAX - FRAG_THROW_MIN) * ai.utilityBias;
    if (!force && (distance < FRAG_THROW_MIN || distance > maxRange)) return false;
    const angle = random() * Math.PI * 2;
    const error = 1 + random() * 2;
    tmpTarget.set(point.x + Math.cos(angle) * error, 1.0, point.z + Math.sin(angle) * error);
    bot.grenades.frag -= 1;
    ai.grenadeReadyAt = time + GRENADE_COOLDOWN_SECONDS;
    ai.throwWindupUntil = time + 0.35; // the telegraph: the bot stands still, arm down
    ctx.combat.throwGrenadeAt(bot, throwOrigin(bot), tmpTarget, 'frag');
    return true;
  }

  // A smoke at a site's mouth: the planter's execute, or a defender covering a defuse.
  // The cloud lands between the site and the approach lane, so a rotating enemy has
  // to push through it to stop the play.
  function tryThrowSmoke(bot, ctx, siteLetter, time) {
    const ai = bot.ai;
    if (bot.grenades.smoke <= 0) return false;
    if (time < ai.grenadeReadyAt) return false;
    const aim = SITE_SMOKE_AIM[siteLetter];
    if (!aim) return false;
    tmpTarget.set(aim.x, 0.5, aim.z);
    bot.grenades.smoke -= 1;
    ai.grenadeReadyAt = time + GRENADE_COOLDOWN_SECONDS;
    ai.throwWindupUntil = time + 0.35; // the telegraph: the bot stands still, arm down
    ctx.combat.throwGrenadeAt(bot, throwOrigin(bot), tmpTarget, 'smoke');
    return true;
  }

  function stepBot(bot, dt, ctx) {
    const { state, combat, agents, time } = ctx;
    const ai = bot.ai;
    if (!bot.alive) return;

    bot.cooldown = Math.max(0, bot.cooldown - dt);
    if (bot.reloadLeft > 0) {
      bot.reloadLeft = Math.max(0, bot.reloadLeft - dt);
      if (bot.reloadLeft === 0) {
        const need = bot.def.mag - bot.mag;
        const take = Math.min(need, bot.reserve);
        bot.mag += take;
        bot.reserve -= take;
      }
    }

    // A throw has a wind-up: for a third of a second after releasing a grenade the bot
    // stands still, arm coming down. That is the telegraph that tells the player a
    // frag is in the air — no shooting, no moving, just a bot that has committed to
    // the throw. The bomb duties below still set the mode, so a defusing bot is not
    // pulled off the bomb by its own wind-up.
    if (time < ai.throwWindupUntil) {
      mover.step(bot, dt, 0, 0, false, false);
      return;
    }

    // The belt grenade follows the stock: it shows while the bot carries any grenade
    // and disappears when the stock is spent, so the player can read a bot's utility
    // off the bot itself. The check is one integer compare per tick.
    const carry = bot.grenades.frag + bot.grenades.smoke;
    if (carry !== bot.grenadeCarry) {
      bot.grenadeCarry = carry;
      setGrenadeCarry(bot, carry);
    }

    // Bomb duties outrank everything else.
    if (state.bomb.state === 'planted' && bot.team === 'def') {
      const site = SITES[state.bomb.site];
      const distance = Math.hypot(site.x - bot.position.x, site.z - bot.position.z);
      if (distance < 1.6) {
        // Arrived on the bomb: cover the defuse with smoke, if this bot carries one.
        // The cloud lands at the site mouth, between the defuser and anyone rotating in.
        if (ai.mode !== 'defuse') tryThrowSmoke(bot, ctx, state.bomb.site, time);
        ai.mode = 'defuse';
      } else if (ai.mode !== 'defuse') {
        ai.mode = 'route';
        const from = nearestWaypoint(bot.position.x, bot.position.z);
        ai.route = findRoute(from, state.bomb.site === 'A' ? 'aSite' : 'bSite');
        ai.routeIndex = 0;
        // Retaking: a defender closing on the planted site throws a frag at the site
        // before pushing in, to clear anyone holding the plant. Stock and cooldown
        // inside tryThrowFrag make this a one-off per bot, not a barrage.
        tryThrowFrag(bot, ctx, site, distance, time);
      }
    }

    const target = seeEnemy(bot, agents, combat, time);
    hearShots(bot, state, time);

    let wishX = 0;
    let wishZ = 0;
    let crouch = false;

    if (ai.mode === 'defuse' && state.bomb.state === 'planted') {
      // Stand on the bomb and hold still; main.js advances the defuse progress.
      wishX = 0;
      wishZ = 0;
    } else if (target && time >= ai.reactionAt) {
      ai.mode = 'engage';
      tmpTarget.set(target.position.x, target.position.y + 1.1, target.position.z);
      const dx = tmpTarget.x - bot.position.x;
      const dz = tmpTarget.z - bot.position.z;
      const distance = Math.hypot(dx, dz) || 1;
      bot.yaw = Math.atan2(-dx, -dz);
      // Strafe across the target's line of fire, flipping direction on a timer.
      if (time >= ai.strafeUntil) {
        ai.strafeDir = random() < 0.5 ? -1 : 1;
        ai.strafeUntil = time + 0.8 + random() * 0.7;
      }
      const side = distance > 14 ? 0.7 : 0.35;
      wishX = (-dz / distance) * ai.strafeDir * side;
      wishZ = (dx / distance) * ai.strafeDir * side;
      if (distance > 26) {
        wishX += (dx / distance) * 0.5;
        wishZ += (dz / distance) * 0.5;
      }
      // A frag on the engage: the bot throws at the enemy it can see, if it has one
      // left and the range is right. The throw happens once per cooldown, never
      // instead of shooting — the burst below still fires.
      tryThrowFrag(bot, ctx, target.position, distance, time);
      // Burst fire: three to five rounds, then a pause to re-aim.
      if (ai.burstPause > 0) {
        ai.burstPause -= dt;
      } else if (ai.burstLeft <= 0) {
        ai.burstLeft = 3 + Math.floor(random() * 3);
        ai.burstPause = 0.35 + random() * 0.35;
      } else if (bot.cooldown === 0 && bot.reloadLeft === 0) {
        if (bot.mag === 0) {
          bot.reloadLeft = bot.def.reload;
        } else {
          bot.mag -= 1;
          ai.burstLeft -= 1;
          bot.cooldown = bot.def.fireGap;
          tmpEye.set(bot.position.x, bot.position.y + bot.eye, bot.position.z);
          tmpTarget.set(target.position.x, target.position.y + 1.1, target.position.z);
          const aim = tmpTarget.sub(tmpEye).normalize();
          const error = aimError(bot, target, distance);
          const result = combat.shoot(bot, tmpEye, aim, error, bot.def, agents, world.shootables);
          if (result.hit && result.agent) {
            ctx.onBotHit(bot, result);
          }
          state.events.push({ kind: 'shot', x: bot.position.x, z: bot.position.z, radius: HEAR_RANGE });
        }
      }
    } else if (ai.mode === 'route' || ai.mode === 'investigate') {
      const nodeName = ai.route[ai.routeIndex];
      if (!nodeName) {
        // Arrived: hold this spot and scan, or plant if this bot carries the bomb.
        if (bot.team === 'atk' && ai.isPlanter && state.bomb.state === 'idle' && ai.destination) {
          const site = SITES[ai.destination];
          const distance = Math.hypot(site.x - bot.position.x, site.z - bot.position.z);
          const defendersNear = agents.some(
            (other) => other.team === 'def' && other.alive && Math.hypot(other.position.x - bot.position.x, other.position.z - bot.position.z) < 15,
          );
          if (distance < site.half && !defendersNear) {
            // The execute: cover the site mouth with smoke before the 3.5-second plant
            // starts, so a rotating defender has to push through a cloud to stop it.
            tryThrowSmoke(bot, ctx, ai.destination, time);
            ai.mode = 'plant';
          } else {
            ai.mode = 'hold';
            ai.holdUntil = time + 2 + random() * 2;
          }
        } else {
          // Arrived on a sound: if this bot came here to investigate a shot it heard,
          // clear the corner with a frag before holding. A frag at a sound is the
          // bot's way of checking a corner it cannot see around, and the 3-second fuse
          // is the warning for anything hiding there.
          if (ai.mode === 'investigate' && ai.lastSeen) {
            const seenDistance = Math.hypot(ai.lastSeen.x - bot.position.x, ai.lastSeen.z - bot.position.z);
            tryThrowFrag(bot, ctx, ai.lastSeen, seenDistance, time);
          }
          ai.mode = 'hold';
          ai.holdUntil = time + 1.5 + random() * 2.5;
        }
      } else {
        const node = { x: 0, z: 0 };
        const waypoint = findWaypoint(nodeName);
        node.x = waypoint.x;
        node.z = waypoint.z;
        const dx = node.x - bot.position.x;
        const dz = node.z - bot.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.7) {
          ai.routeIndex += 1;
        } else {
          wishX = dx / distance;
          wishZ = dz / distance;
          bot.yaw = Math.atan2(-dx, -dz);
        }
      }
    } else if (ai.mode === 'plant') {
      // Stand in the site and hold still; main.js advances the plant progress.
      wishX = 0;
      wishZ = 0;
    } else if (ai.mode === 'hold') {
      crouch = true;
      bot.yaw += Math.sin(time * 0.5 + bot.id.length) * 0.0015;
      if (time >= ai.holdUntil) {
        ai.mode = 'route';
        ai.route = [];
        ai.routeIndex = 0;
      }
    } else if (ai.mode === 'retreat') {
      // After the plant, fall back to a hold off the site.
      const node = findWaypoint(ai.destination === 'A' ? 'aMain' : 'bMain');
      const dx = node.x - bot.position.x;
      const dz = node.z - bot.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.7) {
        ai.mode = 'hold';
        ai.holdUntil = time + 999;
      } else {
        wishX = dx / distance;
        wishZ = dz / distance;
        bot.yaw = Math.atan2(-dx, -dz);
      }
    }

    const length = Math.hypot(wishX, wishZ);
    if (length > 1) {
      wishX /= length;
      wishZ /= length;
    }
    mover.step(bot, dt, wishX, wishZ, false, crouch);
  }

  function findWaypoint(name) {
    // Waypoints are imported as a plain map; this lookup keeps the route code readable.
    return WAYPOINTS[name];
  }

  function stepAll(dt, ctx) {
    for (const bot of bots) stepBot(bot, dt, ctx);
  }

  // Forced throws, for a scripted shot or a test: the same stock and cooldown guards
  // as the AI, but the range window is skipped — a shot stages the throw, it does not
  // cheat the economy. The point is where the frag should land, the site is where
  // the smoke should bloom.
  function forceThrowFrag(bot, point, ctx) {
    const distance = Math.hypot(point.x - bot.position.x, point.z - bot.position.z);
    return tryThrowFrag(bot, ctx, point, distance, ctx.time, true);
  }

  function forceThrowSmoke(bot, siteLetter, ctx) {
    return tryThrowSmoke(bot, ctx, siteLetter, ctx.time);
  }

  // The bots' utility loadout for the buy menu hint: what the enemy carries this round.
  // The counts are the live stocks, so a bot that has already thrown its frag no longer
  // counts toward the total — the hint is the truth, not the plan.
  function utilityReport() {
    let frags = 0;
    let smokes = 0;
    for (const bot of bots) {
      frags += bot.grenades.frag;
      smokes += bot.grenades.smoke;
    }
    return `Bots carry ${frags} frag${frags === 1 ? '' : 's'} · ${smokes} smoke${smokes === 1 ? '' : 's'} this round.`;
  }

  // The loadout by team, for the buy menu hint: what each side carries this round,
  // from the live stocks, so a bot that has already thrown no longer counts.
  function utilityReportByTeam() {
    const count = (team, kind) => bots.filter((bot) => bot.team === team).reduce((sum, bot) => sum + bot.grenades[kind], 0);
    return `ATK ${count('atk', 'frag')} frag ${count('atk', 'smoke')} smoke · DEF ${count('def', 'frag')} frag ${count('def', 'smoke')} smoke`;
  }

  // The grenade rules, for the economy self-check: the throw window and the cooldown
  // the AI enforces, so the running game can verify them beside the prices.
  function grenadeRules() {
    return { throwMin: FRAG_THROW_MIN, throwMax: FRAG_THROW_MAX, cooldown: GRENADE_COOLDOWN_SECONDS };
  }

  function resetRound(state, spawnPoints) {
    bots.length = 0;
    spawnAll(state, spawnPoints);
  }

  return { bots, spawnAll, stepAll, resetRound, utilityReport, utilityReportByTeam, grenadeRules, forceThrowFrag, forceThrowSmoke };
}
