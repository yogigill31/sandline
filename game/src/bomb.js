// The bomb: the objective that makes the map more than a shooting gallery. An attacker
// holds E inside a site for 3.5 seconds to plant; the bomb then beeps for 35 seconds, and
// a defender holding E on it for 5 seconds defuses it. Planting pays $300. The bomb is a
// small amber box with a blinking light, so a planted site reads from across the map.
// Since the revision, a smoke cloud over the site changes the objective itself: the
// plant runs a fifth faster under cover, and the defuse a sixth slower, because the
// wires are harder to see — smoke is worth throwing for the objective, not just for
// the sightlines.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { PLANT_SECONDS, DEFUSE_SECONDS, BOMB_SECONDS, PLANT_REWARD } from './state.js';
import { SITES } from './world.js';

export function createBomb(scene) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.22, 0.3),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.4, metalness: 0.4 }),
  );
  body.castShadow = true;
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.foe) }),
  );
  light.position.set(0, 0.15, 0);
  group.add(body, light);
  group.visible = false;
  scene.add(group);

  let beepAt = 0;

  function inSite(agent, siteName) {
    const site = SITES[siteName];
    return (
      Math.abs(agent.position.x - site.x) <= site.half &&
      Math.abs(agent.position.z - site.z) <= site.half
    );
  }

  // Smoke over the objective changes the objective: a cloud over the site hides the
  // planter, so the plant runs a fifth faster, and hides the wires, so the defuse
  // runs a sixth slower. The numbers are small on purpose — smoke should reward the
  // play, not decide the round by itself — and they only apply while a cloud actually
  // covers the site centre, not while one merely drifts past it.
  function smokeOverSite(smokes, siteName) {
    if (!smokes || !siteName) return false;
    const site = SITES[siteName];
    for (const smoke of smokes) {
      if (Math.hypot(smoke.position.x - site.x, smoke.position.z - site.z) < smoke.radius) return true;
    }
    return false;
  }

  // Advance the bomb by one fixed step. `planter` is the agent holding E in a site (or
  // null), `defuser` the agent holding E on a planted bomb (or null), `smokes` the live
  // smoke clouds from combat (or null). Returns 'planted', 'defused', 'exploded' or
  // null when the state changed this step.
  function step(dt, state, planter, defuser, onBeep, smokes) {
    const bomb = state.bomb;
    if (bomb.state === 'idle') {
      if (planter && (inSite(planter, 'A') || inSite(planter, 'B'))) {
        bomb.state = 'planting';
        bomb.site = inSite(planter, 'A') ? 'A' : 'B';
        bomb.carrier = planter;
        bomb.progress = 0;
      }
      return null;
    }
    if (bomb.state === 'planting') {
      const carrier = bomb.carrier;
      if (!carrier || !carrier.alive || !planter || planter !== carrier || !inSite(carrier, bomb.site)) {
        bomb.state = 'idle';
        bomb.site = null;
        bomb.carrier = null;
        bomb.progress = 0;
        return null;
      }
      bomb.progress += (dt / PLANT_SECONDS) * (smokeOverSite(smokes, bomb.site) ? 1.2 : 1);
      if (bomb.progress >= 1) {
        bomb.state = 'planted';
        bomb.fuse = BOMB_SECONDS;
        bomb.position = { x: carrier.position.x, z: carrier.position.z };
        bomb.progress = 0;
        group.position.set(carrier.position.x, 0.12, carrier.position.z);
        group.visible = true;
        beepAt = 0;
        if (carrier.isPlayer) state.money += PLANT_REWARD;
        return 'planted';
      }
      return null;
    }
    if (bomb.state === 'planted') {
      bomb.fuse -= dt;
      beepAt -= dt;
      if (beepAt <= 0) {
        onBeep();
        // The beeps quicken as the fuse runs down: from one a second to four a second.
        beepAt = 0.25 + (bomb.fuse / BOMB_SECONDS) * 0.75;
      }
      light.material.color.setHex(Math.floor(state.time * 4) % 2 === 0 ? 0xe5484d : 0xf0a830);
      if (defuser) {
        bomb.state = 'defusing';
        bomb.carrier = defuser;
        bomb.progress = 0;
      } else if (bomb.fuse <= 0) {
        bomb.state = 'exploded';
        group.visible = false;
        return 'exploded';
      }
      return null;
    }
    if (bomb.state === 'defusing') {
      const carrier = bomb.carrier;
      const near = carrier && carrier.alive && defuser === carrier &&
        Math.hypot(carrier.position.x - bomb.position.x, carrier.position.z - bomb.position.z) < 1.8;
      if (!near) {
        bomb.state = 'planted';
        bomb.carrier = null;
        bomb.progress = 0;
        return null;
      }
      bomb.progress += (dt / DEFUSE_SECONDS) * (smokeOverSite(smokes, bomb.site) ? 0.85 : 1);
      if (bomb.progress >= 1) {
        bomb.state = 'defused';
        group.visible = false;
        return 'defused';
      }
      return null;
    }
    return null;
  }

  function reset() {
    group.visible = false;
  }

  return { step, reset, group };
}
