import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Coin, Player, RoomState } from '../shared/protocol';
import { loadSaved, useGame, type HitEffect, type Notice } from './useGame';

const MAX_PLAYERS = 5;
const CELLS = Array.from({ length: 25 }, (_, i) => i);

/** Re-render on an interval so timers based on the synced server clock stay live. */
function useTicker(ms: number, active = true) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(t => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

export function App() {
  const game = useGame();
  const { status, state } = game;
  const autoJoined = useRef(false);

  // After a page refresh, rejoin the room we were in (works while it is still waiting).
  useEffect(() => {
    if (autoJoined.current) return;
    autoJoined.current = true;
    const saved = loadSaved();
    if (saved?.code && saved.name) game.join(saved.code, saved.name);
  }, [game]);

  if (!state || status === 'idle' || status === 'connecting') {
    return <Lobby busy={status === 'connecting'} error={game.error} onJoin={game.join} onDismiss={() => game.setError(null)} notices={game.notices} />;
  }
  return <Room game={game} state={state} />;
}

function Lobby({ busy, error, onJoin, onDismiss, notices }: { busy: boolean; error: string | null; onJoin: (code: string, name: string) => void; onDismiss: () => void; notices: Notice[] }) {
  const saved = loadSaved();
  const [code, setCode] = useState(saved?.code ?? '');
  const [name, setName] = useState(saved?.name ?? '');
  const codeOk = /^[A-Za-z0-9]{1,12}$/.test(code);
  const nameOk = name.trim().length > 0 && [...name.trim()].length <= 12;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (codeOk && nameOk && !busy) onJoin(code.trim(), name.trim());
  };

  return (
    <main className="lobby">
      <Toasts notices={notices} />
      <form className="lobby-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-coin" aria-hidden>¥</span>
          <div>
            <h1>金币争夺战</h1>
            <p>5×5 抢金币 · 最多 5 人同场 · 60 秒定胜负</p>
          </div>
        </div>
        <label>
          <span>房间号</span>
          <input value={code} onChange={e => { setCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)); onDismiss(); }}
            placeholder="例如 ROOM1" autoComplete="off" autoCapitalize="characters" aria-label="房间号" />
        </label>
        <label>
          <span>昵称</span>
          <input value={name} onChange={e => { setName(e.target.value); onDismiss(); }} placeholder="1–12 个字符" maxLength={24} aria-label="昵称" />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={!codeOk || !nameOk || busy}>{busy ? '连接中…' : '加入房间'}</button>
        <ul className="rules">
          <li>首位玩家进入后开始 30 秒准备；满 5 人立即进入 3 秒倒计时</li>
          <li>金币随机出现，先点中者 +1 分，分数以服务器判定为准</li>
        </ul>
      </form>
    </main>
  );
}

type Game = ReturnType<typeof useGame>;

function Room({ game, state }: { game: Game; state: RoomState }) {
  const now = game.serverNow();
  const live = state.phase !== 'finished';
  useTicker(state.phase === 'playing' ? 50 : 200, live);
  const remaining = Math.max(0, state.deadline - now);
  const me = state.players.find(p => p.id === game.playerId);
  const gains = useScoreFlashes(state);

  return (
    <main className={`room phase-${state.phase}`}>
      <Toasts notices={game.notices} />
      <header className="topbar">
        <div className="room-meta">
          <span className="label">房间</span><strong data-testid="room-code">{state.code}</strong>
          <span className="pill">{state.players.length}/{MAX_PLAYERS} 人</span>
          {state.round > 1 && <span className="pill">第 {state.round} 局</span>}
        </div>
        <Clock state={state} remaining={remaining} />
        <div className="net">
          <span className={`dot ${game.status === 'joined' ? 'ok' : 'warn'}`} />
          {game.status === 'reconnecting' ? '重连中…' : `延迟 ${game.rtt} ms`}
          <button className="ghost" onClick={game.leave}>离开</button>
        </div>
      </header>

      <aside className="scoreboard" aria-label="积分榜">
        <h2>积分榜</h2>
        <ol>
          {rank(state.players).map((p, i) => (
            <li key={p.id} className={`${p.id === game.playerId ? 'me' : ''} ${gains.has(p.id) ? 'gain' : ''}`} data-testid="score-row">
              <span className="rank">{i + 1}</span>
              <span className="name">{p.name}{p.id === game.playerId && <em>（我）</em>}</span>
              <span className="score" data-testid={p.id === game.playerId ? 'my-score' : undefined}>{p.score}</span>
            </li>
          ))}
          {Array.from({ length: MAX_PLAYERS - state.players.length }, (_, i) => <li key={`empty-${i}`} className="empty"><span className="rank">·</span><span className="name">等待玩家…</span></li>)}
        </ol>
      </aside>

      <section className="arena">
        <Board coin={state.phase === 'playing' ? state.coin : null} now={now} effects={game.effects} onHit={game.hit} isLocked={game.isLocked} />
        {state.phase === 'waiting' && (
          <div className="overlay">
            <p className="overlay-title">等待玩家加入</p>
            <p className="big" data-testid="prepare-timer">{Math.ceil(remaining / 1000)}<small>s</small></p>
            <p>满 {MAX_PLAYERS} 人立即开局，或倒计时结束后以当前人数开局</p>
          </div>
        )}
        {state.phase === 'countdown' && (
          <div className="overlay">
            <p className="overlay-title">准备</p>
            <p className="big pulse" key={Math.ceil(remaining / 1000)} data-testid="countdown">{Math.max(1, Math.ceil(remaining / 1000))}</p>
          </div>
        )}
        {state.phase === 'finished' && <Results players={state.players} meId={game.playerId} onRestart={game.restart} onLeave={game.leave} />}
        {me && state.phase === 'playing' && <p className="hint">点击金币抢分！</p>}
      </section>
    </main>
  );
}

function Clock({ state, remaining }: { state: RoomState; remaining: number }) {
  if (state.phase !== 'playing') {
    const label = { waiting: '准备中', countdown: '即将开始', finished: '已结束', playing: '' }[state.phase];
    return <div className="clock"><span className="label">{label}</span><strong>{state.phase === 'finished' ? '00' : '60'}</strong></div>;
  }
  const secs = Math.ceil(remaining / 1000);
  return (
    <div className={`clock ${secs <= 10 ? 'urgent' : ''}`}>
      <span className="label">剩余</span>
      <strong data-testid="game-timer">{String(secs).padStart(2, '0')}</strong>
    </div>
  );
}

function Board({ coin, now, effects, onHit, isLocked }: { coin: Coin | null; now: number; effects: HitEffect[]; onHit: (id: string, cell: number) => boolean; isLocked: (id: string) => boolean }) {
  // Hide a coin as soon as its server-side lifetime is over, judged by the synced clock,
  // instead of waiting for the next broadcast (which is RTT/2 late).
  const visible = coin && now < coin.expiresAt ? coin : null;
  return (
    <div className="board" role="grid" aria-label="抢夺区">
      {CELLS.map(cell => {
        const effect = effects.find(e => e.cell === cell);
        const here = visible?.cell === cell ? visible : null;
        const locked = here ? isLocked(here.id) : false;
        return (
          <button key={cell} className="cell" data-cell={cell} aria-label={here ? '金币' : `格子 ${cell + 1}`}
            onPointerDown={e => { if (here && !locked) { e.preventDefault(); onHit(here.id, cell); } }}
            onKeyDown={e => { if (here && !locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onHit(here.id, cell); } }}>
            {here && !effect && <CoinView coin={here} now={now} />}
            {effect && <span className={`fx fx-${effect.kind}`} data-testid={`fx-${effect.kind}`}>
              <span className="coin-face" aria-hidden>¥</span>
              {effect.text && <b>{effect.text}</b>}
            </span>}
          </button>
        );
      })}
    </div>
  );
}

function CoinView({ coin, now }: { coin: Coin; now: number }) {
  // Remaining life is computed from server timestamps, so every player sees the same
  // deadline even though the coin reached each of them at a different moment.
  const life = Math.max(1, coin.expiresAt - coin.spawnedAt);
  const left = Math.max(0, Math.min(1, (coin.expiresAt - now) / life));
  return (
    <span className="coin" data-testid="coin" data-coin-id={coin.id} style={{ ['--left' as string]: left }}>
      <span className="coin-face">¥</span>
    </span>
  );
}

function Results({ players, meId, onRestart, onLeave }: { players: Player[]; meId: string | null; onRestart: () => void; onLeave: () => void }) {
  const ranked = rank(players);
  const top = ranked[0]?.score ?? 0;
  const winners = ranked.filter(p => p.score === top && top > 0);
  return (
    <div className="overlay results" data-testid="results">
      <p className="overlay-title">本局结束</p>
      <p className="winner">{winners.length ? `🏆 ${winners.map(w => w.name).join('、')}${winners.length > 1 ? ' 并列第一' : ' 获胜'}` : '无人得分'}</p>
      <ol>{ranked.map((p, i) => <li key={p.id} className={p.id === meId ? 'me' : ''}><span>{i + 1}. {p.name}</span><b>{p.score}</b></li>)}</ol>
      <div className="actions">
        <button className="primary" onClick={onRestart}>再来一局</button>
        <button className="ghost" onClick={onLeave}>返回大厅</button>
      </div>
    </div>
  );
}

function Toasts({ notices }: { notices: Notice[] }) {
  return <div className="toasts" aria-live="polite">{notices.map(n => <div key={n.id} className={`toast ${n.tone}`}>{n.text}</div>)}</div>;
}

function rank(players: Player[]) {
  return [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
}

/** Briefly highlight rows whose score just went up, so players can see who grabbed a coin. */
function useScoreFlashes(state: RoomState) {
  const prev = useRef(new Map<string, number>());
  const round = useRef(state.round);
  const [flash, setFlash] = useState(new Set<string>());
  const scores = useMemo(() => state.players.map(p => [p.id, p.score] as const), [state.players]);
  useEffect(() => {
    if (round.current !== state.round) { round.current = state.round; prev.current = new Map(scores); return; }
    const up = scores.filter(([id, s]) => s > (prev.current.get(id) ?? s)).map(([id]) => id);
    prev.current = new Map(scores);
    if (!up.length) return;
    setFlash(new Set(up));
    const t = window.setTimeout(() => setFlash(new Set()), 700);
    return () => window.clearTimeout(t);
  }, [scores, state.round]);
  return flash;
}
