import type { CardDef } from './types.js';

/**
 * 初始卡池（现代侦探题材）。
 * v0 阶段双方使用相同的"预组卡组"，构筑系统后续版本加入。
 * 数值基准见 DESIGN.md 第 5 节。
 */
export const CARDS: Record<string, CardDef> = {
  rookie_detective: {
    id: 'rookie_detective', name: '见习侦探', cost: 1, kind: 'unit',
    atk: 2, hp: 1, keywords: [],
    art: 'card_rookie_detective', desc: '初出茅庐，干劲十足。',
  },
  street_informer: {
    id: 'street_informer', name: '街头线人', cost: 2, kind: 'unit',
    atk: 3, hp: 2, keywords: [],
    art: 'card_street_informer', desc: '消息灵通，但不太能打。',
  },
  veteran_cop: {
    id: 'veteran_cop', name: '老练刑警', cost: 3, kind: 'unit',
    atk: 4, hp: 3, keywords: [],
    art: 'card_veteran_cop', desc: '见惯了大场面。',
  },
  undercover_agent: {
    id: 'undercover_agent', name: '卧底特工', cost: 4, kind: 'unit',
    atk: 4, hp: 4, keywords: ['infiltrate'],
    art: 'card_undercover_agent', desc: '渗透：攻击时无视敌方前排的阻挡。',
  },
  swat_captain: {
    id: 'swat_captain', name: '重案组长', cost: 5, kind: 'unit',
    atk: 5, hp: 6, keywords: ['guard'],
    art: 'card_swat_captain', desc: '护卫：敌方攻击时必须优先攻击它。',
  },
  sniper: {
    id: 'sniper', name: '狙击手', cost: 2, kind: 'unit',
    atk: 2, hp: 1, keywords: ['ranged'],
    art: 'card_sniper', desc: '远程：可攻击任意目标。建议部署在后排。',
  },
  forensics_expert: {
    id: 'forensics_expert', name: '法医分析师', cost: 3, kind: 'unit',
    atk: 3, hp: 2, keywords: ['ranged'],
    art: 'card_forensics_expert', desc: '远程：可攻击任意目标。建议部署在后排。',
  },
  assault_team: {
    id: 'assault_team', name: '突击队员', cost: 3, kind: 'unit',
    atk: 3, hp: 2, keywords: ['charge'],
    art: 'card_assault_team', desc: '速攻：打出的当回合即可攻击。',
  },
  interrogation: {
    id: 'interrogation', name: '审讯', cost: 2, kind: 'spell',
    effect: { kind: 'damage', amount: 3 },
    art: 'card_interrogation', desc: '对一个敌方单位造成 3 点伤害。',
  },
  gather_clues: {
    id: 'gather_clues', name: '线索搜集', cost: 3, kind: 'spell',
    effect: { kind: 'draw', amount: 2 },
    art: 'card_gather_clues', desc: '抽 2 张牌。',
  },
  crime_scene_scan: {
    id: 'crime_scene_scan', name: '现场勘查', cost: 1, kind: 'spell',
    effect: { kind: 'reveal_hand' },
    art: 'card_crime_scene_scan', desc: '侦测：查看对手的全部手牌。',
  },
};

/** v0 预组卡组：每种牌 2 张，共 22 张 */
export function buildStarterDeck(): string[] {
  const deck: string[] = [];
  for (const id of Object.keys(CARDS)) {
    deck.push(id, id);
  }
  return deck;
}
