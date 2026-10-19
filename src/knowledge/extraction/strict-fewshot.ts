import type { EvidenceWindow } from './evidence.js';
import type { WindowExtractionModel } from './window-proposals.js';

/** Required-nullable transport placeholders, with domain meaning left to the host. */
type StrictWireValue<T> = T extends readonly (infer Item)[] ? readonly StrictWireValue<Item>[]
  : T extends object ? { readonly [Key in keyof T]-?: undefined extends T[Key]
    ? StrictWireValue<Exclude<T[Key], undefined>> | null : StrictWireValue<T[Key]> } : T;
export interface StrictExtractionFewshotExample {
  readonly exampleId: string;
  readonly input: {
    readonly excerpts: readonly EvidenceWindow['excerpts'][number][];
    readonly limitations: readonly string[];
  };
  readonly output: StrictWireValue<WindowExtractionModel>;
}

/** Synthetic prompt demonstrations; neither held-out cases nor human-reviewed Gold. */
export const STRICT_EXTRACTION_FEWSHOT_EXAMPLES = [
  {
    "exampleId": "synthetic-occurrence-and-identifier-v1",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "frost-1",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "user",
          "text": "巡检对象是 FrostGate 与 FrostGateShadow。FrostGate 仍待复核。"
        }
      ],
      "limitations": []
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_gate",
          "label": "FrostGate",
          "description": "原文列出的第一个巡检对象，后文仍待复核。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        },
        {
          "entityId": "e_shadow",
          "label": "FrostGateShadow",
          "description": "原文另列的完整名称，与 FrostGate 分别指代。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_gate_first",
          "entityId": "e_gate",
          "selection": {
            "evidenceRef": "frost-1",
            "quote": "FrostGate",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "第一次独立出现的完整名称。"
        },
        {
          "mentionId": "m_shadow",
          "entityId": "e_shadow",
          "selection": {
            "evidenceRef": "frost-1",
            "quote": "FrostGateShadow",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "第二个对象的完整标识符，不截成前缀。"
        },
        {
          "mentionId": "m_gate_last",
          "entityId": "e_gate",
          "selection": {
            "evidenceRef": "frost-1",
            "quote": "FrostGate",
            "occurrence": 2
          },
          "basis": "explicit",
          "rationale": "后一句再次指向第一个巡检对象；中间复合名称中的同字节子串也计入 occurrence。"
        }
      ],
      "proposals": []
    }
  },
  {
    "exampleId": "synthetic-property-and-independent-metric-v2",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "cup-1",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "user",
          "text": "玻璃杯 C 的容量是 300 毫升。评审单独定义容量偏差指标 M_4，用于比较该杯的容量与目标容量的差。"
        }
      ],
      "limitations": []
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_cup",
          "label": "玻璃杯 C",
          "description": "原文称容量为 300 毫升的玻璃杯。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        },
        {
          "entityId": "e_metric",
          "label": "容量偏差指标 M_4",
          "description": "评审单独定义的指标，用于比较该杯容量与目标容量的差。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_cup",
          "entityId": "e_cup",
          "selection": {
            "evidenceRef": "cup-1",
            "quote": "玻璃杯 C",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "原文完整的杯名称。"
        },
        {
          "mentionId": "m_metric",
          "entityId": "e_metric",
          "selection": {
            "evidenceRef": "cup-1",
            "quote": "容量偏差指标 M_4",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "原文明确独立定义的指标，不仅是一个数值属性。"
        },
        {
          "mentionId": "m_cup_pronoun",
          "entityId": "e_cup",
          "selection": {
            "evidenceRef": "cup-1",
            "quote": "该杯",
            "occurrence": 0
          },
          "basis": "inference",
          "rationale": "同一句承接前述唯一的玻璃杯 C。"
        }
      ],
      "proposals": [
        {
          "proposalId": "p_capacity",
          "draft": {
            "title": "杯容量与容量偏差指标定义",
            "content": {
              "statements": [
                {
                  "statementId": "s_capacity",
                  "subject": {
                    "entityId": "e_cup"
                  },
                  "relation": "容量为 300 毫升",
                  "modality": "descriptive",
                  "polarity": "positive",
                  "context": {
                    "scenario": "本次评审中的玻璃杯 C",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    }
                  },
                  "object": null
                },
                {
                  "statementId": "s_metric",
                  "subject": {
                    "entityId": "e_metric"
                  },
                  "relation": "衡量容量相对目标容量的差",
                  "modality": "descriptive",
                  "polarity": "positive",
                  "context": {
                    "scenario": "本次评审中的容量偏差指标",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [
                      "目标容量数值未提供。"
                    ],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    }
                  },
                  "object": {
                    "entityId": "e_cup"
                  }
                }
              ],
              "organization": {
                "knowledgeKind": "fact"
              }
            },
            "evidence": [
              {
                "evidenceLinkId": "l_capacity",
                "evidenceRef": "cup-1",
                "statementIds": [
                  "s_capacity"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "原文直接给出了杯的容量及单位。"
              },
              {
                "evidenceLinkId": "l_metric",
                "evidenceRef": "cup-1",
                "statementIds": [
                  "s_metric"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "原文明确说明指标独立定义及其比较对象；不补造目标容量。"
              }
            ]
          },
          "entityIds": [
            "e_cup",
            "e_metric"
          ],
          "mentionIds": [
            "m_cup",
            "m_metric",
            "m_cup_pronoun"
          ],
          "citations": [
            {
              "evidenceLinkId": "l_capacity",
              "selection": {
                "evidenceRef": "cup-1",
                "quote": "玻璃杯 C 的容量是 300 毫升。",
                "occurrence": 0
              }
            },
            {
              "evidenceLinkId": "l_metric",
              "selection": {
                "evidenceRef": "cup-1",
                "quote": "评审单独定义容量偏差指标 M_4，用于比较该杯的容量与目标容量的差。",
                "occurrence": 0
              }
            }
          ],
          "reuseRationale": "复查本次容量评审时保留来源陈述的容量值、指标用途及尚缺的目标值。",
          "identityUncertainties": []
        }
      ]
    }
  },
  {
    "exampleId": "synthetic-unknown-not-resolved-by-assistant-v1",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "heron-user",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "user",
          "text": "我说的「蓝鹭」指的是哪一个，目前还不确定。"
        },
        {
          "evidenceRef": "heron-assistant",
          "recordIndex": 1,
          "eventKind": "message",
          "role": "assistant",
          "text": "我猜是蓝鹭数据库。"
        },
        {
          "evidenceRef": "heron-user-later",
          "recordIndex": 2,
          "eventKind": "message",
          "role": "user",
          "text": "先别按这个猜测消歧。"
        }
      ],
      "limitations": []
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_ambiguous",
          "label": "蓝鹭",
          "description": "用户尚未确认所指的蓝鹭。",
          "qualifiers": [],
          "identityStatus": "unresolved",
          "possibleEntityIds": [
            "e_candidate"
          ],
          "uncertainties": [
            "用户未确认具体对象；助手猜测不能作为用户澄清。"
          ],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        },
        {
          "entityId": "e_candidate",
          "label": "蓝鹭数据库",
          "description": "助手提出的候选解释，不代表用户原指代已经确定。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [
            "仅是助手猜测，用户明确要求暂不据此消歧。"
          ],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_ambiguous",
          "entityId": "e_ambiguous",
          "selection": {
            "evidenceRef": "heron-user",
            "quote": "蓝鹭",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "保留用户原始含糊名称，不用后续助手答案覆盖它。"
        },
        {
          "mentionId": "m_candidate",
          "entityId": "e_candidate",
          "selection": {
            "evidenceRef": "heron-assistant",
            "quote": "蓝鹭数据库",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "只识别助手猜测中明确提出的候选名称，不合并成用户已确认身份。"
        }
      ],
      "proposals": []
    }
  },
  {
    "exampleId": "synthetic-normative-grounding-and-partial-admission-v2",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "beacon-1",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "user",
          "text": "离线规程规定：BeaconTray 在未完成人工复核时不得发布。该窗口没有发布执行记录。"
        }
      ],
      "limitations": [
        "仅包含规程说明，未附执行轨迹。"
      ]
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_tray",
          "label": "BeaconTray",
          "description": "离线规程中须在发布前完成人工复核的对象。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_tray",
          "entityId": "e_tray",
          "selection": {
            "evidenceRef": "beacon-1",
            "quote": "BeaconTray",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "原文使用完整名称，不截取前缀。"
        }
      ],
      "proposals": [
        {
          "proposalId": "p_gate",
          "draft": {
            "title": "发布前的人工复核门禁",
            "content": {
              "statements": [
                {
                  "statementId": "s_gate",
                  "subject": {
                    "entityId": "e_tray"
                  },
                  "relation": "发布",
                  "modality": "normative",
                  "polarity": "negative",
                  "context": {
                    "scenario": "离线规程中的发布门禁",
                    "conditions": [
                      "未完成人工复核"
                    ],
                    "exceptions": [],
                    "unknowns": [
                      "本窗口没有发布执行记录。"
                    ],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源没有提供时间。"
                    }
                  },
                  "object": null
                }
              ],
              "organization": {
                "knowledgeKind": "fact"
              }
            },
            "evidence": [
              {
                "evidenceLinkId": "l_gate",
                "evidenceRef": "beacon-1",
                "statementIds": [
                  "s_gate"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "来源规定未复核时不得发布；不是已经遵守规程的执行证据。"
              }
            ]
          },
          "entityIds": [
            "e_tray"
          ],
          "mentionIds": [
            "m_tray"
          ],
          "citations": [
            {
              "evidenceLinkId": "l_gate",
              "selection": {
                "evidenceRef": "beacon-1",
                "quote": "BeaconTray 在未完成人工复核时不得发布。",
                "occurrence": 0
              }
            },
            {
              "evidenceLinkId": "l_gate",
              "selection": {
                "evidenceRef": "beacon-1",
                "quote": "该窗口没有发布执行记录。",
                "occurrence": 0
              }
            }
          ],
          "reuseRationale": "准备发布时复查规程的适用条件，不把规定当成已执行结果。",
          "identityUncertainties": []
        }
      ]
    }
  },
  {
    "exampleId": "synthetic-version-artifact-v2",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "ice-1",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "user",
          "text": "回归语料已冻结为 omk-entity-quality/v12，摘要已登记，此后只读。提取提示词继续迭代，当前是 v14。"
        },
        {
          "evidenceRef": "ice-2",
          "recordIndex": 1,
          "eventKind": "message",
          "role": "assistant",
          "text": "确认：v12 语料按归档版本保留，不与后续版本混算；提取提示词作为持续对象，版本仅作限定。"
        }
      ],
      "limitations": []
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_corpus",
          "label": "回归语料 v12",
          "description": "已冻结归档、此后只读的具体语料版本。",
          "qualifiers": ["omk-entity-quality/v12", "摘要已登记"],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "version",
          "componentRef": null,
          "collection": null
        },
        {
          "entityId": "e_prompt",
          "label": "提取提示词",
          "description": "持续迭代的提取提示词本身；当前版本只是限定，不另建版本实体。",
          "qualifiers": ["当前版本 v14"],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_corpus_full",
          "entityId": "e_corpus",
          "selection": {
            "evidenceRef": "ice-1",
            "quote": "omk-entity-quality/v12",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "冻结归档语料的完整版本标识。"
        },
        {
          "mentionId": "m_corpus_short",
          "entityId": "e_corpus",
          "selection": {
            "evidenceRef": "ice-2",
            "quote": "v12 语料",
            "occurrence": 0
          },
          "basis": "inference",
          "rationale": "后文以限定短名继续指代同一归档版本。"
        },
        {
          "mentionId": "m_prompt",
          "entityId": "e_prompt",
          "selection": {
            "evidenceRef": "ice-1",
            "quote": "提取提示词",
            "occurrence": 0
          },
          "basis": "explicit",
          "rationale": "持续对象本身的名称；v14 是其当前版本限定，不新建版本实体。"
        }
      ],
      "proposals": [
        {
          "proposalId": "k_no_mix",
          "draft": {
            "title": "归档版本语料不与后续版本合并计算",
            "content": {
              "statements": [
                {
                  "statementId": "s1",
                  "subject": { "entityId": "e_corpus" },
                  "relation": "与后续版本语料合并计算",
                  "object": null,
                  "modality": "normative",
                  "polarity": "negative",
                  "context": {
                    "scenario": "语料版本演进",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [],
                    "occurredDuring": { "timeKind": "unknown", "reason": "来源未说明发生时间" },
                    "validDuring": { "timeKind": "unknown", "reason": "来源未说明适用期限" }
                  }
                }
              ],
              "organization": { "knowledgeKind": "fact" }
            },
            "evidence": [
              {
                "evidenceLinkId": "l_no_mix",
                "evidenceRef": "ice-2",
                "statementIds": ["s1"],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "助手在确认中明确提出不混算约束。"
              }
            ]
          },
          "entityIds": ["e_corpus"],
          "mentionIds": ["m_corpus_short"],
          "citations": [
            {
              "evidenceLinkId": "l_no_mix",
              "selection": {
                "evidenceRef": "ice-2",
                "quote": "不与后续版本混算",
                "occurrence": 0
              }
            }
          ],
          "reuseRationale": "后续任何冻结制品升版时复查同一不混算约束。",
          "identityUncertainties": []
        }
      ]
    }
  },
  {
    "exampleId": "synthetic-source-time-and-fact-time-v1",
    "input": {
      "excerpts": [
        {
          "evidenceRef": "harbor-status",
          "recordIndex": 0,
          "eventKind": "message",
          "role": "assistant",
          "timestamp": "2026-10-20T08:00:00.000Z",
          "text": "HarborDesk 的首批功能已交付，但整体准确率尚未验收。"
        },
        {
          "evidenceRef": "harbor-plan",
          "recordIndex": 1,
          "eventKind": "message",
          "role": "user",
          "timestamp": "2026-10-20T08:10:00.000Z",
          "text": "后续重构 HarborDesk 时必须保留来源和修订历史。"
        },
        {
          "evidenceRef": "harbor-event",
          "recordIndex": 2,
          "eventKind": "message",
          "role": "assistant",
          "timestamp": "2026-10-20T09:00:00.000Z",
          "text": "HarborDesk 于 2026-10-20T08:30:00.000Z 完成构建，并于 2026-10-20T09:00:00.000Z 完成启动；这是助手转述，窗口没有执行器原始记录。"
        }
      ],
      "limitations": [
        "合成时间语义示范；来源消息时间不认证事实时间，助手转述不等于直接观测。"
      ]
    },
    "output": {
      "responseKind": "knowledge-extraction",
      "schemaVersion": 4,
      "entities": [
        {
          "entityId": "e_harbor",
          "label": "HarborDesk",
          "description": "本例交付状态、重构要求与事件所指的对象。",
          "qualifiers": [],
          "identityStatus": "proposed",
          "possibleEntityIds": [],
          "uncertainties": [],
          "referentKind": "object",
          "componentRef": null,
          "collection": null
        }
      ],
      "mentions": [
        {
          "mentionId": "m_harbor",
          "entityId": "e_harbor",
          "selection": {
            "evidenceRef": "harbor-status",
            "quote": "HarborDesk",
            "occurrence": null
          },
          "basis": "explicit",
          "rationale": "三条消息明确使用相同名称连续讨论同一对象；不补具体构建或部署身份。"
        }
      ],
      "proposals": [
        {
          "proposalId": "p_status_and_events",
          "draft": {
            "title": "HarborDesk 的交付状态与事件记录",
            "content": {
              "statements": [
                {
                  "statementId": "s_delivered",
                  "subject": {
                    "entityId": "e_harbor"
                  },
                  "object": null,
                  "relation": "首批功能已交付",
                  "modality": "descriptive",
                  "polarity": "positive",
                  "context": {
                    "scenario": "助手汇报的交付状态",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [
                      "没有交付发生时间依据，不能从消息时间推出。"
                    ],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未提供该事实的发生时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未说明适用时间范围。"
                    }
                  }
                },
                {
                  "statementId": "s_acceptance",
                  "subject": {
                    "entityId": "e_harbor"
                  },
                  "object": null,
                  "relation": "整体准确率已完成验收",
                  "modality": "descriptive",
                  "polarity": "negative",
                  "context": {
                    "scenario": "助手汇报的验收缺口",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [
                      "未给出验收活动时间或后续验收结果。"
                    ],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未提供该事实的发生时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未说明适用时间范围。"
                    }
                  }
                },
                {
                  "statementId": "s_build",
                  "subject": {
                    "entityId": "e_harbor"
                  },
                  "object": null,
                  "relation": "完成构建",
                  "modality": "descriptive",
                  "polarity": "positive",
                  "context": {
                    "scenario": "助手转述的构建事件",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [
                      "窗口未提供执行器原始记录，不构成独立验证。"
                    ],
                    "occurredDuring": {
                      "timeKind": "instant",
                      "at": "2026-10-20T08:30:00.000Z"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未说明适用时间范围。"
                    }
                  }
                },
                {
                  "statementId": "s_start",
                  "subject": {
                    "entityId": "e_harbor"
                  },
                  "object": null,
                  "relation": "完成启动",
                  "modality": "descriptive",
                  "polarity": "positive",
                  "context": {
                    "scenario": "助手转述的启动事件",
                    "conditions": [],
                    "exceptions": [],
                    "unknowns": [
                      "窗口未提供执行器原始记录，不构成独立验证。"
                    ],
                    "occurredDuring": {
                      "timeKind": "instant",
                      "at": "2026-10-20T09:00:00.000Z"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未说明适用时间范围。"
                    }
                  }
                }
              ],
              "organization": {
                "knowledgeKind": "fact"
              }
            },
            "evidence": [
              {
                "evidenceLinkId": "l_status",
                "evidenceRef": "harbor-status",
                "statementIds": [
                  "s_delivered",
                  "s_acceptance"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "交付完成与尚未验收分别表达；原文无事实时点，不能复制消息 timestamp。"
              },
              {
                "evidenceLinkId": "l_events",
                "evidenceRef": "harbor-event",
                "statementIds": [
                  "s_build",
                  "s_start"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "原文明示两个事件时刻；启动时刻虽等于消息时间仍保留，但不提升为直接观测。"
              }
            ]
          },
          "entityIds": [
            "e_harbor"
          ],
          "mentionIds": [
            "m_harbor"
          ],
          "citations": [
            {
              "evidenceLinkId": "l_status",
              "selection": {
                "evidenceRef": "harbor-status",
                "quote": "HarborDesk 的首批功能已交付，但整体准确率尚未验收。",
                "occurrence": null
              }
            },
            {
              "evidenceLinkId": "l_events",
              "selection": {
                "evidenceRef": "harbor-event",
                "quote": "HarborDesk 于 2026-10-20T08:30:00.000Z 完成构建，并于 2026-10-20T09:00:00.000Z 完成启动；这是助手转述，窗口没有执行器原始记录。",
                "occurrence": null
              }
            }
          ],
          "reuseRationale": "核对交付、验收与事件记录时，分别读取来源主张和其确有依据的事实时间。",
          "identityUncertainties": []
        },
        {
          "proposalId": "p_plan",
          "draft": {
            "title": "HarborDesk 后续重构的保留要求",
            "content": {
              "statements": [
                {
                  "statementId": "s_protect",
                  "subject": {
                    "entityId": "e_harbor"
                  },
                  "object": null,
                  "relation": "重构时保留来源和修订历史",
                  "modality": "normative",
                  "polarity": "positive",
                  "context": {
                    "scenario": "用户提出的后续重构要求，未记录执行结果",
                    "conditions": [
                      "后续重构 HarborDesk 时"
                    ],
                    "exceptions": [],
                    "unknowns": [
                      "来源未提供执行时间或适用起止时间。"
                    ],
                    "occurredDuring": {
                      "timeKind": "unknown",
                      "reason": "未来要求不表示执行已经发生，来源未给执行时间。"
                    },
                    "validDuring": {
                      "timeKind": "unknown",
                      "reason": "来源未说明适用时间范围。"
                    }
                  }
                }
              ],
              "organization": {
                "knowledgeKind": "method",
                "purpose": "约束后续重构时对来源与修订历史的处理。",
                "instructionStatementIds": [
                  "s_protect"
                ]
              }
            },
            "evidence": [
              {
                "evidenceLinkId": "l_plan",
                "evidenceRef": "harbor-plan",
                "statementIds": [
                  "s_protect"
                ],
                "relation": "supports",
                "basis": "source_assertion",
                "interpretation": "保留用户要求；来源没有提供执行或适用时段，不用消息 timestamp 补齐。"
              }
            ]
          },
          "entityIds": [
            "e_harbor"
          ],
          "mentionIds": [
            "m_harbor"
          ],
          "citations": [
            {
              "evidenceLinkId": "l_plan",
              "selection": {
                "evidenceRef": "harbor-plan",
                "quote": "后续重构 HarborDesk 时必须保留来源和修订历史。",
                "occurrence": null
              }
            }
          ],
          "reuseRationale": "后续重构时保留来源与历史，不把要求的提出当作已经执行。",
          "identityUncertainties": []
        }
      ]
    }
  }
] as const satisfies readonly StrictExtractionFewshotExample[];

/** Fault injection for host diagnostics only; not an additional model-output example. */
export const STRICT_EXTRACTION_PARTIAL_ADMISSION_DIAGNOSTIC = {
  exampleId: 'synthetic-normative-grounding-and-partial-admission-v2',
  goodProposalId: 'p_gate',
  badProposalId: 'p_bad_quote',
  citationIndex: 0,
  badQuote: 'BeaconTray 已经完成人工复核并发布。',
  rejectionReason: 'citation:quote_mismatch',
} as const;

export function renderStrictExtractionFewshotBlock(): string {
  const examples = STRICT_EXTRACTION_FEWSHOT_EXAMPLES.map((example, index) =>
    `正例 ${index + 1}：完整输入与一个合法 wire 输出示范。\n输入：\n${JSON.stringify(example.input)}\n输出：\n${JSON.stringify(example.output)}`);
  const diagnostic = STRICT_EXTRACTION_PARTIAL_ADMISSION_DIAGNOSTIC;
  return `以下正例共 ${STRICT_EXTRACTION_FEWSHOT_EXAMPLES.length} 例，是合成示范，用于展示前述规则如何落实；不是当前窗口的事实，也不是待复制的实体或知识。只依据当前输入提炼。\n`
    + examples.join('\n\n')
    + `\n\n宿主逐项接纳诊断（故障注入说明，不是模型输出示范）：保持正例 4 的原始输入不变，保留正确候选 ${diagnostic.goodProposalId}；测试另复制一个候选为 ${diagnostic.badProposalId}，仅把第一条引用的 quote 改成原文不存在的“${diagnostic.badQuote}”。这个故意错误的副本由宿主以 ${diagnostic.rejectionReason} 拒绝，正确的 ${diagnostic.goodProposalId} 仍被保留，原始响应字节也不得改写。不得生成或模仿这个错误副本；本诊断对应的合法输出示范仍是正例 4 所示、仅含 ${diagnostic.goodProposalId} 的 JSON。`;
}

export const STRICT_EXTRACTION_FEWSHOT_BLOCK = renderStrictExtractionFewshotBlock();
