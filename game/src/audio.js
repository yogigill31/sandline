// Sound, synthesized: no audio files, no network, just WebAudio oscillators and filtered
// noise. The context starts on the first user gesture (the click that locks the pointer),
// so a page that loads muted stays muted until the player plays.
export function createAudio() {
  let ctx = null;
  let master = null;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      return true;
    } catch {
      return false;
    }
  }

  function noiseBuffer(duration) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function playNoise(duration, filterFreq, gainValue, decay) {
    if (!ensure()) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(duration);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + decay);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start();
    source.stop(ctx.currentTime + duration);
  }

  function playTone(freq, duration, gainValue, type = 'sine') {
    if (!ensure()) return;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  }

  return {
    unlock() {
      ensure();
    },
    // weaponId picks the shot's character: the rifle cracks, the shotgun booms, the
    // sniper snaps, the pistol pops.
    shot(weaponId, distant) {
      const freq = weaponId === 'shotgun' ? 500 : weaponId === 'sniper' ? 2400 : weaponId === 'smg' ? 1400 : 900;
      playNoise(0.12, freq, distant ? 0.12 : 0.5, 0.1);
      if (!distant) playTone(weaponId === 'shotgun' ? 90 : 160, 0.08, 0.25, 'square');
    },
    reload() {
      playTone(700, 0.05, 0.15, 'square');
      setTimeout(() => playTone(500, 0.05, 0.15, 'square'), 160);
    },
    hit(killed) {
      playTone(killed ? 1320 : 980, 0.07, 0.2, 'sine');
    },
    hurt() {
      playTone(140, 0.15, 0.3, 'sawtooth');
    },
    beep() {
      playTone(1180, 0.09, 0.25, 'square');
    },
    plant() {
      playTone(660, 0.1, 0.2, 'square');
      setTimeout(() => playTone(880, 0.12, 0.2, 'square'), 120);
    },
    // A grenade throw: the pin's metallic click, then the whoosh of the toss. The click
    // is the warning — a player who hears it knows a frag is in the air, which is the
    // counterplay to a throw they cannot see.
    throwGrenade() {
      playTone(2400, 0.03, 0.18, 'square');
      setTimeout(() => playNoise(0.18, 900, 0.2, 0.16), 60);
    },
    // A frag going off: a low boom that carries. `distant` is a throw that exploded
    // far from the player — same shape, a quarter of the volume, so a distant frag
    // reads as distant instead of silent.
    explosion(distant) {
      playNoise(0.5, 220, distant ? 0.15 : 0.6, 0.45);
      playTone(55, 0.4, distant ? 0.15 : 0.5, 'sine');
    },
    // A smoke popping: a soft hiss, no boom. The hiss is the sound of the site
    // disappearing, and it is deliberately quiet — a smoke is cover, not a threat.
    smoke() {
      playNoise(0.8, 3200, 0.12, 0.75);
    },
    // The frag danger tick: two short beeps while a live frag is close to the player
    // and its fuse is burning down. It is the same pitch as the bomb beep, because it
    // means the same thing — move, now.
    danger() {
      playTone(1180, 0.06, 0.2, 'square');
      setTimeout(() => playTone(1180, 0.06, 0.2, 'square'), 110);
    },
    roundEnd(won) {
      const notes = won ? [523, 659, 784] : [392, 330, 262];
      notes.forEach((freq, index) => {
        setTimeout(() => playTone(freq, 0.22, 0.22, 'triangle'), index * 140);
      });
    },
  };
}
