// SANDLINE: an original two-site bomb map in a desert freight yard. Attackers spawn south
// (z +14), defenders north (z -14). Site A is the west crate yard, Site B the east depot;
// between them run three lanes: A-long on the west edge, mid through the double doors, and
// the B-tunnel on the east edge. Every box is a collider for agents and a surface a bullet
// stops on. The waypoint graph is what the bots navigate: nodes at every junction, edges
// along lanes, so a bot's route is a short BFS instead of a straight line through walls.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Waypoint graph: name -> { x, z, links }.
export const WAYPOINTS = {
  atkSpawn: { x: 0, z: 14, links: ['atkMid', 'aLong1', 'bTun1'] },
  atkMid: { x: 0, z: 9, links: ['atkSpawn', 'midDoors'] },
  midDoors: { x: 0, z: 0, links: ['atkMid', 'midTop'] },
  midTop: { x: 0, z: -6, links: ['midDoors', 'aMain', 'bMain', 'defMid'] },
  aLong1: { x: -20, z: 9, links: ['atkSpawn', 'aLong2'] },
  aLong2: { x: -20, z: -1, links: ['aLong1', 'aCorner'] },
  aCorner: { x: -20, z: -8, links: ['aLong2', 'aSite'] },
  aSite: { x: -16, z: -8, links: ['aCorner', 'aMain'] },
  aMain: { x: -8, z: -8, links: ['aSite', 'midTop', 'aHold'] },
  aHold: { x: -10, z: -11, links: ['aMain', 'defA'] },
  bTun1: { x: 20, z: 9, links: ['atkSpawn', 'bTun2'] },
  bTun2: { x: 20, z: -1, links: ['bTun1', 'bCorner'] },
  bCorner: { x: 20, z: -8, links: ['bTun2', 'bSite'] },
  bSite: { x: 16, z: -8, links: ['bCorner', 'bMain'] },
  bMain: { x: 8, z: -8, links: ['bSite', 'midTop', 'bHold'] },
  bHold: { x: 10, z: -11, links: ['bMain', 'defB'] },
  defSpawn: { x: 0, z: -14, links: ['defMid', 'defA', 'defB'] },
  defMid: { x: 0, z: -11, links: ['defSpawn', 'midTop'] },
  defA: { x: -13, z: -13, links: ['defSpawn', 'aHold'] },
  defB: { x: 13, z: -13, links: ['defSpawn', 'bHold'] },
};

export const SITES = {
  A: { x: -16, z: -8, half: 3.5 },
  B: { x: 16, z: -8, half: 3.5 },
};

// Where a planter's execute smoke is aimed: the mouth of the site, halfway between the
// plant spot and the defenders' approach lane (aMain for A, bMain for B). A cloud there
// sits between the planter and anyone rotating in, which is the whole point of the
// smoke — thrown at the planter's own feet it would hide the planter but not the lane.
export const SITE_SMOKE_AIM = {
  A: { x: -12, z: -8 },
  B: { x: 12, z: -8 },
};

export const SPAWNS = {
  atk: [[-4, 14], [-2, 15], [0, 14], [2, 15], [4, 14]],
  def: [[-4, -14], [-2, -15], [0, -14], [2, -15], [4, -14]],
};

function letterTexture(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(32,36,46,0.85)';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = color;
  ctx.font = 'bold 84px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.55 : 0.92,
      metalness: 0.03,
    });
  }
  // Sand underfoot: the yard floor is warmer than the concrete walls.
  const sand = new THREE.MeshStandardMaterial({ color: new THREE.Color('#8a7355'), roughness: 1, metalness: 0 });

  const colliders = [];
  const shootables = [];

  function box(width, height, depth, x, y, z, material) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      material === 'sand' ? sand : materials[material],
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  // Floor and perimeter: 48 x 36 m, 4.6 m walls, open to the dusk sky.
  box(48.4, 0.4, 36.4, 0, -0.2, 0, 'sand');
  box(0.4, 4.6, 36.4, -24.2, 2.3, 0, 'surface');
  box(0.4, 4.6, 36.4, 24.2, 2.3, 0, 'surface');
  box(48.4, 4.6, 0.4, 0, 2.3, -18.2, 'surface');
  box(48.4, 4.6, 0.4, 0, 2.3, 18.2, 'surface');

  // Mid: double doors — a wall across the middle with a 3 m gap, plus a jumpable platform.
  box(10.4, 4.6, 0.6, -9.2, 2.3, 2.5, 'surface');
  box(10.4, 4.6, 0.6, 9.2, 2.3, 2.5, 'surface');
  box(4.5, 4.6, 0.6, -15.9, 2.3, 2.5, 'surface');
  box(4.5, 4.6, 0.6, 15.9, 2.3, 2.5, 'surface');
  box(3.6, 0.9, 2.4, 0, 0.45, -2.5, 'hairline'); // mid platform, jumpable
  box(1.2, 1.1, 1.2, -5.4, 0.55, -4.4, 'hairline');
  box(1.2, 1.1, 1.2, 5.4, 0.55, -4.4, 'hairline');

  // A site (west yard): a crate stack to plant behind, a tall pillar for the long angle.
  box(3.4, 1.1, 1.2, -17.5, 0.55, -5.6, 'hairline');
  box(1.2, 1.1, 3.4, -13.2, 0.55, -10.6, 'hairline');
  box(1.4, 2.4, 1.4, -19.5, 1.2, -11.5, 'surface');
  box(2.2, 0.9, 2.2, -14.2, 0.45, -6.4, 'hairline');
  box(1.2, 3.2, 1.2, -11.5, 1.6, -12.5, 'hairline');

  // B site (east depot): a container wall, low crates, a corner pillar.
  box(1.2, 2.6, 6.0, 19.8, 1.3, -8.0, 'surface');
  box(3.4, 1.1, 1.2, 14.6, 0.55, -5.6, 'hairline');
  box(1.2, 1.1, 3.4, 13.2, 0.55, -10.6, 'hairline');
  box(2.2, 0.9, 2.2, 17.8, 0.45, -6.4, 'hairline');
  box(1.2, 3.2, 1.2, 11.5, 1.6, -12.5, 'hairline');

  // Lanes: cover on A-long and the B-tunnel so a push is never a firing squad.
  box(1.2, 1.1, 2.4, -20.5, 0.55, 4.0, 'hairline');
  box(1.2, 2.2, 1.2, -20.5, 1.1, -4.5, 'surface');
  box(1.2, 1.1, 2.4, 20.5, 0.55, 4.0, 'hairline');
  box(1.2, 2.2, 1.2, 20.5, 1.1, -4.5, 'surface');
  // Spawn cover, both ends.
  box(2.4, 1.1, 1.2, -6, 0.55, 11.5, 'hairline');
  box(2.4, 1.1, 1.2, 6, 0.55, 11.5, 'hairline');
  box(2.4, 1.1, 1.2, -6, 0.55, -11.5, 'hairline');
  box(2.4, 1.1, 1.2, 6, 0.55, -11.5, 'hairline');

  // Site decals: a painted square on the floor marks where the bomb goes, and a letter
  // board on the back wall names the site from across the map.
  for (const [name, site] of Object.entries(SITES)) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(site.half * 2, site.half * 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.14, depthWrite: false }),
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(site.x, 0.02, site.z);
    group.add(decal);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 2.4),
      new THREE.MeshBasicMaterial({ map: letterTexture(name, PALETTE.accent) }),
    );
    board.position.set(site.x, 2.6, -17.9);
    group.add(board);
  }

  // Light: a low warm sun from the west, a cool fill from the east, and dusk sky.
  const sky = new THREE.HemisphereLight(new THREE.Color('#7d8aa8'), new THREE.Color('#3a2f26'), 0.9);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color('#ffb45e'), 2.4);
  sun.position.set(-18, 16, 10);
  sun.target.position.set(0, 0, -4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.5);
  fill.position.set(14, 10, -12);
  scene.add(fill);

  return { colliders, shootables, group };
}

// The shortest route through the waypoint graph, by breadth-first search. Returns an array
// of waypoint names from `from` to `to`, inclusive; an empty array when unreachable.
export function findRoute(from, to) {
  if (from === to) return [from];
  const cameFrom = { [from]: null };
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of WAYPOINTS[current].links) {
      if (next in cameFrom) continue;
      cameFrom[next] = current;
      if (next === to) {
        const route = [to];
        let step = current;
        while (step !== null) {
          route.unshift(step);
          step = cameFrom[step];
        }
        return route;
      }
      queue.push(next);
    }
  }
  return [];
}

export function nearestWaypoint(x, z) {
  let best = null;
  let bestDistance = Infinity;
  for (const [name, point] of Object.entries(WAYPOINTS)) {
    const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}
