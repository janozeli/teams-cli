import { ACTIVITY_VIEW_STYLE } from "./activity-view-style.js";

/** Installed in each document context; only the main document mounts the view. */
export const INSTALL_ACTIVITY_VIEW = String.raw`(config) => {
  if (typeof document === 'undefined') return { installed: false };
  const old = globalThis.__teamsCliGate;
  if (old && !old.closed && old.operationId !== config.operationId) throw Error('TEAMS_CLI:UI_BUSY:Another operation owns the activity view');
  if (old && old.operationId === config.operationId && !old.closed) {
    old.update(config);
    return { installed: true };
  }
  let depth = 0, interrupted = !!config.interrupted, mode = config.state || 'open', leaseAt = performance.now(), stepId, host, shadow, timer, resizeObserver, cursor, panel;
  let expected = [], scrollTargets = [];
  let commandId = config.commandId, commandRevision = config.commandRevision || 0, commandActive = config.commandActive !== false;
  let generation = 0, controlSeq = 0, phase = config.phase, countdownRemainingMs = config.countdownRemainingMs;
  const clockId = 'document-' + performance.timeOrigin;
  const handlers = [];
  const describe = el => {
    if (!el || !el.getAttribute) return {};
    const out = { tag: String(el.tagName || '').toLowerCase() };
    for (const [key, attr] of [['role','role'], ['tid','data-tid'], ['testId','data-testid']]) {
      const v = el.getAttribute(attr); if (v && v.length <= 160) out[key] = v;
    }
    return out;
  };
  const emit = (kind, data = {}) => {
    try { globalThis[config.binding](JSON.stringify({ operationId: config.operationId, kind, stepId,
      timestamp: new Date(performance.timeOrigin + performance.now()).toISOString(), clockId, controlSeq, ...data })); }
    catch { interrupted = true; mode = 'lost'; }
  };
  const fail = () => { throw Error('TEAMS_CLI:COMMAND_INTERRUPTED:The command was interrupted; pending steps cannot execute'); };
  // Coordinates are visual-only; neither text nor DOM geometry enters the trace.
  const point = (x, y) => {
    if (!cursor || mode !== 'open' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < 0 || x > innerWidth || y < (panel?.getBoundingClientRect().bottom || 0) || y > innerHeight) {
      cursor.hidden = true; return;
    }
    cursor.style.left = (x - 6) + 'px'; cursor.style.top = (y - 6) + 'px'; cursor.hidden = false;
  };
  const pointAt = target => {
    const r = target?.getBoundingClientRect?.();
    if (r && r.width && r.height) point(r.left + r.width / 2, r.top + r.height / 2);
  };
  const api = {
    operationId: config.operationId, closed: false,
    assert() { if (interrupted || !commandActive || api.closed || mode === 'cancelled' || mode === 'waiting') fail(); },
    capture() {
      const capturedId = commandId, capturedGeneration = generation;
      const assert = () => { if (capturedId !== commandId || capturedGeneration !== generation) fail(); api.assert(); };
      return { assert, act(action, fn, target) { assert(); return api.act(action, fn, target); } };
    },
    beginStep(id, owner) { if (owner !== undefined && owner !== commandId) fail(); api.assert(); stepId = id; },
    act(action, fn, target) {
      api.assert();
      if (action === 'scroll') scrollTargets.push({ target, until: performance.now() + 1000, stepId });
      pointAt(target);
      depth++;
      emit('agent.action.started', { action, target: describe(target) });
      try { const result = fn(); pointAt(target); emit('agent.action.completed', { action, target: describe(target) }); return result; }
      finally { depth--; }
    },
    expectInput(method, params) {
      api.assert(); expected = [];
      const add = (type, match = {}) => expected.push({ type, ...match, until: performance.now() + 1000, stepId });
      if (method === 'Input.dispatchMouseEvent') {
        point(params.x, params.y);
        const match = { x: params.x, y: params.y };
        if (params.type === 'mouseMoved') add('pointermove', match);
        if (params.type === 'mousePressed') add('pointerdown', match);
        if (params.type === 'mouseReleased') { add('pointerup', match); add('click', match); }
      } else if (method === 'Input.dispatchKeyEvent') {
        pointAt(document.activeElement);
        add(params.type === 'keyUp' ? 'keyup' : 'keydown', { key: params.key });
        if (params.type !== 'keyUp') { add('beforeinput'); add('input'); }
      } else if (method === 'Input.insertText') { pointAt(document.activeElement); add('beforeinput'); add('input'); }
    },
    clearExpected() { expected = []; },
    update(state) {
      leaseAt = performance.now();
      // Ignore host messages sent before a local input/control was acknowledged.
      if (controlSeq > (state.ackControls?.[clockId] || 0)) return;
      if ((state.commandRevision || 0) < commandRevision) return;
      if ((state.commandRevision || 0) > commandRevision) {
        commandRevision = state.commandRevision; commandId = state.commandId;
        generation++; interrupted = !!state.interrupted; expected = []; scrollTargets = []; stepId = undefined;
      } else if (state.interrupted) interrupted = true;
      commandActive = state.commandActive !== false;
      if (mode !== 'cancelled' && mode !== 'lost') mode = state.state === 'released' ? 'open' : state.state;
      phase = state.phase; countdownRemainingMs = state.countdownRemainingMs;
      render();
    },
    close() {
      if (api.closed) return;
      api.closed = true; interrupted = true;
      clearInterval(timer); for (const [type, fn] of handlers) globalThis.removeEventListener(type, fn, true);
      resizeObserver?.disconnect(); host?.remove(); expected = []; scrollTargets = [];
      // Keep the closed object for any in-flight async script that captured it.
    },
  };
  globalThis.__teamsCliGate = api;
  function observe(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const overOverlay = !!host && path.includes(host);
    const target = path.find(x => x && x.getAttribute) || e.target;
    const control = overOverlay && path.find(x => x?.getAttribute?.('data-action'));
    if (control && ['pointerdown','pointerup','click','keydown','keyup'].includes(e.type)) return; // Controls have explicit semantics below.
    const stamp = performance.now();
    expected = expected.filter(x => x.until >= stamp);
    const index = expected.findIndex(x => x.type === e.type && (x.key === undefined || x.key === e.key) && (x.x === undefined || Math.abs(x.x - e.clientX) < 1 && Math.abs(x.y - e.clientY) < 1));
    scrollTargets = scrollTargets.filter(x => x.until >= stamp);
    const scrolled = e.type === 'scroll' && scrollTargets.find(x => x.target === e.target || e.target?.contains?.(x.target));
    const correlated = depth > 0 || index >= 0 || !!scrolled;
    if (index >= 0) expected.splice(index, 1);
    if (scrolled) scrollTargets = scrollTargets.filter(x => x !== scrolled);
    if (!correlated && mode === 'waiting' && ['pointerdown','pointerup','pointermove','click','keydown','keyup','beforeinput','input','wheel','scroll','touchstart','touchmove','touchend'].includes(e.type)) {
      controlSeq++; phase = 'idle'; countdownRemainingMs = null; render();
    }
    emit(correlated ? 'agent.input.correlated' : 'input', { type: e.type, target: describe(target), overOverlay,
      correlation: depth > 0 ? 'synchronous-owned-action' : index >= 0 ? 'expected-cdp-input' : scrolled ? 'owned-scroll' : undefined });
    // Input observation never changes permission. Only the Pause control enters waiting.
  }
  for (const type of ['pointerdown','pointerup','pointermove','click','keydown','keyup','beforeinput','input','wheel','scroll','touchstart','touchmove','touchend','focus','blur','visibilitychange']) {
    globalThis.addEventListener(type, observe, { capture: true, passive: true }); handlers.push([type, observe]);
  }
  function render() {
    if (!shadow) return;
    host.setAttribute('data-state', mode);
    shadow.querySelector('[data-status]').textContent = mode === 'waiting' ? (phase === 'countdown' ? 'Resuming in ' + Math.ceil(countdownRemainingMs / 1000) + 's' : 'Paused · You’re in control')
      : mode === 'open' ? 'Agent is using Teams' : mode === 'cancelled' ? 'Operation cancelled'
      : mode === 'lost' ? 'Connection lost' : 'Returning control to the agent';
    shadow.querySelector('[data-action=pause]').hidden = mode !== 'open';
    shadow.querySelector('[data-action=resume]').hidden = mode !== 'waiting';
    shadow.querySelector('[data-action=cancel]').disabled = mode === 'cancelled' || mode === 'lost';
    if (mode !== 'open') cursor.hidden = true;
    if (mode === 'cancelled') host.hidden = true;
  }
  if (config.view) {
    host = document.createElement('div'); host.id = 'teams-cli-activity-view';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    shadow = host.attachShadow({ mode: 'open' });
    // Teams enforces Trusted Types. Build HTML and SVG nodes without HTML sinks.
    const make = (tag, attrs = {}, text) => {
      const el = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const svg = (paths, attrs = {}) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', ...attrs })) el.setAttribute(key, value);
      for (const d of paths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); el.appendChild(path);
      }
      return el;
    };
    const style = make('style');
    style.textContent = ${JSON.stringify(ACTIVITY_VIEW_STYLE)};
    panel = make('section', { 'data-panel': '', role: 'region', 'aria-label': 'teams-cli agent controls' });
    const brand = make('div', { 'data-brand': '' });
    brand.appendChild(make('span', { 'data-dot': '', 'aria-hidden': 'true' })); brand.appendChild(make('span', {}, 'teams-cli'));
    panel.appendChild(brand); panel.appendChild(make('span', { 'data-status': '', role: 'status', 'aria-live': 'polite' }));
    const button = (action, label, paths, title) => {
      const el = make('button', { type: 'button', 'data-action': action, title });
      el.appendChild(svg(paths)); el.appendChild(make('span', {}, label)); panel.appendChild(el); return el;
    };
    const pause = button('pause', 'Pause', ['M8 5v14', 'M16 5v14'], 'Pause agent actions; resume after inactivity or with Resume');
    const resume = button('resume', 'Resume', ['M8 5l11 7-11 7z'], 'End the wait; pending steps will not execute');
    const cancel = button('cancel', 'Cancel', ['M8 4h8l4 4v8l-4 4H8l-4-4V8z', 'M9 9l6 6', 'M15 9l-6 6'], 'End this session');
    cursor = make('div', { 'data-cursor': '', 'aria-hidden': 'true', hidden: '' });
    cursor.appendChild(svg(['M8 6C6.1 5.4 5.3 6.3 5.9 8.2L10.2 23C10.8 25 12.6 25.2 13.4 23.2L15.6 17.4L21.8 15.2C23.8 14.5 23.8 12.8 21.8 12.1Z'], { viewBox:'0 0 30 32', width:'30', height:'32', fill:'#292943', stroke:'#e5e6ff', 'stroke-width':'1.8' }));
    shadow.append(style, make('div', { 'data-frame': '', 'aria-hidden': 'true' }), panel, cursor);
    pause.addEventListener('click', () => {
      if (mode !== 'open') return;
      interrupted = true; generation++; controlSeq++; mode = 'waiting'; phase = 'idle'; // Synchronous barrier before notifying the host.
      emit('control.pause'); render(); resume.focus();
    });
    resume.addEventListener('click', () => {
      if (mode !== 'waiting') return;
      interrupted = true; controlSeq++; mode = 'released'; emit('control.resume'); render();
    });
    cancel.addEventListener('click', () => {
      interrupted = true; generation++; controlSeq++; mode = 'cancelled'; emit('control.cancel'); render();
    });
    render(); (document.body || document.documentElement).appendChild(host);
    resizeObserver = new ResizeObserver(() => host.style.setProperty('--bar-height', panel.getBoundingClientRect().height + 'px'));
    resizeObserver.observe(panel);
  }
  timer = setInterval(() => { if (performance.now() - leaseAt > 10000) { emit('observer.lease.expired'); api.close(); } }, 1000);
  return { installed: true, view: !!host };
}`;
