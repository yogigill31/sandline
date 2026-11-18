# SANDLINE

[![make.fun · threejs-fps-01](https://make.fun/badge/threejs-fps-01.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![rank](https://make.fun/badge/threejs-fps-01/yogigill31/sandline/rank.svg)](https://make.fun/bounty/threejs-fps-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![reward](https://make.fun/badge/threejs-fps-01/yogigill31/sandline/reward.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)

SANDLINE is a round-based tactical FPS in the Counter-Strike style, built original for three.js: a two-site bomb map in a desert freight yard, five attackers against five defenders, money between rounds, and a buy menu. Win a round by eliminating the other team, by planting the bomb and letting it detonate, or — on defence — by running the clock out or defusing it.

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080. No build step, no network: the game is static files under `game/`, served as ES modules with the vendored three.js 0.187.0.

## How it plays

- **Rounds**: 15-second buy phase, then a 100-second round. First team to 8 rounds takes the match (at most 15 rounds).
- **The objective**: attackers carry a bomb. Hold `E` inside Site A or B for 3.5 seconds to plant; the bomb beeps for 35 seconds, and a defender holding `E` on it for 5 seconds defuses it.
- **Money**: $800 to start, +$300 a kill, +$300 a plant, +$3,400 a round won, +$2,000 a round lost (plus $500 per consecutive loss, twice at most). Spend it in the buy menu (`B` during the buy phase). A win funds a rifle ($2,700) and a vest ($600) with $100 spare; a loss funds an SMG ($1,300) and a vest.
- **Weapons**: P9 sidearm (free), VK-9 SMG ($1,300), M12 Breacher shotgun ($1,100), AR-77 rifle ($2,700), LR-90 sniper ($4,500, right-click to scope), frag and smoke grenades ($300 each), Kevlar ($600).
- **Gunplay**: hitscan against torso and head (headshots pay 4× on most guns), recoil and spread that punish firing on the move, acceleration, crouching and collision with the map. Hold `G` to cook a grenade — the fuse burns in hand, the arc preview shows where it lands, and the cook bar shows how much fuse is left.
- **Bots**: nine of them. They walk the waypoint graph to their lanes and sites, hold angles, burst at what they see, investigate gunshots they hear, converge on a planted bomb, and plant or defuse it themselves. One attacker carries the bomb. They also throw grenades: a frag at an enemy they can see, a smoke when the planter executes a site or a defender covers a defuse, and a frag at a corner they heard a shot from — one frag per bot per round, an 8-second cooldown, and a wind-up that telegraphs the throw. A grenade on a bot's belt shows it still carries one.
- **Smoke changes the objective**: a cloud over a site makes the plant a fifth faster and the defuse a sixth slower, because the planter is hidden and the wires are harder to see.

## Post-opening revision (2026-11-17)

The bots did not throw grenades. The player could — `G`, $300 a piece — and the bots never did, which made the grenade economy one-sided. This revision fixes that, and rebalances the economy around it:

- **Bot grenades** (`game/src/bots.js`, `game/src/combat.js`): every bot carries a per-round loadout — the planter one frag and one smoke, two defenders one frag each, the mid defender one smoke. A bot throws a frag at a visible enemy 12–28 m away, a smoke at the site mouth when the planter executes or a defender covers a defuse, and a frag at a corner it heard a shot from. Stock, an 8-second cooldown and a 0.35-second wind-up keep throws rare and readable; a thrown grenade is visible in flight, audible as a pin pull, and announced in the feed when it is close to the player.
- **Rebalance** (`game/src/weapons.js`, `game/src/state.js`): SMG $1,500 → $1,300 and damage 26 → 28 (a loss round funds it after a vest); sniper $4,750 → $4,500 (smoke and frags weaken its long sightlines); smoke radius 4.5 → 5.0 m (a site is 3.5 m wide, so 4.5 m left its corners visible); Kevlar $650 → $600 (a vest plus a frag is $900, affordable on a loss round); win $3,250 → $3,400 and loss $1,900 → $2,000 (a win funds a rifle and a vest with $100 spare). `main.ts` checks these anchors at build time and fails the build if they drift apart.
- **Grenade counterplay** (`game/src/combat.js`, `game/src/hud.js`, `game/src/main.js`): a live frag close to the player raises a danger banner with its distance and a warning tick; the HUD shows the player's grenade stock and the round's utility by team; the round-end banner and the match overlay report how much utility each side threw and how much frag damage it did.
- **Cooking and the arc** (`game/src/main.js`, `game/src/input.js`, `game/src/combat.js`): hold `G` to cook a grenade — the fuse burns in hand, the arc preview shows where it will land, the cook bar shows the fuse, and a warning appears in the last 1.5 seconds. Release to throw with the shortened fuse.
- **Self-checks**: load the game with `?test=utility`, `?test=economy` or `?test=smoke` and read `window.__testResult` — the grenade pipeline, the economy anchors and the smoke objective modifier, each verified in the browser. `?shot=utility` captures the grenade showcase frame.

## Controls

`WASD` move · Mouse look · Click fire · `R` reload · `1`–`5` weapons · `G` throw grenade (hold to cook) · `Q` swap grenade · `E` plant/defuse · `B` buy menu · `Ctrl` crouch · `Space` jump · Right-click scope (sniper).

## Layout

- `game/index.html` — page, HUD, buy menu, import map for three.js.
- `game/src/main.js` — boot, the fixed 60 Hz loop, rounds, economy, screenshots.
- `game/src/state.js` — the one state store every module reads.
- `game/src/world.js` — the SANDLINE map, colliders, waypoint graph, bomb sites.
- `game/src/agents.js` — the shared mover and the visible bot bodies.
- `game/src/bots.js` — bot AI: route, hold, engage, investigate, plant, defuse, and the grenade loadout, throws and wind-up.
- `game/src/weapons.js` — the weapon and grenade tables, view models, the throw animation.
- `game/src/combat.js` — the ray, the damage, tracers, grenade physics, the arc preview, the danger check.
- `game/src/bomb.js` — plant, beep, defuse, detonation, and the smoke objective modifier.
- `game/src/audio.js` — procedural WebAudio: shots, reloads, beeps, round stingers, grenade throws, explosions, smoke, danger ticks.
- `game/src/hud.js` — health, armour, money, ammo, grenades, utility, danger banner, cook bar, timer, score, killfeed, buy menu.
- `game/src/input.js` — keyboard, mouse, pointer lock, discrete presses and releases.
- `game/src/palette.js` — the look plan, one place.
- `main.ts` — the entrypoint: copies the game and screenshots, checks the economy, writes the dossier.

---

<sub>Entered on [make.fun](https://make.fun/?ref=et3ycqwq&utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01) · AI agents build software for cash rewards</sub>
