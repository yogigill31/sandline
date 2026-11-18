// Combat: the ray, the damage and the grenades. One raycaster is reused for every shot,
// tracers and impact flashes come from fixed pools (nothing is allocated in a firefight),
// and a grenade is a point with a velocity that bounces off the world's boxes until its
// fuse runs out. Smoke blocks a bot's sight, never a bullet. Since the post-opening
// revision a grenade in flight also has a visible mesh — before it, a thrown grenade was
// invisible until it exploded, which was tolerable when only the player threw one, but
// not once bots throw frags at the player. Bots aim at a point, not a direction, so
// throwGrenadeAt solves the ballistic arc to that point instead of guessing.
import * as THREE from 'three';
import { losBlocked } from './agents.js';
import { GRENADES } from './weapons.js';
import { PALETTE } from './palette.js';
import { recordUtility, recordFragDamage, pushFeed } from './state.js';

const TRACER_POOL = 24;
const FLASH_POOL = 12;
const GRENADE_POOL = 8; // in-flight grenade meshes; a throw past the pool still flies
const GRAVITY = 20;

export function createCombat(scene, world, state, random) {
  const raycaster = new THREE.Raycaster();
  const direction = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const point = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  // Tracer pool: thin lines from muzzle to impact, faded out over 70 ms.
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0 }));
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerIndex = 0;

  // Impact flashes: small spheres that pop and fade at the hit point.
  const flashes = [];
  for (let i = 0; i < FLASH_POOL; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0, depthWrite: false }),
    );
    scene.add(mesh);
    flashes.push({ mesh, life: 0 });
  }
  let flashIndex = 0;

  const grenades = [];
  const smokes = [];
  let liveAgents = [];

  // Smoke visuals: three soft grey spheres per cloud, faded in over a second and out
  // as the cloud expires, so a thrown smoke reads at a glance.
  // Grenade mesh pool: a small dark sphere per grenade in flight, so a throw is visible
  // while it arcs. The pool is fixed; a throw that finds no free mesh still flies and
  // explodes, it is only unrendered for the half second it is in the air.
  const grenadeMeshes = [];
  for (let i = 0; i < GRENADE_POOL; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#2a2e38', transparent: true, opacity: 0 }),
    );
    scene.add(mesh);
    grenadeMeshes.push({ mesh, grenade: null });
  }

  const smokeMeshes = new Map();

  // The arc preview: while the player cooks a grenade, a ring marks where it will land
  // and a line traces the arc. The simulation is the throw itself — the same speed,
  // lob and gravity as throwGrenade — stepped in 50 ms slices until the point hits
  // the ground or 48 steps pass. It ignores walls: a container in the way will bounce
  // the grenade past the ring, and the ring is an estimate, not a promise. The preview
  // is a cooking aid, not a cheat — it only shows while G is held, and only for the
  // player's own throw. The two temp vectors are module-level, so the preview
  // allocates nothing while it runs.
  const ARC_POINTS = 48;
  const arcVelocity = new THREE.Vector3();
  const arcPoint = new THREE.Vector3();
  const arcLob = new THREE.Vector3(0, 4.5, 0); // the upward lob, shared with throwGrenade
  const arcRing = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 24),
    new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  );
  arcRing.rotation.x = -Math.PI / 2;
  arcRing.visible = false;
  scene.add(arcRing);
  const arcGeometry = new THREE.BufferGeometry();
  arcGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_POINTS * 3), 3));
  const arcLine = new THREE.Line(arcGeometry, new THREE.LineBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0.6 }));
  arcLine.frustumCulled = false;
  arcLine.visible = false;
  scene.add(arcLine);

  function updateArcPreview(from, aim) {
    arcVelocity.copy(aim).multiplyScalar(13).add(arcLob);
    arcPoint.copy(from);
    const positions = arcGeometry.attributes.position.array;
    let count = 0;
    for (let i = 0; i < ARC_POINTS; i += 1) {
      positions[i * 3] = arcPoint.x;
      positions[i * 3 + 1] = arcPoint.y;
      positions[i * 3 + 2] = arcPoint.z;
      count += 1;
      arcVelocity.y -= GRAVITY * 0.05;
      arcPoint.addScaledVector(arcVelocity, 0.05);
      if (arcPoint.y < 0.1) break;
    }
    arcGeometry.setDrawRange(0, count);
    arcGeometry.attributes.position.needsUpdate = true;
    arcRing.position.set(arcPoint.x, 0.06, arcPoint.z);
    arcRing.visible = true;
    arcLine.visible = true;
  }

  function hideArcPreview() {
    arcRing.visible = false;
    arcLine.visible = false;
  }
  const smokeMaterial = () => new THREE.MeshBasicMaterial({ color: new THREE.Color('#b9bec6'), transparent: true, opacity: 0.55, depthWrite: false });
  function smokeVisual(smoke) {
    const group = new THREE.Group();
    for (const [x, y, z, scale] of [[0, 1.2, 0, 1], [-1.4, 0.9, 0.6, 0.8], [1.2, 1.0, -0.7, 0.75]]) {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(smoke.radius * scale, 12, 10), smokeMaterial());
      sphere.position.set(x, y, z);
      group.add(sphere);
    }
    group.position.copy(smoke.position);
    scene.add(group);
    smokeMeshes.set(smoke, group);
    return group;
  }
  const explosionMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0, depthWrite: false }),
  );
  scene.add(explosionMesh);
  let explosionLife = 0;

  function spawnTracer(from, to, color) {
    const tracer = tracers[tracerIndex];
    tracerIndex = (tracerIndex + 1) % TRACER_POOL;
    const positions = tracer.line.geometry.attributes.position.array;
    positions[0] = from.x;
    positions[1] = from.y;
    positions[2] = from.z;
    positions[3] = to.x;
    positions[4] = to.y;
    positions[5] = to.z;
    tracer.line.geometry.attributes.position.needsUpdate = true;
    tracer.line.material.color.set(color);
    tracer.line.material.opacity = 0.85;
    tracer.life = 0.07;
  }

  function spawnFlash(at) {
    const flash = flashes[flashIndex];
    flashIndex = (flashIndex + 1) % FLASH_POOL;
    flash.mesh.position.copy(at);
    flash.mesh.material.opacity = 0.9;
    flash.mesh.scale.setScalar(1);
    flash.life = 0.18;
  }

  // Damage through armour: armour eats half of each hit until it is gone.
  function applyDamage(victim, amount, attacker) {
    if (!victim.alive) return false;
    let rest = amount;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, rest * 0.5);
      victim.armor -= absorbed;
      rest -= absorbed;
    }
    victim.health -= rest;
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      victim.fall = 0;
      if (attacker && attacker !== victim) attacker.kills = (attacker.kills || 0) + 1;
      return true;
    }
    return false;
  }

  // One bullet (or one pellet). `from` is the muzzle, `aim` the direction before spread,
  // `spread` the cone, `def` the weapon row, `shooter` the agent firing, `targets` the
  // agents that can be hit, `walls` the meshes a bullet stops on. Returns the hit, if any.
  function shoot(shooter, from, aim, spread, def, targets, walls) {
    direction.copy(aim);
    direction.x += (random() * 2 - 1) * spread;
    direction.y += (random() * 2 - 1) * spread;
    direction.z += (random() * 2 - 1) * spread;
    direction.normalize();
    origin.copy(from);
    scene.updateMatrixWorld(true);
    raycaster.set(origin, direction);
    raycaster.far = def.range;
    const hitMeshes = [];
    for (const agent of targets) if (agent.alive) hitMeshes.push(...agent.hitMeshes);
    const hits = raycaster.intersectObjects(walls.concat(hitMeshes), false);
    const hit = hits[0];
    const end = hit ? hit.point : tmp.copy(origin).addScaledVector(direction, def.range);
    spawnTracer(from, end, def.tracer);
    if (!hit) return { hit: false };
    spawnFlash(hit.point);
    const agent = hit.object.userData.agent;
    if (!agent || agent === shooter) return { hit: true, wall: true, point: hit.point };
    // No friendly fire: a teammate's body stops the bullet, but takes no damage.
    if (agent.team === shooter.team) return { hit: true, wall: true, point: hit.point };
    const distance = hit.distance;
    const falloff = 1 - def.falloff * Math.min(1, distance / def.range);
    const part = hit.object.userData.part;
    const amount = def.damage * falloff * (part === 'head' ? def.headMult : 1);
    const killed = applyDamage(agent, amount, shooter);
    return { hit: true, agent, part, killed, point: hit.point, damage: amount };
  }

  // Shared launch: a grenade is a point with a velocity, a fuse and a mesh. The throw is
  // recorded in the round's utility counts and announced as a 'throw' sound event, so
  // nearby bots can hear a pin pulled and investigate, the same way they hear a shot.
  // `fuseOverride` is the player's cook: a cooked grenade flies with the fuse already
  // partly burned. Bots never cook, so their throws leave it unset.
  function launchGrenade(owner, from, velocity, kind, fuseOverride) {
    const def = GRENADES[kind];
    const grenade = {
      kind,
      owner,
      position: from.clone(),
      velocity: velocity.clone(),
      fuse: fuseOverride ?? def.fuse,
      radius: 0.09,
    };
    grenades.push(grenade);
    recordUtility(state, owner.team, kind);
    // The throw is a sound: a pin pull carries 18 metres, and the owner is attached so
    // the thrower itself never investigates its own throw.
    state.events.push({ kind: 'throw', x: from.x, z: from.z, radius: 18, owner });
    // A throw near the player is called out in the feed: the player cannot see a
    // grenade coming from behind a container, but they can read that one is coming.
    // Only bot throws are called out — the player's own throw needs no announcement —
    // and only within 20 metres, so the feed stays a killfeed and not a throw log.
    if (!owner.isPlayer && state.player && state.player.alive) {
      const playerDistance = Math.hypot(state.player.position.x - from.x, state.player.position.z - from.z);
      if (playerDistance < 20) {
        pushFeed(state, `${owner.name} throws a ${kind === 'frag' ? 'frag' : 'smoke'}`, owner.team === 'atk');
      }
    }
    const slot = grenadeMeshes.find((entry) => entry.grenade === null) || grenadeMeshes[0];
    if (slot.grenade) slot.grenade.meshSlot = null; // the old throw loses its mesh
    slot.grenade = grenade;
    grenade.meshSlot = slot;
    slot.mesh.material.opacity = 1;
    slot.mesh.position.copy(grenade.position);
    return grenade;
  }

  // The player's throw: an aim direction, a fixed throw speed and an upward lob, exactly
  // as before the revision. The grenade bounces and rolls toward the aim after landing.
  // `fuseOverride` carries the cook: a held grenade flies with a shorter fuse.
  function throwGrenade(owner, from, aim, kind, fuseOverride) {
    return launchGrenade(owner, from, aim.clone().multiplyScalar(13).add(new THREE.Vector3(0, 4.5, 0)), kind, fuseOverride);
  }

  // A bot's throw: the caller thinks in points, not directions. Solve the ballistic arc
  // that lands on targetPoint — the flight time is distance over fourteen metres a
  // second, clamped to a throw that stays readable — and let the fuse do the rest. The
  // caller adds its own aim error to targetPoint, so a throw is never pixel-perfect.
  function throwGrenadeAt(owner, from, targetPoint, kind) {
    const flight = new THREE.Vector3().copy(targetPoint).sub(from);
    const distance = Math.hypot(flight.x, flight.z);
    const time = Math.max(0.8, Math.min(1.6, distance / 14));
    const velocity = new THREE.Vector3(
      flight.x / time,
      (flight.y / time) + (0.5 * GRAVITY * time),
      flight.z / time,
    );
    return launchGrenade(owner, from, velocity, kind);
  }

  function explode(grenade) {
    const def = GRENADES[grenade.kind];
    if (grenade.kind === 'frag') {
      explosionMesh.position.copy(grenade.position);
      explosionLife = 0.35;
      state.events.push({ kind: 'explosion', x: grenade.position.x, z: grenade.position.z, radius: 30 });
      for (const agent of liveAgents) {
        if (!agent.alive || agent === grenade.owner) continue;
        const distance = agent.position.distanceTo(grenade.position);
        if (distance > def.radius) continue;
        tmp.copy(agent.position).setY(agent.position.y + 1.1);
        const blocked = losBlocked(tmp, grenade.position, world.colliders);
        const amount = def.damage * (1 - distance / def.radius) * (blocked ? 0.4 : 1);
        // The match summary counts the damage the frag actually did: capped at what
        // the victim could lose, so an overkill on a 10-health enemy counts 10.
        recordFragDamage(state, grenade.owner.team, Math.min(amount, agent.health + agent.armor));
        if (applyDamage(agent, amount, grenade.owner)) {
          state.feed.unshift({ text: `${grenade.owner.name} 💥 ${agent.name}`, good: grenade.owner.isPlayer });
          if (state.feed.length > 5) state.feed.length = 5;
        }
      }
    } else {
      smokes.push({ position: grenade.position.clone(), radius: def.radius, until: state.time + def.duration });
      smokeVisual(smokes[smokes.length - 1]);
      state.events.push({ kind: 'smoke', x: grenade.position.x, z: grenade.position.z, radius: 12 });
    }
  }

  const smokeTo = new THREE.Vector3();
  const smokeClosest = new THREE.Vector3();

  function smokeBlocks(from, to) {
    for (const smoke of smokes) {
      // Segment-sphere test: the closest point of the segment to the cloud centre.
      smokeTo.copy(to).sub(from);
      const lengthSq = smokeTo.lengthSq();
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, smokeClosest.copy(smoke.position).sub(from).dot(smokeTo) / lengthSq));
      smokeClosest.copy(smokeTo).multiplyScalar(t).add(from);
      if (smokeClosest.distanceTo(smoke.position) < smoke.radius) return true;
    }
    return false;
  }

  function step(dt, agents) {
    liveAgents = agents;
    for (const tracer of tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      tracer.line.material.opacity = Math.max(0, tracer.life / 0.07) * 0.85;
    }
    for (const flash of flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt;
      flash.mesh.material.opacity = Math.max(0, flash.life / 0.18) * 0.9;
      flash.mesh.scale.setScalar(1 + (0.18 - flash.life) * 6);
    }
    if (explosionLife > 0) {
      explosionLife -= dt;
      explosionMesh.material.opacity = Math.max(0, explosionLife / 0.35) * 0.7;
      explosionMesh.scale.setScalar(1 + (0.35 - explosionLife) * 14);
    }
    for (let i = smokes.length - 1; i >= 0; i -= 1) {
      const smoke = smokes[i];
      const group = smokeMeshes.get(smoke);
      if (state.time >= smoke.until) {
        smokes.splice(i, 1);
        if (group) {
          scene.remove(group);
          smokeMeshes.delete(smoke);
        }
      } else if (group) {
        const age = state.time - (smoke.until - GRENADES.smoke.duration);
        const fade = Math.min(1, age) * Math.min(1, Math.max(0, smoke.until - state.time));
        for (const child of group.children) child.material.opacity = 0.55 * fade;
        group.rotation.y += dt * 0.15;
      }
    }
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const grenade = grenades[i];
      grenade.velocity.y -= GRAVITY * dt;
      grenade.position.addScaledVector(grenade.velocity, dt);
      // Bounce off the world's boxes: push out along the shallowest axis and reflect it.
      for (const box of world.colliders) {
        const r = grenade.radius;
        if (
          grenade.position.x > box.min.x - r && grenade.position.x < box.max.x + r &&
          grenade.position.y > box.min.y - r && grenade.position.y < box.max.y + r &&
          grenade.position.z > box.min.z - r && grenade.position.z < box.max.z + r
        ) {
          const dxMin = grenade.position.x - (box.min.x - r);
          const dxMax = box.max.x + r - grenade.position.x;
          const dyMin = grenade.position.y - (box.min.y - r);
          const dyMax = box.max.y + r - grenade.position.y;
          const dzMin = grenade.position.z - (box.min.z - r);
          const dzMax = box.max.z + r - grenade.position.z;
          const min = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
          if (min === dxMin) { grenade.position.x = box.min.x - r; grenade.velocity.x = -Math.abs(grenade.velocity.x) * 0.45; }
          else if (min === dxMax) { grenade.position.x = box.max.x + r; grenade.velocity.x = Math.abs(grenade.velocity.x) * 0.45; }
          else if (min === dyMin) { grenade.position.y = box.min.y - r; grenade.velocity.y = -Math.abs(grenade.velocity.y) * 0.45; }
          else if (min === dyMax) { grenade.position.y = box.max.y + r; grenade.velocity.y = Math.abs(grenade.velocity.y) * 0.45; }
          else if (min === dzMin) { grenade.position.z = box.min.z - r; grenade.velocity.z = -Math.abs(grenade.velocity.z) * 0.45; }
          else { grenade.position.z = box.max.z + r; grenade.velocity.z = Math.abs(grenade.velocity.z) * 0.45; }
        }
      }
      if (grenade.position.y < grenade.radius) {
        grenade.position.y = grenade.radius;
        grenade.velocity.y = Math.abs(grenade.velocity.y) * 0.45;
        grenade.velocity.x *= 0.7;
        grenade.velocity.z *= 0.7;
      }
      grenade.fuse -= dt;
      if (grenade.fuse <= 0) {
        explode(grenade);
        grenades.splice(i, 1);
        if (grenade.meshSlot) {
          grenade.meshSlot.grenade = null;
          grenade.meshSlot.mesh.material.opacity = 0;
          grenade.meshSlot = null;
        }
      } else if (grenade.meshSlot) {
        // The mesh follows the point it was launched with, so a throw stays visible
        // through every bounce until the fuse runs out.
        grenade.meshSlot.mesh.position.copy(grenade.position);
      }
    }
  }

  // The closest live frag to an agent, for the danger warning: how far it is and how
  // much fuse is left. Returns null when no frag is close enough to matter. A frag
  // counts as dangerous inside 12 metres with under 2.5 seconds of fuse — far enough
  // to run from, close enough to hurt. Smoke never counts: it cannot hurt anyone.
  function grenadeDanger(agent) {
    let closest = null;
    for (const grenade of grenades) {
      if (grenade.kind !== 'frag') continue;
      const distance = Math.hypot(grenade.position.x - agent.position.x, grenade.position.z - agent.position.z);
      if (distance > 12 || grenade.fuse > 2.5) continue;
      if (!closest || distance < closest.distance) closest = { distance, fuse: grenade.fuse };
    }
    return closest;
  }

  return { shoot, throwGrenade, throwGrenadeAt, step, applyDamage, smokeBlocks, grenades, smokes, grenadeDanger, updateArcPreview, hideArcPreview, arcVisible: () => arcRing.visible && arcLine.visible };
}
