import {
  applyAction,
  botTurn,
  buildStarterDeck,
  CARDS,
  createGame,
  type GameState,
} from '../src/index.js';

/**
 * AI 自对弈数值验证脚本：让内置机器人用预组卡组互相对打 N 局，统计：
 * - 先后手胜率（验证后手补偿是否足够）
 * - 平均回合数（对照 DESIGN 目标单局时长）
 * - 单卡"打出方胜率"（>55% 疑似过强，<45% 疑似过弱，样本少时仅供参考）
 *
 * 用法：npm run selfplay -w @cardetect/shared -- [局数=200] [种子基数=1]
 * 随机只来自 createRng(seed)，同一参数结果完全可复现。
 */

const games = Number(process.argv[2] ?? 200);
const seedBase = Number(process.argv[3] ?? 1);
const MAX_TURNS = 400; // 防守死循环兜底

interface CardStat { played: number; won: number }

let p0Wins = 0;
let p1Wins = 0;
let draws = 0;
let turnsSum = 0;
const cardStats: Record<string, CardStat> = {};

function playOne(seed: number): void {
  let s: GameState = createGame(buildStarterDeck(), buildStarterDeck(), seed);
  const playedBy: Record<string, Set<number>> = {};
  let guard = 0;
  while (s.winner === null && guard < MAX_TURNS) {
    const side = s.current;
    for (const action of botTurn(s, side)) {
      if (s.winner !== null) break;
      const r = applyAction(s, side, action);
      if (!r.ok) throw new Error(`机器人动作非法: ${JSON.stringify(action)} -> ${r.error}`);
      for (const e of r.events) {
        if (e.type === 'play_card' && typeof e.card === 'string') {
          (playedBy[e.card] ??= new Set()).add(e.player as number);
        }
      }
      s = r.state;
    }
    guard++;
  }

  turnsSum += s.turn;
  if (s.winner === null) {
    draws++;
  } else if (s.winner === 0) {
    p0Wins++;
  } else {
    p1Wins++;
  }
  for (const [cardId, players] of Object.entries(playedBy)) {
    const stat = (cardStats[cardId] ??= { played: 0, won: 0 });
    stat.played += players.size;
    if (s.winner !== null && players.has(s.winner)) stat.won++;
  }
}

for (let g = 0; g < games; g++) {
  playOne(seedBase + g * 7919);
}

console.log(`\n===== AI 自对弈报告（${games} 局，种子基数 ${seedBase}）=====`);
console.log(`先手胜率: ${((p0Wins / games) * 100).toFixed(1)}%  后手胜率: ${((p1Wins / games) * 100).toFixed(1)}%  超时平局: ${draws}`);
console.log(`平均回合数: ${(turnsSum / games).toFixed(1)}`);
console.log('\n单卡打出方胜率（打出次数 ≥ 10 才列出）:');
const rows = Object.entries(cardStats)
  .filter(([, st]) => st.played >= 10)
  .map(([id, st]) => ({ name: CARDS[id]?.name ?? id, ...st, rate: st.won / st.played }))
  .sort((a, b) => b.rate - a.rate);
for (const r of rows) {
  const flag = r.rate > 0.55 ? ' ⚠️偏强' : r.rate < 0.45 ? ' ⚠️偏弱' : '';
  console.log(`  ${r.name.padEnd(12, '　')} ${(r.rate * 100).toFixed(1)}%  (${r.won}/${r.played})${flag}`);
}
