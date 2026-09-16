/**
 * tag 解析。
 *
 * 语义（黄金快照硬约束）：
 * - 未知 tag 名 → 抛错（调用方按"跳过该行"处理，两侧一致）
 * - TAG_TYPES 命中值枚举（Zone/CardType/...）→ 十进制或枚举名
 * - TAG_TYPES 命中 Type.* 标量类型 → 仅十进制
 * - 未命中 TAG_TYPES → 仅十进制
 */
import { GAME_TAG, TAG_TYPES, VALUE_ENUMS } from "./enums.generated.js";

/** 教练直接消费的 tag 常量（值来自生成表，避免魔法数字散落）。 */
export const TAG = {
  TURN: GAME_TAG.TURN,
  CURRENT_PLAYER: GAME_TAG.CURRENT_PLAYER,
  CONTROLLER: GAME_TAG.CONTROLLER,
  HERO_ENTITY: GAME_TAG.HERO_ENTITY,
  HEALTH: GAME_TAG.HEALTH,
  ATK: GAME_TAG.ATK,
  DAMAGE: GAME_TAG.DAMAGE,
  COST: GAME_TAG.COST,
  ARMOR: GAME_TAG.ARMOR,
  RESOURCES: GAME_TAG.RESOURCES,
  MAXRESOURCES: GAME_TAG.MAXRESOURCES,
  FATIGUE: GAME_TAG.FATIGUE,
  CARDTYPE: GAME_TAG.CARDTYPE,
  ZONE: GAME_TAG.ZONE,
  ENTITY_ID: GAME_TAG.ENTITY_ID,
  ZONE_POSITION: GAME_TAG.ZONE_POSITION,
} as const;

export const CARDTYPE_HERO = 2;
export const ZONE = {
  INVALID: 0,
  PLAY: 1,
  DECK: 2,
  HAND: 3,
  GRAVEYARD: 4,
  SECRET: 7,
} as const;

const DECIMAL_RE = /^\d+$/;

/** tag/value 双段解析；任何无法识别的组合都抛 ParseTagError。 */
export function parseTag(tagName: string, value: string): [number, number] {
  // 十进制直接转 int（真实日志存在数字 tag 名，如 tag=479）
  const tag = DECIMAL_RE.test(tagName) ? Number(tagName) : GAME_TAG[tagName];
  if (tag === undefined) throw new ParseTagError(`unknown GameTag ${tagName}`);
  const enumName = TAG_TYPES[tag];
  if (enumName !== undefined && !enumName.startsWith("Type.")) {
    const table = VALUE_ENUMS[enumName];
    if (DECIMAL_RE.test(value)) return [tag, Number(value)];
    const byName = table?.[value];
    if (byName !== undefined) return [tag, byName];
    throw new ParseTagError(`unknown ${enumName} value ${value}`);
  }
  // Type.* 标量（BOOL/LOCSTRING/...）与无类型 tag：仅十进制
  if (DECIMAL_RE.test(value)) return [tag, Number(value)];
  throw new ParseTagError(`invalid value ${tagName}=${value}`);
}

export class ParseTagError extends Error {}
