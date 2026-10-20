// Browser helpers with the same signatures as the Kernel browser runtime,
// ported to run in the extension sandbox over DebuggerCdpClient.
//
// Differences from the Kernel runtime are documented on the helper:
//   captureScreenshot returns a data: URL instead of writing to disk.
//   httpGet runs from the extension service worker.

(() => {
  globalThis.xw ??= {};
  const {isInternalUrl} = globalThis.xw.cdpClient;
  const {buildFunctionCallExpression, normalizeJsOptions} = globalThis.xw.pageEvaluation;
  const {resolveUSKey, supportedUSKeyNames} = globalThis.xw.keyboard;

  const SCROLL_COMMAND_TIMEOUT_MS = 5_000;
  const EXECUTION_DEADLINE_MARGIN_MS = 500;

  const SHADOW_HIT_TEST_SOURCE = `
    const composedContains = (ancestor, node) => {
      for (let current = node; current;) {
        if (current === ancestor) return true;
        if (current.parentElement) {
          current = current.parentElement;
          continue;
        }
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : null;
      }
      return false;
    };
    const deepElementFromPoint = (pointX, pointY) => {
      let hit = document.elementFromPoint(pointX, pointY);
      while (hit && hit.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(pointX, pointY);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
  `;

  function optionsObject(raw, helper) {
    if (raw === undefined) return {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${helper}: options must be an object`);
    }
    return raw;
  }

  function rejectUnknownOptions(options, allowed, helper) {
    for (const key of Object.keys(options)) {
      if (!allowed.includes(key)) {
        throw new Error(`${helper}: unknown option: ${key}`);
      }
    }
  }

  function backendNodeId(target, helper) {
    if (!target || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, 'backendNodeId')) {
      return null;
    }
    const id = target.backendNodeId;
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${helper}: backendNodeId must be a positive integer`);
    }
    return id;
  }

  function accessibilityControlState(node) {
    const state = {};
    for (const property of node.properties ?? []) {
      const name = property.name;
      const observed = property.value?.value;
      if (name === 'checked' || name === 'pressed') {
        if (observed === 'mixed') state[name] = 'mixed';
        else if (observed === true || observed === 'true') state[name] = true;
        else if (observed === false || observed === 'false') state[name] = false;
      } else if ((name === 'selected' || name === 'expanded' || name === 'disabled') && typeof observed === 'boolean') {
        state[name] = observed;
      }
    }
    return state;
  }

  function nonNegativeSeconds(value, fallback, helper) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${helper}: timeoutSec must be a non-negative finite number`);
    }
    return value;
  }

  const MODIFIER_SUGAR = {alt: 'Alt', ctrl: 'Control', control: 'Control', meta: 'Meta', shift: 'Shift'};

  function normalizeKeyModifiers(modifiers) {
    if (modifiers === undefined || modifiers === null) return [];
    if (Array.isArray(modifiers)) {
      return modifiers.map((name) => {
        const canonical = MODIFIER_SUGAR[String(name).toLowerCase()];
        if (canonical === undefined) {
          throw new Error(`pressKey: unknown modifier: ${name} (expected Alt, Control, Meta, or Shift)`);
        }
        return canonical;
      });
    }
    if (typeof modifiers === 'object') {
      const out = [];
      for (const [name, on] of Object.entries(modifiers)) {
        if (!on) continue;
        const canonical = MODIFIER_SUGAR[name.toLowerCase()];
        if (canonical === undefined) {
          throw new Error(`pressKey: unknown modifier: ${name} (expected Alt, Control, Meta, or Shift)`);
        }
        if (!out.includes(canonical)) out.push(canonical);
      }
      return out;
    }
    throw new Error('pressKey: modifiers must be an array drawn from Alt, Control, Meta, Shift (or an object like {ctrl: true})');
  }

  const MODIFIER_BITS = {Alt: 1, Control: 2, Meta: 4, Shift: 8};

  const VISIBLE_SOURCE = `(el) => {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }`;

  class BrowserHelpers {
    #client;
    #rpc;
    #platform;

    executionDeadlineMs = null;
    onLog = undefined;

    constructor(client, rpc, platform) {
      this.#client = client;
      this.#rpc = rpc;
      this.#platform = platform;
    }

    #waitDeadline(timeoutMs) {
      const own = Date.now() + timeoutMs;
      const exec = this.executionDeadlineMs;
      if (exec !== null && exec - EXECUTION_DEADLINE_MARGIN_MS < own) {
        return {deadline: exec - EXECUTION_DEADLINE_MARGIN_MS, clamped: true};
      }
      return {deadline: own, clamped: false};
    }

    // Escape hatch + events

    cdp = async (method, params, sessionId) => {
      if (sessionId === null) {
        return this.#client.browserCommand(method, params);
      }
      if (typeof sessionId === 'string') {
        return this.#client.send(method, params, sessionId);
      }
      if (/^(Target|Browser|SystemInfo|Storage)\./.test(method)) {
        return this.#client.browserCommand(method, params);
      }
      return this.#client.sessionCommand(method, params);
    };

    drainEvents = async () => {
      await this.#client.ensureAttached();
      return this.#client.drainEvents();
    };

    waitForEvent = (method, rawOptions) => {
      if (typeof method !== 'string' || method.trim() === '') {
        throw new Error('waitForEvent: method must be a non-empty string');
      }
      const options = optionsObject(rawOptions, 'waitForEvent');
      rejectUnknownOptions(options, ['sessionId', 'timeoutSec', 'predicate'], 'waitForEvent');
      const timeoutSec = nonNegativeSeconds(options.timeoutSec, 30, 'waitForEvent');
      const predicate = options.predicate;
      if (predicate !== undefined && typeof predicate !== 'function') {
        throw new Error('waitForEvent: predicate must be a function');
      }

      let sessionId;
      if (Object.prototype.hasOwnProperty.call(options, 'sessionId')) {
        if (options.sessionId !== null && (typeof options.sessionId !== 'string' || options.sessionId === '')) {
          throw new Error('waitForEvent: sessionId must be a non-empty string or null');
        }
        sessionId = options.sessionId === null ? undefined : options.sessionId;
      } else {
        if (!this.#client.sessionId) {
          throw new Error('waitForEvent: no target is attached; call ensureRealTab() or newTab() before arming a page event');
        }
        sessionId = this.#client.sessionId;
      }

      return this.#client.waitForEvent(method, {sessionId, timeoutMs: timeoutSec * 1000, predicate});
    };

    // Navigation + page state

    gotoUrl = async (url) => {
      return this.#client.sessionCommand('Page.navigate', {url});
    };

    accessibilitySnapshot = async () => {
      await this.#client.ensureAttached();
      const {nodes = []} = await this.#client.sessionCommand('Accessibility.getFullAXTree');
      const info = await this.pageInfo();
      return {
        url: String(info.url ?? ''),
        title: String(info.title ?? ''),
        nodes: nodes
          .filter((node) => !node.ignored && node.backendDOMNodeId)
          .map((node) => ({
            backendNodeId: node.backendDOMNodeId,
            role: String(node.role?.value ?? ''),
            name: String(node.name?.value ?? '').replace(/\s+/g, ' ').trim(),
            ...(node.value ? {value: String(node.value.value)} : {}),
            ...accessibilityControlState(node),
          })),
      };
    };

    pageInfo = async () => {
      const pending = this.#client.pendingDialog;
      if (pending) {
        const info = {dialog: {type: pending.type, message: pending.message}};
        try {
          const targets = await this.#client.listTargets();
          const current = targets.find((t) => t.targetId === this.#client.targetId);
          if (current) {
            info.url = current.url;
            info.title = current.title;
          }
        } catch {
          // Best effort: the dialog itself is the critical payload.
        }
        return info;
      }
      const evalRes = await this.#client.sessionCommand('Runtime.evaluate', {
        expression: `(() => ({
          url: location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scroll: { x: window.scrollX, y: window.scrollY },
          page: {
            width: document.documentElement ? document.documentElement.scrollWidth : 0,
            height: document.documentElement ? document.documentElement.scrollHeight : 0,
          },
          ready_state: document.readyState,
        }))()`,
        returnByValue: true,
      });
      const value = evalRes.result?.value ?? {};
      const dialog = this.#client.pendingDialog;
      return {...value, dialog: dialog ? {type: dialog.type, message: dialog.message} : null};
    };

    // Input

    click = async (target, rawOptions) => {
      const options = optionsObject(rawOptions, 'click');
      rejectUnknownOptions(options, ['button', 'clickCount', 'timeoutSec'], 'click');

      const button = options.button ?? 'left';
      if (button !== 'left' && button !== 'right' && button !== 'middle') {
        throw new Error('click: button must be left, right, or middle');
      }
      const clickCount = options.clickCount ?? 1;
      if (!Number.isInteger(clickCount) || clickCount <= 0) {
        throw new Error('click: clickCount must be a positive integer');
      }

      let point;
      if (typeof target === 'string') {
        if (target.length === 0) throw new Error('click: selector must not be empty');
        point = await this.#waitForClickablePoint(target, nonNegativeSeconds(options.timeoutSec, 10, 'click'));
      } else {
        const nodeId = backendNodeId(target, 'click');
        if (nodeId !== null) {
          point = await this.#waitForClickableBackendNode(nodeId, nonNegativeSeconds(options.timeoutSec, 10, 'click'));
        } else {
          const coordinate = target;
          if (typeof coordinate?.x !== 'number' || !Number.isFinite(coordinate.x) || typeof coordinate?.y !== 'number' || !Number.isFinite(coordinate.y)) {
            throw new Error('click: target must be a selector, accessibility node, or finite {x, y} coordinates');
          }
          if (options.timeoutSec !== undefined) {
            throw new Error('click: timeoutSec is only supported for selector targets or accessibility-node targets');
          }
          point = {x: coordinate.x, y: coordinate.y};
        }
      }

      await this.#client.sessionCommand('Input.dispatchMouseEvent', {type: 'mouseMoved', x: point.x, y: point.y, button: 'none'});
      const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
      for (let count = 1; count <= clickCount; count++) {
        await this.#client.sessionCommand('Input.dispatchMouseEvent', {type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: count});
        await this.#client.sessionCommand('Input.dispatchMouseEvent', {type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: count});
      }
    };

    typeText = async (text) => {
      await this.#client.sessionCommand('Input.insertText', {text});
    };

    fillInput = async (target, text, rawOptions) => {
      if (typeof target === 'string' && target.length === 0) {
        throw new Error('fillInput: selector must be a non-empty string');
      }
      if (typeof target !== 'string' && backendNodeId(target, 'fillInput') === null) {
        throw new Error('fillInput: target must be a selector or accessibility node');
      }
      if (typeof text !== 'string') {
        throw new Error('fillInput: text must be a string');
      }
      const options = optionsObject(rawOptions, 'fillInput');
      rejectUnknownOptions(options, ['clearFirst', 'timeoutSec'], 'fillInput');
      const clearFirst = options.clearFirst ?? true;
      if (typeof clearFirst !== 'boolean') {
        throw new Error('fillInput: clearFirst must be a boolean');
      }
      const timeoutSec = nonNegativeSeconds(options.timeoutSec, 10, 'fillInput');
      if (typeof target === 'string') {
        await this.#waitForFillTarget(target, timeoutSec);
      } else {
        await this.#waitForFillBackendNode(backendNodeId(target, 'fillInput'), timeoutSec);
      }

      if (clearFirst) {
        const modifiers = this.#platform === 'mac' ? 4 : 2;
        const selectAll = {key: 'a', code: 'KeyA', modifiers, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65};
        // macOS Chrome does not run editing shortcuts for synthetic key events; without the
        // explicit command, Meta+A leaves the caret in place and Backspace deletes one character.
        const commands = this.#platform === 'mac' ? {commands: ['selectAll']} : {};
        await this.#client.sessionCommand('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...selectAll, ...commands});
        await this.#client.sessionCommand('Input.dispatchKeyEvent', {type: 'keyUp', ...selectAll});
        await this.pressKey('Backspace');
      }
      for (const char of text) {
        await this.pressKey(char);
      }
      await this.#evaluateInPage(`(() => {
        const el = document.activeElement;
        if (!el) return;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    };

    pressKey = async (key, modifiers) => {
      let modifierBits = 0;
      if (typeof modifiers === 'number') {
        if (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) {
          throw new Error('pressKey: numeric modifiers must be a bitfield from 0 to 15');
        }
        modifierBits = modifiers;
      } else {
        for (const m of normalizeKeyModifiers(modifiers)) {
          modifierBits |= MODIFIER_BITS[m];
        }
      }

      let def;
      try {
        def = resolveUSKey(key, (modifierBits & MODIFIER_BITS.Shift) !== 0);
      } catch {
        throw new Error(`unknown key: ${key} (use one Unicode character or a supported US-layout key such as ${supportedUSKeyNames().slice(0, 20).join(', ')})`);
      }

      const base = {
        code: def.code,
        key: def.key,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: modifierBits,
        location: def.location,
        isKeypad: def.location === 3,
        unmodifiedText: def.unmodifiedText,
      };
      const shortcut = (modifierBits & (1 | 2 | 4)) !== 0;
      const printable = [...def.key].length === 1 && !!def.text && !shortcut;
      await this.#client.sessionCommand('Input.dispatchKeyEvent', {
        ...base,
        type: 'keyDown',
        ...(!printable && def.text && !shortcut ? {text: def.text} : {}),
      });
      if (printable) {
        await this.#client.sessionCommand('Input.dispatchKeyEvent', {...base, type: 'char', text: def.text});
      }
      await this.#client.sessionCommand('Input.dispatchKeyEvent', {...base, type: 'keyUp'});
    };

    scroll = async (x, y, dy = -300, dx = 0) => {
      await this.#client.sessionCommand('Input.dispatchMouseEvent', {type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy}, SCROLL_COMMAND_TIMEOUT_MS);
    };

    // Screenshots

    // Returns a data: URL; the sandbox has no filesystem. maxDim is unsupported.
    captureScreenshot = async (path, fullPage = false, maxDim) => {
      if (maxDim !== undefined) {
        throw new Error('captureScreenshot: maxDim is not supported by the xwebmcp extension');
      }
      const shot = await this.#client.sessionCommand('Page.captureScreenshot', {format: 'png', captureBeyondViewport: fullPage});
      return `data:image/png;base64,${shot.data}`;
    };

    // Tabs

    listTabs = async (includeChrome = true) => {
      const targets = await this.#client.listTargets();
      return targets
        .filter((t) => t.type === 'page')
        .filter((t) => includeChrome || !isInternalUrl(t.url))
        .map((t) => ({targetId: t.targetId, title: t.title, url: t.url}));
    };

    currentTab = async () => {
      await this.#client.ensureAttached();
      const targets = await this.#client.listTargets();
      const current = targets.find((t) => t.targetId === this.#client.targetId);
      if (!current) {
        throw new Error('attached target no longer exists');
      }
      return {targetId: current.targetId, url: current.url, title: current.title};
    };

    #targetId(target) {
      if (typeof target === 'string') return target;
      if (target && typeof target === 'object' && typeof target.targetId === 'string') {
        return target.targetId;
      }
      throw new Error('expected a targetId string or a tab object returned by currentTab/listTabs');
    }

    switchTab = async (target) => {
      return this.#client.attach(this.#targetId(target));
    };

    newTab = async (url = 'about:blank') => {
      if (url !== 'about:blank') {
        const current = await this.currentTab();
        const currentUrl = String(current.url ?? '');
        if (
          currentUrl === '' ||
          currentUrl === 'about:blank' ||
          currentUrl.startsWith('about:blank#') ||
          /^(chrome:\/\/(newtab|new-tab-page)|edge:\/\/newtab|about:newtab)/.test(currentUrl)
        ) {
          const navigation = await this.gotoUrl(url);
          await this.#client.waitForNavigationCommit(current.targetId, navigation, url, 5_000);
          return current.targetId;
        }
      }
      await this.#client.ensureConnected();
      const created = await this.#client.browserCommand('Target.createTarget', {url: 'about:blank'});
      await this.#client.attach(created.targetId);
      if (url !== 'about:blank') {
        const navigation = await this.gotoUrl(url);
        await this.#client.waitForNavigationCommit(created.targetId, navigation, url, 5_000);
      }
      return created.targetId;
    };

    closeTab = async (target) => {
      await this.#client.ensureConnected();
      const id = target === undefined ? this.#client.targetId : this.#targetId(target);
      if (!id) {
        throw new Error('no tab is attached and no target id was provided');
      }
      await this.#client.browserCommand('Target.closeTarget', {targetId: id});
      if (id === this.#client.targetId) {
        this.#client.handleDetached(id);
      }
      await this.#client.waitForTargetGone(id, 5_000);
    };

    ensureRealTab = async () => {
      const tabs = await this.listTabs(false);
      if (tabs.length === 0) return null;
      try {
        const current = await this.currentTab();
        if (!isInternalUrl(String(current.url ?? ''))) return current;
      } catch {
        // No usable attached target; attach the first real page below.
      }
      await this.switchTab(tabs[0]);
      return tabs[0];
    };

    iframeTarget = async (urlSubstring) => {
      const targets = await this.#client.listTargets();
      const match = targets.find((t) => t.type === 'iframe' && t.url.includes(urlSubstring));
      if (!match) return null;
      return {targetId: match.targetId, url: match.url, title: match.title, type: match.type};
    };

    // Waiting

    waitMs = async (milliseconds = 1_000) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    };

    waitForLoad = async (timeoutSec = 15) => {
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      while (Date.now() <= deadline) {
        const res = await this.#client.sessionCommand('Runtime.evaluate', {expression: 'document.readyState', returnByValue: true});
        if (res.result?.value === 'complete') return true;
        await this.waitMs(300);
      }
      return false;
    };

    waitForElement = async (target, rawOptions) => {
      if (typeof target === 'string' && target.length === 0) {
        throw new Error('waitForElement: selector must be a non-empty string');
      }
      if (typeof target !== 'string' && backendNodeId(target, 'waitForElement') === null) {
        throw new Error('waitForElement: target must be a selector or accessibility node');
      }
      const options = optionsObject(rawOptions, 'waitForElement');
      rejectUnknownOptions(options, ['state', 'timeoutSec'], 'waitForElement');
      const state = options.state ?? 'visible';
      if (state !== 'attached' && state !== 'detached' && state !== 'visible' && state !== 'hidden') {
        throw new Error('waitForElement: state must be attached, detached, visible, or hidden');
      }
      const timeoutSec = nonNegativeSeconds(options.timeoutSec, 10, 'waitForElement');
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      for (;;) {
        const found = typeof target === 'string' ? await this.#evaluateInPage(
          `(function elementState(selector, state) {
            const elements = [...document.querySelectorAll(selector)];
            const visible = ${VISIBLE_SOURCE};
            if (state === 'attached') return elements.length > 0;
            if (state === 'detached') return elements.length === 0;
            const visibleCount = elements.filter(visible).length;
            return state === 'visible' ? visibleCount > 0 : visibleCount === 0;
          })(${JSON.stringify(target)}, ${JSON.stringify(state)})`,
        ) : await this.#backendNodeMatchesState(backendNodeId(target, 'waitForElement'), state);
        if (found) return true;
        if (Date.now() >= deadline) return false;
        await this.waitMs(Math.min(100, Math.max(0, deadline - Date.now())));
      }
    };

    waitForNetworkIdle = async (idleSec = 0.5, timeoutSec = 30) => {
      await this.#client.ensureAttached();
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      for (;;) {
        const {inFlight, lastActivity} = this.#client.networkIdleState();
        const now = Date.now();
        if (inFlight === 0 && now - lastActivity >= idleSec * 1000) return true;
        if (now > deadline) return false;
        await this.waitMs(100);
      }
    };

    // JavaScript evaluation + uploads

    js = async (expressionOrFunction, rawOptions) => {
      const options = normalizeJsOptions(rawOptions);
      let expression;
      if (typeof expressionOrFunction === 'string') {
        if (Object.prototype.hasOwnProperty.call(options, 'arg')) {
          throw new Error('js: arg is only supported when evaluating a page function');
        }
        expression = expressionOrFunction;
      } else if (typeof expressionOrFunction === 'function') {
        expression = buildFunctionCallExpression(expressionOrFunction, options.arg);
      } else {
        throw new Error('js: expected a JavaScript expression string or page function');
      }

      if (options.targetId) {
        return this.#client.evaluateOnTarget(options.targetId, expression);
      }
      return this.#evaluateInPage(expression);
    };

    uploadFile = async (target, path) => {
      const paths = typeof path === 'string' ? [path] : path;
      if (!Array.isArray(paths) || paths.length === 0 || paths.some((item) => typeof item !== 'string')) {
        throw new Error('uploadFile requires a local file path or a non-empty array of paths');
      }
      if (typeof target === 'string') {
        if (target.length === 0) throw new Error('uploadFile: selector must be a non-empty string');
        const doc = await this.#client.sessionCommand('DOM.getDocument', {depth: 0});
        const queried = await this.#client.sessionCommand('DOM.querySelector', {nodeId: doc.root.nodeId, selector: target});
        if (!queried.nodeId) {
          throw new Error(`no element matches selector: ${target}`);
        }
        await this.#client.sessionCommand('DOM.setFileInputFiles', {nodeId: queried.nodeId, files: paths});
        return;
      }
      await this.#client.sessionCommand('DOM.setFileInputFiles', {backendNodeId: backendNodeId(target, 'uploadFile'), files: paths});
    };

    // HTTP

    httpGet = async (url, headers, timeoutSec = 20) => {
      if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec < 0) {
        throw new Error('httpGet: timeoutSec must be a non-negative finite number');
      }
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      const timeoutMs = Math.max(0, deadline - Date.now());
      if (timeoutMs === 0) {
        throw new Error(`GET ${url} timed out before it could start`);
      }
      const res = await this.#rpc('http.get', {url, headers: headers ?? {}, timeoutMs});
      if (res.timedOut) throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
      if (!res.ok) throw new Error(`GET ${url} failed with status ${res.status}`);
      return res.text;
    };

    // Internals

    #backendNodeGone(error) {
      return /could not find node|no node with given id|could not resolve backend node/i.test(String(error?.message ?? error));
    }

    async #callOnBackendNode(id, functionDeclaration, args = []) {
      const resolved = await this.#client.sessionCommand('DOM.resolveNode', {backendNodeId: id});
      const objectId = resolved.object?.objectId;
      if (!objectId) throw new Error(`could not resolve backend node ${id}`);
      try {
        const result = await this.#client.sessionCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({value})),
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails || result.result?.subtype === 'error') {
          throw new Error(
            result.result?.description ??
            result.exceptionDetails?.exception?.description ??
            result.exceptionDetails?.text ??
            `backend node ${id} evaluation failed`,
          );
        }
        return result.result?.value;
      } finally {
        try {
          await this.#client.sessionCommand('Runtime.releaseObject', {objectId});
        } catch {
          // The object is already gone when its target closes.
        }
      }
    }

    async #waitForClickableBackendNode(id, timeoutSec) {
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      let lastStatus = 'not found';
      for (;;) {
        try {
          const result = await this.#callOnBackendNode(
            id,
            `async function resolveBackendClickTarget() {
              const el = this;
              if (document.hidden) return { status: 'page hidden (background tab or minimized window); trusted input cannot reach it' };
              const visible = (candidate) => {
                if (!(candidate instanceof Element) || !candidate.isConnected || candidate.getClientRects().length === 0) return false;
                if (typeof candidate.checkVisibility === 'function') {
                  return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                }
                const style = getComputedStyle(candidate);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              };
              if (!visible(el)) return { status: 'not visible' };
              if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { status: 'disabled' };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              const before = el.getBoundingClientRect();
              await new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; resolve(); } }; requestAnimationFrame(() => requestAnimationFrame(finish)); setTimeout(finish, document.hidden ? 50 : 250); });
              if (!visible(el)) return { status: 'detached or hidden' };
              const after = el.getBoundingClientRect();
              const stable =
                Math.abs(before.x - after.x) < 0.25 &&
                Math.abs(before.y - after.y) < 0.25 &&
                Math.abs(before.width - after.width) < 0.25 &&
                Math.abs(before.height - after.height) < 0.25;
              if (!stable) return { status: 'moving' };
              const left = Math.max(0, after.left);
              const right = Math.min(innerWidth, after.right);
              const top = Math.max(0, after.top);
              const bottom = Math.min(innerHeight, after.bottom);
              if (right <= left || bottom <= top) return { status: 'outside viewport' };
              const x = left + (right - left) / 2;
              const y = top + (bottom - top) / 2;
              ${SHADOW_HIT_TEST_SOURCE}
              const hit = deepElementFromPoint(x, y);
              if (!hit || !composedContains(el, hit)) {
                return { status: 'intercepted', hit: hit ? hit.tagName.toLowerCase() : null };
              }
              return { status: 'ready', x, y };
            }`,
          );
          if (result?.status === 'ready' && typeof result.x === 'number' && typeof result.y === 'number') {
            return {x: result.x, y: result.y};
          }
          lastStatus = result?.status ?? 'not actionable';
        } catch (error) {
          if (!this.#backendNodeGone(error)) throw error;
          lastStatus = 'not found';
        }
        if (Date.now() >= deadline) {
          throw new Error(`click: backend node ${id} was not actionable within ${timeoutSec}s (${lastStatus})`);
        }
        await this.waitMs(Math.min(50, Math.max(0, deadline - Date.now())));
      }
    }

    async #waitForFillBackendNode(id, timeoutSec) {
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      let lastStatus = 'not found';
      for (;;) {
        try {
          const result = await this.#callOnBackendNode(
            id,
            `function resolveBackendFillTarget() {
              const el = this;
              const visible = (candidate) => {
                if (!(candidate instanceof Element) || !candidate.isConnected || candidate.getClientRects().length === 0) return false;
                if (typeof candidate.checkVisibility === 'function') {
                  return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                }
                const style = getComputedStyle(candidate);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              };
              if (!visible(el)) return { status: 'not visible' };
              if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { status: 'disabled' };
              const tag = el.tagName;
              const inputType = tag === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
              const textInput = tag === 'INPUT' && ![
                'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
              ].includes(inputType);
              const editable = ((textInput || tag === 'TEXTAREA') && !el.readOnly) || el.isContentEditable;
              if (!editable) return { status: 'not editable' };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              el.focus();
              if (!el.isConnected || (document.activeElement !== el && !el.contains(document.activeElement))) {
                return { status: 'could not focus' };
              }
              return { status: 'ready' };
            }`,
          );
          if (result?.status === 'ready') return;
          lastStatus = result?.status ?? 'not editable';
        } catch (error) {
          if (!this.#backendNodeGone(error)) throw error;
          lastStatus = 'not found';
        }
        if (Date.now() >= deadline) {
          throw new Error(`fillInput: backend node ${id} was not editable within ${timeoutSec}s (${lastStatus})`);
        }
        await this.waitMs(Math.min(50, Math.max(0, deadline - Date.now())));
      }
    }

    async #backendNodeMatchesState(id, state) {
      try {
        return Boolean(await this.#callOnBackendNode(
          id,
          `function backendNodeMatchesState(state) {
            const el = this;
            const attached = el instanceof Element && el.isConnected;
            if (state === 'attached') return attached;
            if (state === 'detached') return !attached;
            if (!attached || el.getClientRects().length === 0) return state === 'hidden';
            let visible;
            if (typeof el.checkVisibility === 'function') {
              visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            } else {
              const style = getComputedStyle(el);
              visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }
            return state === 'visible' ? visible : !visible;
          }`,
          [state],
        ));
      } catch (error) {
        if (!this.#backendNodeGone(error)) throw error;
        return state === 'detached' || state === 'hidden';
      }
    }

    async #waitForClickablePoint(selector, timeoutSec) {
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      let lastStatus = 'not found';
      for (;;) {
        const result = await this.#evaluateInPage(
          `(async function resolveClickTarget(selector) {
            if (document.hidden) return { status: 'page hidden (background tab or minimized window); trusted input cannot reach it' };
            const visible = ${VISIBLE_SOURCE};
            const candidates = [...document.querySelectorAll(selector)].filter(visible);
            if (candidates.length === 0) return { status: 'not visible' };
            if (candidates.length > 1) return { status: 'multiple', count: candidates.length };
            const el = candidates[0];
            if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') {
              return { status: 'disabled' };
            }
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const before = el.getBoundingClientRect();
            await new Promise(resolve => { let done = false; const finish = () => { if (!done) { done = true; resolve(); } }; requestAnimationFrame(() => requestAnimationFrame(finish)); setTimeout(finish, document.hidden ? 50 : 250); });
            if (!el.isConnected || !visible(el)) return { status: 'detached or hidden' };
            const after = el.getBoundingClientRect();
            const stable =
              Math.abs(before.x - after.x) < 0.25 &&
              Math.abs(before.y - after.y) < 0.25 &&
              Math.abs(before.width - after.width) < 0.25 &&
              Math.abs(before.height - after.height) < 0.25;
            if (!stable) return { status: 'moving' };
            const left = Math.max(0, after.left);
            const right = Math.min(innerWidth, after.right);
            const top = Math.max(0, after.top);
            const bottom = Math.min(innerHeight, after.bottom);
            if (right <= left || bottom <= top) return { status: 'outside viewport' };
            const x = left + (right - left) / 2;
            const y = top + (bottom - top) / 2;
            ${SHADOW_HIT_TEST_SOURCE}
            const hit = deepElementFromPoint(x, y);
            if (!hit || !composedContains(el, hit)) {
              return { status: 'intercepted', hit: hit ? hit.tagName.toLowerCase() : null };
            }
            return { status: 'ready', x, y };
          })(${JSON.stringify(selector)})`,
        );

        if (result?.status === 'ready' && typeof result.x === 'number' && typeof result.y === 'number') {
          return {x: result.x, y: result.y};
        }
        if (result?.status === 'multiple') {
          throw new Error(`click: selector ${JSON.stringify(selector)} matches ${result.count} visible elements; use a more specific selector`);
        }
        lastStatus = result?.status ?? 'not actionable';
        if (Date.now() >= deadline) {
          throw new Error(`click: selector ${JSON.stringify(selector)} was not actionable within ${timeoutSec}s (${lastStatus})`);
        }
        await this.waitMs(Math.min(50, Math.max(0, deadline - Date.now())));
      }
    }

    async #waitForFillTarget(selector, timeoutSec) {
      const {deadline} = this.#waitDeadline(timeoutSec * 1000);
      let lastStatus = 'not found';
      for (;;) {
        const result = await this.#evaluateInPage(
          `(function resolveFillTarget(selector) {
            const visible = ${VISIBLE_SOURCE};
            const candidates = [...document.querySelectorAll(selector)].filter(visible);
            if (candidates.length === 0) return { status: 'not visible' };
            if (candidates.length > 1) return { status: 'multiple', count: candidates.length };
            const el = candidates[0];
            if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') {
              return { status: 'disabled' };
            }
            const tag = el.tagName;
            const inputType = tag === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
            const textInput = tag === 'INPUT' && ![
              'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
            ].includes(inputType);
            const editable =
              ((textInput || tag === 'TEXTAREA') && !el.readOnly) ||
              el.isContentEditable;
            if (!editable) return { status: 'not editable' };
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            el.focus();
            if (!el.isConnected || (document.activeElement !== el && !el.contains(document.activeElement))) {
              return { status: 'could not focus' };
            }
            return { status: 'ready' };
          })(${JSON.stringify(selector)})`,
        );

        if (result?.status === 'ready') return;
        if (result?.status === 'multiple') {
          throw new Error(`fillInput: selector ${JSON.stringify(selector)} matches ${result.count} visible elements; use a more specific selector`);
        }
        lastStatus = result?.status ?? 'not editable';
        if (Date.now() >= deadline) {
          throw new Error(`fillInput: selector ${JSON.stringify(selector)} was not editable within ${timeoutSec}s (${lastStatus})`);
        }
        await this.waitMs(Math.min(50, Math.max(0, deadline - Date.now())));
      }
    }

    async #evaluateInPage(expression) {
      await this.#client.ensureAttached();
      return this.#client.evaluate(this.#client.sessionId, expression);
    }
  }

  const helperNames = Object.freeze([
    'cdp', 'drainEvents', 'waitForEvent', 'gotoUrl', 'pageInfo', 'accessibilitySnapshot', 'click', 'typeText',
    'fillInput', 'pressKey', 'scroll', 'captureScreenshot', 'listTabs', 'currentTab', 'switchTab', 'newTab',
    'closeTab', 'ensureRealTab', 'iframeTarget', 'waitMs', 'waitForLoad', 'waitForElement', 'waitForNetworkIdle',
    'js', 'uploadFile', 'httpGet',
  ]);

  function buildBrowserGlobals(helpers) {
    const namespace = Object.fromEntries(helperNames.map((name) => [name, helpers[name]]));
    const browser = Object.freeze({...namespace});
    return {browser, ...namespace};
  }

  globalThis.xw.browserHelpers = {BrowserHelpers, helperNames, buildBrowserGlobals};
})();
