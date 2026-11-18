// Keyboard and mouse, and the pointer lock that turns the mouse into look. Plain browser
// APIs only: the game asks the canvas for pointer lock and reads movementX/Y while it holds
// it. Number keys switch weapons, G throws the selected grenade, Q swaps grenade type, B
// opens the buy menu, E plants or defuses, and the right mouse button scopes the sniper.
// Presses and releases are both tracked as discrete sets: the grenade cook starts on a
// G press and ends on a G release, so the release has to be a first-class event, not a
// key that merely stopped being held.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const state = { keys, locked: false, firing: false, scoping: false, lookX: 0, lookY: 0 };
  const pressed = new Set(); // keys pressed since the last takePressed() call
  const released = new Set(); // keys released since the last takeReleased() call

  function setKey(event, down) {
    if (down) {
      if (!keys.has(event.code)) pressed.add(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
      released.add(event.code);
    }
    if (event.code === 'Space') event.preventDefault();
  }

  window.addEventListener('keydown', (event) => setKey(event, true));
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => {
    keys.clear();
    pressed.clear();
    released.clear();
    state.firing = false;
    state.scoping = false;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.scoping = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.scoping = false;
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      pressed.clear();
      released.clear();
      state.firing = false;
      state.scoping = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    takePressed() {
      const out = new Set(pressed);
      pressed.clear();
      return out;
    },
    // The releases since the last call, drained the same way as the presses. The cook
    // reads this once per frame: a G in the released set is the throw, and a G that
    // never appears is a cook still going.
    takeReleased() {
      const out = new Set(released);
      released.clear();
      return out;
    },
  };
}
