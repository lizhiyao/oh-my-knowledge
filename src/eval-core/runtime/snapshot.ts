import {
  SchemaIdentitySchema,
  type CoreSchemaValidator,
  type SchemaIdentity,
} from '../contracts/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';

export class RuntimeBindingSnapshotError extends TypeError {
  readonly referenceId: string;

  constructor(referenceId: string) {
    super('Schema validator registry contains an invalid binding.');
    this.name = 'RuntimeBindingSnapshotError';
    this.referenceId = referenceId;
  }
}

export function snapshotSchemaValidators(
  validators: ReadonlyMap<string, CoreSchemaValidator>,
): ReadonlyMap<string, CoreSchemaValidator> {
  return new Map([...validators].map(([key, validator]) => {
    const schema = SchemaIdentitySchema.safeParse(validator?.schema);
    if (!schema.success || typeof validator?.parse !== 'function') {
      throw new RuntimeBindingSnapshotError(key);
    }
    const captured: CoreSchemaValidator = Object.freeze({
      schema: deepFreeze(snapshotJson(schema.data)) as SchemaIdentity,
      parse: validator.parse.bind(validator),
    });
    return [key, captured] as const;
  }));
}
