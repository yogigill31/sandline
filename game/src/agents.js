// Agents: one body for the player and for every bot. A body is a position, a velocity and a
// capsule resolved against the world's boxes one axis at a time, plus the torso and head
// meshes a bullet can hit. Player and bot share this code, so a bot moves, crouches and
// collides exactly like the player does — and the raycaster cannot tell them apart.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.12;
const STAND_EYE = 1.6;
const CROUCH_EYE = 1.02;
const WALK_SPEED = 5.2;
const CROUCH_SPEED = 2.4;
const GROUND_ACCEL = 42;
const AIR_ACCEL = 9;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP_SPEED = 6.2;

export function createMover(colliders) {
  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - RADIUS, y + lift, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - lift, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  // wishX/wishZ is a unit direction in world space (0,0 to stand still); jump and crouch
  // are booleans. Runs at the fixed step, so movement is the same at any frame rate.
  function step(body, dt, wishX, wishZ, jump, crouching) {
    if (crouching && !body.crouching) {
      body.crouching = true;
      body.height = CROUCH_HEIGHT;
    } else if (!crouching && body.crouching && !overlaps(body.position.x, body.position.y, body.position.z, STAND_HEIGHT, 0.02)) {
      body.crouching = false;
      body.height = STAND_HEIGHT;
    }
    const eyeTarget = body.crouching ? CROUCH_EYE : STAND_EYE;
    body.eye += (eyeTarget - body.eye) * Math.min(1, dt * 12);

    wish.set(wishX, 0, wishZ);
    const speed = body.crouching ? CROUCH_SPEED : WALK_SPEED;
    const blend = Math.min(1, (body.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt / speed);
    body.velocity.x += (wish.x * speed - body.velocity.x) * blend;
    body.velocity.z += (wish.z * speed - body.velocity.z) * blend;
    if (body.onGround && wish.lengthSq() === 0) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      body.velocity.x *= damp;
      body.velocity.z *= damp;
    }

    if (jump && body.onGround) {
      body.velocity.y = JUMP_SPEED;
      body.onGround = false;
    }
    body.velocity.y -= GRAVITY * dt;

    const nextX = body.position.x + body.velocity.x * dt;
    if (!overlaps(nextX, body.position.y, body.position.z, body.height, 0.04)) body.position.x = nextX;
    else body.velocity.x = 0;
    const nextZ = body.position.z + body.velocity.z * dt;
    if (!overlaps(body.position.x, body.position.y, nextZ, body.height, 0.04)) body.position.z = nextZ;
    else body.velocity.z = 0;

    body.position.y += body.velocity.y * dt;
    body.onGround = false;
    const hit = overlaps(body.position.x, body.position.y, body.position.z, body.height, 0);
    if (hit && body.velocity.y <= 0) {
      body.position.y = hit.max.y;
      body.velocity.y = 0;
      body.onGround = true;
    } else if (hit) {
      body.position.y = hit.min.y - body.height;
      body.velocity.y = 0;
    }
    if (body.position.y < 0) {
      body.position.y = 0;
      body.velocity.y = 0;
      body.onGround = true;
    }
    body.velocity.y = Math.max(-30, body.velocity.y);
  }

  function groundSpeed(body) {
    return Math.hypot(body.velocity.x, body.velocity.z);
  }

  return { step, groundSpeed, overlaps };
}

// A segment blocked by a wall: the slab test, run against the same colliders the mover
// uses, so a bot never sees through a crate it cannot walk through.
export function losBlocked(from, to, colliders) {
  const dirX = to.x - from.x;
  const dirY = to.y - from.y;
  const dirZ = to.z - from.z;
  for (const box of colliders) {
    let tMin = 0;
    let tMax = 1;
    for (const [origin, dir, min, max] of [
      [from.x, dirX, box.min.x, box.max.x],
      [from.y, dirY, box.min.y, box.max.y],
      [from.z, dirZ, box.min.z, box.max.z],
    ]) {
      if (Math.abs(dir) < 1e-9) {
        if (origin < min || origin > max) {
          tMin = 1;
          tMax = 0;
          break;
        }
      } else {
        let t1 = (min - origin) / dir;
        let t2 = (max - origin) / dir;
        if (t1 > t2) {
          const swap = t1;
          t1 = t2;
          t2 = swap;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) break;
      }
    }
    if (tMin <= tMax && tMax >= 0 && tMin <= 1) return true;
  }
  return false;
}

const torsoGeometry = new THREE.BoxGeometry(0.52, 0.78, 0.3);
const headGeometry = new THREE.SphereGeometry(0.155, 16, 12);
const legsGeometry = new THREE.BoxGeometry(0.4, 0.62, 0.26);
const gunGeometry = new THREE.BoxGeometry(0.07, 0.09, 0.55);
const grenadeGeometry = new THREE.SphereGeometry(0.09, 8, 6);

// A visible body for a bot (the player has none: you never see yourself). The torso and
// head are the two hit parts; the gun is cosmetic. Team colours come from the palette.
export function createAgentBody(scene, agent) {
  const teamColor = agent.team === 'atk' ? PALETTE.accent : PALETTE.foe;
  const torsoMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.6, metalness: 0.05 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.45, metalness: 0.1 });
  const legsMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 });
  const gunMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.5, metalness: 0.3 });

  const group = new THREE.Group();
  const legs = new THREE.Mesh(legsGeometry, legsMaterial);
  legs.position.y = 0.31;
  const torso = new THREE.Mesh(torsoGeometry, torsoMaterial);
  torso.position.y = 1.0;
  torso.userData.part = 'torso';
  const head = new THREE.Mesh(headGeometry, headMaterial);
  head.position.y = 1.53;
  head.userData.part = 'head';
  const gun = new THREE.Mesh(gunGeometry, gunMaterial);
  gun.position.set(0.28, 1.05, -0.2);
  // The grenade on the belt: a small dark sphere at the hip, visible while the agent
  // carries any grenade, hidden when the stock is spent. It is the visual answer to
  // "does that bot still have a frag" — the player reads it off the bot instead of
  // guessing. The player has no body mesh, so theirs never shows. It is a child of the
  // group, so it follows the body, the crouch and the fall without any extra code.
  const grenade = new THREE.Mesh(
    grenadeGeometry,
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#2a2e38'), roughness: 0.5, metalness: 0.4 }),
  );
  grenade.position.set(-0.3, 0.85, 0.1);
  grenade.visible = false;
  group.add(legs, torso, head, gun, grenade);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  scene.add(group);

  torso.userData.agent = agent;
  head.userData.agent = agent;
  agent.group = group;
  agent.torso = torso;
  agent.head = head;
  agent.hitMeshes = [torso, head];
  agent.grenadeMesh = grenade;
  agent.grenadeCarry = 0; // grenades carried, mirrored from the bot's stock by bots.js
  agent.fall = 0;
}

// Show or hide the belt grenade. bots.js calls this when a stock changes; it is a
// visibility flag, not a mesh rebuild, so it costs nothing per frame. Agents without
// a body mesh — the player — have no grenadeMesh and are skipped.
export function setGrenadeCarry(agent, count) {
  if (!agent.grenadeMesh) return;
  agent.grenadeMesh.visible = count > 0;
}

// Keep a body's meshes where its mover is, facing its yaw; a dead body tips over and sinks
// slightly, then stays down until the round resets it.
export function syncBody(agent, dt) {
  if (!agent.group) return;
  agent.group.position.copy(agent.position);
  agent.group.position.y = agent.position.y;
  agent.group.rotation.y = agent.yaw;
  if (!agent.alive) {
    agent.fall = Math.min(1, agent.fall + dt / 0.4);
    agent.group.rotation.x = -agent.fall * 1.45;
    agent.group.position.y = agent.position.y - agent.fall * 0.08;
  } else {
    agent.group.rotation.x = 0;
    agent.fall = 0;
  }
}

export function newBody(x, z, yaw) {
  return {
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(),
    yaw,
    pitch: 0,
    eye: STAND_EYE,
    onGround: true,
    crouching: false,
    height: STAND_HEIGHT,
  };
}
