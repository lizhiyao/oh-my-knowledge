export const OBSERVATION_CAPTURE_SCOPE = 'observation:capture';

export interface ObservationPrincipal {
  tenantId: string;
  principalId: string;
  scopes: readonly string[];
}

export interface PrincipalResolver<Request = unknown> {
  resolve(request: Request): Promise<ObservationPrincipal>;
}

export type ObservationPrincipalErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'tenant_mismatch'
  | 'invalid_principal';

export class ObservationPrincipalError extends Error {
  readonly statusCode: 401 | 403;

  constructor(
    readonly code: ObservationPrincipalErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ObservationPrincipalError';
    this.statusCode = code === 'unauthenticated' || code === 'invalid_principal' ? 401 : 403;
  }
}

export const LOCAL_OBSERVATION_PRINCIPAL: ObservationPrincipal = Object.freeze({
  tenantId: 'local',
  principalId: 'local-user',
  scopes: Object.freeze([OBSERVATION_CAPTURE_SCOPE]),
});

export function validateObservationPrincipal(value: unknown): ObservationPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ObservationPrincipalError('invalid_principal', 'Principal 必须是对象。');
  }
  const candidate = value as Partial<ObservationPrincipal>;
  const tenantId = validateOpaqueId(candidate.tenantId, 'tenantId');
  const principalId = validateOpaqueId(candidate.principalId, 'principalId');
  if (!Array.isArray(candidate.scopes)) {
    throw new ObservationPrincipalError('invalid_principal', 'Principal scopes 必须是数组。');
  }
  const scopes = candidate.scopes.map((scope) => validateScope(scope));
  if (new Set(scopes).size !== scopes.length) {
    throw new ObservationPrincipalError('invalid_principal', 'Principal scopes 不能重复。');
  }
  return { tenantId, principalId, scopes };
}

export function assertObservationCaptureScope(principal: ObservationPrincipal): void {
  if (!principal.scopes.includes(OBSERVATION_CAPTURE_SCOPE)) {
    throw new ObservationPrincipalError(
      'forbidden',
      `Principal 缺少 ${OBSERVATION_CAPTURE_SCOPE} scope。`,
    );
  }
}

function validateOpaqueId(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ObservationPrincipalError(
      'invalid_principal',
      `${field} 必须是 1 至 256 个字符的稳定不透明 ID。`,
    );
  }
  return value;
}

function validateScope(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > 120
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ObservationPrincipalError(
      'invalid_principal',
      'Scope 必须是 1 至 120 个字符的非空字符串。',
    );
  }
  return value;
}
