import { objectMembers, readValue, scanJsonValue, type JsonWindow, type JsonValueKind } from './jsonl-record-window.js';

/**
 * 窗口支撑的记录视图：让适配器「按普通对象读」，但只有真被读到的字段才解成 JS 值。
 *
 * 为什么惰性只做两层：撑住内存斜率的是「逐条为整条记录建对象图」，而一次记录访问里，
 * 大字节永远挂在 `payload` 的直接子字段上（`payload.output`／`payload.input`／`payload.item`
 * 这一批），`payload` 再往下的字段本身就是被消费的证据。所以：
 *
 * - 记录顶层：按需取值，其中 `payload` 给下一层视图；
 * - `payload` 层：按需取值，但它的字段一旦取用就整体解成真实值；
 * - 更深的层不存在——取到的永远是普通对象／字符串。
 *
 * 第三条是刻意的：让 `payload` 以下立刻落地，产物里就不可能混进视图，也不需要每个消费点各自记得
 * 「先展开再保存」。
 *
 * 视图本身**不持有任何字节**，只持源文件的绝对字节区间：每次取字段都按定位读进调用方给的共享
 * 缓冲。这一条是实测逼出来的——原来每个视图复制一份行字节，一趟整档因此多花约 380 MiB 瞬时分配
 * （同一份 1 357 MiB 日志：带复制一趟 459 MiB，零复制同一批字节的结构行走 78 MiB）。
 *
 * 等价性由 jsonl-record-window 那条分工承诺兜底：字段值就是 `JSON.parse` 吃该字段字节的结果；
 * 键序与重复键取 `objectMembers` 的 `JSON.parse` 语义，所以 `Object.keys`／`JSON.stringify`／
 * 展开运算在视图上的结果与整条解析后的结果逐字相同。
 */

/** 记录顶层唯一继续下钻的字段：大字节都挂在它的直接子字段上。 */
const LAZY_MEMBER = 'payload';

/** 源文件里的一段字节区间，加上「把它读进共享缓冲」的能力：视图只存这两个数，不存字节。 */
interface Span {
  begin: number;
  end: number;
  valueKind: JsonValueKind;
}

interface RecordLocation {
  /** 读 `[absoluteBegin, absoluteBegin + length)` 到共享缓冲；返回缓冲的内容到下次读之前有效。 */
  bytes: (absoluteBegin: number, length: number) => Buffer;
}

function windowView(location: RecordLocation, span: Span, materializeBelow: boolean): object {
  const values = new Map<string, unknown>();
  let members: Map<string, Span> | undefined;
  let order: string[] | undefined;

  // 第一次取字段就把整层的「键→值区间」一次建好：按键逐次定位会把整层重扫 N 遍——包括那些
  // 根本不会被读到的大字段，一条记录取 N 个字段就是 N 趟。实测 704 MiB 档的 wall 因此从
  // 基线约 12 s 涨到 104 s，而建表趟数只与视图数同阶。
  const memberMap = (): Map<string, Span> => {
    if (!members) {
      members = new Map();
      order = [];
      const length = span.end - span.begin;
      const buffer = location.bytes(span.begin, length);
      const window: JsonWindow = { valueKind: 'object', begin: 0, end: length };
      for (const member of objectMembers(buffer, window)) {
        const name = readValue(buffer, member.key) as string;
        members.set(name, {
          begin: span.begin + member.value.begin,
          end: span.begin + member.value.end,
          valueKind: member.value.valueKind,
        });
        if (!order.includes(name)) order.push(name);
      }
    }
    return members;
  };

  /** 把一个区间读进共享缓冲并在那个缓冲上解值：解出来的东西是副本，不别名到共享缓冲。 */
  const decode = (target: Span): unknown => {
    const length = target.end - target.begin;
    const buffer = location.bytes(target.begin, length);
    return readValue(buffer, { valueKind: target.valueKind, begin: 0, end: length });
  };

  const read = (key: string): unknown => {
    if (values.has(key)) return values.get(key);
    const found = memberMap().get(key);
    if (!found) return undefined;
    const isSubtree = found.valueKind === 'object' || found.valueKind === 'array';
    // 只有记录顶层的 payload 继续做成视图；其余子树一次解成真实值，视图因此不会往下带。
    const value = isSubtree && !materializeBelow && key === LAZY_MEMBER
      ? windowView(location, found, true)
      : decode(found);
    values.set(key, value);
    return value;
  };

  // 目标保持为空对象：合成属性一律报成可配置，才不会撞上 Proxy 不变式——目标自身的不可配置
  // 属性必须出现在 ownKeys 里，而空对象除了内部槽位什么都没有。
  return new Proxy({} as Record<string, unknown>, {
    get(target, property) {
      return typeof property === 'string' ? read(property) : Reflect.get(target, property, target);
    },
    has(_target, property) {
      return typeof property === 'string' && memberMap().has(property);
    },
    ownKeys() {
      memberMap();
      return order!;
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== 'string' || !memberMap().has(property)) return undefined;
      return { value: read(property), enumerable: true, configurable: true, writable: false };
    },
    set() {
      throw new Error('流式 trace 记录视图是只读的');
    },
    defineProperty() {
      throw new Error('流式 trace 记录视图是只读的');
    },
    deleteProperty() {
      throw new Error('流式 trace 记录视图是只读的');
    },
  });
}

export type WindowedRecord =
  | { viewKind: 'record'; record: object }
  | { viewKind: 'malformed' }
  | { viewKind: 'ignored' };

/**
 * 把一行记录的字节包成视图。`malformed` 与 `JSON.parse` 抛错同判，`ignored` 对应「不是对象」
 * 的值——整档路径把这两类分别计入畸形与非对象，口径不能因为走按需取值而改。
 */
export function windowedRecord(location: RecordLocation, absoluteBegin: number, length: number): WindowedRecord {
  const buffer = location.bytes(absoluteBegin, length);
  const window = scanJsonValue(buffer, 0, length);
  if (!window) return { viewKind: 'malformed' };
  if (window.valueKind !== 'object') return { viewKind: 'ignored' };
  const span: Span = {
    begin: absoluteBegin + window.begin,
    end: absoluteBegin + window.end,
    valueKind: 'object',
  };
  return { viewKind: 'record', record: windowView(location, span, false) };
}
