/**
 * PlayerManager：hslog player.py 的 TS 移植（实体解析所需的子集）。
 *
 * 作用：把 TAG_CHANGE 等行里的玩家名令牌解析回实体 id——名字先经
 * DebugPrintGame(PlayerName=) / CREATE_GAME(Player ...) 注册，后到的
 * 名字令牌经 name/alias/entity_id/player_id 多路映射合并到同一引用。
 * 解析不出实体 id 的引用在导出时表现为 MissingPlayerData（整局丢弃），
 * 与 Python 侧一致。
 */

export class PlayerReference {
  entityId: number | null = null;
  name: string | null;
  playerId: number | null;

  constructor(init: { name?: string | null; entityId?: number | null; playerId?: number | null }) {
    this.name = init.name ?? null;
    this.entityId = init.entityId ?? null;
    this.playerId = init.playerId ?? null;
  }
}

export const UNKNOWN_HUMAN_PLAYER = "UNKNOWN HUMAN PLAYER";

/** InconsistentPlayerIdError 等价：行级错误（跳过该行）。 */
export class PlayerManagerError extends Error {}

function maybeAlias(name: string): string | undefined {
  const hash = name.indexOf("#");
  return hash > 0 ? name.slice(0, hash) : undefined;
}

export class PlayerManager {
  private readonly byName = new Map<string, PlayerReference>();
  private readonly nameAliases = new Map<string, string>();
  private readonly byEntityId = new Map<number, PlayerReference>();
  private readonly byPlayerId = new Map<number, PlayerReference>();
  /** entityId → playerId（TAG_CHANGE/初始 tag 的 CONTROLLER 记账）。 */
  private readonly entityControllers = new Map<number, number>();
  private aiPlayer: PlayerReference | null = null;
  /**
   * 引用首次获得实体 id 时回调（TAG_CHANGE 延迟应用依赖此钩子——
   * Python 侧包对象持有共享可变引用，导出晚于解析）。
   */
  onEntityIdAssigned: ((ref: PlayerReference) => void) | null = null;

  getByEntityId(entityId: number): PlayerReference | undefined {
    return this.byEntityId.get(entityId);
  }

  registerController(entityId: number, playerId: number): void {
    this.entityControllers.set(entityId, playerId);
  }

  getControllerByEntityId(entityId: number): number | undefined {
    return this.entityControllers.get(entityId);
  }

  /**
   * create_or_update_player 的移植。冲突（同 key 不同 id）抛错 → 行级跳过。
   * isAi 传导 aiPlayer（旅店老板改名分支用）。
   */
  createOrUpdatePlayer(
    init: {
      name?: string | null;
      entityId?: number | null;
      playerId?: number | null;
      isAi?: boolean;
    },
  ): PlayerReference {
    const name = init.name ?? null;
    const entityId = init.entityId ?? null;
    const playerId = init.playerId ?? null;

    let player: PlayerReference | undefined;
    if (name && name !== UNKNOWN_HUMAN_PLAYER) {
      player = this.byName.get(name) ?? this.byName.get(this.nameAliases.get(name) ?? "");
    }
    if (!player) {
      if (entityId !== null) player = this.byEntityId.get(entityId);
      else if (playerId !== null) player = this.byPlayerId.get(playerId);
      if (!player) player = new PlayerReference({ name, entityId, playerId });
    }

    if (init.isAi) this.aiPlayer = player;

    if (name) {
      if (player.name === null || player.name === UNKNOWN_HUMAN_PLAYER) {
        player.name = name;
      } else if (player.name !== name && this.nameAliases.get(name) !== player.name) {
        if (player === this.aiPlayer) {
          player.name = name; // 旅店老板改名，合法
        } else if (name !== UNKNOWN_HUMAN_PLAYER) {
          throw new PlayerManagerError(`player name conflict: ${player.name} vs ${name}`);
        }
      }
      if (name !== UNKNOWN_HUMAN_PLAYER && !this.byName.has(name) && !this.nameAliases.has(name)) {
        if (player.entityId === null && entityId === null) {
          this.guessPlayerEntityId(name);
          if (this.byName.has(name)) player = this.byName.get(name)!;
        }
        this.byName.set(name, player);
        const alias = maybeAlias(name);
        if (alias && !this.nameAliases.has(alias)) this.nameAliases.set(alias, name);
      }
    }

    if (entityId !== null) {
      const wasUnresolved = player.entityId === null;
      if (player.entityId === null) player.entityId = entityId;
      else if (player.entityId !== entityId) {
        throw new PlayerManagerError(
          `inconsistent entity id ${entityId} for player ${player.name}`,
        );
      }
      const existing = this.byEntityId.get(player.entityId);
      if (existing && existing !== player) {
        const existingWas = existing.entityId === null;
        mergeReference(existing, player);
        if (existingWas && existing.entityId !== null) this.onEntityIdAssigned?.(existing);
      } else if (!existing) {
        this.byEntityId.set(player.entityId, player);
      }
      if (wasUnresolved && player.entityId !== null) {
        this.onEntityIdAssigned?.(player);
      }
    }

    if (playerId !== null) {
      if (player.playerId === null) player.playerId = playerId;
      else if (player.playerId !== playerId) {
        throw new PlayerManagerError(
          `inconsistent player id ${playerId} for player ${player.name}`,
        );
      }
      const existing = this.byPlayerId.get(player.playerId);
      if (existing && existing !== player) {
        // 双向合并：未解析的名字引用可能在此获得实体 id（回调触发延迟回放）
        const leftWas = existing.entityId === null;
        const rightWas = player.entityId === null;
        mergeReference(existing, player);
        if (leftWas && existing.entityId !== null) this.onEntityIdAssigned?.(existing);
        if (rightWas && player.entityId !== null) this.onEntityIdAssigned?.(player);
      } else if (!existing) {
        this.byPlayerId.set(player.playerId, player);
      }
    }

    return player;
  }

  /**
   * 只注册了一个名字、新名字又不是 UNKNOWN 时，可推断另一个实体位
   * （实体 2/3 是协议常量）。Battlegrounds/佣兵特判不移植（教练场景
   * 不涉及；game_meta 未消费）。
   */
  private guessPlayerEntityId(name: string): void {
    if (this.byName.size !== 1 || name === UNKNOWN_HUMAN_PLAYER) return;
    const other = [...this.byName.values()][0];
    const entityId = other.entityId === 2 ? 3 : 2;
    if (this.byEntityId.has(entityId)) {
      const player = this.byEntityId.get(entityId)!;
      player.name = name;
      this.byName.set(name, player);
      const alias = maybeAlias(name);
      if (alias && !this.nameAliases.has(alias)) this.nameAliases.set(alias, name);
    } else {
      this.createOrUpdatePlayer({ name, entityId });
    }
  }
}

function mergeReference(left: PlayerReference, right: PlayerReference): void {
  // hslog _safe_merge_player_references 的双向语义：两侧互补 id/name，
  // 冲突抛错（行级跳过）。右侧获得实体 id 正是"名字引用最终解析"的关键。
  if (left.entityId === null) {
    if (right.entityId !== null) left.entityId = right.entityId;
  } else if (right.entityId === null) {
    right.entityId = left.entityId;
  } else if (left.entityId !== right.entityId) {
    throw new PlayerManagerError(
      `inconsistent entity id on merge: ${left.entityId} vs ${right.entityId}`,
    );
  }

  if (left.playerId === null) {
    if (right.playerId !== null) left.playerId = right.playerId;
  } else if (right.playerId === null) {
    right.playerId = left.playerId;
  } else if (left.playerId !== right.playerId) {
    throw new PlayerManagerError(
      `inconsistent player id on merge: ${left.playerId} vs ${right.playerId}`,
    );
  }

  if (left.name === null || left.name === UNKNOWN_HUMAN_PLAYER) {
    if (right.name !== null) left.name = right.name;
  } else if (right.playerId === null || right.name === UNKNOWN_HUMAN_PLAYER) {
    // 条件照抄 hslog（上游疑似笔误的 player_id 判定，为对拍保留原语义）
    if (left.name !== null) right.name = left.name;
  }
}
