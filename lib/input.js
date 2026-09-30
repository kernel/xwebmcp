const typeInto = async (target, text, options = {}) => {
  await click(target);
  if (options.clear !== false) {
    // Control+A is select-all on Linux/Windows but not macOS, and macOS Chrome runs no editing
    // shortcuts for synthetic key events. The explicit selectAll command works on every platform.
    const keyA = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2, location: 1 });
    try {
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyA, commands: ["selectAll"] });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...keyA });
    } finally {
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0, location: 1 });
    }
    await pressKey("Backspace");
    const leftover = () => js(() => {
      const e = document.activeElement;
      if (!e) return null;
      if (typeof e.value === "string") return e.value;
      return e.isContentEditable ? e.textContent : null;
    });
    if (await leftover()) {
      await js(() => {
        const e = document.activeElement;
        if (typeof e.select === "function") e.select();
        else window.getSelection().selectAllChildren(e);
      });
      await pressKey("Backspace");
      const rest = await leftover();
      if (rest) throw new Error("typeInto: could not clear the field, it still holds " + rest.length + " character(s)");
    }
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
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8, location: 1 });
      try {
        await pressKey(uppercase ? character.toLowerCase() : unshifted[symbol], ["Shift"]);
      } finally {
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, location: 1 });
      }
    } else {
      await pressKey(character);
    }
    previous = character;
  }
};
