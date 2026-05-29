import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';

// Language extension factory map
const languageFactories: Record<string, () => Extension> = {
  // JavaScript/TypeScript family
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),

  // Web
  html: () => html(),
  css: () => css(),
  scss: () => css(),
  sass: () => css(),
  less: () => css(),

  // Data formats
  json: () => json(),
  xml: () => xml(),

  // Programming languages
  python: () => python(),
  rust: () => rust(),
  go: () => go(),
  java: () => java(),
  cpp: () => cpp(),
  c: () => cpp(),
  php: () => php(),
  sql: () => sql(),
  markdown: () => markdown(),
  yaml: () => yaml(),
};

// Cache for loaded extensions
const extensionCache = new Map<string, Extension>();

/**
 * Get CodeMirror 6 language extensions for a given Prism language ID
 * @param prismLanguageId - Language ID from languageDetection.ts (e.g., 'javascript', 'python')
 * @returns Array of CodeMirror extensions for the language
 */
export function getCodeMirrorLanguageExtensions(prismLanguageId: string): Extension[] {
  if (!prismLanguageId || prismLanguageId === 'plaintext') {
    return [];
  }

  // Check cache first
  if (extensionCache.has(prismLanguageId)) {
    return [extensionCache.get(prismLanguageId)!];
  }

  const factory = languageFactories[prismLanguageId];
  if (!factory) {
    // No language support available, return empty array for plain text
    return [];
  }

  try {
    const extension = factory();
    extensionCache.set(prismLanguageId, extension);
    return [extension];
  } catch (error) {
    console.warn(`Failed to load language extension for ${prismLanguageId}:`, error);
    return [];
  }
}

/**
 * Get list of supported language IDs
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(languageFactories);
}
