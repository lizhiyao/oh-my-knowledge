const SETUP_FAILURE_RE = /auth|login|credential|API[_ ]?KEY|BASE_URL|API error|ENOENT|not found|ECONN|ENOTFOUND|ETIMEDOUT|timeout|timed out|401|403|404|invalid_request_error/i;

const MODEL_UNAVAILABLE_RE = /model .*not supported|model is not supported|unsupported model|invalid_request_error.*model|model.*invalid_request_error|model_not_found|model .*not found|model .*does not exist|no such model|not have access to (the )?model|model .*not available|model .*is not available/i;

export function looksLikeModelUnavailableFailure(message: string): boolean {
  return MODEL_UNAVAILABLE_RE.test(message);
}

export function looksLikeLlmSetupFailure(message: string): boolean {
  return SETUP_FAILURE_RE.test(message) || looksLikeModelUnavailableFailure(message);
}
