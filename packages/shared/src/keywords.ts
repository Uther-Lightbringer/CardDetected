import type { Faction, Keyword } from './types.js';

/**
 * 关键词元数据注册表：中文名 + 规则说明。
 * 客户端卡牌上的关键词标签与悬停 tooltip 统一从这里取文案，
 * 新增关键词只需在此登记一处。
 */
export const KEYWORD_DEFS: Record<Keyword, { name: string; desc: string }> = {
  melee: {
    name: '近战',
    desc: '只能攻击敌方前锋单位；敌方前锋全空时，才可攻击后营单位或对方棋手。',
  },
  ranged: {
    name: '远程',
    desc: '可攻击任意目标（含对方棋手），无视阵型阻挡。建议部署在后营。',
  },
  guard: {
    name: '护卫',
    desc: '敌方攻击时，只要场上有护卫单位，必须优先攻击护卫。',
  },
  charge: {
    name: '速攻',
    desc: '打出的当回合即可攻击，不受休整（召唤失调）限制。',
  },
  infiltrate: {
    name: '渗透',
    desc: '攻击时无视敌方前锋的阻挡，可直击任意目标。',
  },
  stealth: {
    name: '易容',
    desc: '可盖放打出，对外显示为 1/1 路人；攻击、被攻击或被指定时翻开并结算「翻开时」效果。',
  },
};

/** 门派元数据 */
export const FACTION_DEFS: Record<Faction, { name: string; desc: string }> = {
  wuying: { name: '无影楼', desc: '刺客组织。易容、渗透、单点爆发；前锋薄弱，怕群伤。' },
  tieji: { name: '铁脊山庄', desc: '外家硬功门派。护卫、阵型增益、高质量前锋；缺直伤。' },
  wudu: { name: '五毒教', desc: '下毒放蛊。污染对手牌库、拖慢节奏；怕驱毒。' },
  tianji: { name: '天机阁', desc: '情报组织。识破、强制翻开、驱毒、反制埋伏；进攻性弱。' },
};

/** 蛊奴 token 的卡 id（下毒效果的产物） */
export const NOISE_CARD_ID = 'gu_slave';
