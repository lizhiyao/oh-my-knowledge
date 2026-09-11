import type { Interfaces } from '@oclif/core';
import type { CliLang } from './i18n.js';

type OptionalUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: T[K];
};

/** Infer declared flags without oclif's implicit JSON field; language is resolved by the host. */
export type CommandFlags<T> = OptionalUndefined<Omit<Interfaces.InferredFlags<T>, 'lang' | ('json' extends keyof T ? never : 'json')>> & {
  lang: CliLang;
};
