// CDP client with the surface the Kernel browser helpers expect, backed by
// chrome.debugger through the service worker instead of a WebSocket.
//
// A chrome.debugger session per target replaces Kernel's single browser
// connection. The attached tab's page session is the "root" session; it has
// no CDP session id in chrome.debugger, so the client mints one
// (`root:<targetId>`) so that waitForEvent, cdp(method, params, sessionId), and
// event.sessionId behave exactly as they do in the Kernel runtime. Out-of-
// process iframes attached through Target.setAutoAttach keep their real flat
// session ids.

(() => {
  globalThis.xw ??= {};

  const EVENT_RING_CAPACITY = 500;
  const COMMAND_TIMEOUT_MS = 30_000;
  const COMMAND_DEADLINE_MARGIN_MS = 500;
  const ENABLE_DOMAINS_BUDGET_MS = 10_000;
  const ENABLE_DOMAIN_COMMAND_TIMEOUT_MS = 5_000;
  const DIALOG_DISMISS_TIMEOUT_MS = 5_000;

  const INTERNAL_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'chrome-untrusted://', 'devtools://', 'edge://', 'about:'];

  function isInternalUrl(url) {
    return INTERNAL_URL_PREFIXES.some((p) => url.startsWith(p));
  }

  class CdpCommandTimeoutError extends Error {
    cdpCommandTimeout = true;
  }

  function isCdpCommandTimeout(err) {
    return err instanceof CdpCommandTimeoutError || err?.cdpCommandTimeout === true;
  }

  function rootSessionId(targetId) {
    return `root:${targetId}`;
  }

  class DebuggerCdpClient {
    #rpc;
    #events = [];
    #eventWaiters = new Set();
    #attachedTargets = new Set();
    #inFlightRequests = new Set();
    #lastNetworkActivity = 0;
    #rendererResponsive = true;
    #closed = false;

    sessionId = null;
    targetId = null;
    pendingDialog = null;
    onDialogAutoDismissed = undefined;
    executionDeadlineMs = null;

    // rpc(method, params) resolves with the service worker's result or rejects
    // with an Error carrying its message.
    constructor(rpc) {
      this.#rpc = rpc;
    }

    get connected() {
      return !this.#closed;
    }

    async ensureConnected() {
      if (this.#closed) throw new Error('the invocation has finished');
    }

    // Events arrive from the service worker for every target this invocation
    // attached to. Root-session events carry the minted root session id.
    handleEvent({method, params, sessionId, targetId, time}) {
      if (!this.#attachedTargets.has(targetId)) return;
      const resolvedSessionId = sessionId ?? rootSessionId(targetId);
      const event = {method, params, sessionId: resolvedSessionId, time: time ?? Date.now()};
      this.#events.push(event);
      if (this.#events.length > EVENT_RING_CAPACITY) {
        this.#events.splice(0, this.#events.length - EVENT_RING_CAPACITY);
      }

      if (resolvedSessionId === this.sessionId) {
        if (method === 'Page.javascriptDialogOpening') {
          this.pendingDialog = {type: params?.type ?? 'alert', message: params?.message ?? '', since: Date.now()};
        } else if (method === 'Page.javascriptDialogClosed') {
          this.pendingDialog = null;
        }
      }

      if (method.startsWith('Network.') && resolvedSessionId === this.sessionId) {
        this.#lastNetworkActivity = Date.now();
        const requestId = params?.requestId;
        if (method === 'Network.requestWillBeSent' && requestId) {
          this.#inFlightRequests.add(requestId);
        } else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && requestId) {
          this.#inFlightRequests.delete(requestId);
        }
      }

      if (method === 'Target.detachedFromTarget' && params?.sessionId && params.sessionId === this.sessionId) {
        this.sessionId = null;
        this.targetId = null;
        this.pendingDialog = null;
      }

      for (const waiter of [...this.#eventWaiters]) {
        if (waiter.method !== method || waiter.sessionId !== resolvedSessionId) continue;
        try {
          if (!waiter.predicate || waiter.predicate(event)) waiter.accept(event);
        } catch (err) {
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    handleDetached(targetId) {
      this.#attachedTargets.delete(targetId);
      if (targetId === this.targetId) {
        this.sessionId = null;
        this.targetId = null;
        this.pendingDialog = null;
      }
    }

    waitForEvent(method, options = {}) {
      const {timeout} = this.#effectiveCommandTimeout(options.timeoutMs);
      if (timeout <= 0) return Promise.resolve(null);

      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, event) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#eventWaiters.delete(waiter);
          if (error) reject(error);
          else resolve(event ?? null);
        };
        const waiter = {
          method,
          sessionId: options.sessionId,
          predicate: options.predicate,
          accept: (event) => finish(undefined, event),
          reject: (error) => finish(error),
        };
        const timer = setTimeout(() => finish(undefined, null), timeout);
        this.#eventWaiters.add(waiter);
      });
    }

    // Browser-level commands have no browser target in chrome.debugger; they go
    // to the attached page target without a session id, which is where
    // Target.createTarget / Target.closeTarget are answered.
    async browserCommand(method, params) {
      await this.ensureAttached();
      return this.#send(this.targetId, undefined, method, params);
    }

    async sessionCommand(method, params, timeoutMs) {
      await this.ensureAttached();
      if (!this.#rendererResponsive) {
        this.#rendererResponsive = await this.#enableDomains(this.targetId);
      }
      return this.#send(this.targetId, undefined, method, params, timeoutMs);
    }

    // send routes by session id: the minted root id targets the tab's page
    // session, a real flat session id targets an attached child target, and no
    // session id is browser-level.
    async send(method, params, sessionId, timeoutMs) {
      if (sessionId === undefined) return this.browserCommand(method, params);
      if (typeof sessionId === 'string' && sessionId.startsWith('root:')) {
        return this.#send(sessionId.slice('root:'.length), undefined, method, params, timeoutMs);
      }
      await this.ensureAttached();
      return this.#send(this.targetId, sessionId, method, params, timeoutMs);
    }

    async #send(targetId, sessionId, method, params, timeoutMs) {
      await this.ensureConnected();
      const {timeout, clampedByDeadline} = this.#effectiveCommandTimeout(timeoutMs);
      const rendererHint = !this.#rendererResponsive
        ? ' (the page renderer is unresponsive — a modal JavaScript dialog may be blocking it; ' +
          'recover with cdp("Page.handleJavaScriptDialog", { accept: true }) or cdp("Page.reload"))'
        : '';
      if (timeout <= 0) {
        throw new CdpCommandTimeoutError(`CDP ${method} could not run: the execution deadline has already been reached${rendererHint}`);
      }
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          let message = `CDP ${method} timed out after ${timeout}ms`;
          if (clampedByDeadline) message += ' (bounded by the execution timeout)';
          message += rendererHint;
          reject(new CdpCommandTimeoutError(message));
        }, timeout);
      });
      try {
        const result = await Promise.race([
          this.#rpc('cdp.send', {targetId, sessionId, method, params}),
          timeoutPromise,
        ]);
        this.#attachedTargets.add(targetId);
        return result;
      } catch (err) {
        if (isCdpCommandTimeout(err)) throw err;
        throw new Error(`CDP ${method} failed: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }

    #effectiveCommandTimeout(overrideMs) {
      let timeout = overrideMs ?? COMMAND_TIMEOUT_MS;
      const exec = this.executionDeadlineMs;
      if (exec !== null) {
        const remaining = exec - COMMAND_DEADLINE_MARGIN_MS - Date.now();
        if (remaining < timeout) return {timeout: remaining, clampedByDeadline: true};
      }
      return {timeout, clampedByDeadline: false};
    }

    async listTargets() {
      await this.ensureConnected();
      const targets = await this.#rpc('cdp.targets', {});
      return targets.map((t) => ({
        targetId: t.targetId,
        type: t.type,
        title: t.title ?? '',
        url: t.url ?? '',
        attached: !!t.attached,
        tabId: t.tabId,
      }));
    }

    async attach(targetId) {
      await this.ensureConnected();
      if (this.targetId === targetId && this.sessionId) {
        return this.sessionId;
      }
      const previousTargetId = this.targetId;
      await this.#rpc('cdp.attach', {targetId});
      this.#attachedTargets.add(targetId);
      this.sessionId = rootSessionId(targetId);
      this.targetId = targetId;
      this.pendingDialog = null;
      this.#inFlightRequests.clear();
      this.#lastNetworkActivity = Date.now();
      try {
        await this.#send(targetId, undefined, 'Target.activateTarget', {targetId});
      } catch {
        // Activation can be rejected for some target types.
      }
      this.#rendererResponsive = await this.#enableDomains(targetId);
      await this.#dismissStaleDialog();
      if (previousTargetId && previousTargetId !== targetId) {
        try {
          await this.#rpc('cdp.detach', {targetId: previousTargetId});
        } catch {
          // Best effort.
        }
        this.#attachedTargets.delete(previousTargetId);
      }
      return this.sessionId;
    }

    async #enableDomains(targetId) {
      const start = Date.now();
      for (const method of ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable']) {
        const remaining = ENABLE_DOMAINS_BUDGET_MS - (Date.now() - start);
        if (remaining <= 0) return false;
        try {
          await this.#send(targetId, undefined, method, undefined, Math.min(remaining, ENABLE_DOMAIN_COMMAND_TIMEOUT_MS));
        } catch (err) {
          if (isCdpCommandTimeout(err)) return false;
        }
      }
      try {
        await this.#send(targetId, undefined, 'Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, ENABLE_DOMAIN_COMMAND_TIMEOUT_MS);
      } catch {
        // Child frames stay unattached; top-level automation still works.
      }
      return true;
    }

    async #dismissStaleDialog() {
      if (!this.sessionId) return;
      if (this.#rendererResponsive && !this.pendingDialog) return;
      let dismissed = null;
      try {
        await this.#send(this.targetId, undefined, 'Page.handleJavaScriptDialog', {accept: true}, DIALOG_DISMISS_TIMEOUT_MS);
        dismissed = this.pendingDialog ?? {type: 'unknown', message: '', since: Date.now()};
      } catch {
        // No dialog showing, or it could not be answered in time.
      }
      if (dismissed) {
        this.pendingDialog = null;
        this.onDialogAutoDismissed?.(dismissed);
        if (!this.#rendererResponsive) {
          this.#rendererResponsive = await this.#enableDomains(this.targetId);
        }
      }
    }

    async ensureAttached() {
      await this.ensureConnected();
      if (this.sessionId && this.targetId) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const targets = await this.listTargets();
        const pages = targets.filter((t) => t.type === 'page');
        const pick =
          pages.find((t) => t.targetId === this.targetId) ??
          pages.find((t) => !isInternalUrl(t.url)) ??
          pages[0];
        if (!pick) break;
        try {
          await this.attach(pick.targetId);
          return;
        } catch (err) {
          if (attempt === 0 && String(err?.message ?? err).includes('No target with given id')) continue;
          throw err;
        }
      }
      const created = await this.#rpc('tabs.create', {url: 'about:blank'});
      await this.attach(created.targetId);
    }

    async waitForNavigationCommit(targetId, navigation, expectedUrl, timeoutMs) {
      if (this.targetId !== targetId || !this.sessionId) {
        throw new Error(`cannot wait for navigation: target ${targetId} is not attached`);
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const {frameTree} = await this.#send(this.targetId, undefined, 'Page.getFrameTree', undefined, 1_000);
          const frame = frameTree?.frame;
          if (frame?.id === navigation.frameId && (navigation.loaderId ? frame.loaderId === navigation.loaderId : frame.url === expectedUrl)) {
            return;
          }
        } catch {
          // Renderer busy or target gone; keep polling until the deadline.
        }
        if (Date.now() >= deadline) {
          throw new Error(`navigation to ${JSON.stringify(expectedUrl)} did not commit within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async waitForTargetGone(targetId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const targets = await this.listTargets();
          if (!targets.some((t) => t.targetId === targetId)) return;
        } catch {
          return;
        }
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async ensureRealTab() {
      await this.ensureAttached();
      const targets = await this.listTargets();
      const current = targets.find((t) => t.targetId === this.targetId);
      if (current && current.type === 'page' && !isInternalUrl(current.url)) return current;
      const real = targets.find((t) => t.type === 'page' && !isInternalUrl(t.url));
      if (real) {
        await this.attach(real.targetId);
        return real;
      }
      const created = await this.#rpc('tabs.create', {url: 'about:blank'});
      await this.attach(created.targetId);
      const after = await this.listTargets();
      return after.find((t) => t.targetId === created.targetId) ?? {targetId: created.targetId, type: 'page', title: '', url: 'about:blank', attached: true};
    }

    async evaluateOnTarget(targetId, expression) {
      await this.ensureConnected();
      const owned = !this.#attachedTargets.has(targetId);
      if (owned) {
        await this.#rpc('cdp.attach', {targetId});
        this.#attachedTargets.add(targetId);
      }
      try {
        const res = await this.#send(targetId, undefined, 'Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
        return decodeEvaluation(res);
      } finally {
        if (owned) {
          try {
            await this.#rpc('cdp.detach', {targetId});
          } catch {
            // ignore
          }
          this.#attachedTargets.delete(targetId);
        }
      }
    }

    async evaluate(sessionId, expression) {
      const res = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
      return decodeEvaluation(res);
    }

    drainEvents() {
      const events = this.#events;
      this.#events = [];
      return events;
    }

    networkIdleState() {
      return {inFlight: this.#inFlightRequests.size, lastActivity: this.#lastNetworkActivity};
    }

    close() {
      this.#closed = true;
      const err = new Error('the invocation has finished');
      for (const waiter of [...this.#eventWaiters]) waiter.reject(err);
      this.#eventWaiters.clear();
    }
  }

  function decodeEvaluation(evalRes) {
    if (evalRes.exceptionDetails || evalRes.result?.subtype === 'error') {
      const desc =
        evalRes.result?.description ??
        evalRes.exceptionDetails?.exception?.description ??
        evalRes.exceptionDetails?.text ??
        'evaluation failed';
      throw new Error(desc);
    }
    if ('value' in (evalRes.result ?? {})) {
      return evalRes.result.value;
    }
    return decodeUnserializable(evalRes.result?.unserializableValue);
  }

  function decodeUnserializable(value) {
    if (value === 'NaN') return Number.NaN;
    if (value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (value === '-0') return -0;
    if (typeof value === 'string' && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    return undefined;
  }

  globalThis.xw.cdpClient = {isInternalUrl, CdpCommandTimeoutError, isCdpCommandTimeout, rootSessionId, DebuggerCdpClient};
})();
