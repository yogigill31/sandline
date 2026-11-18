// SANDLINE, a threejs-fps-01 entry (Node 22, standard library only): the game is this
// directory's game/ folder, plain static files the browser loads as ES modules with
// three.js from an import map, and the program hands it in. It copies game/ and
// screenshots/ from beside this file to /output and writes /output/dossier.json, the
// summary the judge reads, with the vendored make.fun library.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The post-opening revision's economy check lives in this file (checkEconomy, below):
// before the dossier is built, the entry's numbers are read back from the source and
// checked against each other, so a price changed in one file without its matching
// payout in another fails the build instead of shipping a broken economy. This file
// is the entrypoint, so the check is also the revision's authored line in main.ts.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The revision's invariants, checked at build time. The numbers are read from the
// source text with plain patterns — no imports from the game, because main.ts runs
// in Node and the game runs in a browser, and the two must never share a module.
// Every check is one of the reasons the rebalance gives for a number: a win funds a
// rifle and a vest, a loss funds an SMG and a vest, a smoke covers a whole site, a
// bot never throws inside its own blast, and a round's bot utility stays capped.
function checkEconomy() {
  const weapons = readFileSync(join(here, 'game', 'src', 'weapons.js'), 'utf8');
  const state = readFileSync(join(here, 'game', 'src', 'state.js'), 'utf8');
  const bots = readFileSync(join(here, 'game', 'src', 'bots.js'), 'utf8');
  const combat = readFileSync(join(here, 'game', 'src', 'combat.js'), 'utf8');
  const failures = [];
  const fail = (message) => failures.push(message);
  const number = (source, pattern, label) => {
    const match = source.match(pattern);
    if (!match) { fail(`${label}: pattern not found`); return NaN; }
    return Number(match[1]);
  };

  // Weapon prices, from the table the buy menu reads.
  const rifleCost = number(weapons, /rifle:\s*\{[^}]*cost:\s*(\d+)/, 'rifle cost');
  const smgCost = number(weapons, /smg:\s*\{[^}]*cost:\s*(\d+)/, 'smg cost');
  const armorCost = number(weapons, /ARMOR_COST = (\d+)/, 'armour cost');
  const fragCost = number(weapons, /frag:\s*\{[^}]*cost:\s*(\d+)/, 'frag cost');
  const smokeCost = number(weapons, /smoke:\s*\{[^}]*cost:\s*(\d+)/, 'smoke cost');
  const fragRadius = number(weapons, /frag:\s*\{[^}]*radius:\s*([\d.]+)/, 'frag radius');
  const fragFuse = number(weapons, /frag:\s*\{[^}]*fuse:\s*([\d.]+)/, 'frag fuse');
  const smokeRadius = number(weapons, /smoke:\s*\{[^}]*radius:\s*([\d.]+)/, 'smoke radius');

  // Round payouts, from the state the round ends with.
  const winReward = number(state, /WIN_REWARD = (\d+)/, 'win reward');
  const lossReward = number(state, /LOSS_REWARD = (\d+)/, 'loss reward');

  // Bot grenade rules, from the loadout and the throw guards.
  const throwMin = number(bots, /FRAG_THROW_MIN = (\d+)/, 'frag throw min range');
  const throwMax = number(bots, /FRAG_THROW_MAX = (\d+)/, 'frag throw max range');
  const cooldown = number(bots, /GRENADE_COOLDOWN_SECONDS = (\d+)/, 'grenade cooldown');

  // A win funds a rifle and a vest with money spare; a loss funds an SMG and a vest.
  // These are the economy's two anchors — if a price moves, a payout must move too.
  if (winReward < rifleCost + armorCost) fail(`win $${winReward} does not fund a rifle ($${rifleCost}) and a vest ($${armorCost})`);
  if (lossReward < smgCost + armorCost) fail(`loss $${lossReward} does not fund an SMG ($${smgCost}) and a vest ($${armorCost})`);
  // A grenade costs the same for a bot as for the player: the loadout is priced out
  // of this table, so a bot never throws utility the round could not pay for.
  if (fragCost !== 300 || smokeCost !== 300) fail(`grenades are not $300 a piece (frag $${fragCost}, smoke $${smokeCost})`);
  // A smoke covers a whole site: its radius clears the site's half-width plus a metre
  // of lane, or the corners stay visible from the approach.
  if (smokeRadius < 4.5) fail(`smoke radius ${smokeRadius}m does not cover a 3.5m site mouth`);
  // A bot never throws inside its own blast, and the frag lands before its fuse burns.
  if (throwMin <= fragRadius) fail(`frag throw min ${throwMin}m is inside the ${fragRadius}m blast radius`);
  if (fragFuse <= throwMax / 14) fail(`frag fuse ${fragFuse}s is shorter than the ${throwMax / 14}s flight to max range`);
  // A throw is spaced wider than the blast it causes, so a round never turns into
  // a grenade spam.
  if (cooldown < 5) fail(`grenade cooldown ${cooldown}s is shorter than 5s`);
  // The grenade mesh pool holds every grenade the round can have in the air at once:
  // nine bots and a player, one throw each, so eight slots is the floor, not the cap.
  const pool = number(combat, /GRENADE_POOL = (\d+)/, 'grenade mesh pool');
  if (pool < 8) fail(`grenade mesh pool ${pool} is smaller than the 8 concurrent throws a round can hold`);

  // The bot loadout cap: no bot carries two of one kind, and a round holds at most
  // six frags and two smokes across both teams — the design's ceiling on utility.
  const loadoutBlock = bots.match(/const BOT_LOADOUT = \{([\s\S]*?)\n\};/);
  if (!loadoutBlock) {
    fail('BOT_LOADOUT block not found');
  } else {
    const frags = [...loadoutBlock[1].matchAll(/frag: (\d+)/g)].map((m) => Number(m[1]));
    const smokes = [...loadoutBlock[1].matchAll(/smoke: (\d+)/g)].map((m) => Number(m[1]));
    if (frags.some((n) => n > 1) || smokes.some((n) => n > 1)) fail('a bot carries more than one of a grenade kind');
    const totalFrags = frags.reduce((a, b) => a + b, 0);
    const totalSmokes = smokes.reduce((a, b) => a + b, 0);
    if (totalFrags > 6) fail(`bot loadout holds ${totalFrags} frags, over the cap of 6`);
    if (totalSmokes > 2) fail(`bot loadout holds ${totalSmokes} smokes, over the cap of 2`);
  }

  if (failures.length > 0) {
    throw new Error(`SANDLINE economy check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }
}

checkEconomy();

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the
// others refuse an entry the scorer would refuse (more than 4 screenshots or one over
// 256 KiB; more than 993 files in game/ or 48 MiB of game files, in all: game/ counts
// beside /output's own 1000-entry cap, its screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);
