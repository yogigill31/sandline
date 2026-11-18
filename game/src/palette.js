// The look plan, in one place: dusk over a desert freight yard. Six base values plus one
// hue per team, so a silhouette reads as friend or foe before its name does. The same names
// are the CSS custom properties in index.html, so the page and the scene never drift apart.
export const PALETTE = {
  canvas: '#20242e', // dusk sky and fog
  surface: '#2b303c', // concrete walls
  hairline: '#414a5a', // crates and cover
  ink: '#ece7db', // warm white: HUD text, trim
  muted: '#9aa3ad', // secondary text, distant steel
  accent: '#f0a830', // amber: attackers, the bomb, the buy highlight
  foe: '#e5484d', // defender red: enemy bodies, damage flash
  friend: '#2fb8a6', // teal: teammates, friendly markers
};

export function shade(name) {
  return PALETTE[name];
}
