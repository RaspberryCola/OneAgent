import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * OneAgent light theme for file preview
 * Matches the existing design system: grayscale palette, SF Pro Rounded, zero shadows
 */
export const oneAgentLightTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: '#18181b', // pure-black
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    lineHeight: '1.6',
    caretColor: '#18181b',
    padding: '12px',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#18181b',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(0, 0, 0, 0.08)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#a0a0a0', // stone
    fontSize: '11px',
    minWidth: '3em',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 1em 0 4px',
    textAlign: 'right',
    minWidth: '2.5em',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#a0a0a0',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.3)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(234, 179, 8, 0.5)',
  },
  '&.cm-focused .cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.4)',
  },
}, { dark: false });

/**
 * Syntax highlighting for the light theme
 * Using grayscale + muted accents to match design system
 */
const oneAgentHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#52525b' }, // stone-600
  { tag: tags.operator, color: '#71717a' }, // stone-500
  { tag: tags.special(tags.variableName), color: '#52525b' },
  { tag: tags.typeName, color: '#52525b' },
  { tag: tags.atom, color: '#71717a' },
  { tag: tags.number, color: '#71717a' },
  { tag: tags.definition(tags.variableName), color: '#18181b' },
  { tag: tags.string, color: '#3f3f46' }, // stone-700
  { tag: tags.special(tags.string), color: '#3f3f46' },
  { tag: tags.comment, color: '#a1a1aa', fontStyle: 'italic' }, // stone-400
  { tag: tags.variableName, color: '#27272a' }, // stone-800
  { tag: tags.tagName, color: '#52525b' },
  { tag: tags.bracket, color: '#71717a' },
  { tag: tags.meta, color: '#71717a' },
  { tag: tags.link, color: '#52525b', textDecoration: 'underline' },
  { tag: tags.heading, color: '#18181b', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.bool, color: '#71717a' },
  { tag: tags.null, color: '#71717a' },
  { tag: tags.className, color: '#52525b' },
  { tag: tags.propertyName, color: '#3f3f46' },
  { tag: tags.function(tags.variableName), color: '#18181b' },
  { tag: tags.regexp, color: '#52525b' },
]);

export const oneAgentLightExtensions = [
  oneAgentLightTheme,
  syntaxHighlighting(oneAgentHighlightStyle),
];

/**
 * OneAgent diff theme
 * Extends light theme with diff-specific decorations
 */
export const oneAgentDiffTheme = EditorView.theme({
  '.cm-mergeView': {
    overflow: 'hidden',
  },
  '.cm-mergeViewEditor': {
    fontSize: '12px',
  },
  '.cm-mergeViewUnchanged': {
    opacity: '0.7',
  },
}, { dark: false });

export const oneAgentDiffExtensions = [
  oneAgentDiffTheme,
  syntaxHighlighting(oneAgentHighlightStyle),
];
