/**
 * Detect programming language from file extension
 * Used for syntax highlighting in file preview
 */

// Map of file extensions to Prism language identifiers
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  vue: 'vue',

  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',

  // Data formats
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'toml',
  ini: 'ini',

  // Programming languages
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  groovy: 'groovy',
  clj: 'clojure',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  bat: 'batch',

  // Markup/Documentation
  md: 'markdown',
  markdown: 'markdown',
  rst: 'rest',
  tex: 'latex',

  // Config
  dockerfile: 'docker',
  makefile: 'makefile',
  cmake: 'cmake',

  // Other
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  env: 'bash',
  gitignore: 'gitignore',
  editorsconfig: 'editorconfig',

  // Logs
  log: 'plaintext',
  txt: 'plaintext',
};

// Special filename patterns
const SPECIAL_FILES: Record<string, string> = {
  'dockerfile': 'docker',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  'makefile': 'makefile',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'gitignore',
  '.editorconfig': 'editorconfig',
  '.env': 'bash',
  'package.json': 'json',
  'tsconfig.json': 'json',
  'cargo.toml': 'toml',
  'pyproject.toml': 'toml',
  'go.mod': 'go',
  'go.sum': 'plaintext',
};

/**
 * Detect language from file path
 * @param filePath - Full path to the file
 * @returns Prism language identifier (defaults to 'plaintext')
 */
export function detectLanguage(filePath: string): string {
  const fileName = filePath.toLowerCase().split('/').pop() || '';
  const baseName = fileName.split('/').pop() || '';

  // Check special filenames first
  if (SPECIAL_FILES[baseName]) {
    return SPECIAL_FILES[baseName];
  }

  // Get extension (handle files with multiple dots like .d.ts)
  const parts = fileName.split('.');
  if (parts.length > 1) {
    // Try last extension
    const ext = parts.pop() || '';
    if (EXTENSION_TO_LANGUAGE[ext]) {
      return EXTENSION_TO_LANGUAGE[ext];
    }

    // Try combined extension (e.g., d.ts)
    if (parts.length > 1) {
      const combinedExt = `${parts.pop()}.${ext}`;
      if (EXTENSION_TO_LANGUAGE[combinedExt]) {
        return EXTENSION_TO_LANGUAGE[combinedExt];
      }
    }
  }

  return 'plaintext';
}

/**
 * Get display name for language
 * @param language - Prism language identifier
 * @returns Human-readable language name
 */
export function getLanguageDisplayName(language: string): string {
  const DISPLAY_NAMES: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    tsx: 'TypeScript (React)',
    jsx: 'JavaScript (React)',
    python: 'Python',
    ruby: 'Ruby',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    kotlin: 'Kotlin',
    swift: 'Swift',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    yaml: 'YAML',
    xml: 'XML',
    markdown: 'Markdown',
    bash: 'Shell',
    sql: 'SQL',
    docker: 'Dockerfile',
    toml: 'TOML',
    plaintext: 'Plain Text',
  };

  return DISPLAY_NAMES[language] || language.charAt(0).toUpperCase() + language.slice(1);
}