/**
 * 实体模型：hearthstone.entities 的 TS 移植（只保留教练消费的字段）。
 *
 * 对齐说明：initial_card_id / initial_creator / known_starting_deck 等
 * hscoach 从不消费的字段未移植；GAME_RESET 只重置 card_id/revealed
 * （与 Card.reset() 一致）。
 */
import { TAG, ZONE } from "./tags.js";

export type Tags = Map<number, number>;

export class CardEntity {
  readonly kind = "card" as const;
  readonly id: number;
  cardId: string | null;
  revealed = false;
  readonly tags: Tags;

  constructor(id: number, cardId: string | null, tags: Tags) {
    this.id = id;
    this.cardId = cardId;
    this.tags = tags;
  }

  zone(): number {
    return this.tags.get(TAG.ZONE) ?? ZONE.INVALID;
  }

  /** SHOW_ENTITY：揭示 + 合并 tags。 */
  reveal(cardId: string, tags: Tags): void {
    this.revealed = true;
    this.cardId = cardId;
    mergeTags(this.tags, tags);
  }

  /** HIDE_ENTITY：只撤销揭示（区域变化由后续 TAG_CHANGE 驱动）。 */
  hide(): void {
    this.revealed = false;
  }

  /** CHANGE_ENTITY：变换卡牌。原 CardID 缺失是导出级错误（整局丢弃）。 */
  change(cardId: string, tags: Tags): void {
    if (!this.cardId) {
      throw new GameExportError(
        `CHANGE_ENTITY ${this.id} to ${cardId} with no previous known CardID.`,
      );
    }
    this.cardId = cardId;
    mergeTags(this.tags, tags);
  }

  /** GAME_RESET：还原到未揭示状态。 */
  reset(): void {
    this.cardId = null;
    this.revealed = false;
  }
}

export class PlayerEntity {
  readonly kind = "player" as const;
  readonly id: number;
  readonly playerId: number;
  readonly hi: number;
  readonly lo: number;
  readonly name: string | null = null;
  readonly tags: Tags = new Map();

  constructor(id: number, playerId: number, hi: number, lo: number) {
    this.id = id;
    this.playerId = playerId;
    this.hi = hi;
    this.lo = lo;
  }

  zone(): number {
    return this.tags.get(TAG.ZONE) ?? ZONE.INVALID;
  }
}

export class GameEntityModel {
  readonly kind = "game" as const;
  readonly id: number;
  readonly tags: Tags = new Map();
  readonly players: PlayerEntity[] = [];
  readonly entities = new Map<number, CardEntity | PlayerEntity | GameEntityModel>();
  /** FriendlyPlayerExporter 的内联结果（首个手牌 SHOW_ENTITY 的控制者）。 */
  friendlyPlayerByShow: number | null = null;

  constructor(id: number) {
    this.id = id;
    this.entities.set(id, this);
  }

  inZone(zone: number): Array<CardEntity | PlayerEntity> {
    const out: Array<CardEntity | PlayerEntity> = [];
    for (const entity of this.entities.values()) {
      if (entity.kind === "game") continue;
      if (entity.zone() === zone) out.push(entity);
    }
    return out;
  }

  findEntityById(id: number): CardEntity | PlayerEntity | GameEntityModel | undefined {
    return this.entities.get(id);
  }

  registerEntity(entity: CardEntity | PlayerEntity): void {
    this.entities.set(entity.id, entity);
    if (entity instanceof PlayerEntity) this.players.push(entity);
  }

  /** GAME_RESET：所有卡牌实体回到未揭示状态。 */
  reset(): void {
    for (const entity of this.entities.values()) {
      if (entity instanceof CardEntity) entity.reset();
    }
  }
}

/** 导出级错误：Python 侧 packet_tree.export() 抛出 → 整局丢弃。 */
export class GameExportError extends Error {}

function mergeTags(target: Tags, source: Tags): void {
  for (const [tag, value] of source) target.set(tag, value);
}
