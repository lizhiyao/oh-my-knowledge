import {
  assertIdentityFilesUnchanged,
  captureIdentityFiles,
  type CapturedIdentityFile,
  type ContentIdentityFile,
} from './content-identity.js';

export type CodexContentIdentityFile = ContentIdentityFile;
export type CapturedCodexIdentityFile = CapturedIdentityFile;
export const captureCodexIdentityFiles = captureIdentityFiles;
export const assertCodexIdentityFilesUnchanged = assertIdentityFilesUnchanged;
