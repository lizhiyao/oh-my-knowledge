# Global settings and configuration scope

Studio’s Settings button manages local user preferences in `$OMK_HOME/settings.json` (`~/.oh-my-knowledge/settings.json` by default). CLI and Studio share this file. Reading creates no directory; saving invokes no model, moves no data and changes no historical run.

## Persisted preferences

| Setting | Built-in default | Scope |
| --- | --- | --- |
| Knowledge folder | `$OMK_HOME/knowledge` | Studio extraction and `omk observe knowledge`; `workspace` / `--workspace` overrides it |
| Extraction provider | `codex` | Knowledge extraction; supports `codex`, `openai-api`, `anthropic-api` |
| Extraction model | Unset | Must be selected before extraction; changing provider does not inherit another provider’s model |
| Default language | `zh` | Studio and CLI; `lang` / `--lang` overrides it |

Priority: **explicit request → existing environment overrides → saved settings → built-in defaults**. `OMK_EXECUTOR`, `OMK_MODEL` and `OMK_LANG` remain environment overrides; Settings shows the overriding variable names. There is no additional knowledge-folder environment alias. An empty model means selection is required, not automatic model discovery.

The knowledge page’s per-operation folder and model controls do not modify global preferences. Browsers no longer own durable folder settings. Old browser selections are not automatically copied into the settings file; save them explicitly if needed. Explicit page directories still apply. Changing the default does not migrate existing candidates or sources.

## Configuration that remains elsewhere

| Scope | Configuration | Owner |
| --- | --- | --- |
| Startup and data root | `OMK_HOME`, Studio `--host` / `--port`, `OMK_REPORT_HOST` / `OMK_REPORT_PORT` | Environment or startup flags; no live root or listener changes |
| API credentials and endpoints | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | Environment; keys are neither accepted nor displayed by settings |
| External runtimes | `CODEX_HOME`, Codex config, PATH, proxy configuration | Runtime or startup environment; third-party configuration is not modified |
| General execution/evaluation defaults | `OMK_EXECUTOR`, `OMK_MODEL`, `OMK_JUDGE_MODELS` | Existing CLI environment overrides; evaluations do not read the extraction model preference |
| Project and evaluation run | Evaluation config, judges, samples, assertions, concurrency, budgets, report/observation directories | Project files or command flags; not promoted to user preferences |
| Extraction and maintenance operation | Conversation, task, selected messages, model override, revision and rationale | Current workflow; no automatic historical scanning or sending |
| Maintenance and internal infrastructure | `OMK_SKIP_UPDATE_CHECK`, `BROWSER`, cache/tree directories and retention limits, mock variables | Existing advanced environment controls, outside the ordinary settings form |

Environment changes generally require restarting Studio. Reading settings does not verify credentials or model availability. Extraction still requires preview and confirmation.

## File and concurrency

The file uses `schemaVersion: 1` and only known fields. Corrupt files, unknown versions, relative folders and credential fields are rejected without silent overwrites. Saves carry a read revision; conflicts require a reload. Extraction runs continue to record the actual provider, model and selected source.
