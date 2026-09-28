const typeInto = async (target, text, options = {}) => {
  await click(target);
  if (options.clear !== false) {
    await pressKey("a", ["Control"]);
    await pressKey("Backspace");
  }
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const unshifted = '`1234567890-=[]\\;\',./';
  const random = options.random || Math.random;
  let previous = "";
  for (const character of text) {
    if (previous && options.cadence !== "none") {
      const pause = /[.@\s]/.test(previous) ? [80, 200] : [50, 120];
      await waitMs(pause[0] + Math.floor(random() * (pause[1] - pause[0] + 1)));
    }
    const uppercase = character >= "A" && character <= "Z";
    const symbol = shifted.indexOf(character);
    if (uppercase || symbol !== -1) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
      try {
        await pressKey(uppercase ? character.toLowerCase() : unshifted[symbol], ["Shift"]);
      } finally {
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
      }
    } else {
      await pressKey(character);
    }
    previous = character;
  }
};
