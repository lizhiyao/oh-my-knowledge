/** Only a known rejection before publication may use this error. Reading/I/O failures are not capacity receipts. */
export class LibraryWriteCapacityError extends Error {
  constructor(readonly capacityScope: 'history' | 'file' | 'workspace') { super(`Library ${capacityScope} write capacity exceeded.`); }
}

export class LibraryReferentKindConflictError extends Error {
  constructor() { super('Library referent kind conflict.'); }
}
