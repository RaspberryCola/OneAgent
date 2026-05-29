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
    color: '#24292e',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    lineHeight: '1.6',
    caretColor: '#24292e',
    padding: '12px',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#24292e',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: '#0366d625',
  },
  '.cm-selectionBackground': {
    backgroundColor: '#0366d625',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#6a737d',
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
    color: '#6a737d',
  },
  '.cm-matchingBracket': {
    backgroundColor: '#0366d625',
    outline: '1px solid #0366d640',
  },
  '.cm-searchMatch': {
    backgroundColor: '#fff2cc',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#ffdf5d',
  },
  '&.cm-focused .cm-searchMatch': {
    backgroundColor: '#ffdf5d66',
  },
}, { dark: false });

/**
 * GitHub-style syntax highlighting
 * Based on GitHub's light theme color scheme
 */
const oneAgentHighlightStyle = HighlightStyle.define([
  // Comments
  { tag: tags.comment, color: '#6a737d', fontStyle: 'italic' },
  { tag: tags.lineComment, color: '#6a737d', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#6a737d', fontStyle: 'italic' },
  { tag: tags.docComment, color: '#6a737d', fontStyle: 'italic' },

  // Strings
  { tag: tags.string, color: '#032f62' },
  { tag: tags.special(tags.string), color: '#032f62' },
  { tag: tags.regexp, color: '#032f62' },

  // Numbers and booleans
  { tag: tags.number, color: '#005cc5' },
  { tag: tags.bool, color: '#005cc5' },
  { tag: tags.null, color: '#005cc5' },

  // Keywords
  { tag: tags.keyword, color: '#d73a49' },
  { tag: tags.controlKeyword, color: '#d73a49' },
  { tag: tags.operatorKeyword, color: '#d73a49' },
  { tag: tags.definitionKeyword, color: '#d73a49' },
  { tag: tags.moduleKeyword, color: '#d73a49' },

  // Operators and punctuation
  { tag: tags.operator, color: '#d73a49' },
  { tag: tags.punctuation, color: '#24292e' },
  { tag: tags.bracket, color: '#24292e' },
  { tag: tags.separator, color: '#24292e' },

  // Variables and functions
  { tag: tags.variableName, color: '#24292e' },
  { tag: tags.definition(tags.variableName), color: '#24292e' },
  { tag: tags.function(tags.variableName), color: '#6f42c1' },
  { tag: tags.propertyName, color: '#005cc5' },
  { tag: tags.special(tags.variableName), color: '#e36209' },

  // Types and classes
  { tag: tags.typeName, color: '#6f42c1' },
  { tag: tags.className, color: '#6f42c1' },
  { tag: tags.namespace, color: '#6f42c1' },

  // Tags (HTML/XML)
  { tag: tags.tagName, color: '#22863a' },
  { tag: tags.attributeName, color: '#6f42c1' },
  { tag: tags.attributeValue, color: '#032f62' },

  // Meta and decorators
  { tag: tags.meta, color: '#6a737d' },
  { tag: tags.annotation, color: '#6a737d' },

  // Links
  { tag: tags.link, color: '#032f62', textDecoration: 'underline' },
  { tag: tags.url, color: '#032f62', textDecoration: 'underline' },

  // Headings (Markdown)
  { tag: tags.heading, color: '#24292e', fontWeight: 'bold' },
  { tag: tags.heading1, color: '#24292e', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading2, color: '#24292e', fontWeight: 'bold', fontSize: '1.1em' },

  // Emphasis
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },

  // Other
  { tag: tags.atom, color: '#005cc5' },
  { tag: tags.labelName, color: '#6f42c1' },
  { tag: tags.color, color: '#005cc5' },
  { tag: tags.unit, color: '#005cc5' },
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
