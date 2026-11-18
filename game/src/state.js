// The one state store: every number the game, the HUD and the bots read lives here, and
// nothing else keeps a copy of it. main.js steps the simulation; the modules below mutate
// this object through the helpers, never through their own counters.
//
// Phases: 'menu' (overlay up, world idle) -> 'buy' (15 s, buy menu open) -> 'live' (round
// running) -> 'roundEnd' (3 s banner, then next buy phase or match end) -> 'matchEnd'.
// The player is always on the attacking team; the defending team is bots only.

export const PHASE = {
  MENU: 'menu',
  BUY: 'buy',
  LIVE: 'live',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
};

export const MATCH_TARGET = 8; // first team to 8 rounds takes the match
export const MAX_ROUNDS = 15; // a 7-7 split ends in a draw
export const ROUND_SECONDS = 100;
export const BUY_SECONDS = 15;
export const BOMB_SECONDS = 35;
export const PLANT_SECONDS = 3.5;
export const DEFUSE_SECONDS = 5;
export const ROUND_END_SECONDS = 3.5;
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const PLANT_REWARD = 300;
// Post-opening rebalance: a round win pays $3,400 because that is exactly a rifle
// ($2,700) plus a vest ($600) with $100 spare — a win always funds a full rebuy, and
// the grenades on top come from kill and plant bonuses. A loss pays $2,000, which funds
// an SMG ($1,300) and a vest ($600) with $100 spare, or a grenade pair on a saved rifle.
// Before this revision the win paid $3,250 (a rifle and a vest, but nothing spare) and
// the loss $1,900 (an SMG and a vest left the buyer $50 short). The numbers are chosen
// so the buy menu's prices and the round payouts line up with no dead money.
export const WIN_REWARD = 3400;
export const LOSS_REWARD = 2000;
export const LOSS_STREAK_BONUS = 500; // per consecutive loss, at most two streaks

export function createState() {
  return {
    phase: PHASE.MENU,
    round: 1,
    score: { atk: 0, def: 0 },
    lossStreak: 0, // consecutive rounds the attackers lost
    money: START_MONEY,
    timer: BUY_SECONDS, // seconds left in the current phase
    bomb: {
      state: 'idle', // idle | planting | planted | defusing | defused | exploded
      site: null, // 'A' | 'B'
      position: null, // { x, z } where the bomb sits once planted
      fuse: 0, // seconds left once planted
      progress: 0, // 0..1 while planting or defusing
      carrier: null, // agent doing the plant/defuse, or null
    },
    player: {
      alive: true,
      health: 100,
      armor: 0,
      weapon: 'rifle',
      grenades: { frag: 0, smoke: 0 },
      selectedGrenade: 'frag',
      kills: 0,
      deaths: 0,
    },
    feed: [], // killfeed lines, newest first: { text, good }
    events: [], // one-frame sound events for the bots: { kind, x, z, radius }
    // Utility thrown this round, per team: combat.throwGrenade records every bot throw
    // here, main.js resets it at the start of a round and reports it at the end. The
    // player throws into the same counts through the same function, so the summary
    // covers the whole round's grenade use, not just the bots'.
    utility: { atk: { frag: 0, smoke: 0 }, def: { frag: 0, smoke: 0 } },
    // Utility thrown this match, per team — the same recordUtility call that feeds the
    // per-round counts also feeds this one, so the match-end overlay can report the
    // whole match's grenade use beside the frag damage. It resets in startMatch,
    // never in startRound.
    matchUtility: { atk: { frag: 0, smoke: 0 }, def: { frag: 0, smoke: 0 } },
    // Frag damage dealt this match, per team — combat.explode records it, endMatch
    // reports it. Separate from the per-round utility counts, which reset every round.
    fragDamage: { atk: 0, def: 0 },
    winner: null, // 'atk' | 'def' | 'draw' once a round or the match ends
    roundResult: '', // human line for the round-end banner
    time: 0, // seconds since the match started
  };
}

// Money for a round result. Called once, at the end of the round, by the round controller.
export function roundPayout(state, attackersWon) {
  if (attackersWon) {
    state.money += WIN_REWARD;
    state.lossStreak = 0;
  } else {
    state.money += LOSS_REWARD + Math.min(2, state.lossStreak) * LOSS_STREAK_BONUS;
    state.lossStreak += 1;
  }
}

export function pushFeed(state, text, good) {
  state.feed.unshift({ text, good });
  if (state.feed.length > 5) state.feed.length = 5;
}

export function pushEvent(state, kind, x, z, radius) {
  state.events.push({ kind, x, z, radius });
}

// Record one grenade throw in the round's utility counts. The thrower is a bot or the
// player; both count, because the round-end summary is about the round, not the thrower.
// The same call feeds the match totals, so the two can never disagree with each other.
export function recordUtility(state, team, kind) {
  const side = state.utility[team];
  if (!side || (kind !== 'frag' && kind !== 'smoke')) return;
  side[kind] += 1;
  state.matchUtility[team][kind] += 1;
}

// Fresh utility counts for a new round. main.js calls this from startRound, beside the
// feed reset, so a round never reports the previous round's throws.
export function resetUtility(state) {
  state.utility = { atk: { frag: 0, smoke: 0 }, def: { frag: 0, smoke: 0 } };
}

// Record frag damage for the match summary. Only frags count here — smoke deals none —
// and the amount is the damage after falloff and the through-wall reduction, so the
// total is the damage the frags actually did.
export function recordFragDamage(state, team, amount) {
  if (state.fragDamage[team] === undefined || amount <= 0) return;
  state.fragDamage[team] += amount;
}

// One line describing the round's utility, for the feed and the HUD. The format is
// fixed — "ATK 2 frag 1 smoke · DEF 1 frag 0 smoke" — so the round-end feed line and
// the live HUD line always agree with each other, and the playtest can match on it.
export function utilitySummary(state) {
  const utility = state.utility;
  return `ATK ${utility.atk.frag} frag ${utility.atk.smoke} smoke · DEF ${utility.def.frag} frag ${utility.def.smoke} smoke`;
}

// One line describing the match's frag damage, for the match-end overlay. The numbers
// are the effective damage — capped at what the victims could actually lose — so a
// frag that overkills a 10-health enemy counts 10, not 120.
export function fragDamageSummary(state) {
  return `Frag damage this match — ATK ${Math.round(state.fragDamage.atk)} · DEF ${Math.round(state.fragDamage.def)}.`;
}

// One line describing the match's utility, for the match-end overlay. The format is
// the same as the round summary, so the two read as one report.
export function matchUtilitySummary(state) {
  const utility = state.matchUtility;
  return `Utility this match — ATK ${utility.atk.frag} frag ${utility.atk.smoke} smoke · DEF ${utility.def.frag} frag ${utility.def.smoke} smoke.`;
}
