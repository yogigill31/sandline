// Weapons: one table, no special cases. Each entry is a buy-menu line and a gun at once:
// damage falls off with range, headshots multiply, spread grows with movement and with
// sustained fire, and recoil kicks the aim up. The buy menu reads this same table, so a
// price in the menu is always the price the game charges.
//
// Post-opening rebalance (2026-11-17): the bots now throw grenades, so every price is
// judged against the $300 a grenade costs and the $3,400 a round win pays. The rule is
// simple — a round's payout should fund a complete loadout with no dead money left
// over, and no weapon should be a strict downgrade of another at its price.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  // P9 Sidearm — free, and the only gun that stays free. 34 damage with a 4x head
  // multiplier means two headshots kill an unarmoured enemy, so a broke round is never
  // a hopeless round. Unchanged: a free gun is the floor the whole economy stands on.
  pistol: {
    name: 'P9 Sidearm', cost: 0, damage: 34, headMult: 4, range: 45, falloff: 0.45,
    fireGap: 0.16, auto: false, mag: 12, reserve: 36, reload: 1.4,
    spreadStill: 0.003, spreadMove: 0.02, recoil: 0.008, kick: 0.03, tracer: PALETTE.ink,
  },
  // VK-9 SMG — $1,300, was $1,500, damage 28, was 26. At $1,500 it was never worth it:
  // saving $200 more bought nothing, and a rifle at $2,700 was always the better goal.
  // At $1,300 it is exactly what a loss round pays for after a vest ($2,000 - $600),
  // and the damage bump keeps its time-to-kill honest at close range, where its 38 m
  // range and fast fire rate are the point. The close-quarters answer to the rifle.
  smg: {
    name: 'VK-9 SMG', cost: 1300, damage: 28, headMult: 4, range: 38, falloff: 0.5,
    fireGap: 0.08, auto: true, mag: 32, reserve: 96, reload: 2.0,
    spreadStill: 0.006, spreadMove: 0.03, recoil: 0.006, kick: 0.02, tracer: PALETTE.accent,
  },
  // M12 Breacher — $1,100, unchanged. Eight pellets at 13 damage each make it the
  // site-clearing gun: one shot at point blank is 104 damage before falloff, which is
  // why its range stops at 18 m. It stays cheaper than the SMG because it is a one-job
  // gun — past a doorway it is a liability, and the price says so.
  shotgun: {
    name: 'M12 Breacher', cost: 1100, damage: 13, headMult: 2, range: 18, falloff: 0.7,
    fireGap: 0.85, auto: false, mag: 6, reserve: 24, reload: 2.6, pellets: 8,
    spreadStill: 0.02, spreadMove: 0.035, recoil: 0.03, kick: 0.09, tracer: PALETTE.accent,
  },
  // AR-77 Rifle — $2,700, unchanged. The default gun: 33 damage, 70 m range, a 30-round
  // magazine, and the only rifle that stays accurate on the move. A round win ($3,400)
  // funds a rifle and a vest with $100 spare, which is the economy's anchor — every
  // other price is measured against this one. Changing it would move every loadout.
  rifle: {
    name: 'AR-77 Rifle', cost: 2700, damage: 33, headMult: 4, range: 70, falloff: 0.35,
    fireGap: 0.096, auto: true, mag: 30, reserve: 90, reload: 1.9,
    spreadStill: 0.0022, spreadMove: 0.028, recoil: 0.009, kick: 0.055, tracer: PALETTE.accent,
  },
  // LR-90 Longshot — $4,500, was $4,750. One shot at 115 damage kills an unarmoured
  // enemy outright and leaves an armoured one at 35, but its 1.15-second fire gap and
  // its 0.09 moving spread mean it only works from a hold. Bots now smoke site mouths
  // and throw frags at holds, which is exactly the long sightline this gun lives on —
  // the $250 cut keeps it buyable after two won rounds instead of three, so the
  // sniper stays a real choice instead of a luxury that never appears.
  sniper: {
    name: 'LR-90 Longshot', cost: 4500, damage: 115, headMult: 2, range: 120, falloff: 0.1,
    fireGap: 1.15, auto: false, mag: 5, reserve: 15, reload: 2.8, scoped: true,
    spreadStill: 0.0004, spreadMove: 0.09, recoil: 0.05, kick: 0.14, tracer: PALETTE.ink,
  },
};

// Grenades: $300 a piece, for the player and for the bots alike — the bot loadout in
// bots.js is priced out of this same table, so a bot never throws utility the round's
// economy could not pay for.
export const GRENADES = {
  // Frag: 120 damage across a 7-metre radius, falling off with distance and halved
  // through a wall, on a 3-second fuse. The fuse is the counterplay: a frag you hear
  // coming is a frag you can walk out of. Unchanged — the bots throw the same frag
  // the player has always thrown, at the same price.
  frag: { name: 'Frag Grenade', cost: 300, fuse: 3, radius: 7, damage: 120 },
  // Smoke: radius 5.0 metres, was 4.5. A site is 3.5 metres from centre to edge, so
  // a 4.5-metre cloud left its corners visible from the approach lane — a smoke that
  // does not cover the whole mouth is a smoke that does not work. At 5.0 metres the
  // cloud covers the site and the lane into it, which is what the planter is paying
  // for. Duration 12 seconds, unchanged: long enough to plant, short enough to end.
  smoke: { name: 'Smoke Grenade', cost: 300, fuse: 1.2, radius: 5.0, duration: 12 },
};

// Armour: $600, was $650. A frag's splash makes armour a real choice instead of a
// luxury — 120 damage at the centre of the blast is a kill without it, a survivable
// hit with it — and at $600 a vest plus a frag is $900, affordable on a loss round
// with a saved rifle. The $50 cut is the difference between armour being a decision
// and armour being a default.
export const ARMOR_COST = 600;
export const BUY_ORDER = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

// One gun instance: a view model on the camera, a magazine, and the bloom that grows as
// you hold the trigger. The shooter owns the ray; this module owns the numbers.
export function createGun(camera, weaponId) {
  const def = WEAPONS[weaponId];
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.2 });

  const model = new THREE.Group();
  const long = weaponId === 'sniper' ? 0.72 : weaponId === 'shotgun' ? 0.55 : 0.42;
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, long), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, long * 0.9), grip);
  barrel.position.set(0, 0.025, -long * 0.85);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
  stock.position.set(0, -0.02, long * 0.55);
  model.add(receiver, barrel, stock);
  if (weaponId === 'sniper') {
    const scope = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.2), accent);
    scope.position.set(0, 0.09, -0.1);
    model.add(scope);
  }
  if (weaponId === 'shotgun') {
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.2), accent);
    pump.position.set(0, -0.03, -0.3);
    model.add(pump);
  }
  model.position.set(0.24, -0.2, -0.42);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  const state = {
    id: weaponId, mag: def.mag, reserve: def.reserve,
    cooldown: 0, reloadLeft: 0, flash: 0, kick: 0, bloom: 0, throwT: 0,
  };

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.bloom = Math.max(0, state.bloom - dt * 0.09);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    state.throwT = Math.max(0, state.throwT - dt);
    // The throw lunges the view model forward and dips it, so a grenade leaving the
    // hand reads as a throw instead of the gun simply vanishing for a frame.
    model.position.z = -0.42 + state.kick - state.throwT * 0.25;
    model.rotation.x = state.kick * 2.2 - state.throwT * 0.5;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (def.reload - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = def.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    def,
    step,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = def.fireGap;
      state.flash = 0.06;
      state.kick = def.kick;
      state.bloom = Math.min(0.05, state.bloom + def.recoil * 0.6);
    },
    // The throw animation: a 0.35-second lunge of the view model, fired when a
    // grenade leaves the hand. It is the only visible part of the player's throw.
    throwKick() {
      state.throwT = 0.35;
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag === def.mag || state.reserve === 0) return;
      state.reloadLeft = def.reload;
    },
    spread(speed) {
      const moving = Math.min(1, speed / 5.2);
      return def.spreadStill + moving * def.spreadMove + state.bloom;
    },
    refill() {
      state.mag = def.mag;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
    },
    dispose() {
      camera.remove(model, flash, flashLight);
    },
  };
}
