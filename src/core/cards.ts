/**
 * 卡牌知识库：内置 HearthstoneJSON 简中卡库
 * （cards.all.zhCN.json 全卡 + cards.zhCN.json 收集卡，收集卡优先覆盖）。
 * 查询纯内存、离线可用，无下载路径。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /<\/?[bi]>/g;
const PLACEHOLDER_RE = /\{\d+\}/g;
const WHITESPACE_RE = /\n{3,}/g;

/** HearthstoneJSON 文本标记清洗（<b>/<i>/$/#/[x]/{N}）。 */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw
    .replace(TAG_RE, "")
    .replace(/\$/g, "\n")
    .replace(/#/g, "• ")
    .replace(/\[x\]/g, "")
    .replace(PLACEHOLDER_RE, "X")
    .replace(WHITESPACE_RE, "\n\n");
  return text.trim();
}

export interface Card {
  id: string;
  name: string;
  text: string;
  cost: number;
  attack: number | null;
  health: number | null;
  type: string;
  cardClass: string;
  cardSet: string;
}

interface RawCard {
  id?: string;
  name?: string;
  text?: string;
  cost?: number;
  attack?: number;
  health?: number;
  type?: string;
  cardClass?: string;
  set?: string;
}

/** 卡库数据目录：随插件分发的 data/（HearthstoneJSON 简中全卡 + 收集卡）。 */
export function defaultDataDirs(): string[] {
  const pkgDir = dirname(fileURLToPath(import.meta.url)); // …/lib/core 或 …/src/core
  return [join(resolve(pkgDir, "..", ".."), "data")];
}

export class CardDatabase {
  private cards = new Map<string, Card>();
  private loaded = false;

  constructor(private readonly dataDirs: string[] = defaultDataDirs()) {}

  get size(): number {
    return this.cards.size;
  }

  async build(): Promise<void> {
    if (this.loaded) return;
    const all = await this.readJson("cards.all.zhCN.json", true);
    const collectible = await this.readJson("cards.zhCN.json", false);
    const map = new Map<string, Card>();
    // 全卡先装（含教程卡），收集卡覆盖
    for (const entry of all) loadEntry(map, entry);
    for (const entry of collectible) loadEntry(map, entry);
    this.cards = map;
    this.loaded = true;
  }

  private async readJson(filename: string, required: boolean): Promise<RawCard[]> {
    for (const dir of this.dataDirs) {
      const path = join(dir, filename);
      if (!existsSync(path)) continue;
      try {
        const raw = JSON.parse(await readFile(path, "utf-8")) as RawCard[];
        if (Array.isArray(raw)) return raw;
      } catch {
        // 损坏文件按缺失处理，继续找下一个候选目录
      }
    }
    if (required) throw new Error(`card database not found: ${filename}`);
    return [];
  }

  get(cardId: string): Card | undefined {
    return this.cards.get(cardId);
  }

  iterCards(): Card[] {
    return [...this.cards.values()];
  }

  has(cardId: string): boolean {
    return this.cards.has(cardId);
  }
}

function loadEntry(map: Map<string, Card>, entry: RawCard): void {
  const id = entry.id;
  if (!id) return;
  map.set(id, {
    id,
    name: entry.name ?? id,
    text: cleanText(entry.text),
    cost: entry.cost ?? 0,
    attack: entry.attack ?? null,
    health: entry.health ?? null,
    type: entry.type ?? "",
    cardClass: entry.cardClass ?? "",
    cardSet: entry.set ?? "",
  });
}
