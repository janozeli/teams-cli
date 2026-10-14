#!/usr/bin/env node
/**
 * Modelo executável para revisão — NÃO altera o Teams nem o runtime atual.
 * Base: discussão desta sessão, 2026-09-24.
 *
 * Decidido: Pause inicia a pausa; ociosidade dispara UMA CONTAGEM SEPARADA,
 * visível na view; Resume preserva a sessão e não repete o comando interrompido.
 * Aprovado para implementação: interação durante a contagem a cancela e volta
 * à espera por ociosidade. Tempos definidos pelo usuário: 30s de ociosidade e 10s de contagem.
 *
 * Execute: node scripts/model-interaction.mjs       (catálogo + cenário + verificações)
 *          node scripts/model-interaction.mjs --json (mesmos dados, parseáveis)
 *
 * Relógio virtual monotônico: atMs é o instante de processamento no modelo.
 * A ordem é a de dispatch(), inclusive em empates. Não é um algoritmo para ordenar
 * timestamps de fontes distintas nem um substituto do schema de trace de produção.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CONFIG = Object.freeze({
  idleBeforeCountdownMs: 30_000, // Ociosidade necessária ANTES da contagem aparecer.
  resumeCountdownMs: 10_000,    // Duração da contagem, contada a partir do seu disparo.
  viewRefreshMs: 250,          // Cadência de tick/render; nunca é reiniciada por input.
});

export const VARIABLES = {
  'config.idleBeforeCountdownMs': 'Constante. Limiar de ociosidade; não é a contagem visível.',
  'config.resumeCountdownMs': 'Constante. Tempo completo mostrado quando a contagem começa.',
  'config.viewRefreshMs': 'Constante. Scheduler chama system.tick nesta cadência; não acumula tempo.',
  sessionId: 'Identidade estável até Cancel/agent.session.end; Resume não cria outra sessão.',
  phase: 'active | paused.idle | paused.countdown | ended.',
  nowMs: 'Relógio monotônico, avança quando um evento é processado.',
  pauseStartedAtMs: 'Instante do Pause; null fora da pausa.',
  lastInteractionAtMs: 'Último input elegível durante a pausa; começa no instante do Pause.',
  countdownStartedAtMs: 'null ao aguardar ociosidade; recebe nowMs quando a contagem dispara.',
  currentCommandId: 'Comando em curso ou aguardando liberação; null depois de retornar.',
  commands: 'Registro por ID. Estado e invalidated persistem; A nunca volta a ser executável.',
  steps: 'Registro de passos já despachados e seus resultados; um efeito em voo pode terminar.',
  trace: 'Sequência única de registros imutáveis do modelo; continua após Resume e novos comandos.',
  nextSeq: 'Próxima sequência do trace; nunca reinicia dentro da sessão.',
  'derived.idleTimeMs': 'Só em paused.idle: nowMs - lastInteractionAtMs. Inativo (null) durante a contagem.',
  'derived.countdownDeadlineMs': 'countdownStartedAtMs + resumeCountdownMs, ou null.',
  'derived.countdownRemainingMs': 'max(0, deadline - nowMs), ou null se não há contagem.',
  'derived.displaySeconds': 'ceil(countdownRemainingMs / 1000); null oculta o número.',
  'derived.overlayVisible': 'phase !== ended; a view permanece após Resume.',
  'derived.canAcceptCommand': 'phase === active e currentCommandId === null.',
};

// Metadados de origem são preservados; isTrusted sozinho não prova que foi uma pessoa.
export const INPUT_KINDS = Object.freeze([
  'pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup',
  'beforeinput', 'input', 'wheel', 'scroll', 'touchstart', 'touchmove', 'touchend',
]);
export const EVENT_TYPES = {
  'control.pause': 'Somente em active: invalida o comando, fecha barreira, inicia paused.idle.',
  'input.observed': 'user/unknown + tipo elegível atualiza lastInteractionAtMs só durante pausa.',
  'system.tick': 'Calcula ociosidade; dispara a contagem ou a liberação quando atingir o limite.',
  'control.resume': 'Durante qualquer fase de pausa: libera sessão e retorna comando interrompido.',
  'control.cancel': 'Encerra a sessão, retorna comando cancelado, remove view.',
  'agent.command.start': 'Aceita novo ID somente em sessão ativa sem comando em curso.',
  'agent.step.request': 'Despacha apenas para comando atual, válido e com barreira aberta.',
  'application.step.result': 'Registra efeito já despachado, mesmo após Pause/Cancel; não abre barreira.',
  'agent.command.finish': 'Conclui comando válido. Não encerra a sessão/view.',
  'agent.session.end': 'Encerramento explícito pelo agente; encerra comandos pendentes e view.',
  'system.failure': 'Falha de infraestrutura encerra sessão sem alegar rollback de efeitos.',
};
// Focus/blur/visibility e input de agent/application são trace-only neste modelo.
// Isto é uma escolha explícita de modelagem: não tratamos foco como atividade elegível.
// A lista e a regra de cancelar a contagem por input ainda podem ser refinadas.

export class InteractionModel {
  constructor(config = CONFIG, sessionId = 'session-demo') {
    this.config = Object.freeze({ ...config });
    for (const value of Object.values(this.config)) assert.ok(Number.isInteger(value) && value > 0);
    this.sessionId = sessionId;
    this.phase = 'active';
    this.nowMs = 0;
    this.pauseStartedAtMs = null;
    this.lastInteractionAtMs = null;
    this.countdownStartedAtMs = null;
    this.currentCommandId = null;
    this.commands = new Map();
    this.steps = new Map();
    this.trace = [];
    this.nextSeq = 1;
    this.record('session.started');
  }
  record(type, data = {}, causedBy) {
    const seq = this.nextSeq++;
    this.trace.push(Object.freeze({ seq, eventId: `${this.sessionId}:${seq}`, sessionId: this.sessionId,
      atMs: this.nowMs, type, ...(causedBy ? { causedBy } : {}), data: structuredClone(data) }));
    return `${this.sessionId}:${seq}`;
  }
  snapshot() {
    const countdownDeadlineMs = this.countdownStartedAtMs === null ? null
      : this.countdownStartedAtMs + this.config.resumeCountdownMs;
    const countdownRemainingMs = countdownDeadlineMs === null ? null : Math.max(0, countdownDeadlineMs - this.nowMs);
    return {
      sessionId: this.sessionId, phase: this.phase, nowMs: this.nowMs,
      pauseStartedAtMs: this.pauseStartedAtMs, lastInteractionAtMs: this.lastInteractionAtMs,
      countdownStartedAtMs: this.countdownStartedAtMs, currentCommandId: this.currentCommandId,
      commands: Object.fromEntries(this.commands), steps: Object.fromEntries(this.steps),
      nextSeq: this.nextSeq, traceRecords: this.trace.length,
      derived: {
        idleTimeMs: this.phase === 'paused.idle' ? this.nowMs - this.lastInteractionAtMs : null,
        countdownDeadlineMs, countdownRemainingMs,
        displaySeconds: countdownRemainingMs === null ? null : Math.ceil(countdownRemainingMs / 1000),
        overlayVisible: this.phase !== 'ended',
        canAcceptCommand: this.phase === 'active' && this.currentCommandId === null,
        statusText: this.phase === 'paused.idle' ? 'Paused · You’re in control'
          : this.phase === 'paused.countdown' ? `Resuming in ${Math.ceil(countdownRemainingMs / 1000)}s`
          : this.phase === 'active' ? 'Agent session active' : 'Session ended',
      },
    };
  }
  returnCommand(status, cause) {
    if (this.currentCommandId === null) return;
    const commandId = this.currentCommandId;
    const old = this.commands.get(commandId);
    this.commands.set(commandId, { status, invalidated: old.invalidated || status !== 'completed' });
    this.record('command.returned', { commandId, status, pendingStepsWillExecute: false }, cause);
    this.currentCommandId = null;
  }
  clearPause() {
    this.pauseStartedAtMs = this.lastInteractionAtMs = this.countdownStartedAtMs = null;
  }
  release(reason, cause) {
    this.returnCommand('interrupted', cause); // Nunca recoloca A em execução.
    this.phase = 'active'; this.clearPause();
    this.record('pause.released', { reason, sessionContinues: true }, cause);
  }
  dispatch(event) {
    assert.ok(event.type in EVENT_TYPES, `Unknown event: ${event.type}`);
    assert.ok(Number.isFinite(event.atMs) && event.atMs >= this.nowMs, 'Use monotonic processing times');
    this.nowMs = event.atMs;
    const { type, atMs, ...data } = event;
    const cause = this.record(type, data);
    if (type === 'application.step.result') {
      assert.ok(this.steps.has(event.stepId), 'A result requires an already dispatched step');
      assert.ok(['confirmed', 'unknown'].includes(event.outcome));
      this.steps.set(event.stepId, { ...this.steps.get(event.stepId), outcome: event.outcome });
      this.record('step.result.recorded', { stepId: event.stepId, outcome: event.outcome }, cause);
      return this.snapshot(); // Um efeito em voo não é desfeito por Pause ou Cancel.
    }
    if (this.phase === 'ended') { this.record('event.ignored', { reason: 'session-ended' }, cause); return this.snapshot(); }
    switch (type) {
      case 'control.pause':
        if (this.phase !== 'active') break; // Pause repetido não renova o prazo.
        this.phase = 'paused.idle';
        this.pauseStartedAtMs = this.lastInteractionAtMs = this.nowMs;
        this.countdownStartedAtMs = null;
        if (this.currentCommandId !== null) this.commands.set(this.currentCommandId, { status: 'interrupted.waiting', invalidated: true });
        this.record('pause.started', { commandId: this.currentCommandId }, cause);
        break;
      case 'input.observed':
        if (this.phase === 'active' || !['user', 'unknown'].includes(event.actor) || !INPUT_KINDS.includes(event.kind)) break;
        this.lastInteractionAtMs = this.nowMs; // Não recria scheduler e não incrementa contador.
        if (this.phase === 'paused.countdown') this.record('countdown.cancelled', { reason: 'activity' }, cause);
        this.phase = 'paused.idle'; this.countdownStartedAtMs = null;
        break;
      case 'system.tick':
        if (this.phase === 'paused.idle' && this.snapshot().derived.idleTimeMs >= this.config.idleBeforeCountdownMs) {
          this.phase = 'paused.countdown'; this.countdownStartedAtMs = this.nowMs;
          // Começa AGORA: um tick atrasado não consome a contagem antes de mostrá-la.
          this.record('countdown.started', { durationMs: this.config.resumeCountdownMs }, cause);
        } else if (this.phase === 'paused.countdown' && this.snapshot().derived.countdownRemainingMs === 0) {
          this.release('countdown-elapsed', cause);
        }
        break;
      case 'control.resume':
        if (this.phase.startsWith('paused.')) this.release('resume-button', cause);
        break;
      case 'control.cancel':
      case 'agent.session.end':
      case 'system.failure':
        this.returnCommand(type === 'system.failure' ? 'failed' : 'cancelled', cause);
        this.phase = 'ended'; this.clearPause();
        this.record('session.ended', { reason: type }, cause);
        break;
      case 'agent.command.start':
        if (!this.snapshot().derived.canAcceptCommand || this.commands.has(event.commandId)) {
          this.record('command.rejected', { commandId: event.commandId, reason: 'session-busy-or-id-reused' }, cause); break;
        }
        assert.ok(typeof event.commandId === 'string' && event.commandId.length);
        this.currentCommandId = event.commandId;
        this.commands.set(event.commandId, { status: 'running', invalidated: false });
        this.record('command.accepted', { commandId: event.commandId }, cause);
        break;
      case 'agent.step.request': {
        const command = this.commands.get(event.commandId);
        if (this.phase !== 'active' || this.currentCommandId !== event.commandId || !command || command.invalidated || command.status !== 'running') {
          this.record('step.not-executed', { commandId: event.commandId, stepId: event.stepId }, cause); break;
        }
        assert.ok(typeof event.stepId === 'string' && !this.steps.has(event.stepId));
        this.steps.set(event.stepId, { commandId: event.commandId, outcome: 'in-flight' });
        this.record('step.dispatched', { commandId: event.commandId, stepId: event.stepId }, cause);
        break;
      }
      case 'agent.command.finish':
        if (this.phase === 'active' && this.currentCommandId === event.commandId) this.returnCommand('completed', cause);
        break;
    }
    return this.snapshot();
  }
}

export function demonstration() {
  const model = new InteractionModel();
  const events = [
    { atMs: 0, type: 'agent.command.start', commandId: 'A' },
    { atMs: 1000, type: 'agent.step.request', commandId: 'A', stepId: 'A.1' },
    { atMs: 2000, type: 'control.pause' },
    { atMs: 3000, type: 'application.step.result', stepId: 'A.1', outcome: 'confirmed' },
    { atMs: 5000, type: 'input.observed', actor: 'user', kind: 'keydown' },
    { atMs: 20_000, type: 'system.tick' }, // 15s ocioso; ainda sem contagem.
    { atMs: 35_000, type: 'system.tick' }, // 30s ocioso -> MOSTRA 10s; ociosidade fica inativa.
    { atMs: 40_000, type: 'system.tick' }, // Mostra 5s.
    { atMs: 43_000, type: 'input.observed', actor: 'user', kind: 'pointermove' },
    { atMs: 60_000, type: 'system.tick' }, // 17s ocioso, sem número na tela.
    { atMs: 73_000, type: 'system.tick' }, // Nova contagem completa de 10s.
    { atMs: 78_000, type: 'system.tick' }, // Mostra 5s; ociosidade continua inativa.
    { atMs: 83_000, type: 'system.tick' }, // Libera sessão; A retorna interrompido.
    { atMs: 84_000, type: 'agent.step.request', commandId: 'A', stepId: 'A.2' }, // Negado.
    { atMs: 85_000, type: 'agent.command.start', commandId: 'B' },
    { atMs: 86_000, type: 'agent.step.request', commandId: 'B', stepId: 'B.1' },
    { atMs: 87_000, type: 'application.step.result', stepId: 'B.1', outcome: 'confirmed' },
    { atMs: 88_000, type: 'agent.command.finish', commandId: 'B' }, // View permanece.
    { atMs: 90_000, type: 'agent.session.end' }, // Agora fecha a view.
  ];
  const timeline = events.map(event => {
    const s = model.dispatch(event);
    return { timeSeconds: s.nowMs / 1000, event: event.type, phase: s.phase,
      idleSeconds: s.derived.idleTimeMs === null ? null : s.derived.idleTimeMs / 1000,
      countdownSeconds: s.derived.displaySeconds, overlayVisible: s.derived.overlayVisible,
      view: s.derived.statusText, commandA: s.commands.A?.status ?? null };
  });
  return { config: CONFIG, variables: VARIABLES, eventTypes: EVENT_TYPES, inputKinds: INPUT_KINDS,
    proposedRule: 'Input during countdown cancels it and returns to waiting for inactivity.',
    timeline, finalState: model.snapshot(), trace: model.trace };
}

function verify() {
  const demo = demonstration();
  assert.equal(demo.timeline.find(x => x.timeSeconds === 35).countdownSeconds, 10);
  assert.equal(demo.timeline.find(x => x.timeSeconds === 43).countdownSeconds, null);
  assert.equal(demo.timeline.find(x => x.timeSeconds === 73).countdownSeconds, 10);
  assert.equal(demo.timeline.find(x => x.timeSeconds === 83).overlayVisible, true);
  assert.equal(demo.timeline.find(x => x.timeSeconds === 88).overlayVisible, true);
  assert.ok(demo.timeline.filter(x => x.phase === 'paused.countdown').every(x => x.idleSeconds === null));
  assert.equal(demo.timeline.find(x => x.timeSeconds === 40).countdownSeconds, 5);
  assert.equal(demo.timeline.find(x => x.timeSeconds === 78).countdownSeconds, 5);
  assert.equal(demo.finalState.steps['A.2'], undefined);
  assert.equal(demo.finalState.steps['A.1'].outcome, 'confirmed');
  assert.equal(demo.finalState.commands.A.status, 'interrupted');
  assert.equal(demo.finalState.commands.B.status, 'completed');
  for (const duringCountdown of [false, true]) {
    for (const type of ['control.resume', 'control.cancel']) {
      const m = new InteractionModel();
      m.dispatch({ type: 'agent.command.start', atMs: 0, commandId: 'A' });
      m.dispatch({ type: 'control.pause', atMs: 0 });
      if (duringCountdown) m.dispatch({ type: 'system.tick', atMs: 30_000 });
      const s = m.dispatch({ type, atMs: 31_000 });
      assert.equal(s.phase, type === 'control.resume' ? 'active' : 'ended');
      assert.equal(s.commands.A.invalidated, true);
    }
  }
  const m = new InteractionModel();
  m.dispatch({ type: 'input.observed', atMs: 0, actor: 'user', kind: 'click' });
  assert.equal(m.phase, 'active'); // Input nunca é a entrada na pausa.
  m.dispatch({ type: 'control.pause', atMs: 0 });
  m.dispatch({ type: 'system.tick', atMs: 60_000 }); // Scheduler atrasado.
  assert.equal(m.snapshot().derived.displaySeconds, 10); // Não pula a contagem visível.
  m.dispatch({ type: 'input.observed', atMs: 61_000, actor: 'agent', kind: 'pointermove' });
  assert.equal(m.phase, 'paused.countdown');
  m.dispatch({ type: 'input.observed', atMs: 62_000, actor: 'unknown', kind: 'pointermove' });
  assert.equal(m.phase, 'paused.idle');
  assert.equal(m.snapshot().derived.idleTimeMs, 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify();
  const result = demonstration();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...result, verification: 'passed' }, null, 2));
  else {
    console.log('MODELO PARA REVISÃO — sem conexão com o Teams; ociosidade 30s, contagem 10s.');
    console.table(result.config);
    console.table(Object.entries(result.variables).map(([variable, behavior]) => ({ variable, behavior })));
    console.table(Object.entries(result.eventTypes).map(([event, behavior]) => ({ event, behavior })));
    console.table(result.timeline);
    console.log('Verificações passaram. Use --json para estados e trace completos.');
  }
}
